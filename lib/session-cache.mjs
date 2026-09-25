// 输入栏状态位（contributes.ui.inputStatus）的数据源：本会话缓存命中率 + 本会话最近一次生成速度。
//
// ── 缓存命中率 ──
// 口径：命中 = 缓存读 token，未命中 = 未缓存输入 token，
//   命中率 = Σ缓存读 ÷ (Σ缓存读 + Σ未命中输入)
// 不是自己发明的式子：宿主账本每条记录同时给 cache.readTokens 和 input.uncachedTokens，
// 这个比值与宿主自己的 cache.hitRatio 一致（真实记录核对过：74112 与 930 得 98.7607%）。
// 不做的事：不把各次请求的 hitRatio 取平均（每次请求的输入体量差几个量级，平均没有意义）；
// 不把"没有缓存信息"当 0（供应商没上报和真的没命中是两回事）。
//
// ── 生成速度 ──
// 来源是内置服务里那条会话自己的采样（token-tracker.speed），按真实会话文件路径取。
// 必须说清的口径：桌面会话的 tok/s 由「本条消息时间 − 上一条消息时间」估出，含网络与排队，
// 是真实生成速度的下限；宿主账本里的 durationMs 对桌面回复几乎恒为 0，取不到精确值。
// 所以界面上的速度是估算值，tooltip 里如实写明。
//
// ── 数据来源 ──
// 缓存走宿主账本 ctx.bus.request("usage:list", { sessionId })（权威）；
// 速度走内置服务的 speedQuery(sessionPath)。会话身份从总线拿：
// session_created / session_forked 带 sessionId + sessionPath，llm_usage 带 entry.attribution.sessionId。

// 另经 ctx.bus.request("session:list", { scope: "all" }) 一次性取回全部「会话 id → 文件」对照表
// （需 app/sessions.read；只取 sessionId 与 path 做身份对齐，不读正文本）。这条是重载后立刻可用的那条路。

export const CACHE_ITEM_ID = "session-cache";

const DEFAULT_THROTTLE_MS = 1500; // 同一条会话在这个窗口内只查一次
const DEFAULT_LIMIT = 500;        // 单次账本查询上限；被截断时如实写进 tooltip
const WARM_WINDOW_MS = 24 * 3600 * 1000; // 启动预热只看最近 24 小时
const WARM_LIMIT = 50;
const WARM_SESSIONS = 3;
const WARM_DELAY_MS = 2500;       // 等贡献表登记完再写覆盖（apply 返回后才登记）

const PATHS_TTL_MS = 15000;       // 会话对照表最短重取间隔（避免每次刷新都问了）

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(Math.round(n));
}

// 从一条账本记录里取出 (缓存读, 未命中输入)，并标出这条记录能不能用。
//   usable   —— 输入侧有数，能参与比例计算
//   reported —— 这条记录明确带了缓存口径（不是"缺失"）
export function splitCache(usage) {
  const cache = usage && typeof usage.cache === "object" && usage.cache !== null ? usage.cache : null;
  const read = num(cache?.readTokens) ?? 0;
  const uncachedRaw = num(usage?.input?.uncachedTokens);
  const inputTotal = num(usage?.input?.totalTokens);

  let uncached = uncachedRaw;
  if (uncached === null) {
    // input.totalTokens 可能已经含缓存读，先减再算；减不动就按原值。
    if (inputTotal === null) return { read, uncached: 0, usable: false, reported: false };
    uncached = read > 0 && inputTotal >= read ? inputTotal - read : inputTotal;
  }

  const reported = uncachedRaw !== null
    || (cache !== null && (num(cache.readTokens) !== null || cache.hitRatio != null || cache.support != null || cache.hit != null));
  return { read, uncached, usable: true, reported };
}

export function renderCachePart(read, uncached) {
  const total = read + uncached;
  if (!(total > 0)) return "缓存：—";
  return `缓存：${Math.round((read / total) * 100)}%`;
}

export function renderSpeedPart(sample) {
  const tps = num(sample?.tps);
  if (tps === null || tps <= 0) return "速度：—";
  return `速度：${Math.round(tps)} tok/s`;
}

