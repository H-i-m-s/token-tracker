// 缓存命中率：全应用只有这一种算法。
//
// 口径：缓存读 / 输入总量，其中输入总量**含**缓存读（也就是明细行里「输入Token」那一列）、
// 不含输出。命中率是「这次读的上下文里有多少是白拿的」，输出跟它没关系。
//
// 以前有三处各算各的：
//   · 顶部 KPI：cacheRead / totalTokens —— 分母里带了输出，同一个会话会比明细低几个点
//   · 明细行 / CSV：cacheRead / inputTokens（含缓存读）—— 这一处本来是对的
//   · 实时面板：sessionCacheRead / sessionTotalTokens —— 同样把输出算进了分母
// 于是「拿明细去核对 KPI 永远对不上」，而且没有任何地方说明它们不是一回事。
//
// 注意：扫描时 dailyBreakdown.input 是**未命中**的输入，明细行的 inTokens 是
// 「未命中 + 缓存读」。调用方传进来的必须是后者，所以 dashboard.js 那边写的是
// `sums.totalInput + sums.totalCacheRead`。

/**
 * @param {number} cacheRead 缓存读 tokens
 * @param {number} inputInclusive 输入总量（含缓存读）
 * @returns {number|null} 0~1；分母无效时返回 null（「没有口径」比「0%」诚实）
 */
export function hitRate(cacheRead, inputInclusive) {
  const read = Number(cacheRead);
  const input = Number(inputInclusive);
  if (!Number.isFinite(input) || input <= 0) return null;
  if (!Number.isFinite(read) || read <= 0) return 0;
  return Math.min(1, read / input);
}

/**
 * 同上，但直接给界面用的百分比数值（保留一位小数）。
 * 分母无效时给 0：KPI 那格历来显示 0.0%，不改成「—」以免动到界面契约。
 */
export function hitRatePercent(cacheRead, inputInclusive) {
  const r = hitRate(cacheRead, inputInclusive);
  return r === null ? 0 : +(r * 100).toFixed(1);
}

/** 同上的字符串形态（实时面板那几个字段历史上就是字符串）。 */
export function hitRatePercentText(cacheRead, inputInclusive) {
  const r = hitRate(cacheRead, inputInclusive);
  return (r === null ? 0 : r * 100).toFixed(1);
}
