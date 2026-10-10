import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventStreams } from "./lib/event-stream.mjs";
import { EventEmitter } from "node:events";
import { LocalClient } from "./lib/local-client.mjs";
import { createDisplayUnitsReader } from "./lib/display-units.mjs";
import { SessionCacheStatus } from "./lib/session-cache.mjs";
import { createInputStatusPrefs } from "./lib/input-status-prefs.mjs";
import { shapeSnapshot, shapeBalances } from "./lib/snapshot-service.mjs";
import { okResponse, errResponse } from "./lib/api-errors.mjs";
// 明细导出：CSV 的拼装在引擎侧（前端分页后手里只有一页），mock 预览用同一份拼装器与同一份 mock 行。
import { buildDetailsCSV } from "./runtime/engine/services/details-csv.js";
import { mockDashboardRows } from "./lib/mock-data.mjs";
// 更新说明：内容来自 GitHub Release，不硬编码进界面（见 lib/update-check.mjs 顶部的来源说明）。
import { createUpdateCheck, displayVersion } from "./lib/update-check.mjs";

export const APP_ID = "token-tracker-app";



function jsonResponse(c, body, status = 200) {
  return c.json(body, status);
}

function textResponse(c, text, status = 200) {
  return c.text(text, status);
}


export function apply(ctx, { clientFactory = options => new LocalClient(options), updateCheckFactory = createUpdateCheck } = {}) {
  const log = (level, ...args) => {
    const sink = level === "warn" ? "warn" : level === "error" ? "error" : "log";
    try { ctx?.logger?.[level]?.(...args); } catch {}
    try { console[sink](`[${APP_ID}]`, ...args); } catch {}
  };

  log("info", "apply：v2 Token 用量 App 启动");

  if (!ctx || typeof ctx.routes?.register !== "function") {
    log("error", "ctx.routes.register 不可用——宿主低于 0.978.0？");
    return () => {};
  }

  const dataDir = typeof ctx.dataDir === "string" && ctx.dataDir ? ctx.dataDir : null;
  if (!dataDir) {
    log("warn", "ctx.dataDir 缺失——settings 等本地持久化将不可用");
  }

  const rootReady = dataDir ? mkdir(dataDir, { recursive: true }).catch((e) => {
    log("error", `dataDir 创建失败：${e?.message || e}`);
    return undefined;
  }) : Promise.resolve();

  // 输入栏状态位卡片的四个开关（card/cache/speed/ttft）：真相落在 app 数据目录下的 input-status.json。
  // 每次读取都反映落盘的最新值（getPrefs 是个即时读盘的口，不在启动时读一次就定格）。
  const inputStatusPrefs = createInputStatusPrefs({ file: dataDir ? path.join(dataDir, "input-status.json") : null, log });

  // 数字单位（中文万/亿 ↔ 英文 K/M/B）：真相在引擎写的 app-settings.json（设置页与显示设置菜单改的都是它），
  // 主进程只现读那一小段 —— 输入栏状态位的文字要按它写。路径拼贴与解析都在 lib/display-units.mjs，
  // 那里能测到「读的就是引擎写的那份」。
  const readDisplayUnits = createDisplayUnitsReader({ dataDir });

  const defaultMock = process.env.TOKEN_TRACKER_MOCK === "1";
  const busClient = clientFactory({ ctx, log, defaultMock });

  // ── 首字响应时间（TTFT）──
  // 口径：请求即将发出（provider/before-request）→ 收到响应（provider/after-response）。
  // 两处都只取一个时间戳，不改请求也不读内容。before-request 是决策钩子，宿主会等它返回，
  // 所以回调里绝不能做 IO —— 任何耗时都等于给每一次生成加一道闸。
  // 同一会话的请求是串行的，按会话文件名排队取起点即可，不需要请求 id。
  // 只存内存：这是实时测出来的值，重启后从下一次请求重新开始。
  // 位置很关键：扫描引擎跑在独立子进程里（ctx.runtime.start），它的 ctx 没有 hooks，
  // 所以 TTFT 只能在这个进程里测，再注入给输入栏与实时页两处。
  const ttft = {
    pending: new Map(),   // 会话文件名 → 起点毫秒（FIFO）
    rings: new Map(),     // 会话文件名 → 最近几次首字耗时（毫秒）
    last: 0,              // 全机最近一次（实时页用）
    KEEP: 10,
    STALE_MS: 300000,     // 超过 5 分钟没等到响应的起点作废
  };
  const ttftDisposers = [];
  const ttftKeyOf = (sessionPath) => (sessionPath ? path.basename(String(sessionPath)) : "");
  const ttftFor = (sessionPath) => {
    const ring = ttft.rings.get(ttftKeyOf(sessionPath));
    return Array.isArray(ring) && ring.length ? ring[ring.length - 1] : 0;
  };
  const ttftAverage = () => {
    let sum = 0, n = 0;
    for (const ring of ttft.rings.values()) for (const v of ring) { sum += v; n++; }
    return n > 0 ? Math.round(sum / n) : 0;
  };
  try {
    const hooks = ctx.hooks;
    if (typeof hooks?.onDecision === "function" && typeof hooks?.on === "function") {
      const offDecision = hooks.onDecision("provider/before-request", (invocation) => {
        const key = ttftKeyOf(invocation?.session?.sessionPath);
        if (key) {
          const queue = ttft.pending.get(key) || [];
          queue.push(Date.now());
          if (queue.length > 8) queue.shift();
          ttft.pending.set(key, queue);
        }
        return undefined; // 不改动请求本身
      });
      const offEvent = hooks.on("provider/after-response", (event) => {
        const key = ttftKeyOf(event?.session?.sessionPath);
        if (!key) return;
        const queue = ttft.pending.get(key);
        if (!queue || !queue.length) return;
        const now = Date.now();
        while (queue.length && now - queue[0] > ttft.STALE_MS) queue.shift();
        if (!queue.length) { ttft.pending.delete(key); return; }
        const ms = now - queue.shift();
        if (!queue.length) ttft.pending.delete(key);
        if (!(ms > 0 && ms < ttft.STALE_MS)) return;
        const ring = ttft.rings.get(key) || [];
        ring.push(ms);
        if (ring.length > ttft.KEEP) ring.shift();
        ttft.rings.set(key, ring);
        ttft.last = ms;
        // 实时页不必等下一个轮询周期，让它在这一次计量后立刻重新拉一次快照。
        try { updateEmitter.emit("update", { type: "update" }); } catch {}
      });
      ttftDisposers.push(() => { try { offDecision?.(); } catch {} try { offEvent?.(); } catch {} });
      log("info", "首字响应时间：钩子已注册（provider/before-request + provider/after-response）");
    } else {
      log("warn", "首字响应时间不可用：ctx.hooks 未提供（宿主版本过低或权限未开）");
    }
  } catch (error) { log("warn", "注册首字钩子失败:", error?.message || error); }
  // 输入栏状态位：本会话缓存命中率 + 本会话最近一次生成速度（见 lib/session-cache.mjs）。
  // 速度走内置服务按真实会话文件路径取，拿不到就返回 null，界面显示“—”。
  // 速度来自引擎（子进程）；首字在这个进程里测。两半在这里合成一条回给输入栏。
  const speedQuery = async (sessionPath) => {
    const ttftMs = ttftFor(sessionPath);
    let sample = null;
    try { sample = (await busClient.request("token-tracker.speed", { sessionPath })) || null; } catch { sample = null; }
    if (sample) return ttftMs ? { ...sample, ttft: ttftMs } : sample;
    // 速度估不出来但有首字时，别把整个状态位丢掉：回一个只带首字的壳。
    return ttftMs ? { scope: "session", tps: 0, ttft: ttftMs } : null;
  };
  // 会话 id → 真实会话文件路径：向宿主一次性要对照表（scope:"all"，需 app/sessions.read）。
  // 只取 sessionId 与 path 两个字段做身份对齐，不读会话正文；失败时安静退化到全机兜底。
  const listSessions = async () => {
    try {
      const result = await ctx.bus.request("session:list", { scope: "all", lifecycle: "active" });
      const list = Array.isArray(result?.sessions) ? result.sessions : [];
      return list
        .map(s => ({ sessionId: s?.sessionId, path: s?.path }))
        .filter(s => typeof s.sessionId === "string" && s.sessionId && typeof s.path === "string" && s.path);
    } catch (e) {
      log("warn", `会话对照表获取失败（session:list）：${e?.message || e}`);
      return [];
    }
  };
  const sessionCache = new SessionCacheStatus({ bus: ctx.bus, inputStatus: ctx.inputStatus, log, speedQuery, listSessions, getPrefs: () => inputStatusPrefs.read(), getUnits: readDisplayUnits });
  const unsubSessionCache = sessionCache.start();

  const updateEmitter = new EventEmitter();
  updateEmitter.setMaxListeners(25);
  const streams = createEventStreams(updateEmitter);

  // ── 更新说明 ──
  // 当前版本只认包根的 manifest.json。release.ps1 已经把 manifest 定为唯一事实源
  // （tag 由它推出、发布门禁也校验它），package.json 里的 version 历史上跟它漂过，不参与。
  const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
  const readAppVersion = () => {
    try {
      const text = readFileSync(path.join(APP_ROOT, "manifest.json"), "utf8").replace(/^\uFEFF/, "");
      return String(JSON.parse(text)?.version || "");
    } catch (e) {
      log("warn", `manifest.json 读不到，版本号留空：${e?.message || e}`);
      return "";
    }
  };
  const appVersion = readAppVersion();
  // 出站只能走宿主的受控通道：v2 App 的子进程不开 --allow-net，裸 fetch 会被运行时拒掉，
  // 报出来还只是一句「fetch failed」。白名单在 manifest.json 顶层的 network.allowedHosts。
  const netFetch = typeof ctx?.network?.fetch === "function"
    ? (url, init) => ctx.network.fetch(url, init)
    : null;
  if (!netFetch) log("warn", "宿主没有给出站网络通道 ctx.network.fetch，更新检查会直说没网络能力");
  const updateCheck = updateCheckFactory({ dataDir, appVersion, log, fetchImpl: netFetch });
  // 已经推过的快照签名：只有影响「提不提醒」的东西变了，才值得再推一次给界面。
  let pushedSignature = updateCheck.signature();

  /** 看一眼有没有新版。内部按 TTL 节流，所以挂在扫描事件上随便调也不会把 GitHub 问爆。 */
  async function refreshNotice({ force = false } = {}) {
    let snap;
    try {
      snap = await updateCheck.check({ force });
    } catch (e) {
      log("warn", `更新说明检查失败：${e?.message || e}`);
      snap = updateCheck.snapshot();
    }
    const signature = updateCheck.signature(snap);
    if (signature !== pushedSignature) {
      pushedSignature = signature;
      updateEmitter.emit("update", { type: "update", updateNotice: snap });
    }
    return snap;
  }

  // Subscribe to this App's embedded service. No external plugin is required.
  const unsubscribeUpdates = busClient.subscribe("token-tracker.updated", (payload) => {
    updateEmitter.emit("update", { ...payload, type: "update" });
    // 扫描出新用量时顺手看一眼版本：这就是「扫描出有新版本就提醒」的触发点，不另起定时器。
    void refreshNotice();
  }, { mock: defaultMock });

  function isMock(c) {
    return c.req.query("mock") === "1" || defaultMock;
  }

  async function handleSnapshot(c) {
    try {
      const raw = await busClient.request("token-tracker.snapshot", {}, { mock: isMock(c) });
      // 首字响应时间在插件进程里测，快照是引擎给的：这里把两格补进去。
      const withTtft = { ...(raw || {}), realtime: { ...((raw && raw.realtime) || {}), lastTtft: ttft.last, avgTtft: ttftAverage() } };
      const snapshot = shapeSnapshot(withTtft);
      return jsonResponse(c, okResponse({ snapshot }));
    } catch (err) {
      log("error", "GET /snapshot error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "SNAPSHOT_FAILED", err?.message || "获取快照失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  async function handleDashboard(c) {
    const payload = {
      range: c.req.query("range") || "today",
      from: c.req.query("from") || "",
      to: c.req.query("to") || "",
      agent: c.req.query("agent") || "",
      model: c.req.query("model") || "",
      provider: c.req.query("provider") || "",
      type: c.req.query("type") || "",
      // 明细已服务端分页：页码/排序/门槛跟着一起发，否则每次拿到的都是第一页的默认排序。
      page: c.req.query("page") || "",
      pageSize: c.req.query("pageSize") || "",
      sortKey: c.req.query("sortKey") || "",
      order: c.req.query("order") || "",
      minTokens: c.req.query("minTokens") || "",
    };
    try {
      const raw = await busClient.request("token-tracker.dashboard", payload, { mock: isMock(c) });
      const dashboard = raw;
      return jsonResponse(c, okResponse({ dashboard }));
    } catch (err) {
      log("error", "GET /dashboard error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "DASHBOARD_FAILED", err?.message || "获取消费明细失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  // 明细导出：明细服务端分页之后，前端手里只有一页，而导出的语义是「当前筛选 + 当前排序下的全部行」，
  // 所以 CSV 只能由引擎拼好（约 1.5 MB，仍在上限内），这里只负责转发与保存。
  async function handleDetailsCsv(c) {
    const payload = {
      range: c.req.query("range") || "today",
      from: c.req.query("from") || "",
      to: c.req.query("to") || "",
      agent: c.req.query("agent") || "",
      model: c.req.query("model") || "",
      provider: c.req.query("provider") || "",
      type: c.req.query("type") || "",
      sortKey: c.req.query("sortKey") || "",
      order: c.req.query("order") || "",
      minTokens: c.req.query("minTokens") || "",
    };
    try {
      if (isMock(c)) {
        // mock 路径没有引擎：用同一份 mock 明细行、同一个 CSV 拼装器，别另写一套。
        return jsonResponse(c, okResponse({ csv: buildDetailsCSV(mockDashboardRows(payload.range || "today")) }));
      }
      const csv = await busClient.request("token-tracker.details.csv", payload);
      if (typeof csv !== "string") throw Object.assign(new Error("导出内容必须是引擎生成的 CSV 文本"), { code: "CSV_FAILED" });
      return jsonResponse(c, okResponse({ csv }));
    } catch (err) {
      log("error", "GET /details.csv error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "CSV_FAILED", err?.message || "导出失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  // 「点得开」：明细里的一行 → 这一轮的会话文件与逐次调用拆解。
  // sessionKey/seq 原样转给引擎（引擎只拿 sessionKey 索引缓存里的会话，不接受文件路径）。
  async function handleTurn(c) {
    const payload = {
      sessionKey: c.req.query("sessionKey") || "",
      seq: c.req.query("seq") || "",
    };
    if (isMock(c)) {
      // mock 没有引擎：预览里那一轮本来就没有会话文件。
      return jsonResponse(c, errResponse("NO_SESSION_FILE", "预览模式没有会话文件"));
    }
    try {
      const turn = await busClient.request("token-tracker.turn", payload);
      // 失败的两种形状（引擎的 ok:false、传输异常）都收成 errResponse —— 前端只认 error.code/message，
      // 平铺一个 ok:false 出去会让它退化成「请求失败 (200)」，真正的原因就丢了。
      if (!turn || turn.ok === false) {
        return jsonResponse(c, errResponse(turn?.code || "TURN_FAILED", turn?.message || "获取轮次详情失败"));
      }
      return jsonResponse(c, okResponse({ turn }));
    } catch (err) {
      log("error", "GET /turn error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "TURN_FAILED", err?.message || "获取轮次详情失败"), 503);
    }
  }

  // 只取「消费明细」这一块：界面翻页/换排序/换门槛时只重取这一块，不再把整份看板搬一遍。
  // range/筛选/分页排序门槛原样转给引擎；mock 路径没有引擎，details 给 null，让前端用它自己那套回落
  // （别在插件里另写一份明细计算）。
  async function handleDetails(c) {
    const payload = {
      range: c.req.query("range") || "today",
      from: c.req.query("from") || "",
      to: c.req.query("to") || "",
      agent: c.req.query("agent") || "",
      model: c.req.query("model") || "",
      provider: c.req.query("provider") || "",
      type: c.req.query("type") || "",
      page: c.req.query("page") || "",
      pageSize: c.req.query("pageSize") || "",
      sortKey: c.req.query("sortKey") || "",
      order: c.req.query("order") || "",
      minTokens: c.req.query("minTokens") || "",
    };
    if (isMock(c)) return jsonResponse(c, okResponse({ details: null }));
    try {
      const out = await busClient.request("token-tracker.details", payload);
      return jsonResponse(c, okResponse(out));
    } catch (err) {
      log("error", "GET /details error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "DETAILS_FAILED", err?.message || "获取消费明细失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  async function handleBalance(c) {
    try {
      const raw = await busClient.request("token-tracker.balance", {}, { mock: isMock(c) });
      const balances = shapeBalances(raw);
      return jsonResponse(c, okResponse({ balances }));
    } catch (err) {
      log("error", "GET /balance error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "BALANCE_FAILED", err?.message || "获取余额失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  async function handleDsUsage(c) {
    const payload = {
      days: Number(c.req.query("days")) || undefined,
      // from 可能是 0（“全部历史”不设下限），用 0 兜底会把它当成没传，所以按 undefined 判断。
      from: c.req.query("from") !== undefined ? Number(c.req.query("from")) : undefined,
      to: c.req.query("to") !== undefined ? Number(c.req.query("to")) : undefined,
      force: c.req.query("force") === "1",
      withHistory: c.req.query("history") !== "0",
    };
    try {
      const raw = await busClient.request("token-tracker.ds-usage", payload, { mock: isMock(c) });
      return jsonResponse(c, okResponse({ dsUsage: raw }));
    } catch (err) {
      log("error", "GET /ds-usage error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "DS_USAGE_FAILED", err?.message || "获取官网用量失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  // 体检（只读）：库/表规模、落盘统计、账本来源；bytes=1 时另外拆一份整份看板的字节。
  // 预览模式没有引擎、也就没有库要读，直接说清楚，不编数字。
  async function handleDiagnostics(c) {
    if (isMock(c)) return jsonResponse(c, errResponse("NO_ENGINE", "预览模式没有体检数据（要读引擎的缓存库）"));
    const payload = { bytes: c.req.query("bytes") === "1", range: c.req.query("range") || "all" };
    try {
      const diagnostics = await busClient.request("token-tracker.diagnostics", payload);
      return jsonResponse(c, okResponse({ diagnostics }));
    } catch (err) {
      log("error", "GET /diagnostics error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "DIAGNOSTICS_FAILED", err?.message || "获取体检数据失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  async function handleRefresh(c) {
    try {
      const payload = { force: c.req.query("force") === "1" };
      const result = await busClient.request("token-tracker.refresh", payload, { mock: isMock(c) });
      return jsonResponse(c, okResponse({ accepted: true, ...result }));
    } catch (err) {
      log("error", "POST /refresh error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "REFRESH_FAILED", err?.message || "触发扫描失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  async function handleSettingsRead(c) {
    try {
      const settings = await busClient.request("token-tracker.settings.read", {}, { mock: isMock(c) });
      return jsonResponse(c, okResponse({ settings }));
    } catch (err) {
      log("error", "GET /settings error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "SETTINGS_FAILED", err?.message || "读取设置失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  async function handleSettingsWrite(c) {
    let body = {};
    try {
      body = await c.req.json();
    } catch { return jsonResponse(c, errResponse("INVALID_JSON", "请求体必须是 JSON"), 400); }
    try {
      const settings = await busClient.request("token-tracker.settings.write", body, { mock: isMock(c) });
      return jsonResponse(c, okResponse({ settings }));
    } catch (err) {
      log("error", "POST /settings error:", err?.message || err);
      return jsonResponse(c, errResponse(err?.code || "SETTINGS_FAILED", err?.message || "保存设置失败"), err?.code === "INVALID_SETTINGS" ? 400 : 503);
    }
  }

  // 输入栏状态位卡片的四个开关：真相在插件侧（input-status.json），这里只负责读、写与生效。
  async function handleInputStatusPrefsRead(c) {
    return jsonResponse(c, okResponse({ prefs: inputStatusPrefs.read() }));
  }

  async function handleInputStatusPrefsWrite(c) {
    let body = {};
    try {
      body = await c.req.json();
    } catch { return jsonResponse(c, errResponse("INVALID_JSON", "请求体必须是 JSON"), 400); }
    const before = inputStatusPrefs.read();
    let prefs;
    try {
      // 只覆盖传进来的键；非法值/未知键由 store 忽略，不写进盘。
      prefs = inputStatusPrefs.write(body);
    } catch (err) {
      log("error", "POST /input-status-prefs error:", err?.message || err);
      return jsonResponse(c, errResponse("PREFS_SAVE_FAILED", err?.message || "保存输入栏偏好失败"), 503);
    }
    // card 由关变开：把卡片补回来（预热最近会话）；由开变关：立即把已挂的会话全部收起。
    try {
      if (!before.card && prefs.card) await sessionCache.warm();
      else if (before.card && !prefs.card) await sessionCache.hideAll();
    } catch (err) {
      log("warn", `输入栏偏好生效失败：${err?.message || err}`);
    }
    return jsonResponse(c, okResponse({ prefs }));
  }

  // 预览模式没有真实版本可比：给一份固定的样张，好让弹窗在预览里也能看形状。
  function mockNotice() {
    const sections = [
      { heading: "新增", items: ["明细表可以按「未命中缓存」排序", "更新说明弹窗：内容来自 GitHub Release"] },
      { heading: "修复", items: ["中文供应商名筛选一直返回 0 行"] },
    ];
    return {
      current: displayVersion(appVersion) || "8.5.0",
      latest: { version: "8.7.0", tag: "v8.7.0", date: new Date().toISOString(), url: "", title: "Token 用量 v8.7.0" },
      hasUpdate: true,
      notes: [{ version: "8.7.0", tag: "v8.7.0", date: new Date().toISOString(), url: "", sections }],
      releaseUrl: "",
      checkedAt: Date.now(),
      error: "",
      fromCache: true,
      enabled: true,
      ackVersion: "",
      dismissedThisSession: false,
      shouldAutoShow: false,
      mock: true,
    };
  }

  async function handleUpdateCheck(c) {
    if (isMock(c)) return jsonResponse(c, okResponse({ update: mockNotice() }));
    try {
      const update = await refreshNotice({ force: c.req.query("force") === "1" });
      return jsonResponse(c, okResponse({ update }));
    } catch (err) {
      log("error", "GET /update-check error:", err?.message || err);
      return jsonResponse(c, errResponse("UPDATE_CHECK_FAILED", err?.message || "检查更新失败"), 503);
    }
  }

  // 「我已知晓」与「先不看」都走这里。后者只记在插件进程内存里，App 一重启就忘。
  // 写完立刻广播：两个界面同时开着时，谁先关，另一个的弹窗跟着一起关。
  async function handleUpdateDismiss(c) {
    if (isMock(c)) return jsonResponse(c, okResponse({ update: mockNotice() }));
    let body = {};
    try {
      body = await c.req.json();
    } catch { return jsonResponse(c, errResponse("INVALID_JSON", "请求体必须是 JSON"), 400); }
    const action = String(body?.action || "");
    let update;
    if (action === "ack" || action === "later") {
      update = updateCheck.dismiss(body.version, action === "ack" ? "read" : "later");
    } else if (action === "toggle") {
      update = updateCheck.setEnabled(body.enabled !== false);
    } else {
      return jsonResponse(c, errResponse("UNKNOWN_ACTION", "action 只认 ack / later / toggle"), 400);
    }
    pushedSignature = updateCheck.signature(update);
    updateEmitter.emit("update", { type: "update", updateNotice: update });
    return jsonResponse(c, okResponse({ update }));
  }

  let unregisterRoutes = null;
  try {
    unregisterRoutes = ctx.routes.register((app) => {
      app.get("/spike", (c) => textResponse(c, `${APP_ID} spike route ok`));
      app.get("/snapshot", handleSnapshot);
      app.get("/update-check", handleUpdateCheck);
      app.post("/update-check", handleUpdateDismiss);
      app.get("/dashboard", handleDashboard);
      app.get("/details.csv", handleDetailsCsv);
      app.get("/details", handleDetails);
      app.get("/turn", handleTurn);
      app.get("/diagnostics", handleDiagnostics);
      app.get("/balance", handleBalance);
      app.get("/ds-usage", handleDsUsage);
      app.post("/refresh", handleRefresh);
      app.get("/settings", handleSettingsRead);
      app.post("/settings", handleSettingsWrite);
      app.get("/input-status-prefs", handleInputStatusPrefsRead);
      app.post("/input-status-prefs", handleInputStatusPrefsWrite);
      app.get("/events", (c) => {
        const stream = streams.open(c.req.raw.signal);
        if (!stream) return c.json(errResponse("STREAM_LIMIT", "事件连接已达上限"), 503);
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      });
      return rootReady;
    });
  } catch (err) {
    unsubscribeUpdates?.();
    try { unsubSessionCache?.(); } catch {}
    sessionCache.dispose();
    streams.dispose();
    busClient.dispose?.();
    log("error", "ctx.routes.register 失败:", err?.message || err);
    throw err;
  }

  log("info", "routes registered: /snapshot /update-check /dashboard /details.csv /details /turn /diagnostics /balance /ds-usage /refresh /settings /input-status-prefs /events");

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    try { unsubSessionCache?.(); } catch {}
    sessionCache.dispose();
    try { unsubscribeUpdates(); } catch {}
    streams.dispose();
    updateEmitter.removeAllListeners();
    if (typeof unregisterRoutes === "function") {
      try { unregisterRoutes(); } catch {}
    }
    for (const off of ttftDisposers) { try { off(); } catch {} }
    ttftDisposers.length = 0;
    await busClient.dispose?.();
    log("info", "disposer：routes / embedded runtime 已注销");
  };
}

export default { apply };
