import { resolveHanaHome, readTextFile } from "./services/platform.js";
import fs from "node:fs";
import path from "node:path";
import { collectBalances } from "./services/balance.js";
import { createSettingsService } from "./services/settings.js";

const HOME = resolveHanaHome();
const AGENTS = path.join(HOME, "agents");
const CACHE = "token-cache.json";
const CACHE_VERSION = 21;
const ARCHIVE = "usage-archive.json";
const ARCHIVE_VERSION = 1;

function tokVal(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return v.totalTokens || 0;
  return 0;
}

export default class TokenTrackerPlugin {
  async onload() {
    const { dataDir, config, log, bus } = this.ctx;
    const cachePath = path.join(dataDir, CACHE);
    const archivePath = path.join(dataDir, ARCHIVE);
    const archive = loadArchive(archivePath, log) || { version: ARCHIVE_VERSION, updatedAt: null, entries: {} };
    const settings = createSettingsService({ dataDir, config });
    let interval = settings.read().scanInterval * 1000;
    const shared = { data: null, ready: false, cachePath, dataDir, archivePath, archive, realtimeSnapshot };
    this.ctx._tokenCache = shared;

    // 通过 agent:list 获取 agentId → name 映射
    try {
      const result = await bus.request("agent:list");
      if (result?.agents) {
        const agentNames = {};
        for (const a of result.agents) {
          agentNames[a.id] = a.name || a.id;
        }
        shared.agentNames = agentNames;
      }
    } catch (e) {
      log.warn("[token-tracker] agent:list failed:", e.message);
    }
    // scan(force=false): 增量（靠 mtime），供定时器用
    // fullScan():        全量，供首次加载和刷新按钮用
    // 扫描完成时 emit 到 bus（P1：v2 App / 其他插件可订阅 token-tracker.updated）
    shared.scan = (force) => {
      if (shared.scanPromise) {
        if (force && !shared.scanForce) return shared.scanPromise.then(() => shared.scan(true));
        return shared.scanPromise;
      }
      shared.scanning = true;
      shared.scanForce = !!force;
      shared.scanPromise = scanAll(shared, log, force).then(() => {
        shared.emitUpdated?.();
      }).finally(() => {
        shared.scanning = false;
        shared.scanPromise = null;
      });
      return shared.scanPromise;
    };
    shared.fullScan = () => shared.scan(true);

    // 缓存有效时走增量扫描，仅首次/版本升级时全量（后台执行，不阻塞启动）
    const old = loadCache(cachePath, log);
    if (old && old.version === CACHE_VERSION) {
      shared.scan(false);
    } else {
      shared.fullScan();
    }
    // 首次播种：归档为空时，下次扫描会把账本当前全量并入历史
    if (!archive.updatedAt) log.info("[token-tracker] archive empty, will seed from usage-ledger on next scan");
    let timer = setInterval(() => shared.scan(false).catch(e => log.warn(e.message)), interval);
    timer.unref?.();
    this.register(() => clearInterval(timer));
    // ── 实时会话监控：订阅消息事件 ──
    // ── 实时会话监控：订阅 token_usage + context_usage ──
    const realtime = {
      agentId: null, agentName: null, sessionPath: null,
      model: null, provider: null,
      lastInput: 0, lastOutput: 0, lastReasoning: 0,
      lastCacheRead: 0, lastTotalTokens: 0, lastCost: 0,
      sessionInput: 0, sessionOutput: 0, sessionReasoning: 0,
      sessionCacheRead: 0, sessionTotalTokens: 0, sessionCost: 0, sessionMsgCount: 0,
      contextTokens: 0, contextWindow: 0,
      elapsed: 0, totalRequests: 0,
      balance: null, balanceCurrency: "CNY",
      updatedAt: Date.now(), currentSessionStart: Date.now()
    };
    shared.realtime = realtime;
    const liveSnapshot = () => {
      const snapshot = realtimeSnapshot(realtime, shared.agentNames || shared.data?.agentNames || {});
      const speed = shared.data?._speedStats;
      return { ...snapshot, lastTps: speed?.last?.tps || 0, avgTps: speed?.avgTps || 0 };
    };
    this.register(() => {
      for (const client of [...(shared._realtimeClients || [])]) client.close?.();
    });

    // P1：总线广播（扫描完成 / token_usage 到达时触发，见 shared.scan 与 pushToSSE）
    // 踩坑点 2：bus.subscribe 的 types 过滤器不可靠；事件消费方需在回调内手动过滤 ev?.type
    shared.emitUpdated = () => {
      try {
        if (typeof bus.emit === "function") {
          bus.emit({
            type: "token-tracker.updated",
            lastScan: shared.data?.lastScan || null,
            realtime: liveSnapshot(),
            summaryVersion: 1
          }, null);
        }
      } catch { /* bus.emit 不可用不反噬 */ }
    };

    function pushToSSE() {
      // P1：token_usage 到达即向 bus 广播（不依赖是否有 SSE 客户端在线）
      if (typeof shared.emitUpdated === "function") { try { shared.emitUpdated(); } catch {} }
      if (!shared._realtimeClients) return;
      // 同步当前余额查询结果，供 widget SSE 推送的 balance 字段使用
      if (shared.data?._balances) {
        realtime.balances = shared.data._balances;
        realtime.balanceUpdatedAt = Date.now();
      }
      const payload = { type: "usage", data: realtimeSnapshot(realtime, shared.agentNames) };
      // 生成速度（来自历史扫描聚合，真实可溯源）
      const ss = shared.data?._speedStats;
      if (ss) {
        payload.data.lastTps = ss.last?.tps || 0;
        payload.data.lastTextTps = ss.last?.textTps || 0;
        payload.data.avgTps = ss.avgTps || 0;
      }
      for (const client of shared._realtimeClients) {
        try { if (typeof client.send === "function") client.send(payload); } catch {}
      }
    }

    function agentFromPath(sp) {
      if (!sp) return null;
      const m = sp.match(/agents[\\\/]([^\\\/]+)[\\\/]/);
      return m ? m[1] : null;
    }

    // 订阅 token_usage（每次 LLM 调用完成时发出）
    const unsub1 = bus.subscribe((ev, ssp) => {
      try {

        if (ev?.type === "context_usage") {
          const sp = ssp || ev.sessionPath;
          if (!realtime.sessionPath || !sp || sp === realtime.sessionPath) {
            realtime.contextTokens = Number(ev.tokens) || 0;
            realtime.contextWindow = Number(ev.contextWindow) || 0;
            realtime.updatedAt = Date.now();
            pushToSSE();
          }
          return;
        }
        if (ev?.type !== "token_usage") return;
        const u = ev?.usage || {};
        if (!u || !u.totalTokens) return;
        const sp = ssp || ev.sessionPath || realtime.sessionPath;
        const aid = agentFromPath(sp);
        if (sp && sp !== realtime.sessionPath) {
          realtime.agentId = aid;
          realtime.agentName = shared.agentNames?.[aid] || aid;
          realtime.sessionInput = 0; realtime.sessionOutput = 0; realtime.sessionReasoning = 0;
          realtime.sessionCacheRead = 0; realtime.sessionTotalTokens = 0;
          realtime.sessionCost = 0; realtime.sessionMsgCount = 0;
          realtime.totalRequests = 0;
          realtime.contextTokens = 0; realtime.contextWindow = 0;
          realtime.currentSessionStart = Date.now();
        }
        if (sp) realtime.sessionPath = sp;
        realtime.model = ev?.modelId || realtime.model;
        realtime.provider = ev?.modelProvider || realtime.provider;
        const inp = u.input || 0, out = u.output || 0, rsn = u.reasoningTokens || 0;
        const cr = u.cacheRead || u.readCache || 0;
        const tot = u.totalTokens || (inp + out);
        const cost = Number(typeof u.cost === "object" ? u.cost?.total : u.cost) || 0;
        realtime.lastInput = inp; realtime.lastOutput = out; realtime.lastReasoning = rsn;
        realtime.lastCacheRead = cr; realtime.lastTotalTokens = tot; realtime.lastCost = cost;
        realtime.sessionInput += inp; realtime.sessionOutput += out; realtime.sessionReasoning += rsn;
        realtime.sessionCacheRead += cr; realtime.sessionTotalTokens += tot;
        realtime.sessionCost += cost; realtime.sessionMsgCount += 1;
        realtime.totalRequests += 1;
        realtime.elapsed = Math.floor((Date.now() - realtime.currentSessionStart) / 1000);
        realtime.updatedAt = Date.now();
        pushToSSE();
      } catch (e) { /* token_usage error */ }
    });

    this.register(() => { unsub1(); });

    // ── P1：v1/v2 数据桥（v2 App 并行开发，契约不得偏离）──
    // bus.handle 请求式 handler：token-tracker.snapshot / dashboard / balance / refresh。
    // dashboard 复用路由抽出的 ctx._buildDashboardData（与 /dashboard/data 同一套构建逻辑）。
    const pluginCtx = this.ctx;
    const busUnsubs = [];
    const regHandler = (type, fn) => {
      try {
        const un = bus.handle(type, fn);
        if (typeof un === "function") busUnsubs.push(un);
        const name = type.replace(/^token-tracker\./, "").replaceAll(".", "/");
        const off = bus.handle(`app:token-tracker/${name}`, async (payload, request) => {
          if (request?.caller?.kind !== "app" || request.caller.appId !== "token-tracker-app") {
            throw Object.assign(new Error("此服务只供 Token 用量 App 调用"), { code: "APP_SERVICE_CROSS_APP_DENIED" });
          }
          const result = type === "token-tracker.dashboard" && pluginCtx._buildDashboardData
            ? await pluginCtx._buildDashboardData(payload || {}, { skipBalances: true })
            : await fn(payload);
          // Cross-App services are JSON-only. Keep private legacy dashboard config off this bridge.
          if (result && typeof result === "object") {
            delete result._balanceApis;
            if (result.summary) result.summary.highUsageThreshold = settings.read().highUsageThreshold;
          }
          return JSON.parse(JSON.stringify(result ?? null));
        });
        if (typeof off === "function") busUnsubs.push(off);
      } catch (e) { log.warn("[token-tracker] bus.handle(" + type + ") failed:", e.message); }
    };

    // 实时快照（realtime + balances + agentNames，纯内存态，不打外网）
    regHandler("token-tracker.snapshot", async () => {
      const cacheData = shared.data;
      const snap = liveSnapshot();
      return {
        realtime: snap,
        balances: shared.balanceSnapshot?.balances || [],
        balanceUpdatedAt: shared.balanceSnapshot?.updatedAt || null,
        agentNames: shared.agentNames || cacheData?.agentNames || {},
        lastScan: cacheData?.lastScan || null,
        ready: !!shared.ready
      };
    });

    // 聚合统计：入参 { range, from, to, agent, model, provider, type }，与 /dashboard/data 同口径
    regHandler("token-tracker.dashboard", async (payload) => {
      const p = payload || {};
      const fn = pluginCtx._buildDashboardData;
      if (typeof fn !== "function") return { error: "token-tracker 数据服务未就绪（等待路由注册）" };
      try {
        const r = await fn({ range: p.range, from: p.from, to: p.to, agent: p.agent, model: p.model, provider: p.provider, type: p.type });
        if (r && r.notReady) return { error: r.error };
        return r;
      } catch (e) {
        // 与旧 HTTP 路由同语义：错误不拖垮调用方，错误文案随响应返回
        return { error: e?.message || "构建失败" };
      }
    });

    // 余额：走统一适配层（DeepSeek/GLM 显式 + balance-apis 配置分支）
    regHandler("token-tracker.balance", async () => {
      try { await import("./routes/dashboard.js").catch(() => {}); } catch {}
      try {
        shared.balanceSnapshot = await collectBalances({ dataDir: shared.dataDir });
        return shared.balanceSnapshot;
      } catch (e) {
        return { balances: [], error: e?.message || "查询失败" };
      }
    });

    // 触发扫描（force 可选）
    regHandler("token-tracker.refresh", async (payload) => {
      const force = !!(payload && payload.force);
      if (typeof shared.scan !== "function") return { error: "scanner unavailable" };
      await shared.scan(force);
      return { ok: true, lastScan: shared.data?.lastScan || null, full: force };
    });

    regHandler("token-tracker.settings.read", () => settings.read());
    regHandler("token-tracker.settings.write", (payload) => {
      const result = settings.write(payload);
      clearInterval(timer);
      interval = result.scanInterval * 1000;
      timer = setInterval(() => shared.scan(false).catch(e => log.warn(e.message)), interval);
      timer.unref?.();
      shared.emitUpdated?.();
      return result;
    });

    this.register(() => { for (const un of busUnsubs) { try { un(); } catch {} } });

    log.info("token-tracker loaded (interval " + interval + "ms)");
  }
}

