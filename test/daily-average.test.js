import test from "node:test";
import assert from "node:assert/strict";
import { dailyAverage, calendarDays } from "../ui/analytics.mjs";

// KPI 上那格「日均消耗」只在窗口超过一天时出现，分母是所选范围的日历天数。
//
// 分母口径只有一种：calendarDays 的跨度（含中间没有记录的空白日），不取“有记录的天数”。
// 理由：日图的横轴就是这个跨度，零用量那天在图上占一格，除它才对得上眼前的图。

test("日均 = 合计 ÷ 日历天数", () => {
  assert.equal(dailyAverage(700, 7), 100);
  assert.equal(Math.round(dailyAverage(27_741_149_876, 170)), 163_183_235);
});

test("单日区间：日均恰好等于合计", () => {
  const total = 25_895_833;
  assert.equal(dailyAverage(total, 1), total);
});

test("天数不合法时返回 null（让上层写「—」，不吐 Infinity / NaN）", () => {
  assert.equal(dailyAverage(100, 0), null);
  assert.equal(dailyAverage(100, -1), null);
  assert.equal(dailyAverage(NaN, 7), null);
  assert.equal(dailyAverage(undefined, 7), null);
  assert.equal(dailyAverage(100, undefined), null);
  assert.equal(dailyAverage(100, "七"), null);
});

test("分母来自跨度而不是桶数：中间空一天也要算进分母", () => {
  // 10-01 到 10-03 共 3 天，但只有两天有记录
  const analytics = { daily: [{ date: "2026-10-01" }, { date: "2026-10-03" }] };
  const days = calendarDays(analytics, { range: "all", from: "2026-10-01", to: "2026-10-03" });
  assert.deepEqual(days, ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(dailyAverage(300, days.length), 100, "不能算成 300/2 = 150");
});

test("自选单日：from 与 to 同一天时只算一天", () => {
  const analytics = { daily: [{ date: "2026-10-20" }] };
  const days = calendarDays(analytics, { range: "all", from: "2026-10-20", to: "2026-10-20" });
  assert.equal(days.length, 1, "单日窗口要触发「显示单轮 P90」那条分支");
});
