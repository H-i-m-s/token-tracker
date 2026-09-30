// 消费明细的「看」这一层：排序、门槛、分页切片。纯函数，不碰 DOM，可以单独跑测试。
//
// 这张表的定位是考古（翻到第 900 页找某一天没有意义），所以给的是
//「按用量倒序 + 设门槛」——把最大的几笔捞到眼前，而不是更多页码。

export const DETAIL_SORTS = [
  { key: "time", label: "时间 ↓" },
  { key: "tokens", label: "用量 ↓" },
];

// 门槛按全量 146 天、16,269 条有量轮次的实测分位挑：
// P50 47万 / P90 362万 / P99 1570万 / 最大 7709万。各档剩多少条也是实测：
// ≥300万 ≈ 2,000 条（40 页）、≥500万 ≈ 1,050 条（21 页）、≥1000万 ≈ 350 条（8 页）、
// ≥3000万 = 32 条（1 页）—— 最后一档就是“把最猛的几笔直接摊在一屏里”。
export const DETAIL_THRESHOLDS = [
  { key: 0, label: "不限" },
  { key: 3000000, label: "≥300万" },
  { key: 5000000, label: "≥500万" },
  { key: 10000000, label: "≥1000万" },
  { key: 30000000, label: "≥3000万" },
];

// 后端给的就是时间倒序，sort=time 时原样返回，不复制数组。
export function viewRows(rows, { sort = "time", minTokens = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const kept = minTokens > 0 ? list.filter((r) => (r.totalTokens || 0) >= minTokens) : list;
  if (sort !== "tokens") return kept;
  // 用量相同时按时间倒序兜底，让顺序稳定：同一份数据每次渲染的页序必须一致，
  // 否则翻页时同一条记录可能在两页里各出现一次。
  return [...kept].sort((a, b) =>
    ((b.totalTokens || 0) - (a.totalTokens || 0)) || String(b.time || "").localeCompare(String(a.time || "")));
}

export function sumTokens(rows) {
  let sum = 0;
  for (const r of rows) sum += r.totalTokens || 0;
  return sum;
}

// 页码一律夹在 [1, totalPages]：范围或门槛一换，原来的页码可能就不存在了。
export function pageSlice(rows, page, size) {
  const list = Array.isArray(rows) ? rows : [];
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (current - 1) * size;
  return { totalPages, page: current, start, rows: list.slice(start, start + size) };
}