function realtimeSnapshot(rt, agentNames) {
  const sessionRatio = rt.sessionTotalTokens > 0 ? ((rt.sessionCacheRead / rt.sessionTotalTokens) * 100).toFixed(1) : "0.0";
  const lastRatio = rt.lastTotalTokens > 0 ? ((rt.lastCacheRead / rt.lastTotalTokens) * 100).toFixed(1) : "0.0";
  const contextPercent = rt.contextWindow > 0 ? ((rt.contextTokens / rt.contextWindow) * 100).toFixed(1) : "0.0";
  return {
    agentId: rt.agentId,
    agentName: (agentNames||{})[rt.agentId] || rt.agentId || "—",
    model: rt.model || "—", provider: rt.provider || "—",
    sessionPath: rt.sessionPath,
    lastInput: rt.lastInput, lastOutput: rt.lastOutput, lastReasoning: rt.lastReasoning,
    lastCacheRead: rt.lastCacheRead, lastTotalTokens: rt.lastTotalTokens, lastCost: rt.lastCost, lastHitRate: lastRatio,
    sessionInput: rt.sessionInput, sessionOutput: rt.sessionOutput, sessionReasoning: rt.sessionReasoning,
    sessionCacheRead: rt.sessionCacheRead, sessionTotalTokens: rt.sessionTotalTokens,
    sessionCost: rt.sessionCost, sessionMsgCount: rt.sessionMsgCount, sessionHitRate: sessionRatio,
    contextTokens: rt.contextTokens, contextWindow: rt.contextWindow, contextPercent: contextPercent,
    elapsed: rt.elapsed, totalRequests: rt.totalRequests,
    balances: rt.balances || null,
    balanceUpdatedAt: rt.balanceUpdatedAt || null,
    updatedAt: rt.updatedAt
  };
}


