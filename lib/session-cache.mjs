// 输入栏状态位（contributes.ui.inputStatus）的数据源：本会话缓存命中率 + 本会话最近一次生成速度。
//
// ── 缓存命中率 ──
// 口径：命中 = 缓存读 token，未命中 = 未缓存输入 token，
//   命中率 = Σ缓存读 ÷ (Σ缓存读 + Σ未命中输入)
// 范围：这条会话、当前模型、最近的 50 条记录。
// 不是自己发明的式子：宿主账本每条记录同时给 cache.readTokens 和 input.uncachedTokens，
// 这个比值与宿主自己的 cache.hitRatio 一致（真实记录核对过：74112 与 930 得 98.7607%）。
// 不做的事：不把各次请求的 hitRatio 取平均（每次请求的输入体量差几个量级，平均没有意义）；
// 不把"没有缓存信息"当 0（供应商没上报和真的没命中是两回事）。
//
// ── 生成速度 ──
// 来源是内置服务里那条会话自己的采样（token-tracker.speed），按真实会话文件路径取。
// 口径：分母是「本条回复落笔 − 上一条记录落笔」——上一条只可能是用户发出的消息或工具结果，
// 所以工具执行时间不进分母，用户发送前的阅读与书写也不进分母。每次请求在开始吐字之前那段固定
// 开销（排队、预填充、首字等待、网络）由内置服务在对最近 8 条采样做的一元回归里当截距解出来；
// 拟合不成立时按 1 秒固定开销直接除，所以总有数。宿主账本里的 durationMs 实测恒为 0，拿不到精确值。
// 单次仍只是估算：同批样本四分位离散度 ±25%，快慢主要来自服务端排队与负载。
// 界面上不给这个数加修饰语（2026-09-25：曾在速度前自行加过一个「约」，被要求去掉）。要不要表达
// “这是估算”由用户决定，不由代码替他决定。
// 口径不写进 tooltip：用户不说添加什么具体内容，不得自行添加。
//
// ── 调用次数 ──
// 口径：这条会话在宿主账本里全部的请求记录数，按 requestId 去重。工具结果回喂后的续写、子代理
//   内部的每一次调用都各自成一条记录；账本把子代理记录挂在父会话的 attribution.sessionId 上，
//   父子关系另存在 source.parent / source.actor（2026-09-25 实测：本会话 563 条 = session/reply 301
//   + subagent/run 262，两者都随对话增长，此处只是当时的快照）。这一项不看模型、也不受上面 50 条窗口影响：窗口只服务于命中率。
//
// ── 数据来源 ──
// 缓存走宿主账本 ctx.bus.request("usage:list", { sessionId })（权威）；
// 速度走内置服务的 speedQuery(sessionPath)。会话身份从总线拿：
// session_created / session_forked 带 sessionId + sessionPath，llm_usage 带 entry.attribution.sessionId。

// 另经 ctx.bus.request("session:list", { scope: "all" }) 一次性取回全部「会话 id → 文件」对照表
// （需 app/sessions.read；只取 sessionId 与 path 做身份对齐，不读正文本）。这条是重载后立刻可用的那条路。

export const CACHE_ITEM_ID = "session-cache";

const DEFAULT_THROTTLE_MS = 1500; // 同一条会话在这个窗口内只查一次
const CACHE_WINDOW = 50;          // 命中率只算最近的 50 条记录（这条会话、当前模型）
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

// 输出 token 单独用 k：它比命中/未命中小一个量级，走万位会把有效数字吃掉（3.2万 → 32.0k）。
function fmtK(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return k >= 100 ? String(Math.round(k)) + "k" : k.toFixed(1) + "k";
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

// 从一条账本记录里取输出 token。不同供应商的字段形状不一样，按顺序认几种，取不到就 null
// （不假装是 0：没有口径和真的输出 0 是两回事，和缓存那半同一个原则）。
export function outputOf(usage) {
  const direct = num(usage?.output);
  if (direct !== null) return direct;
  const out = usage && typeof usage.output === "object" && usage.output !== null ? usage.output : null;
  return num(out?.totalTokens) ?? num(out?.total) ?? null;
}

export function renderCachePart(read, uncached) {
  const total = read + uncached;
  if (!(total > 0)) return "缓存：—";
  return `缓存：${((read / total) * 100).toFixed(1)}%`; // 输出一位小数
}

export function renderSpeedPart(sample) {
  const tps = num(sample?.tps);
  if (tps === null || tps <= 0) return "速度：—";
  return `速度：${Math.round(tps)} tok/s`;
}

// 条目里的模型形状是 { provider, modelId, api }。缺字段就返回 null，调用方宁可不筛，也别筛错。
export function modelKeyOf(entry) {
  const m = entry && typeof entry.model === "object" ? entry.model : null;
  const id = m && typeof m.modelId === "string" && m.modelId ? m.modelId : null;
  if (!id) return null;
  const prov = m && typeof m.provider === "string" && m.provider ? m.provider : "";
  return prov ? prov + "/" + id : id;
}

// 当前模型 = 最新一条记录的模型。一个会话换了模型，命中率也要跟着换，
// 否则新旧模型的请求会被混成一个百分比（比值不会跳，只会安静地说一个谁都不像的数）。
export function pickCurrentModel(entries) {
  let best = null, bestT = -Infinity;
  for (const entry of entries) {
    const key = modelKeyOf(entry);
    if (!key) continue;
    const t = Date.parse(String(entry?.startedAt || ""));
    if (!Number.isFinite(t) || t <= bestT) continue;
    bestT = t; best = key;
  }
  return best;
}

// 按 requestId 去重后聚合。usage:list 一般已经去过重，这里只是防重不漏。
export function aggregate(entries) {
  const seen = new Set();
  let read = 0, uncached = 0, requests = 0, usable = 0, reported = 0, output = 0, outputReported = 0;
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
    const out = outputOf(entry?.usage);
    if (out !== null) { output += out; outputReported += 1; }
  }
  return { read, uncached, requests, usable, reported, output, outputReported };
}

