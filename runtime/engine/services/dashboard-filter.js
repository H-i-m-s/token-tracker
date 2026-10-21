// 供应商 / 模型筛选的纯逻辑层（不碰 DOM、不读环境变量，可以直接被测试导入）。
//
// 为什么单独一个文件：dashboard.js 顶层会读 TOKEN_TRACKER_DATA_DIR，导进来就得配环境，
// 于是最该被钉死的数字口径反而没法单测。
//
// 历史教训（不要退回四条分支）：以前 daily 与 hourly 各自写了「供应商+模型 / 只供应商 /
// 只模型 / 都不选」四条分支，而且各自去不同的层取数。于是同一个筛选在两条路上口径不同，
// 时段图的 desktop/channel 被 providerTotals 与 models 各加了一次，按供应商筛选时正好翻倍
// （实测 provider=deepseek：hourly desktop 150,929,360 vs daily 75,464,680）。

/**
 * 造一个谓词：命中 providerTotals 的键就参与合计。
 * 键的形状是「供应商/模型」，而模型 id 自己可能带斜杠
 *（magpie-gateway/workbuddy/deepseek-v4.1-flash），所以只按第一个斜杠切。
 * 语义与 filterSessions 一致：字段内 OR、字段间 AND。
 *
 * @returns {null | ((pk: string) => boolean)} null 表示不筛（走桶自带的合计）
 */
export function providerModelMatcher(providers = [], models = []) {
  const pList = Array.isArray(providers) ? providers : [];
  const mList = Array.isArray(models) ? models : [];
  if (!pList.length && !mList.length) return null;
  return (pk) => {
    const key = String(pk ?? "");
    const sep = key.indexOf("/");
    const p = sep > 0 ? key.slice(0, sep) : "";
    const m = sep > 0 ? key.slice(sep + 1) : "";
    if (pList.length && !pList.includes(p)) return false;
    if (mList.length && !mList.includes(m)) return false;
    return true;
  };
}

/** 日桶（dailyBreakdown[day].providerTotals[pk]）能给的字段 */
export const DAILY_PT_FIELDS = ["totalTokens", "input", "output", "cacheRead", "cacheWrite", "assistantCount"];

/** 时段桶（hourlyBreakdown[day][hour].providerTotals[pk]）能给的字段，带 desktop/channel 等类型拆分 */
export const HOURLY_PT_FIELDS = [
  "totalTokens", "desktop", "channel", "bridge", "background", "sub", "ledger", "cacheRead", "assistantCount",
];

/**
 * 把一个桶里「命中筛选」的 provider/model 项加起来。
 *
 * 只读 providerTotals 这一层，不再去 models 层二次累加：两层里本来就有同一批数，
 * 各加一遍就是翻倍。缺字段 / null / NaN 一律当 0（账本与旧缓存里可能是缺的）。
 */
export function sumProviderTotals(bucket, match, fields = DAILY_PT_FIELDS) {
  const out = {};
  for (const f of fields) out[f] = 0;
  if (typeof match !== "function") return out;
  for (const [pk, pt] of Object.entries(bucket?.providerTotals || {})) {
    if (!match(pk)) continue;
    for (const f of fields) out[f] += Number(pt?.[f]) || 0;
  }
  return out;
}