async function scanAll(shared, log, force) {
  const old = loadCache(shared.cachePath, log);
  const cache = old || { version: CACHE_VERSION, lastScan: null, sessions: {}, agentNames: {} };
  // 版本不匹配 或 外部强制 → 全量重扫（忽略旧 mtime）
  const full = force || cache.version !== CACHE_VERSION;
  cache.version = CACHE_VERSION;
  let changed = false;

  // 优先使用 agent:list API 返回的 agent 名称
  if (shared.agentNames) {
    cache.agentNames = { ...shared.agentNames, ...cache.agentNames };
  }

  let dirs = [];
  try { dirs = fs.readdirSync(AGENTS).filter(n => fs.statSync(path.join(AGENTS, n)).isDirectory()); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  // Collect display names from identity.md (template-safe, fallback only)
  for (const id of dirs) {
    if (!cache.agentNames[id]) {
      try {
        const c = readTextFile(path.join(AGENTS, id, "identity.md"));
        const m = c.match(/^#\s+(.+)/m);
        if (m) {
          const name = m[1].trim();
          if (!name.includes("{{")) {
            cache.agentNames[id] = name;
          } else {
            cache.agentNames[id] = id;
          }
        } else {
          cache.agentNames[id] = id;
        }
      } catch { cache.agentNames[id] = id; }
    }
  }
  for (const agent of dirs) {
    changed = scanDir(path.join(AGENTS, agent, "sessions"), agent, "desktop", null, cache, full ? null : old) || changed;
    const arch = path.join(AGENTS, agent, "sessions", "archived");
    if (fs.existsSync(arch)) changed = scanDir(arch, agent, "desktop", null, cache, full ? null : old) || changed;
    const phone = path.join(AGENTS, agent, "phone", "sessions");
    if (fs.existsSync(phone)) {
      for (const sub of fs.readdirSync(phone)) {
        const sp = path.join(phone, sub);
        if (!fs.statSync(sp).isDirectory()) continue;
        changed = scanDir(sp, agent, "channel", sub.replace(/-[^-]+$/, ""), cache, full ? null : old) || changed;
      }
    }
    // bridge 私聊会话
    const bridge = path.join(AGENTS, agent, "sessions", "bridge");
    if (fs.existsSync(bridge)) {
      for (const sub of fs.readdirSync(bridge)) {
        if (sub === "bridge-sessions.json") continue;
        const sp = path.join(bridge, sub);
        if (!fs.statSync(sp).isDirectory()) continue;
        changed = scanDir(sp, agent, "bridge", sub, cache, full ? null : old) || changed;
      }
    }
    // 后台活动
    const activity = path.join(AGENTS, agent, "activity");
    if (fs.existsSync(activity)) {
      changed = scanDir(activity, agent, "background", null, cache, full ? null : old) || changed;
    }
    // 子代理会话
    const subagent = path.join(AGENTS, agent, "subagent-sessions");
    if (fs.existsSync(subagent)) {
      changed = scanDir(subagent, agent, "sub", null, cache, full ? null : old) || changed;
      for (const sub of fs.readdirSync(subagent)) {
        if (sub === "session-meta.json") continue;
        const sp = path.join(subagent, sub);
        if (!fs.statSync(sp).isDirectory()) continue;
        changed = scanDir(sp, agent, "sub", sub, cache, full ? null : old) || changed;
      }
    }
    // workflow 任务会话（此前漏扫，导致 workflow 调用不计入统计）
    const wf = path.join(AGENTS, agent, "workflow-sessions");
    if (fs.existsSync(wf)) {
      changed = scanDir(wf, agent, "background", null, cache, full ? null : old) || changed;
    }
  }
  // usage-ledger.json 中无 sessionPath 的条目（memory + utility 子系统）
  changed = scanLedger(cache, log, full, shared) || changed;

  // 保留最近5天的对话
  var cutoff5d = Date.now() - 5 * 86400000;
  for (const _key of Object.keys(cache.sessions)) {
    const _s = cache.sessions[_key];
    if (_s.conversations && _s.conversations.length) {
      var _before = _s.conversations.length;
      _s.conversations = _s.conversations.filter(function(c){ return new Date(c.time).getTime() >= cutoff5d; });
      if (_s.conversations.length !== _before) changed = true;
    }
  }

  if (changed) {
    cache.lastScan = new Date().toISOString();
    const dailyGlobal = buildDailyGlobal(cache);
    cache.prediction = computePrediction(cache, dailyGlobal);
    cache._speedStats = buildSpeedStats(cache);
    saveCache(shared.cachePath, cache, log);
  }
  shared.data = cache;
  shared.ready = true;

  // 汇总扫描期跳过的 JSONL 行，如果有污染的会话文件告警
  let _totalSkipped = 0;
  for (const _k of Object.keys(cache.sessions)) {
    _totalSkipped += (cache.sessions[_k].skippedLines || 0);
  }
  if (_totalSkipped > 0) {
    log.warn("[token-tracker] scan: skipped " + _totalSkipped + " invalid JSONL line(s) — some sessions may have corrupted lines, check the .jsonl files");
  }
}

function scanDir(dir, agent, type, channel, cache, old) {
  let changed = false;
  let conv = null;
  let files = [];
  try { files = fs.readdirSync(dir).filter(n => n.endsWith(".jsonl") && !n.includes(".repair.jsonl")); }
  catch { return false; }

  for (const fn of files) {
    const fp = path.join(dir, fn);
    const key = `${agent}::${type}::${channel||""}::${fn}`;
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }

    // 文件未变化则跳过
    const prev = old?.sessions?.[key];
    if (prev && prev.mtime === stat.mtimeMs) continue;

    const data = { agent, type, channelName: channel||null,  filePath: fp, mtime: stat.mtimeMs, size: stat.size, fileName: fn, firstTime: null, lastTime: null, msgCount: 0, assistantCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, models: {}, providers: {}, conversations: [], mediaGen: {} };

    try {
      var currentProvider = null;
      var _lastModel = null;
      var _skipped = 0;
      var _prevEvTs = NaN; // 上一条消息事件时间，用于计算本次 LLM 调用耗时
      for (const line of readTextFile(fp).split("\n").filter(Boolean)) {
        let p;
        try { p = JSON.parse(line); } catch { _skipped++; continue; }
        if (_skipped > 0 && !(data._skipReported)) {
          // 调用方拿不到 scanDir，这里最早结束在 scanAll（data 走 changed 路径拿到）
          data._skipReported = true;
        }
        if (p.type === "model_change" && p.provider) {
          currentProvider = p.provider;
          _lastModel = null;
          continue;
        }
        if (p.type === "custom" && p.customType === "hana-deferred-result" && p.data) {
          var _hd = p.data;
          if (_hd.taskId && _hd.status === "success") {
            var _mk = _hd.type === "video-generation" ? "video" : "image";
            for (var _tk in data.mediaGen) {
              var _mg = data.mediaGen[_tk];
              if (_mg._taskIds && _mg._taskIds[_hd.taskId]) {
                _mg.successCount = (_mg.successCount || 0) + 1;
                break;
              }
            }
          }
          continue;
        }
        if (p.type !== "message" || !p.message) continue;
        const m = p.message;
        const ts = p.timestamp || m.timestamp || "";
        if (!data.firstTime) data.firstTime = ts;
        data.lastTime = ts;
        var _evTs = ts ? new Date(ts).getTime() : NaN;
        data.msgCount++;
        // 对话拆分
        if (m.role === "user") {
          if (conv) data.conversations.push(conv);
          var _txt = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content[0]?.text||"" : "");
          conv = { time: ts, userContent: _txt, userSnippet: _txt.slice(0,50), model: null, provider: null, totalTokens: 0, msgCount: 0, toolCalls: [], steps: [] };
        }
        if (m.role === "assistant" && conv) {
          const _f = m.stopReason === "error" || m.isError === true || !!m.errorMessage;
          if (!_f) {
            conv.msgCount++;
            if (!conv.model) { conv.model = m.model; conv.provider = m.provider; }
            if (m.usage) { var _tot = m.usage.totalTokens || ((m.usage.input||0)+(m.usage.output||0)); conv.totalTokens += _tot; }
          }
          if (Array.isArray(m.content)) {
            for (var _i=0; _i<m.content.length; _i++) {
              var _it = m.content[_i];
              if (!_it) continue;
              if (_it.type === "toolCall") {
                conv.toolCalls.push({ name: _it.name, args: _it.arguments });
                var _isFile = ["edit","write"].includes(_it.name);
                conv.steps.push({ t: _isFile ? "fm" : "tc", name: _it.name, args: _it.arguments });
                if (_it.name === "image-gen_generate-image" || _it.name === "image-gen_generate-video") {
                  var _mKind = _it.name === "image-gen_generate-video" ? "video" : "image";
                  var _mModel = _it.arguments?.model || "";
                  var _mProv = _it.arguments?.provider || "";
                  if (!_mModel) _mModel = _mKind === "video" ? "default-video" : "default-image";
                  if (!_mProv) _mProv = "default";
                  var _mKey = _mProv + "/" + _mModel;
                  if (!data.mediaGen[_mKey]) data.mediaGen[_mKey] = { provider: _mProv, model: _mModel, kind: _mKind, callCount: 0, successCount: 0, _taskIds: {}, _callIds: {} };
                  data.mediaGen[_mKey].callCount++;
                  if (_it.id) data.mediaGen[_mKey]._callIds[_it.id] = true;
                }
              } else if (_it.type === "thinking") {
                conv.steps.push({ t: "th", c: _it.thinking || "" });
              } else if (_it.type === "text") {
                conv.steps.push({ t: "tx", c: _it.text || "" });
              }
            }
          } else if (typeof m.content === "string" && m.content) {
            conv.steps.push({ t: "tx", c: m.content });
          }
        }
        if (m.role === "toolResult" && m.toolName && m.toolName.startsWith("image-gen_") && m.details?.mediaGeneration) {
          var _mg2 = m.details.mediaGeneration;
          var _tcid = m.toolCallId;
          if (_mg2.tasks && Array.isArray(_mg2.tasks)) {
            for (var _ti = 0; _ti < _mg2.tasks.length; _ti++) {
              var _tid = _mg2.tasks[_ti]?.taskId;
              if (!_tid) continue;
              for (var _mk2 in data.mediaGen) {
                if (_tcid && data.mediaGen[_mk2]._callIds[_tcid]) {
                  data.mediaGen[_mk2]._taskIds[_tid] = true;
                }
              }
            }
          }
        }
        // 失败请求（stopReason=error / isError / errorMessage）不产生有效调用，不计入统计
        const _failedMsg = m.role === "assistant" && m.usage && (m.stopReason === "error" || m.isError === true || !!m.errorMessage);
        if (m.role === "assistant" && m.usage && !_failedMsg) {
          const msgProvider = m.provider || currentProvider;
          const u = m.usage;
          const inp = tokVal(u.input), out = tokVal(u.output), cr = u.cacheRead||0, cw = u.cacheWrite||0;
          const rsn = tokVal(u.reasoning) || 0;
          const tot = u.totalTokens ?? (inp + out);
          const model = m.model || "unknown";
          data.assistantCount++; data.input += inp; data.output += out; data.cacheRead += cr; data.cacheWrite += cw; data.totalTokens += tot; data.cost += u.cost?.total || 0;
          // ── tok/s：本次调用耗时 = 本消息时间 − 上一条消息时间（含网络与排队，生成速度下限）──
          if (conv && !isNaN(_evTs) && !isNaN(_prevEvTs) && _evTs > _prevEvTs) {
            var _durMs = _evTs - _prevEvTs;
            if (_durMs >= 100 && _durMs < 600000) {
              var _tps = Math.round(out / (_durMs / 1000));
              var _txtTps = Math.round((out - rsn) / (_durMs / 1000));
              if (!conv.speeds) conv.speeds = [];
              conv.speeds.push({ ts, durMs: _durMs, out, reasoning: rsn, tps: _tps, textTps: _txtTps, model, provider: msgProvider });
              if (conv.speeds.length > 100) conv.speeds.shift();
              conv.speedOut = (conv.speedOut || 0) + out;
              conv.speedDur = (conv.speedDur || 0) + _durMs;
              if (_tps > (conv.speedMax || 0)) conv.speedMax = _tps;
              if (!data.speeds) data.speeds = [];
              data.speeds.push({ ts, durMs: _durMs, out, reasoning: rsn, tps: _tps, textTps: _txtTps, model, provider: msgProvider, agent, type });
              if (data.speeds.length > 200) data.speeds.shift();
            }
          }
          // 模型变了但没有 model_change 事件 → 不知道供应商，不归属
          if (_lastModel !== null && _lastModel !== model) currentProvider = null;
          _lastModel = model;
          // 按天统计 — 存在会话自身上，不往 cache 里累加
          const d = new Date(ts); const day = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
          if (day) {
            if (!data.dailyBreakdown) data.dailyBreakdown = {};
            if (!data.dailyBreakdown[day]) data.dailyBreakdown[day] = { totalTokens:0, desktop:0, channel:0, bridge:0, background:0, sub:0, ledger:0, input:0, output:0, cacheRead:0, cacheWrite:0, assistantCount:0, models:{} };
            data.dailyBreakdown[day].totalTokens += tot;
            data.dailyBreakdown[day].input += inp;
            data.dailyBreakdown[day].output += out;
            data.dailyBreakdown[day].cacheRead += cr;
            data.dailyBreakdown[day].cacheWrite += cw;
            data.dailyBreakdown[day].assistantCount += 1;
            if (type === "desktop") data.dailyBreakdown[day].desktop += tot;
            else if (type === "bridge") data.dailyBreakdown[day].bridge += tot;
            else if (type === "background") data.dailyBreakdown[day].background += tot;
            else if (type === "sub") data.dailyBreakdown[day].sub += tot;
            else if (type === "ledger") data.dailyBreakdown[day].ledger += tot;
            else data.dailyBreakdown[day].channel += tot;
            // 按 model 精确统计
            if (!data.dailyBreakdown[day].models[model]) data.dailyBreakdown[day].models[model] = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, assistantCount:0 };
            data.dailyBreakdown[day].models[model].input += inp;
            data.dailyBreakdown[day].models[model].output += out;
            data.dailyBreakdown[day].models[model].cacheRead += cr;
            data.dailyBreakdown[day].models[model].cacheWrite += cw;
            data.dailyBreakdown[day].models[model].totalTokens += tot;
            data.dailyBreakdown[day].models[model].assistantCount += 1;
            // 按供应商/模型统计
            if (msgProvider) {
              const pk = msgProvider + "/" + model;
              if (!data.dailyBreakdown[day].providerTotals) data.dailyBreakdown[day].providerTotals = {};
              if (!data.dailyBreakdown[day].providerTotals[pk]) data.dailyBreakdown[day].providerTotals[pk] = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
              data.dailyBreakdown[day].providerTotals[pk].totalTokens += tot;
              data.dailyBreakdown[day].providerTotals[pk].input += inp;
              data.dailyBreakdown[day].providerTotals[pk].output += out;
              data.dailyBreakdown[day].providerTotals[pk].cacheRead += cr;
              data.dailyBreakdown[day].providerTotals[pk].cacheWrite += cw;
              data.dailyBreakdown[day].providerTotals[pk].assistantCount += 1;
            }
            // 按小时统计 — 用于今日维度
            const hour = String(d.getHours()).padStart(2,"0");
            if (!data.hourlyBreakdown) data.hourlyBreakdown = {};
            if (!data.hourlyBreakdown[day]) data.hourlyBreakdown[day] = {};
            if (!data.hourlyBreakdown[day][hour]) data.hourlyBreakdown[day][hour] = { totalTokens:0, desktop:0, channel:0, bridge:0, background:0, sub:0, ledger:0, cacheRead:0, cacheWrite:0 };
            data.hourlyBreakdown[day][hour].totalTokens += tot;
            data.hourlyBreakdown[day][hour].cacheRead += cr;
            data.hourlyBreakdown[day][hour].cacheWrite += cw;
            if (type === "desktop") data.hourlyBreakdown[day][hour].desktop += tot;
            else if (type === "bridge") data.hourlyBreakdown[day][hour].bridge += tot;
            else if (type === "background") data.hourlyBreakdown[day][hour].background += tot;
            else if (type === "sub") data.hourlyBreakdown[day][hour].sub += tot;
            else if (type === "ledger") data.hourlyBreakdown[day][hour].ledger += tot;
            else data.hourlyBreakdown[day][hour].channel += tot;
            if (!data.hourlyBreakdown[day][hour].models) data.hourlyBreakdown[day][hour].models = {};
            if (!data.hourlyBreakdown[day][hour].models[model]) data.hourlyBreakdown[day][hour].models[model] = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, assistantCount:0, desktop:0, channel:0 };
            data.hourlyBreakdown[day][hour].models[model].input += inp;
            data.hourlyBreakdown[day][hour].models[model].output += out;
            data.hourlyBreakdown[day][hour].models[model].cacheRead += cr;
            data.hourlyBreakdown[day][hour].models[model].cacheWrite += cw;
            data.hourlyBreakdown[day][hour].models[model].totalTokens += tot;
            data.hourlyBreakdown[day][hour].models[model].assistantCount += 1;
            if (type === "desktop") data.hourlyBreakdown[day][hour].models[model].desktop += tot;
            else if (type === "bridge") data.hourlyBreakdown[day][hour].models[model].bridge += tot;
            else if (type === "background") data.hourlyBreakdown[day][hour].models[model].background += tot;
            else if (type === "sub") data.hourlyBreakdown[day][hour].models[model].sub += tot;
            else if (type === "ledger") data.hourlyBreakdown[day][hour].models[model].ledger += tot;
            else data.hourlyBreakdown[day][hour].models[model].channel += tot;
            if (msgProvider) {
              const pk = msgProvider + "/" + model;
              if (!data.hourlyBreakdown[day][hour].providerTotals) data.hourlyBreakdown[day][hour].providerTotals = {};
              if (!data.hourlyBreakdown[day][hour].providerTotals[pk]) data.hourlyBreakdown[day][hour].providerTotals[pk] = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, desktop: 0, channel: 0, assistantCount: 0 };
              data.hourlyBreakdown[day][hour].providerTotals[pk].totalTokens += tot;
              data.hourlyBreakdown[day][hour].providerTotals[pk].input += inp;
              data.hourlyBreakdown[day][hour].providerTotals[pk].output += out;
              data.hourlyBreakdown[day][hour].providerTotals[pk].cacheRead += cr;
              data.hourlyBreakdown[day][hour].providerTotals[pk].cacheWrite += cw;
              data.hourlyBreakdown[day][hour].providerTotals[pk].assistantCount += 1;
              if (type === "desktop") data.hourlyBreakdown[day][hour].providerTotals[pk].desktop += tot;
              else if (type === "bridge") data.hourlyBreakdown[day][hour].providerTotals[pk].bridge += tot;
              else if (type === "background") data.hourlyBreakdown[day][hour].providerTotals[pk].background += tot;
              else if (type === "sub") data.hourlyBreakdown[day][hour].providerTotals[pk].sub += tot;
              else if (type === "ledger") data.hourlyBreakdown[day][hour].providerTotals[pk].ledger += tot;
              else data.hourlyBreakdown[day][hour].providerTotals[pk].channel += tot;
            }
          }
          if (!data.models[model]) data.models[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
          data.models[model].input += inp; data.models[model].output += out; data.models[model].cacheRead += cr; data.models[model].cacheWrite += cw; data.models[model].count++;
          if (msgProvider) {
            const pk = msgProvider + "/" + model;
            if (!data.providers[pk]) data.providers[pk] = { provider: msgProvider, model, totalTokens: 0, count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            data.providers[pk].totalTokens += tot;
            data.providers[pk].count++;
            data.providers[pk].input += inp;
            data.providers[pk].output += out;
            data.providers[pk].cacheRead += cr;
            data.providers[pk].cacheWrite += cw;
          }
        }
        _prevEvTs = _evTs;
      }
    } catch {}
    if (conv) { data.conversations.push(conv); conv = null; }
    data.title = (fn.match(/^(\d{4}-\d{2}-\d{2})/)||[])[1] || "unknown";
    if (_skipped > 0) data.skippedLines = _skipped;
    cache.sessions[key] = data;
    changed = true;
  }
  return changed;
}