export class SessionCacheStatus {
  constructor({ bus, inputStatus, log = () => {}, speedQuery = null, listSessions = null, throttleMs = DEFAULT_THROTTLE_MS, warmDelayMs = WARM_DELAY_MS }) {
    this.bus = bus;
    this.inputStatus = inputStatus;
    this.speedQuery = speedQuery;
    this.listSessions = listSessions;
    this.log = log;
    this.throttleMs = throttleMs;
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
      // 不传 limit：宿主的过滤器里没有模型字段，先拿这条会话的记录，再自己筛模型、取最近 50 条。
      const result = await this.bus.request("usage:list", { sessionId });
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      // 只算当前这个模型的请求（与速度那半同一个口径）；算不出当前模型时就退回全部，不硬猜。
      const currentModel = pickCurrentModel(entries);
      const byModel = currentModel ? entries.filter((e) => modelKeyOf(e) === currentModel) : entries;
      // 宿主按写入顺序返回（旧→新），末尾才是最近的：命中率取最近 50 条。
      const agg = aggregate(byModel.slice(-CACHE_WINDOW));
      // 次数取整条会话（含工具回合续写与子代理内部调用），与窗口和模型都无关。
      const sessionCalls = aggregate(entries).requests;
      const cacheKnown = agg.usable > 0 && agg.reported > 0;
      const sample = await this.lookupSpeed(sessionId);
      const speedKnown = (num(sample?.tps) ?? 0) > 0;
      // 两头都没有数据就藏起来：输入栏不挂占位符，没数的时候最好的呈现是不出现。
      if (!cacheKnown && !speedKnown) {
        await this.apply(sessionId, { visible: false });
        return;
      }
      await this.publish(sessionId, agg, cacheKnown, sample, sessionCalls);
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

  async publish(sessionId, agg, cacheKnown, sample, sessionCalls) {
    const tps = num(sample?.tps);
    const speedKnown = tps !== null && tps > 0;
    // 卡片上只放“有哪一半写哪一半”，中间用全角空格：普通连续空格会被 HTML 折叠掉。
    const text = [
      cacheKnown ? renderCachePart(agg.read, agg.uncached) : null,
      speedKnown ? renderSpeedPart(sample) : null,
    ].filter(Boolean).join("　");
    if (!text) return;

    // 用户不说添加什么具体内容，不得自行添加。
    // tooltip 只放卡片放不下的既有信息：命中/未命中、输出、次数、截断说明——这几项都有据可循。
    // 动态内容只能占一行（2026-09-25 实测）：tooltip 里的 \n 会被宿主折叠成空格，分不了行；
    // 弹层上方那行来自 manifest 里静态的 title（必填非空），拿不到实时数字。所以下面统一用「 · 」
    // 串成一行，别再试图塞换行。
    // （2026-09-25：曾在此自行加了一句“速度按本会话样本校准”，被要求删除。备注、口径、措辞
    //   都不属于“既有信息”，要写什么得等用户点名。）
    const parts = [];
    if (cacheKnown) {
      parts.push(`命中 ${fmtNum(agg.read)} / 未命中 ${fmtNum(agg.uncached)}`);
      // 有 output 口径才写“输出”：取不到就整段不出现，不写“输出 0”制造假精确。
      if (agg.outputReported > 0) parts.push(`输出 ${fmtK(agg.output)}`);
      parts.push(`${sessionCalls} 次`);
      const missing = agg.usable - agg.reported;
      if (missing > 0) parts.push(`${missing} 次无口径`);
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
