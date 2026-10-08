// 消费明细的「看」这一层：排序、门槛、分页切片。纯函数，不碰 DOM，可以单独跑测试。
//
// 这张表的定位是考古（翻到第 900 页找某一天没有意义），所以给的是
//「按用量倒序 + 设门槛」——把最大的几笔捞到眼前，而不是更多页码。

import { scaleText } from "./units.mjs";

export const DETAIL_SORTS = [
  { key: "time", label: "时间 ↓" },
  { key: "tokens", label: "用量 ↓" },
  // 命中缓存的输入单价低一个量级，所以“贵”不在总量上，在未命中那部分上。
  { key: "uncached", label: "未命中输入 ↓" },
];

// 门槛按全量 146 天、16,269 条有量轮次的实测分位挑：
// P50 47万 / P90 362万 / P99 1570万 / 最大 7709万。各档剩多少条也是实测：
// ≥300万 ≈ 2,000 条（40 页）、≥500万 ≈ 1,050 条（21 页）、≥1000万 ≈ 350 条（8 页）、
// ≥3000万 = 32 条（1 页）—— 最后一档就是“把最猛的几笔直接摊在一屏里”。
// 门槛标签跟着设置里的数字单位走：中文「≥300万」，英文「≥3M」。
function thresholdLabel(key) {
  return key === 0 ? "不限" : "≥" + scaleText(key, { trim: true, plain: (v) => String(Math.round(v)) });
}
// label 写成 getter：单位制要到 bootstrap 读完设置才定下来，模块加载时就把字符串定死会让切换失效。
// key 仍然是数字（引擎侧按 minTokens 收数），一个都不变。
export const DETAIL_THRESHOLDS = [0, 3000000, 5000000, 10000000, 30000000].map((key) => ({
  key,
  get label() { return thresholdLabel(key); },
}));

// 与引擎的 ROW_COLS 同序（引擎那边是唯一出处，这里只是“引擎没给列名”时的兜底；
// 两边是否还对齐由 test/rows-wire.test.js 对拍）。
export const ROW_COLS = ["time", "agent", "agentName", "provider", "model",
  "totalTokens", "inputTokens", "outputTokens", "cacheRead", "calls", "sessionKey", "seq"];

// 把「列名 + 数组行」解回对象行。对象行（mock 数据）原样返回。
// 键名只发一次是为了载荷能过宿主的 4 MiB 响应硬顶，解回来这一层是唯一一处。
export function decodeRows(payload, cols = null) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const names = Array.isArray(payload?.rowCols) && payload.rowCols.length ? payload.rowCols : (cols || ROW_COLS);
  return {
    ...(payload || {}),
    rows: rows.map((r) => {
      if (!Array.isArray(r)) return r;
      const out = {};
      for (let i = 0; i < names.length; i++) out[names[i]] = r[i] ?? null;
      return out;
    }),
  };
}

// 后端给的就是时间倒序，sort=time 时原样返回，不复制数组。
export function viewRows(rows, { sort = "time", minTokens = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const kept = minTokens > 0 ? list.filter((r) => (r.totalTokens || 0) >= minTokens) : list;
  if (sort === "time") return kept;
  // 数值相同时按时间倒序兜底，让顺序稳定：同一份数据每次渲染的页序必须一致，
  // 否则翻页时同一条记录可能在两页里各出现一次。
  const timeDesc = (a, b) => String(b.time || "").localeCompare(String(a.time || ""));
  if (sort === "uncached") return [...kept].sort((a, b) => (uncachedInput(b) - uncachedInput(a)) || timeDesc(a, b));
  return [...kept].sort((a, b) => ((b.totalTokens || 0) - (a.totalTokens || 0)) || timeDesc(a, b));
}

// 未命中缓存的输入 = 输入总量 − 命中缓存的部分。排序看的是“贵的那些”，不是总量。
// 老记录（v24 之前）没带缓存拆分，只能按“输入全是未命中”参与排序；重扫之后不存在这种记录。
export function uncachedInput(r) {
  const input = Number(r?.inputTokens) || 0;
  const read = Number(r?.cacheRead) || 0;
  return Math.max(0, input - read);
}

// 命中缓存的输入占比（0~1）。没有缓存口径的记录返回 null —— 用 0 冒充“完全没命中”是假话。
export function hitRate(r) {
  const read = r?.cacheRead;
  const input = Number(r?.inputTokens);
  if (read == null || !Number.isFinite(input) || input <= 0) return null;
  return Math.max(0, Math.min(1, Number(read) / input));
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