// ─── usage-ledger.json 扫描（memory + utility 子系统无 JSONL 的 LLM 调用）───
function scanLedger(cache, log, force, shared) {
  const p = path.join(HOME, "usage-ledger.json");
  if (!fs.existsSync(p)) return false;

  // 增量：仅当 ledger 文件 mtime 变化或强制时重建，否则跳过（避免每次全量重算）
  const lmtime = fs.statSync(p).mtimeMs;
  if (!force && cache._ledgerMtime === lmtime) return false;

  for (const k of Object.keys(cache.sessions)) {
    if (k.startsWith("__ledger__")) delete cache.sessions[k];
  }

  let data;
  try { data = JSON.parse(readTextFile(p)); }
  catch { return false; }
  if (!data?.entries?.length) return false;

  // ── 独立历史归档：账本记录按 requestId 去重并入 usage-archive.json。
  // 账本是 5000 条环形缓冲，满了会挤掉最旧记录；归档后统计从归档构建，
  // 账本丢数据不再影响历史总量。
  const archive = shared?.archive;
  let merged = 0;
  if (archive) {
    for (const e of data.entries) {
      const rid = e.requestId;
      if (!rid || archive.entries[rid]) continue;
      archive.entries[rid] = entryToArchive(e);
      merged++;
    }
    if (merged > 0 || !archive.updatedAt) {
      archive.updatedAt = new Date().toISOString();
      saveArchive(shared.archivePath, archive, log);
    }
  }

  let changed = false;
  const seen = new Set();

  // 从归档构建（而非当次账本快照）：被挤掉的最旧记录仍保留在历史里
  const archivedEntries = archive ? Object.values(archive.entries) : data.entries;
  for (const raw of archivedEntries) {
    const e = archive ? archiveToEntry(raw) : raw;
    const kind = e.attribution?.kind;
    if (kind !== "memory" && kind !== "utility") continue;
    // 失败的请求不算有效调用，不进入任何统计（含次数占比）
    if (e.status === "error" || e.error != null) continue;
    // 归档条目已按 requestId 去重；原始条目才需要这里去重
    if (e.requestId) {
      if (seen.has(e.requestId)) continue;
      seen.add(e.requestId);
    }

    const agent = e.attribution?.agentId || "hanako";
    const model = e.model?.modelId || "unknown";
    const provider = e.model?.provider || "";
    const ts = e.startedAt || e.endedAt || "";
    // 统一本地时区取日（与 scanDir 一致，避免 UTC 日期错位）
    let day = "unknown";
    if (ts) {
      const td = new Date(ts);
      if (!isNaN(td.getTime())) {
        day = td.getFullYear() + "-" + String(td.getMonth() + 1).padStart(2, "0") + "-" + String(td.getDate()).padStart(2, "0");
      }
    }
    const inpRaw = tokVal(e.usage?.input);
    const out = tokVal(e.usage?.output);
    const cr = e.usage?.cache?.readTokens || e.usage?.cacheRead || 0;
    const cw = e.usage?.cache?.writeTokens || e.usage?.cacheWrite || 0;
    const inp = (cr > 0 && inpRaw >= cr) ? inpRaw - cr : inpRaw;
    const tot = e.usage?.totalTokens ?? (inp + out + cr);
    const cost = e.usage?.costTotal || e.usage?.cost?.total || 0;

    const key = `__ledger__${agent}::${kind}::${day}`;
    if (!cache.sessions[key]) {
      cache.sessions[key] = {
        agent, type: "ledger", channelName: null, 
        filePath: p, mtime: 0, size: 0,
        fileName: "usage-ledger.json",
        firstTime: null, lastTime: null,
        msgCount: 0, assistantCount: 0,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: 0,
        models: {}, providers: {}, conversations: [], mediaGen: {},
        dailyBreakdown: {}, hourlyBreakdown: {},
        title: day,
      };
      changed = true;
    }
    const s = cache.sessions[key];
    if (!s.firstTime) s.firstTime = ts;
    s.lastTime = ts; s.msgCount++; s.assistantCount++;
    s.input += inp; s.output += out; s.cacheRead += cr; s.cacheWrite += cw;
    s.totalTokens += tot; s.cost += cost;

    // ── tok/s：官方 ledger 自带 durationMs，精确耗时 ──
    var _durMs = e.durationMs || 0;
    if (!_durMs && e.startedAt && e.endedAt) {
      var _d1 = new Date(e.startedAt).getTime(), _d2 = new Date(e.endedAt).getTime();
      if (!isNaN(_d1) && !isNaN(_d2) && _d2 > _d1) _durMs = _d2 - _d1;
    }
    if (_durMs >= 100 && _durMs < 600000) {
      var _tps = Math.round(out / (_durMs / 1000));
      var _rsn = e.usage?.output?.reasoningTokens || 0;
      var _txtTps = Math.round((out - _rsn) / (_durMs / 1000));
      if (!s.speeds) s.speeds = [];
      s.speeds.push({ ts, durMs: _durMs, out, reasoning: _rsn, tps: _tps, textTps: _txtTps, model, provider });
      if (s.speeds.length > 200) s.speeds.shift();
    }

    if (!s.models[model]) s.models[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
    s.models[model].input += inp; s.models[model].output += out;
    s.models[model].cacheRead += cr; s.models[model].cacheWrite += cw; s.models[model].count++;

    if (provider) {
      const pk = provider + "/" + model;
      if (!s.providers[pk]) s.providers[pk] = { provider, model, totalTokens: 0, count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      s.providers[pk].totalTokens += tot; s.providers[pk].count++;
      s.providers[pk].input += inp; s.providers[pk].output += out; s.providers[pk].cacheRead += cr; s.providers[pk].cacheWrite += cw;
    }

    if (!s.dailyBreakdown[day]) {
      s.dailyBreakdown[day] = { totalTokens:0, desktop:0, channel:0, bridge:0, background:0, sub:0, ledger:0, input:0, output:0, cacheRead:0, cacheWrite:0, assistantCount:0, models:{} };
    }
    const bd = s.dailyBreakdown[day];
    bd.totalTokens += tot; bd.ledger += tot;
    bd.input += inp; bd.output += out;
    bd.cacheRead += cr; bd.cacheWrite += cw; bd.assistantCount++;
    if (!bd.models[model]) bd.models[model] = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, assistantCount:0 };
    bd.models[model].input += inp; bd.models[model].output += out;
    bd.models[model].cacheRead += cr; bd.models[model].cacheWrite += cw; bd.models[model].totalTokens += tot;
    bd.models[model].assistantCount++;
    if (provider) {
      const pk = provider + "/" + model;
      if (!bd.providerTotals) bd.providerTotals = {};
      if (!bd.providerTotals[pk]) bd.providerTotals[pk] = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
      bd.providerTotals[pk].totalTokens += tot;
      bd.providerTotals[pk].input += inp;
      bd.providerTotals[pk].output += out;
      bd.providerTotals[pk].cacheRead += cr;
      bd.providerTotals[pk].cacheWrite += cw;
      bd.providerTotals[pk].assistantCount++;
    }
    const hour = ts ? ts.slice(11, 13) : "00";
    if (!s.hourlyBreakdown[day]) s.hourlyBreakdown[day] = {};
    if (!s.hourlyBreakdown[day][hour]) {
      s.hourlyBreakdown[day][hour] = {
        totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0,
        cacheRead: 0, cacheWrite: 0, assistantCount: 0, models: {}, providerTotals: {}
      };
    }
    const hb = s.hourlyBreakdown[day][hour];
    hb.totalTokens += tot;
    hb.ledger += tot;
    hb.cacheRead += cr;
    hb.cacheWrite += cw;
    hb.assistantCount++;
    // 小时级模型明细（供今日/单日趋势响应模型筛选）
    if (!hb.models[model]) {
      hb.models[model] = {
        totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0,
        desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0
      };
    }
    hb.models[model].totalTokens += tot;
    hb.models[model].input += inp;
    hb.models[model].output += out;
    hb.models[model].cacheRead += cr;
    hb.models[model].cacheWrite += cw;
    hb.models[model].assistantCount++;
    hb.models[model].ledger += tot;
    if (provider) {
      const pk = provider + "/" + model;
      if (!hb.providerTotals[pk]) {
        hb.providerTotals[pk] = {
          totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0,
          desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0
        };
      }
      hb.providerTotals[pk].totalTokens += tot;
      hb.providerTotals[pk].input += inp;
      hb.providerTotals[pk].output += out;
      hb.providerTotals[pk].cacheRead += cr;
      hb.providerTotals[pk].cacheWrite += cw;
      hb.providerTotals[pk].assistantCount++;
      hb.providerTotals[pk].ledger += tot;
    }
  }
  cache._ledgerMtime = lmtime;
  return changed;
}

// ─── 每日全局消耗汇总 ───
function buildDailyGlobal(cache) {
  const dailyGlobal = {};
  for (const s of Object.values(cache.sessions)) {
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (!dailyGlobal[day]) dailyGlobal[day] = 0;
      dailyGlobal[day] += d.totalTokens || 0;
    }
  }
  return dailyGlobal;
}

