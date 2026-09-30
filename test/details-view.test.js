import test from "node:test";
import assert from "node:assert/strict";
import { viewRows, sumTokens, pageSlice, DETAIL_THRESHOLDS, DETAIL_SORTS, hitRate, uncachedInput } from "../ui/details-view.mjs";

const row = (time, totalTokens) => ({ time, totalTokens });

test("viewRows：默认保持后端给的时间倒序，不复制也不重排", () => {
  const rows = [row("2026-09-30T10:00:00Z", 100), row("2026-09-29T10:00:00Z", 900)];
  assert.deepEqual(viewRows(rows), rows);
  assert.equal(viewRows(rows)[0], rows[0], "时间序应当是原数组本身，不做无谓拷贝");
});

test("viewRows：按用量倒序，并用时间倒序兜底同值", () => {
  const rows = [row("2026-09-28T00:00:00Z", 500), row("2026-09-30T00:00:00Z", 500), row("2026-09-29T00:00:00Z", 2000)];
  const sorted = viewRows(rows, { sort: "tokens" });
  assert.deepEqual(sorted.map((r) => r.totalTokens), [2000, 500, 500]);
  assert.equal(sorted[1].time, "2026-09-30T00:00:00Z", "同用量时新的排前面");
  assert.equal(rows[0].totalTokens, 500, "排序不应改动入参数组");
});

test("viewRows：门槛是「大于等于」，0 表示不过滤", () => {
  const rows = [row("a", 999999), row("b", 1000000), row("c", 5000000)];
  assert.equal(viewRows(rows).length, 3);
  assert.deepEqual(viewRows(rows, { minTokens: 1000000 }).map((r) => r.totalTokens), [1000000, 5000000]);
  // 门槛与排序可以叠加：先筛再排
  assert.deepEqual(viewRows(rows, { sort: "tokens", minTokens: 1000000 }).map((r) => r.totalTokens), [5000000, 1000000]);
});

test("viewRows：空输入与脏输入不抛", () => {
  assert.deepEqual(viewRows(undefined), []);
  assert.deepEqual(viewRows([]), []);
  assert.deepEqual(viewRows([{ time: "a" }, { totalTokens: null }], { sort: "tokens" }).length, 2);
});

test("sumTokens：缺字段按 0 计", () => {
  assert.equal(sumTokens([row("a", 100), { time: "b" }, row("c", 250)]), 350);
  assert.equal(sumTokens([]), 0);
});

test("pageSlice：页码越界要夹回来，不能返回空页", () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(String(i), 1));
  assert.deepEqual(pageSlice(rows, 1, 50).rows.length, 50);
  assert.deepEqual([pageSlice(rows, 3, 50).rows.length, pageSlice(rows, 3, 50).totalPages], [20, 3]);
  // 超上界 → 最后一页；小于 1 / 非数字 → 第一页
  assert.equal(pageSlice(rows, 99, 50).page, 3);
  assert.equal(pageSlice(rows, 0, 50).page, 1);
  assert.equal(pageSlice(rows, NaN, 50).page, 1);
  // 空集合也是 1 页，不是 0 页
  assert.deepEqual([pageSlice([], 5, 50).page, pageSlice([], 5, 50).totalPages], [1, 1]);
});

test("pageSlice：切出来的页拼起来正好是全集，不漏不重", () => {
  const rows = Array.from({ length: 237 }, (_, i) => row(String(i), i));
  const seen = [];
  for (let p = 1; p <= pageSlice(rows, 1, 50).totalPages; p++) seen.push(...pageSlice(rows, p, 50).rows);
  assert.equal(seen.length, rows.length);
  assert.deepEqual(seen.map((r) => r.totalTokens), rows.map((r) => r.totalTokens));
});

test("门槛档位是有序的且首档为 0（界面直接拿来做选项）", () => {
  assert.equal(DETAIL_THRESHOLDS[0].key, 0);
  assert.deepEqual(DETAIL_THRESHOLDS.map((t) => t.key), [...DETAIL_THRESHOLDS.map((t) => t.key)].sort((a, b) => a - b));
});

test("hitRate：命中占输入的比例，没有口径时给 null", () => {
  assert.equal(hitRate({ inputTokens: 1000, cacheRead: 900 }), 0.9);
  assert.equal(hitRate({ inputTokens: 14000, cacheRead: 14000 }), 1);
  assert.equal(hitRate({ inputTokens: 1000, cacheRead: 0 }), 0);
  assert.equal(hitRate({ inputTokens: 1000 }), null, "老记录没有 cacheRead，不能当 0% 展示");
  assert.equal(hitRate({ inputTokens: 0, cacheRead: 0 }), null, "输入为 0 时没有比例可言");
  assert.equal(hitRate({ inputTokens: 100, cacheRead: 300 }), 1, "脏数据（命中大于输入）夹到 1");
  assert.equal(hitRate(undefined), null);
});

test("uncachedInput：输入总量减命中，不冒出负数", () => {
  assert.equal(uncachedInput({ inputTokens: 15500, cacheRead: 14000 }), 1500);
  assert.equal(uncachedInput({ inputTokens: 15500 }), 15500, "没有拆分时按输入全是未命中参与排序");
  assert.equal(uncachedInput({ inputTokens: 100, cacheRead: 300 }), 0);
  assert.equal(uncachedInput(undefined), 0);
});

test("viewRows：按未命中输入倒序，同值用时间倒序兜底", () => {
  const rows = [
    { time: "2026-09-28T00:00:00Z", totalTokens: 9000000, inputTokens: 8000000, cacheRead: 7900000 },
    { time: "2026-09-30T00:00:00Z", totalTokens: 5000000, inputTokens: 4000000, cacheRead: 3500000 },
    { time: "2026-09-29T00:00:00Z", totalTokens: 6000000, inputTokens: 1000000, cacheRead: 999000 },
  ];
  const sorted = viewRows(rows, { sort: "uncached" });
  assert.deepEqual(sorted.map((r) => uncachedInput(r)), [500000, 100000, 1000]);
  // 最贵的那条是未命中最多的（总量 500 万），不是总量最大的（900 万那条几乎全命中）
  assert.equal(sorted[0].totalTokens, 5000000);
  assert.equal(sorted.at(-1).totalTokens, 6000000, "未命中只有 1 千的那条排最后");
  assert.equal(rows[0].totalTokens, 9000000, "排序不应改动入参数组");
  const tie = viewRows([{ time: "2026-09-01T00:00:00Z", inputTokens: 100 }, { time: "2026-09-09T00:00:00Z", inputTokens: 100 }], { sort: "uncached" });
  assert.equal(tie[0].time, "2026-09-09T00:00:00Z", "未命中相同时新的排前面");
});

test("排序项：三档齐全且 key 唯一（界面直接拿来做选项）", () => {
  assert.deepEqual(DETAIL_SORTS.map((s) => s.key), ["time", "tokens", "uncached"]);
  assert.equal(new Set(DETAIL_SORTS.map((s) => s.key)).size, DETAIL_SORTS.length);
});
