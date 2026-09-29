import { resolveHanaHome, readTextFile } from "./services/platform.js";
import fs from "node:fs";
import path from "node:path";
import { collectBalances } from "./services/balance.js";
import { createSettingsService } from "./services/settings.js";
import { loadSqliteDriver, createSqliteCacheStore } from "./services/cache-store.js";
import { openDsUsageStore } from "./services/ds-usage-store.js";
import { createDsUsageService, recentMonths } from "./services/ds-usage-service.js";
import { createJsonJournalStore } from "./services/json-journal-store.js";
import { openArchiveStore } from "./services/archive-store.js";
import { writeFileAtomic, renameToBackup } from "./services/jsonl-log.js";

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
    // ── DeepSeek 官网用量（platform.deepseek.com 官方账单）──
    // token 由 ds-token-source 去内置浏览器的磁盘存储里找，只留在内存、不落盘；
    // 拉回来的按天用量与消费按行落进 SQLite，避免整文件反复擦写（这个 App 的老毛病）。
    const dsStore = openDsUsageStore({ file: path.join(dataDir, "ds-usage.sqlite"), log });
    const dsUsage = createDsUsageService({ store: dsStore, log });
    this.register(() => { try { dsStore?.close?.(); } catch {} });
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
    // 介质优先按行存进 SQLite（一次只写变化的行）；拿不到驱动就用追加式 JSON 日志，
    // 主文件仍是 token-cache.json，同样只追加变化会话，不再每次整库重写。
    const DatabaseSync = loadSqliteDriver();
    let store = null;
    let usingSqlite = false;
    if (DatabaseSync) {
      try {
        store = createSqliteCacheStore({ DatabaseSync, file: path.join(path.dirname(cachePath), "cache.sqlite"), log });
        usingSqlite = true;
      } catch (e) {
        log.warn("[token-tracker] sqlite 缓存不可用，退回 JSON 追加日志：", e.message);
        store = null;
      }
    }
    if (!store) store = createJsonJournalStore({ file: cachePath, log });
    let old = store.load();
    if (!old && usingSqlite) {
      old = loadCache(cachePath, log);
      if (old) {
        // 首次把旧 JSON 快照搬进 SQLite：先写一份自洽的整份快照（含从追加日志/meta 合并回来的
        // 最新态）再改名留底，随后清理 .journal / .meta 边车，避免日后降级复活 stale 数据。
        // 备份命名走 renameToBackup：已存在 token-cache.json.imported 时绝不删除，改用带时间戳的新名。
        try {
          writeFileAtomic(cachePath, JSON.stringify(old));
          const dest = renameToBackup(cachePath, ".imported");
          fs.rmSync(cachePath + ".journal", { force: true });
          fs.rmSync(cachePath + ".meta", { force: true });
          log.info("[token-tracker] 旧 JSON 快照已改名留底：" + path.basename(dest));
        } catch (e) {
          log.warn("[token-tracker] 旧 JSON 快照改名失败：", e.message);
        }
      }
    }

    // 把缓存放进 shared.data，作为下一轮扫描的增量基准。
    // 少了这一步，第一轮扫描又是从空白开始（文件全量重解析 + 账本重建 + 裁剪重跑）。
    if (old && old.sessions && Object.keys(old.sessions).length) shared.data = old;

    // 落盘调度：变化只标脏（见 createPersistScheduler），退出时再刷一次。
    // 计数从上一份缓存里续上，“今日累计”跟重启前的接得起。
    // 即使会话为空（load 返回 null），meta 仍可通过 readMeta() 读回，不让计数被静默清零。
    const initialPersist = (old && old.persist)
      || (typeof store.readMeta === "function" ? store.readMeta()?.persist : null)
      || null;
    const persist = createPersistScheduler({ cachePath, log, getData: () => shared.data, store, initial: initialPersist });
    shared.persist = persist;
    this.register(() => { try { persist.stop(); } catch (e) { log.warn("[token-tracker] final flush failed:", e.message); } });

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
        // 落盘统计（第 0 步的可观测性）：写入次数、累计字节、上次原因与耗时、今日累计
        persist: shared.persist?.stats || cacheData?.persist || null,
        ready: !!shared.ready
      };
    });

    // 单会话最近一次生成速度（输入栏状态位用）。会话采样按文件名匹配：调用方给的是稳定 sessionId
    // 对应的真实会话文件路径。
    //
    // 口径（三件事同时成立，回给调用方的才是这个数）：
    //   1) 分母 = 本条回复落笔 − 上一条记录落笔。上一条只可能是「用户发出的消息」或「工具结果」，
    //      所以工具执行时间不进分母；用户发送之前的阅读与思考也不进分母（消息是发送那一刻才落笔的）。
    //   2) 每次请求在开始吐字之前还有一段固定开销：排队 + 预填充 + 首字等待 + 网络。这段不用单独估，
    //      它就是拟合直线的截距——一次最小二乘同时给出斜率（速度）和截距（开销）。
    //   3) 只取这个会话、当前模型、窗口够长的采样，从新到旧最多 8 条；换了模型就只用新模型那段。
    //      样本少或拟合站不住时，按 1 秒固定起跑开销直接除，保证有数可看。
    regHandler("token-tracker.speed", async (payload) => {
      const cacheData = shared.data;
      const wantFile = payload?.sessionPath ? path.basename(String(payload.sessionPath)) : "";
      const samples = [];
      if (wantFile && cacheData?.sessions) {
        for (const session of Object.values(cacheData.sessions)) {
          if (!session || session.type === "ledger") continue;
          if (session.fileName !== wantFile) continue;
          // 对话级与会话级是同一批采样的两份存法，取其一，避免重复计入校正样本。
          let got = 0;
          for (const conv of (session.conversations || [])) {
            for (const s of (conv.speeds || [])) if (s) { samples.push(s); got++; }
          }
          if (!got) for (const s of (session.speeds || [])) if (s) samples.push(s);
        }
      }
      if (!samples.length) {
        // 兜底：会话还没采到（例如应用重载后当前会话不会重发 session_created），给全机最近的一条采样，
        // 并把 scope 说清。兜底值不做校正，由调用方标的。
        const last = cacheData?._speedStats?.last;
        if (!last || !last.tps) return null;
        return { scope: "global", ...shapeSample(last) };
      }

      // 当前模型 = 最近一条采样的模型：换了模型就从新模型重新起算。
      const newest = samples.reduce((a, s) => (!a || tsNum(s.ts) > tsNum(a.ts) ? s : a));
      const modelKey = speedModelKey(newest);

      // 取样：本会话、当前模型、窗口够长，从新到旧最多 8 条。
      const picked = samples
        .filter((s) => speedModelKey(s) === modelKey
          && tsNum(s.durMs) >= SPEED_MIN_DUR_MS
          && tsNum(s.durMs) < SPEED_MAX_DUR_MS
          && (s.out || 0) >= SPEED_MIN_OUT)
        .sort((a, b) => tsNum(b.ts) - tsNum(a.ts))
        .slice(0, SPEED_SAMPLE_LIMIT);
      // 一条窗口够长的采样都没有：连 1 秒起跑都扣不动，没有数可给。
      if (!picked.length) return null;

      const est = estimateSpeed(picked);
      if (!est || !(est.tps > 0)) return null;

      return {
        scope: "session",
        ...shapeSample(newest),
        tps: Math.round(est.tps),
        mode: est.mode,
        n: picked.length,
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

    // 官网用量：默认最近 1 个月，可传 count（最多 36）或显式 months 列表。
    // force=1 忽略缓存强制重拉；否则历史月冻结、当月有存活期。
    regHandler("token-tracker.ds-usage", async (payload) => {
      const p = payload || {};
      const count = Number(p.count) > 0 ? Math.min(36, Math.floor(Number(p.count))) : 1;
      const months = Array.isArray(p.months) && p.months.length ? p.months : recentMonths(count);
      const r = await dsUsage.getUsage({ months, force: !!p.force });
      // 出网前只留聚合所需字段：token 与磁盘路径都不外泄。
      return {
        hasToken: r.hasToken,
        tokenError: r.tokenError,
        updatedAt: r.updatedAt,
        months: r.months.map((m) => ({
          ym: m.ym,
          fromCache: m.fromCache,
          currency: m.currency,
          error: m.error,
          usageRows: m.usageRows,
          costRows: m.costRows,
        })),
      };
    });

    this.register(() => { for (const un of busUnsubs) { try { un(); } catch {} } });

    log.info("token-tracker loaded (interval " + interval + "ms)");
  }
}

// 速度采样统一成回包形状（会话采样与全机兜底采样字段名略有差别）。
function shapeSample(sample) {
  return {
    tps: Number(sample?.tps) || 0,
    textTps: sample?.textTps ?? null,
    out: sample?.out ?? null,
    durMs: sample?.durMs ?? null,
    model: sample?.model ?? null,
    at: sample?.ts ?? null,
    estimated: true
  };
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
  // 旧缓存：优先用上一轮的扫描结果（它来自 SQLite 缓存，启动时已由 store.load() 播下）。
  // 以前这里只读 token-cache.json —— 那份文件在迁移到 SQLite 之后已经不存在，于是每一轮都
  // 从空白开始：文件全量重解析、账本每轮重建、5 天裁剪每轮重跑，一次落盘要写上千行。
  const old = (shared.data && shared.data.sessions && Object.keys(shared.data.sessions).length)
    ? shared.data
    : loadCache(shared.cachePath, log);
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
  const _ledgerChanged = scanLedger(cache, log, full, shared);
  changed = _ledgerChanged || changed;
  // 按行落盘时要显式补报“变了但 mtime/size 看不出来”的键。
  // 账本会话的 mtime/size 恒为 0，所以账本一重建就整批补报。
  const _forcedKeys = [];
  if (_ledgerChanged) {
    for (const _key of Object.keys(cache.sessions)) if (_key.startsWith("__ledger__")) _forcedKeys.push(_key);
  }

  // 保留最近5天的对话（同样就地改记录、不动 mtime/size → 补报被裁的键）
  var cutoff5d = Date.now() - 5 * 86400000;
  for (const _key of Object.keys(cache.sessions)) {
    const _s = cache.sessions[_key];
    if (_s.conversations && _s.conversations.length) {
      var _before = _s.conversations.length;
      _s.conversations = _s.conversations.filter(function(c){ return new Date(c.time).getTime() >= cutoff5d; });
      if (_s.conversations.length !== _before) { changed = true; _forcedKeys.push(_key); }
    }
  }

  if (changed) {
    cache.lastScan = new Date().toISOString();
    const dailyGlobal = buildDailyGlobal(cache);
    cache.prediction = computePrediction(cache, dailyGlobal);
    cache._speedStats = buildSpeedStats(cache);
    // 标脏而不是立刻写：攒批由调度器决定（没有调度器时才直接落盘）
    if (shared.persist) shared.persist.markDirty(_forcedKeys);
    else saveCache(shared.cachePath, cache, log);
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
          // 不存对话正文与工具参数：用量统计只需要下面这几个数字（正文本来就在会话文件里，
          // 且界面上没有任何地方读它）。
          conv = { time: ts, model: null, provider: null, totalTokens: 0, msgCount: 0, inTokens: 0, outTokens: 0 };
        }
        if (m.role === "assistant" && conv) {
          const _f = m.stopReason === "error" || m.isError === true || !!m.errorMessage;
          if (!_f) {
            conv.msgCount++;
            if (!conv.model) { conv.model = m.model; conv.provider = m.provider; }
            if (m.usage) {
              var _tot = m.usage.totalTokens || ((m.usage.input||0)+(m.usage.output||0));
              conv.totalTokens += _tot;
              // 输入 = 未命中缓存的输入 + 命中缓存的输入；加上输出正好等于总数（逐条实测成立）
              conv.inTokens += tokVal(m.usage.input) + tokVal(m.usage.cacheRead);
              conv.outTokens += tokVal(m.usage.output);
            }
          }
          if (Array.isArray(m.content)) {
            for (var _i=0; _i<m.content.length; _i++) {
              var _it = m.content[_i];
              if (!_it) continue;
              if (_it.type === "toolCall") {
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
              }
            }
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
// 采样里的时间戳是 ISO 字符串，直接 Number() 会得到 NaN，比较全都为 false。
// 必须统一走这里，否则「取最新一条」会变成「取第一条」。
function tsNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Date.parse(String(v || ""));
  return Number.isFinite(n) ? n : 0;
}

// ─── 生成速度：取样与估计 ───
// 口径见 token-tracker.speed：本会话、当前模型、窗口够长的采样，从新到旧最多 8 条，拟合一次。
// 拟合站不住（样本少、输出量太接近、结果飞出合理区间）时，按 1 秒固定起跑开销直接除，总有数。
const SPEED_SAMPLE_LIMIT = 8;
const SPEED_MIN_DUR_MS = 6000;        // 窗口下限：再短的话起跑开销占比太大，估不出速度
const SPEED_MAX_DUR_MS = 120000;      // 上限：超过两分钟的采样多半混进了空转
const SPEED_MIN_OUT = 200;            // 输出下限：太小的话分母几乎全是开销
const SPEED_FIXED_OVERHEAD_MS = 1000; // 估不出起跑开销时的固定值
const SPEED_MIN_TPS = 20;             // 合理区间：本机各模型实测约 20~550，明显失真的不端出来
const SPEED_MAX_TPS = 1500;

// 采样属于哪个模型。新记录自带 provider；没有 provider 的旧记录只按 model 归。
function speedModelKey(sample) {
  const model = String(sample?.model || "?");
  const provider = String(sample?.provider || "");
  return provider ? provider + "/" + model : model;
}

// 对最多 8 条采样做一次最小二乘：Δt ≈ t0 + 输出/v —— 速度 = 1/斜率，截距就是起跑开销。
// 拟合不成立时退回「按固定起跑开销直接除」的口径；两条路都不成立才没有数。
function estimateSpeed(picked) {
  const byFixedOverhead = () => {
    const out = picked.reduce((a, s) => a + (s.out || 0), 0);
    const dur = picked.reduce((a, s) => a + tsNum(s.durMs) - SPEED_FIXED_OVERHEAD_MS, 0);
    if (!(dur > 0)) return null;
    const tps = out / (dur / 1000);
    return tps >= SPEED_MIN_TPS && tps <= SPEED_MAX_TPS ? { tps, mode: "fixed" } : null;
  };
  if (picked.length < 2) return byFixedOverhead();
  const n = picked.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of picked) {
    const x = s.out || 0, y = tsNum(s.durMs) / 1000;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return byFixedOverhead();
  // 输出量彼此太接近时斜率没有信息量（截距会变负、速度会飞），先看样本本身的跨度。
  const outs = picked.map((s) => s.out || 0);
  const omax = Math.max(...outs), omin = Math.min(...outs);
  if (!(omin > 0) || omax / omin < 2) return byFixedOverhead();
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  if (!(b > 0) || !(a >= 0)) return byFixedOverhead();
  // 拟合得有一半以上的变化被这条线解释（R² ≥ 0.5），否则斜率就是噪声，直接飞的那种。
  // 不过关不算“没数”，只是换用固定开销口径：数照样有，只是稳。
  let ss = 0, rr = 0;
  const my = sy / n;
  for (const s of picked) {
    const x = s.out || 0, y = tsNum(s.durMs) / 1000;
    ss += (y - my) ** 2;
    rr += (y - (a + b * x)) ** 2;
  }
  const r2 = ss > 0 ? 1 - rr / ss : 0;
  if (r2 < 0.5) return byFixedOverhead();
  const tps = 1 / b;
  if (!(tps >= SPEED_MIN_TPS && tps <= SPEED_MAX_TPS)) return byFixedOverhead();
  return { tps, mode: "fit", t0: a * 1000, r2 };
}

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
  all.sort((a, b) => tsNum(b.sp.ts) - tsNum(a.sp.ts));
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
// 内部数据文件；条目紧凑存储（不带缩进）。历史只追加：新增条目写进 usage-archive.jsonl，
// 只有一次性迁移用 tmp + rename 原子落地，之后不再整份重写历史。
// 读：以追加日志（usage-archive.jsonl）为准，旧版单文件首次读取时一次性安全迁移。
// 返回对象仍是 { version, updatedAt, entries } 形状；内部句柄挂在不可枚举的 _store 上，
// 供 saveArchive 做增量追加。
function loadArchive(p, log) {
  const store = openArchiveStore(p, log);
  const data = { version: ARCHIVE_VERSION, entries: store.entries };
  Object.defineProperty(data, "_store", { value: store, enumerable: false, configurable: true });
  Object.defineProperty(data, "updatedAt", {
    get: () => store.updatedAt,
    set: (v) => { store.updatedAt = v; },
    enumerable: true, configurable: true,
  });
  return data;
}

// 写：只追加新增条目（按 requestId 去重），不再整份重写历史。
function saveArchive(p, data, log) {
  const store = data && data._store;
  if (store) {
    try {
      store.appendPending();
      return true;
    } catch (e) {
      if (log) log.warn("[token-tracker] saveArchive failed:", p, e.message);
      return false;
    }
  }
  // 兜底：没有日志句柄时按老办法整写一份（正常启动路径不会走到）。
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

// ─── 落盘调度：这份缓存是“派生数据” ───
// 它唯一的用途是让下次启动少扫一遍（全量重扫实测约 8 秒），所以“新”没有任何价值；
// 而每次模型调用都整块重写一遍六十多 MiB 是纯浪费（实测一次重写里真正的变化只有 6 KB）。
// 于是：变化只标脏，攒到触发条件才原子写一次；崩溃最多丢掉一个攒批窗口的增量，
// 代价只是那个窗口里动过的文件下次重新解析（增量扫描按 mtime，不是全量 8 秒）。
const PERSIST_FLUSH_MS = 5 * 60 * 1000;

export function createPersistScheduler({ cachePath, log, getData, store = null, flushMs = PERSIST_FLUSH_MS, initial = null }) {
  const stats = {
    writes: 0, bytes: 0, lastAt: null, lastReason: null,
    lastMs: 0, lastBytes: 0, day: null, dayBytes: 0, dayWrites: 0,
    lastRows: 0, lastScope: null, lastDetail: null,
  };
  // 上一次运行写进缓存里的计数：续上它，避免“今日累计”被一次重载清零。
  if (initial && typeof initial === "object") {
    for (const key of Object.keys(stats)) {
      if (initial[key] !== undefined && initial[key] !== null) stats[key] = initial[key];
    }
  }
  let dirty = false;
  let timer = null;
  let flushing = false;
  let stopped = false;
  const forced = new Set(); // 调用方明确知道变了、但 mtime/size 看不出来的键
  let allDirty = false;      // 整库重写（首次导入、全量重扫）

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  function arm(reason) {
    if (stopped || timer) return;
    timer = setTimeout(() => flush(reason), flushMs);
    timer.unref?.();
  }

  function flush(reason) {
    if (flushing) return false;
    const data = getData?.();
    if (!data || typeof data !== "object") return false;
    if (!dirty) return false; // 没变化就不写盘：空转零写入
    flushing = true;
    const started = Date.now();
    try {
      const _now = new Date();
      const day = _now.getFullYear() + "-" + String(_now.getMonth() + 1).padStart(2, "0") + "-" + String(_now.getDate()).padStart(2, "0");
      if (stats.day !== day) { stats.day = day; stats.dayBytes = 0; stats.dayWrites = 0; }
      const snapshot = () => ({
        writes: stats.writes, bytes: stats.bytes, lastAt: stats.lastAt,
        lastReason: stats.lastReason, lastMs: stats.lastMs,
        lastBytes: stats.lastBytes, day: stats.day, dayBytes: stats.dayBytes,
        dayWrites: stats.dayWrites,
        lastRows: stats.lastRows, lastScope: stats.lastScope, lastDetail: stats.lastDetail,
      });
      let saved;
      if (store) {
        // 按行存：只写这一轮真的变过的会话，外加调用方补报的键。
        saved = store.save(data, [...forced], allDirty);
      } else {
        // JSON 退路：计数和正文在同一份文件里，只能先写后更新，计数会慢一拍
        //（界面上显示的计数读的是内存态，不受这一拍影响）。
        data.persist = snapshot();
        const text = JSON.stringify(data); // 紧凑：两个空格缩进会白吃约 22% 的体积
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = cachePath + ".tmp";
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, cachePath); // 原子替换：崩了也不会留半截文件
        saved = { rows: 0, bytes: Buffer.byteLength(text) };
      }
      const bytes = saved.bytes;
      stats.writes += 1;
      stats.bytes += bytes;
      stats.lastAt = new Date(started).toISOString();
      stats.lastReason = reason;
      stats.lastMs = Date.now() - started;
      stats.lastBytes = bytes;
      stats.dayBytes += bytes;
      stats.dayWrites += 1;
      stats.lastRows = saved.rows || 0;
      stats.lastScope = saved.scope || "JSON";
      stats.lastDetail = saved.why
        ? saved.why.stale + " 行因文件变动 · " + saved.why.forced + " 行补报 · " + saved.why.gone + " 行移除"
        : null;
      data.persist = snapshot();
      // meta 里写的是“这次写完之后”的真实计数，所以重启读回来不会慢一拍。
      if (store) store.saveMeta(data);
      forced.clear();
      allDirty = false;
      dirty = false;
      log.info("[token-tracker] cache flushed (" + reason + "): " + (store ? saved.rows + " 行 [" + stats.lastScope + "] / " : "") + (bytes / 1024).toFixed(0) + " KiB in " + stats.lastMs + " ms, writes=" + stats.writes + ", today=" + stats.dayWrites + " 次 / " + (stats.dayBytes / 1048576).toFixed(2) + " MiB");
      return true;
    } catch (e) {
      // 写失败不清 dirty，等下一次触发重试；但必须留痕，不能默默吞掉。
      log.warn("[token-tracker] cache flush failed:", e.code || "", e.message);
      return false;
    } finally {
      flushing = false;
      clearTimer();
      // 写失败时 dirty 还在，重新起一个重试窗口；成功后 dirty 已清，不会重排。
      if (dirty) arm("重试");
    }
  }

  return {
    stats,
    markDirty(keys) {
      dirty = true;
      if (keys) for (const key of keys) forced.add(key);
      arm("定时");
    },
    markAllDirty() { dirty = true; allDirty = true; arm("定时"); },
    flushNow(reason) { clearTimer(); return flush(reason); },
    stop() { stopped = true; clearTimer(); const ok = flush("退出"); return ok; },
  };
}

// 读整份缓存（基线快照 + 追加日志重放）。调用方语义不变：返回完整缓存对象或 null。
function loadCache(p, log) {
  try {
    return createJsonJournalStore({ file: p, log }).load();
  } catch (e) {
    if (log) log.warn("[token-tracker] cache read failed:", e.code || "", e.message);
    return null;
  }
}

// 显式整份落盘：把当前态压成自洽基线并清空日志（原子写）。调用方语义不变。
function saveCache(p, data, log) {
  try {
    return createJsonJournalStore({ file: p, log }).compact(data);
  } catch (e) {
    if (log) log.warn("[token-tracker] saveCache failed:", e.code || "", e.message);
    return false;
  }
}