// ─── 生成速度汇总：所有会话 speeds 合并，加权平均（Σ输出 / Σ耗时）───
// provider 字段：新采集记录自带；旧缓存记录无 provider，用会话级 providers 映射反查（多供应商取 token 量最大的归属）
function provOfSession(s, model) {
  if (!s || !s.providers || !model) return "";
  let best = "", bestTk = 0;
  for (const pk of Object.keys(s.providers)) {
    const sep = pk.indexOf("/");
    if (sep <= 0 || pk.slice(sep + 1) !== model) continue;
    const tk = s.providers[pk].totalTokens || 0;
    if (tk > bestTk) { bestTk = tk; best = s.providers[pk].provider || pk.slice(0, sep); }
  }
  return best;
}

function buildSpeedStats(cache) {
  const all = [];
  for (const s of Object.values(cache.sessions)) {
    if (s.type === "ledger") {
      for (const sp of (s.speeds || [])) all.push({ sp, s });
      continue;
    }
    // 普通会话：优先对话级 speeds（避免与会话级重复计数）；无对话时用会话级兑底
    let got = 0;
    for (const c of (s.conversations || [])) {
      for (const sp of (c.speeds || [])) { all.push({ sp, s }); got++; }
    }
    if (!got) {
      for (const sp of (s.speeds || [])) all.push({ sp, s });
    }
  }
  if (!all.length) return null;
  all.sort((a, b) => (a.sp.ts < b.sp.ts ? 1 : a.sp.ts > b.sp.ts ? -1 : 0));
  const recent = all.slice(0, 50);
  const wAvg = (arr) => {
    const out = arr.reduce((a, x) => a + (x.sp.out || 0), 0);
    const dur = arr.reduce((a, x) => a + (x.sp.durMs || 0), 0);
    return dur > 0 ? out / (dur / 1000) : 0;
  };
  const byModel = {};
  const byProvider = {};
  for (const { sp, s } of all) {
    if (!byModel[sp.model]) byModel[sp.model] = { out: 0, durMs: 0, txt: 0, n: 0 };
    byModel[sp.model].out += sp.out || 0;
    byModel[sp.model].durMs += sp.durMs || 0;
    byModel[sp.model].txt += (sp.out || 0) - (sp.reasoning || 0);
    byModel[sp.model].n++;
    const prov = sp.provider || provOfSession(s, sp.model);
    if (!prov) continue;
    if (!byProvider[prov]) byProvider[prov] = { out: 0, durMs: 0, txt: 0, n: 0, models: {} };
    byProvider[prov].out += sp.out || 0;
    byProvider[prov].durMs += sp.durMs || 0;
    byProvider[prov].txt += (sp.out || 0) - (sp.reasoning || 0);
    byProvider[prov].n++;
    const mm = sp.model || "unknown";
    if (!byProvider[prov].models[mm]) byProvider[prov].models[mm] = { out: 0, durMs: 0, txt: 0, n: 0 };
    byProvider[prov].models[mm].out += sp.out || 0;
    byProvider[prov].models[mm].durMs += sp.durMs || 0;
    byProvider[prov].models[mm].txt += (sp.out || 0) - (sp.reasoning || 0);
    byProvider[prov].models[mm].n++;
  }
  const modelStats = Object.entries(byModel)
    .map(([model, v]) => ({ model, n: v.n, tps: Math.round(v.out / (v.durMs / 1000)), textTps: Math.round(v.txt / (v.durMs / 1000)) }))
    .sort((a, b) => b.n - a.n);
  const providerStats = Object.entries(byProvider)
    .map(([provider, v]) => ({
      provider, n: v.n, tps: Math.round(v.out / (v.durMs / 1000)), textTps: Math.round(v.txt / (v.durMs / 1000)),
      models: Object.entries(v.models)
        .map(([model, mv]) => ({ model, n: mv.n, tps: Math.round(mv.out / (mv.durMs / 1000)), textTps: Math.round(mv.txt / (mv.durMs / 1000)) }))
        .sort((a, b) => b.n - a.n)
    }))
    .sort((a, b) => b.n - a.n);
  // ── 最近一小时：ts 距今 3600s 内的调用加权平均 ──
  const hourCut = Date.now() - 3600000;
  const hour = all.filter((x) => {
    const t = new Date(x.sp.ts).getTime();
    return !isNaN(t) && t >= hourCut;
  });
  const last = all[0];
  return {
    last: last ? { ts: last.sp.ts, model: last.sp.model, provider: last.sp.provider || provOfSession(last.s, last.sp.model), tps: last.sp.tps, textTps: last.sp.textTps, out: last.sp.out, durMs: last.sp.durMs } : null,
    avgTps: Math.round(wAvg(all)),
    avgTextTps: Math.round(all.reduce((a, x) => a + ((x.sp.out || 0) - (x.sp.reasoning || 0)), 0) / (all.reduce((a, x) => a + (x.sp.durMs || 0), 0) / 1000)),
    recentTps: Math.round(wAvg(recent)),
    hourTps: hour.length ? Math.round(wAvg(hour)) : 0,
    hourCount: hour.length,
    count: all.length,
    modelStats,
    providerStats
  };
}

