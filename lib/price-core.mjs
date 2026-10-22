// 价格的纯算术：没有文件、没有网络、没有数据库。
//
// 为什么单独一个文件并且被两个进程共用：
//   引擎要拿价格算钱（每个看板请求都算），App 层要拿价格显示「默认价 / 已定价」并落盘。
//   这两边必须用同一套换算与合并规则 —— 若各留一份，早晚漂成
//   「界面上说已定价，看板上却算不出钱」这种查半天的问题。
//
// 谁写谁读：
//   能写价格的只有 App 层（lib/price-file.mjs）。这里只负责算，不碰盘。
//
// 四条口径，改之前先看这里：
//   1. 金额单位是「美元 / 每百万 token」。价格表永远存美元，换人民币只是显示层的事
//      （见 ui/currency.mjs），否则汇率一变动历史成本就跟着变。
//   2. 四个价：input（缓存未命中）、cacheRead（命中）、cacheWrite（写入）、output。
//      缺省即 0。cacheWrite 绝大多数模型不收费，只有极少数收。
//   3. 用户表**按项**覆盖默认表：他只填了 output，input 仍然用默认的。
//      整条覆盖会让「填一格」等于「把另外三格清零」，成本凭空少算。
//   4. 「没填」与「0」是两件事。0 是免费，undefined 是不知道 —— 归一化时不要把前者变成后者。

export const PRICE_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