// 按 requestId 去重后聚合。usage:list 一般已经去过重，这里只是防重不漏。
export function aggregate(entries) {
  const seen = new Set();
  let read = 0, uncached = 0, requests = 0, usable = 0, reported = 0;
  for (const entry of entries) {
    const id = entry?.requestId;
    if (typeof id === "string" && id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    requests += 1;
    const amount = splitCache(entry?.usage);
    if (!amount.usable) continue;
    usable += 1;
    if (amount.reported) reported += 1;
    read += amount.read;
    uncached += amount.uncached;
  }
  return { read, uncached, requests, usable, reported };
}

export class SessionCacheStatus {
  constructor({ bus, inputStatus, log = () => {}, speedQuery = null, listSessions = null, throttleMs = DEFAULT_THROTTLE_MS, limit = DEFAULT_LIMIT, warmDelayMs = WARM_DELAY_MS }) {
    this.bus = bus;
    this.inputStatus = inputStatus;
    this.speedQuery = speedQuery;
    this.listSessions = listSessions;
    this.log = log;
    this.throttleMs = throttleMs;
    this.limit = limit;
    this.warmDelayMs = warmDelayMs;
    this.timers = new Map();
    this.running = new Set();
    this.paths = new Map(); // sessionId -> 真实会话文件路径（速度查询用）
    this.pathsSyncedAt = 0;
    this.pathsInFlight = null;
    this.warmTimer = null;
    this.disposed = false;
  }

  // 订阅事件，返回退订函数。宿主没有对应能力时安静退化，不影响应用其余部分。
  start() {
    if (typeof this.bus?.subscribe !== "function" || typeof this.inputStatus?.set !== "function") {
      this.log("warn", "输入栏状态位不可用：缺少 ctx.bus.subscribe 或 ctx.inputStatus.set");
      return () => {};
    }
    let off;
    try {
      off = this.bus.subscribe((event) => {
        try {
          this.onEvent(event);
        } catch (e) {
          this.log("warn", "输入栏状态位事件处理失败：", e?.message || e);
        }
      }, { types: ["session_created", "session_forked", "llm_usage"] });
    } catch (e) {
      this.log("warn", "输入栏状态位订阅失败：", e?.message || e);
      return () => {};
    }
    this.warmStart();
    return () => { try { off?.(); } catch {} };
  }

  onEvent(event) {
    const type = event?.type;
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : event;

    if (type === "session_created" || type === "session_forked") {
      const sessionId = payload?.sessionId;
      // 隔离会话（子代理、后台任务）不进桌面输入框，不必挂。
      if (typeof sessionId !== "string" || !sessionId || payload?.isolated === true) return;
      if (typeof payload.sessionPath === "string" && payload.sessionPath) this.paths.set(sessionId, payload.sessionPath);
      this.schedule(sessionId, true);
      return;
    }

    if (type !== "llm_usage") return;
    const entry = event?.entry || payload?.entry;
    const sessionId = entry?.attribution?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return;
    // sessionPath 不在 SDK 类型里，是入口里的附加字段：只当兜底，别覆盖 session_created 给的。
    const sessionPath = entry?.attribution?.sessionPath;
    if (!this.paths.has(sessionId) && typeof sessionPath === "string" && sessionPath) this.paths.set(sessionId, sessionPath);
    this.schedule(sessionId, false);
  }

  schedule(sessionId, immediate) {
    if (this.disposed || !sessionId) return;
    const pending = this.timers.get(sessionId);
    if (pending && !immediate) return;
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(sessionId);
    }
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      if (this.disposed) return;
      this.refresh(sessionId).catch(() => {});
    }, immediate ? 120 : this.throttleMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  // 向宿主要一次「会话 id → 会话文件路径」对照表。失败不影响缓存那半，只是速度退回全机兜底。
  async syncPaths(force) {
    if (typeof this.listSessions !== "function") return false;
    if (!force && Date.now() - this.pathsSyncedAt < PATHS_TTL_MS) return true;
    if (this.pathsInFlight) return this.pathsInFlight;
    this.pathsInFlight = (async () => {
      try {
        const list = await this.listSessions();
        let added = 0;
        for (const item of list) {
          if (!this.paths.has(item.sessionId)) added += 1;
          this.paths.set(item.sessionId, item.path);
        }
        this.pathsSyncedAt = Date.now();
        if (added) this.log("info", `会话对照表更新：新增 ${added} 条，共 ${this.paths.size} 条`);
        return true;
      } catch (e) {
        this.log("warn", `会话对照表同步失败：${e?.message || e}`);
        return false;
      } finally {
        this.pathsInFlight = null;
      }
    })();
    return this.pathsInFlight;
  }

  async lookupSpeed(sessionId) {
    if (typeof this.speedQuery !== "function") return null;
    try {
      // 路径未知时也问一次：内置服务会用全机最近一次采样兜底，并在回包里标 scope。
      return (await this.speedQuery(this.paths.get(sessionId) || null)) || null;
    } catch (e) {
      // 拿不到速度只是少一半信息，不影响缓存那半；但要留痕，不能默默消失。
      this.log("warn", `速度查询失败：${e?.message || e}`);
      return null;
    }
  }

  async refresh(sessionId) {
    if (this.disposed || this.running.has(sessionId)) return;
    this.running.add(sessionId);
    try {
      // 缺路径时先补一次对照表：有 TTL，不会每次刷新都问宿主。
      if (!this.paths.has(sessionId)) await this.syncPaths(false);
      const result = await this.bus.request("usage:list", { sessionId, limit: this.limit });
      const agg = aggregate(Array.isArray(result?.entries) ? result.entries : []);
      const cacheKnown = agg.usable > 0 && agg.reported > 0;
      const sample = await this.lookupSpeed(sessionId);
      const speedKnown = (num(sample?.tps) ?? 0) > 0;
      // 两头都没有数据就藏起来：输入栏不挂占位符，没数的时候最好的呈现是不出现。
      if (!cacheKnown && !speedKnown) {
        await this.apply(sessionId, { visible: false });
        return;
      }
      await this.publish(sessionId, agg, cacheKnown, sample, Boolean(result?.nextCursor));
    } catch (e) {
      this.log("warn", `输入栏状态位查询失败（${sessionId}）：${e?.message || e}`);
    } finally {
      this.running.delete(sessionId);
    }
  }

  // 覆盖是按会话存的：写一次就跟着那个会话走，切回来不用重算。
  async apply(sessionId, payload) {
    await this.inputStatus.set({ sessionId, id: CACHE_ITEM_ID, ...payload });
  }

  async publish(sessionId, agg, cacheKnown, sample, truncated) {
    const tps = num(sample?.tps);
    const speedKnown = tps !== null && tps > 0;
    // 卡片上只放“有哪一半写哪一半”，中间用全角空格：普通连续空格会被 HTML 折叠掉。
    const text = [
      cacheKnown ? renderCachePart(agg.read, agg.uncached) : null,
      speedKnown ? renderSpeedPart(sample) : null,
    ].filter(Boolean).join("　");
    if (!text) return;

    // tooltip 只补卡片放不下的东西：不重复百分比，不放速度（速度已在卡片上，这一行一长就撑破固定宽度的框）。
    const parts = [];
    if (cacheKnown) {
      parts.push(`命中 ${fmtNum(agg.read)} / 未命中 ${fmtNum(agg.uncached)}`);
      parts.push(`${agg.usable} 次`);
      const missing = agg.usable - agg.reported;
      // 两条附注不叠加：截断更能说明这个数不完整，优先留它。
      if (truncated) parts.push(`仅计前 ${this.limit} 条`);
      else if (missing > 0) parts.push(`${missing} 次无口径`);
    } else {
      parts.push("缓存暂无口径");
    }

    await this.apply(sessionId, { text, tooltip: parts.join(" · "), visible: true });
    // 速度来源写进日志：session 是本会话自己的采样，global 是全机兜底（对照表没兜住时）。
    const from = speedKnown ? `，速度来源=${sample?.scope || "?"}` : "";
    this.log("info", `输入栏状态位：${sessionId} → ${text}${from}`);
  }

  // 宿主重启 / 应用重载后，动态覆盖会清空，而已打开的会话不会再发 session_created。
  // 启动时拿最近窗口内出现过的会话 id 预热一下，把这一个缝补上。
  warmStart() {
    if (this.disposed || typeof this.bus?.request !== "function") return;
    const timer = setTimeout(() => {
      this.warm().catch(() => {});
    }, this.warmDelayMs);
    timer.unref?.();
    this.warmTimer = timer;
  }

  async warm() {
    try {
      // 先把「会话 id → 文件」对照表拿全：重载后已经坐在里面的会话也能直接对上。
      await this.syncPaths(true);
      const since = new Date(Date.now() - WARM_WINDOW_MS).toISOString();
      const result = await this.bus.request("usage:list", { since, limit: WARM_LIMIT });
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      const ids = [];
      for (const entry of entries) {
        const sessionId = entry?.attribution?.sessionId;
        const sessionPath = entry?.attribution?.sessionPath;
        if (typeof sessionId === "string" && sessionId) {
          if (typeof sessionPath === "string" && sessionPath && !this.paths.has(sessionId)) this.paths.set(sessionId, sessionPath);
          if (!ids.includes(sessionId)) ids.push(sessionId);
        }
        if (ids.length >= WARM_SESSIONS) break;
      }
      for (const sessionId of ids) await this.refresh(sessionId);
    } catch (e) {
      this.log("warn", `输入栏状态位预热失败：${e?.message || e}`);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.running.clear();
    this.paths.clear();
  }
}