// ─── 预测：历史小时分布 + 实时占比 ───
function computePrediction(cache, dailyGlobal) {
  const days = Object.keys(dailyGlobal).sort();
  if (days.length < 2) return null;

  const values = days.map(d => dailyGlobal[d]);
  const dailyAvg = Math.round(values.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, values.length));

  // ── 历史小时分布（排除今天） ──
  const cnToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const hourTotals = new Array(24).fill(0);
  let histDays = 0;
  for (const s of Object.values(cache.sessions)) {
    const hb = s.hourlyBreakdown || {};
    for (const [day, hours] of Object.entries(hb)) {
      if (day === cnToday) continue;
      let hasData = false;
      for (const [h, v] of Object.entries(hours)) {
        hourTotals[parseInt(h, 10)] += v.totalTokens || 0;
        hasData = true;
      }
      if (hasData) histDays++;
    }
  }
  const histTotal = hourTotals.reduce((a, b) => a + b, 0);
  let cumulativePct = null;
  if (histDays >= 3 && histTotal > 0) {
    cumulativePct = new Array(24);
    let running = 0;
    for (let h = 0; h < 24; h++) {
      running += hourTotals[h] / histTotal;
      cumulativePct[h] = running;
    }
  }

  // ── 本月已用 ──
  const monthPrefix = cnToday.slice(0, 7);
  let monthToDate = 0;
  for (const [d, v] of Object.entries(dailyGlobal)) {
    if (d.startsWith(monthPrefix)) monthToDate += v;
  }

  // ── 距月底 ──
  const now = new Date();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = lastDayOfMonth - now.getDate();

  return {
    dailyAvg,
    cumulativePct,
    monthToDate,
    daysLeftInMonth,
    projectedMonthEnd: Math.round(monthToDate + dailyAvg * daysLeftInMonth),
  };
}