// 出厂自带的价格（OpenCode Go 官方定价，2026-08 校验过）。
// 这是「用户没填时」的兜底值，界面上要能区分哪些数是它给的。
export const DEFAULT_PRICE_TABLE = {
  "opencode-go/deepseek-v4-flash": { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 },
  "opencode-go/deepseek-v4-pro": { input: 0.435, cacheRead: 0.003625, cacheWrite: 0, output: 0.87 },
  "opencode-go/gpt-5.6-luna": {
    input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2,
    // 长上下文分档：单次上下文超过 272K 之后走这一档。
    contextTiers: [{ maxContext: 272000, input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 }],
  },
  "opencode-go/grok-4.5": { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  "opencode-go/glm-5.2": { input: 1.4, cacheRead: 0.26, cacheWrite: 0, output: 4.4 },
  "opencode-go/glm-5.1": { input: 1.4, cacheRead: 0.26, cacheWrite: 0, output: 4.4 },
  "opencode-go/kimi-k3": { input: 3, cacheRead: 0.3, cacheWrite: 0, output: 15 },
  "opencode-go/kimi-k2.7-code": { input: 0.95, cacheRead: 0.19, cacheWrite: 0, output: 4 },
  "opencode-go/kimi-k2.6": { input: 0.95, cacheRead: 0.16, cacheWrite: 0, output: 4 },
  "opencode-go/mimo-v2.5": { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 },
  "opencode-go/mimo-v2.5-pro": { input: 0.435, cacheRead: 0.003625, cacheWrite: 0, output: 0.87 },
  "opencode-go/minimax-m3": { input: 0.3, cacheRead: 0.06, cacheWrite: 0, output: 1.2 },
  "opencode-go/minimax-m2.7": { input: 0.3, cacheRead: 0.06, cacheWrite: 0.375, output: 1.2 },
  "opencode-go/minimax-m2.5": { input: 0.3, cacheRead: 0.06, cacheWrite: 0.375, output: 1.2 },
  "opencode-go/qwen3.7-max": { input: 2.5, cacheRead: 0.5, cacheWrite: 3.125, output: 7.5 },
  "opencode-go/hy3": { input: 0.14, cacheRead: 0.035, cacheWrite: 0, output: 0.58 },
};

/**
 * 是否「四价」形态。
 * 空对象也算：它表示「这个模型立了键、四价都还没填」，用户自行添加时就是这个状态。
 * 不把空对象算进来的话，新加的模型下次刷新就凭空消失。
 */
export function isFlatPrice(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (Object.keys(v).length === 0) return true;
  return PRICE_KEYS.some((k) => v[k] !== undefined) || Array.isArray(v.contextTiers);
}

/**
 * 归一化：只留四个数字 + contextTiers。
 * 非数字、负数、Infinity、空串一律当作「没填」丢掉，不写 0。
 */
export function normalizePrice(raw) {
  if (!isFlatPrice(raw)) return null;
  const out = {};
  for (const k of PRICE_KEYS) {
    const n = Number(raw[k]);
    if (raw[k] === "" || raw[k] == null || !Number.isFinite(n) || n < 0) continue;
    out[k] = n;
  }
  if (Array.isArray(raw.contextTiers)) {
    const tiers = raw.contextTiers.map((t) => {
      if (!t || typeof t !== "object") return null;
      const max = Number(t.maxContext);
      if (!Number.isFinite(max) || max <= 0) return null;
      const tier = { maxContext: max };
      for (const k of PRICE_KEYS) {
        const n = Number(t[k]);
        if (Number.isFinite(n) && n >= 0) tier[k] = n;
      }
      return tier;
    }).filter(Boolean);
    if (tiers.length) out.contextTiers = tiers;
  }
  return out;
}

/**
 * 用户表覆盖默认表，**按项**合并。
 * 这是「界面允许只填一格」的前提：只填 output 时，另外三格仍是默认价。
 */
export function mergePriceTables(userTable, defaults = DEFAULT_PRICE_TABLE) {
  const merged = {};
  for (const [key, value] of Object.entries(defaults || {})) merged[key] = { ...value };
  for (const [key, value] of Object.entries(userTable || {})) {
    merged[key] = { ...(merged[key] || {}), ...value };
  }
  return merged;
}

/**
 * 长上下文分档：单次请求的上下文量**超过**某档的 maxContext 就走那档（长上下文更贵），
 * 多档命中取门槛最高的。maxContext 本身不进结果。
 * 上下文量用 input + cacheRead：长上下文场景缓存命中占大头，只拿 input 判，高档永远触发不了。
 */
export function pickPrice(price, mv) {
  if (!price) return null;
  if (!Array.isArray(price.contextTiers) || !price.contextTiers.length) return price;
  const calls = Math.max(1, mv.callCount || mv.assistantCount || 1);
  const perCall = ((mv.input || 0) + (mv.cacheRead || 0)) / calls;
  let ap = price;
  let matchedMax = -1;
  for (const tier of price.contextTiers) {
    // maxContext 是这一档的**下限**（超过它才进这档），不是上限。
    // 写成 maxContext > perCall 就是反的 —— 这个方向已经错过两次（一次是初版，
    // 一次是重写时），所以把比较写成「单次量 < 门槛 → 跳过」这种正向说法，
    // 读起来不容易再错。
    if (perCall <= tier.maxContext) continue;
    if (tier.maxContext < matchedMax) continue;
    const { maxContext, ...tierPrice } = tier;
    ap = { ...price, ...tierPrice };
    matchedMax = maxContext;
  }
  return ap;
}

/**
 * 算一笔钱。
 * mv：{ input, cacheRead, cacheWrite, output, callCount / assistantCount }
 * 缺项按 0 算；没价就 0。永远不返回 NaN。
 */
export function calcCost(price, mv) {
  if (!price || !mv) return 0;
  const ap = pickPrice(price, mv);
  if (!ap) return 0;
  return (mv.input || 0) * (ap.input || 0) / 1e6
    + (mv.cacheRead || 0) * (ap.cacheRead || 0) / 1e6
    + (mv.cacheWrite || 0) * (ap.cacheWrite || 0) / 1e6
    + (mv.output || 0) * (ap.output || 0) / 1e6;
}

/** 有没有「真的能算出钱」的项。全 0 = 没配（界面上那句「未完整定价」靠它判）。 */
export function isPriced(price) {
  if (!price) return false;
  return PRICE_KEYS.some((k) => Number(price[k]) > 0);
}

/** 价格键 → 供应商与模型。模型名里允许再带斜杠，所以只切第一个。 */
export function splitKey(key) {
  const s = String(key ?? "");
  const at = s.indexOf("/");
  if (at <= 0) return { provider: "", model: s };
  return { provider: s.slice(0, at), model: s.slice(at + 1) };
}
