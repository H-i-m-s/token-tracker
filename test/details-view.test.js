import test from "node:test";
import assert from "node:assert/strict";
import { viewRows, sumTokens, pageSlice, DETAIL_THRESHOLDS } from "../ui/details-view.mjs";

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