// ─── 独立历史归档（usage-archive.json）───
// 核心 usage-ledger 是 5000 条环形缓冲，满了会挤掉最旧记录；
// 插件把账本记录按 requestId 去重归档到这里，统计从归档构建，账本丢数据不影响历史。
// 内部数据文件，紧凑存储（不带缩进）；原子写（tmp + rename）防半截写入。
function loadArchive(p, log) {
  let raw;
  try { raw = readTextFile(p); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    if (log) log.warn("[token-tracker] archive read failed:", e.code || "", e.message);
    return null;
  }
  try { return JSON.parse(raw); }
  catch (e) {
    if (log) log.warn("[token-tracker] archive parse failed:", p, e.message);
    // 保留损坏文件供人工恢复，下次扫描重新播种
    try { fs.renameSync(p, p + ".corrupt-" + Date.now()); } catch {}
    return null;
  }
}

function saveArchive(p, data, log) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    if (log) log.warn("[token-tracker] saveArchive failed:", p, e.message);
    return false;
  }
}

// 账本 entry → 归档条目（短键紧凑存储；type 聚合时再派生，不落盘）
function entryToArchive(e) {
  const u = e.usage || {};
  const inp = typeof u.input === "object" ? (u.input.totalTokens || 0) : (u.input || 0);
  const out = typeof u.output === "object" ? (u.output.totalTokens || 0) : (u.output || 0);
  const cr = u.cache?.readTokens || u.cacheRead || 0;
  const cw = u.cache?.writeTokens || u.cacheWrite || 0;
  const tot = u.totalTokens || (inp + out + cr);
  const cost = e.usage?.costTotal || e.usage?.cost?.total || 0;
  return {
    t: e.startedAt || "", e: e.endedAt || "", d: e.durationMs || 0,
    a: e.attribution?.agentId || "unknown",
    m: e.model?.modelId || "unknown", p: e.model?.provider || "",
    i: inp, o: out, c: cr, cw, tot, cost,
    sub: e.source?.subsystem || "", k: e.attribution?.kind || "",
    sf: e.source?.surface || "", ct: e.attribution?.conversationType || ""
  };
}

