import { mkdir } from "node:fs/promises";
import { createEventStreams } from "./lib/event-stream.mjs";
import { EventEmitter } from "node:events";
import { LocalClient } from "./lib/local-client.mjs";
import { SessionCacheStatus } from "./lib/session-cache.mjs";
import { shapeSnapshot, shapeBalances } from "./lib/snapshot-service.mjs";
import { okResponse, errResponse } from "./lib/api-errors.mjs";

export const APP_ID = "token-tracker-app";



function jsonResponse(c, body, status = 200) {
  return c.json(body, status);
}

function textResponse(c, text, status = 200) {
  return c.text(text, status);
}


export function apply(ctx, { clientFactory = options => new LocalClient(options) } = {}) {
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

  const defaultMock = process.env.TOKEN_TRACKER_MOCK === "1";
  const busClient = clientFactory({ ctx, log, defaultMock });
  // 输入栏状态位：本会话缓存命中率 + 本会话最近一次生成速度（见 lib/session-cache.mjs）。
  // 速度走内置服务按真实会话文件路径取，拿不到就返回 null，界面显示“—”。
  const speedQuery = (sessionPath) => busClient.request("token-tracker.speed", { sessionPath })
    .then(sample => sample || null)
    .catch(() => null);
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
  const sessionCache = new SessionCacheStatus({ bus: ctx.bus, inputStatus: ctx.inputStatus, log, speedQuery, listSessions });
  const unsubSessionCache = sessionCache.start();

  const updateEmitter = new EventEmitter();
  updateEmitter.setMaxListeners(25);
  const streams = createEventStreams(updateEmitter);

  // Subscribe to this App's embedded service. No external plugin is required.
  const unsubscribeUpdates = busClient.subscribe("token-tracker.updated", (payload) => {
    updateEmitter.emit("update", { ...payload, type: "update" });
  }, { mock: defaultMock });

  function isMock(c) {
    return c.req.query("mock") === "1" || defaultMock;
  }

  async function handleSnapshot(c) {
    try {
      const raw = await busClient.request("token-tracker.snapshot", {}, { mock: isMock(c) });
      const snapshot = shapeSnapshot(raw);
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

  let unregisterRoutes = null;
  try {
    unregisterRoutes = ctx.routes.register((app) => {
      app.get("/spike", (c) => textResponse(c, `${APP_ID} spike route ok`));
      app.get("/snapshot", handleSnapshot);
      app.get("/dashboard", handleDashboard);
      app.get("/balance", handleBalance);
      app.get("/ds-usage", handleDsUsage);
      app.post("/refresh", handleRefresh);
      app.get("/settings", handleSettingsRead);
      app.post("/settings", handleSettingsWrite);
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

  log("info", "routes registered: /snapshot /dashboard /balance /ds-usage /refresh /settings /events");

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
    await busClient.dispose?.();
    log("info", "disposer：routes / embedded runtime 已注销");
  };
}

export default { apply };