// 归档条目 → 账本 entry 形状（供 scanLedger 的聚合循环复用同一套派生逻辑）
function archiveToEntry(r) {
  return {
    startedAt: r.t || null,
    endedAt: r.e || null,
    durationMs: r.d || 0,
    model: { provider: r.p || "", modelId: r.m || "unknown" },
    attribution: { agentId: r.a || "unknown", kind: r.k || "", conversationType: r.ct || "" },
    source: { subsystem: r.sub || "", surface: r.sf || "" },
    usage: {
      input: { totalTokens: r.i || 0 },
      output: { totalTokens: r.o || 0 },
      cache: { readTokens: r.c || 0, writeTokens: r.cw || 0 },
      totalTokens: r.tot || 0,
      costTotal: r.cost || 0
    }
  };
}

function loadCache(p, log) {
  let raw;
  try { raw = readTextFile(p); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    if (log) log.warn("[token-tracker] cache read failed:", e.code || "", e.message);
    return null;
  }
  try { return JSON.parse(raw); }
  catch (e) {
    if (log) log.warn("[token-tracker] cache parse failed (corrupted file?):", p, e.message);
    return null;
  }
}

function saveCache(p, data, log) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    if (log) log.warn("[token-tracker] saveCache failed:", p, e.message);
    return false;
  }
}
