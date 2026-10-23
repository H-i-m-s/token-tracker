// 分时定价与按次计价。
//
// 这一组测的是「同一个模型，在不同时刻、不同调用次数下，钱算得对不对」。
// 每条断言都对着一个具体算式，不测「字段是否存在」。

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseClock, matchTimeTier, normalizeTimeTiers, pickPrice, calcCost,
  normalizePrice, isFlatPrice, isPriced,
} from "../lib/price-core.mjs";
import { toStoredPrice } from "../ui/price-money.mjs";

const at = (hh, mm = 0, weekday = 1) => ({ minutes: hh * 60 + mm, weekday });

// ── 时刻解析 ────────────────────────────────────────────────────────────────

test("parseClock 认 HH:MM 两种宽度，越界与乱写返回 null", () => {
  assert.equal(parseClock("08:00"), 480);
  assert.equal(parseClock("8:00"), 480);
  assert.equal(parseClock("23:59"), 1439);
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("08:60"), null);
  assert.equal(parseClock("8点"), null);
  assert.equal(parseClock(""), null);
});

// ── 时段归属 ────────────────────────────────────────────────────────────────

test("忙时段左闭右开：08:00 进忙时，22:00 出忙时", () => {
  const tiers = normalizeTimeTiers([
    { from: "08:00", to: "22:00", output: 16 },
    { output: 8 },
  ]);
  assert.equal(matchTimeTier(tiers, at(8, 0)).output, 16, "08:00 应算忙时");
  assert.equal(matchTimeTier(tiers, at(21, 59)).output, 16, "21:59 应算忙时");
  assert.equal(matchTimeTier(tiers, at(22, 0)).output, 8, "22:00 应已出忙时");
  assert.equal(matchTimeTier(tiers, at(7, 59)).output, 8, "07:59 应算闲时");
});

test("跨午夜：22:00→08:00 命中当晚与次日凌晨两头", () => {
  const tiers = normalizeTimeTiers([
    { from: "22:00", to: "08:00", output: 8 },
    { output: 16 },
  ]);
  assert.equal(matchTimeTier(tiers, at(23, 0)).output, 8);
  assert.equal(matchTimeTier(tiers, at(2, 0)).output, 8);
  assert.equal(matchTimeTier(tiers, at(7, 59)).output, 8);
  assert.equal(matchTimeTier(tiers, at(8, 0)).output, 16);
  assert.equal(matchTimeTier(tiers, at(15, 0)).output, 16);
});

test("days 限定：周末不享受工作日的忙时定义", () => {
  const tiers = normalizeTimeTiers([
    { from: "08:00", to: "22:00", days: [1, 2, 3, 4, 5], output: 16 },
    { output: 8 },
  ]);
  assert.equal(matchTimeTier(tiers, at(10, 0, 1)).output, 16, "周一上午");
  assert.equal(matchTimeTier(tiers, at(10, 0, 6)).output, 8, "周六上午该走兜底");
  assert.equal(matchTimeTier(tiers, at(10, 0, 0)).output, 8, "周日上午该走兜底");
});

test("没有兜底段时，落在空档返回 null（用基础四价）", () => {
  const tiers = normalizeTimeTiers([{ from: "08:00", to: "12:00", output: 16 }]);
  assert.equal(matchTimeTier(tiers, at(10, 0)).output, 16);
  assert.equal(matchTimeTier(tiers, at(20, 0)), null);
});

test("时段里只写 output 时，input 仍用基础价", () => {
  const price = { input: 2, output: 8, timeTiers: [{ from: "08:00", to: "22:00", output: 16 }] };
  const busy = pickPrice(price, { input: 1e6 }, at(10, 0));
  const idle = pickPrice(price, { input: 1e6 }, at(23, 0));
  assert.equal(busy.input, 2, "忙时段没写 input，应沿用基础价");
  assert.equal(busy.output, 16);
  assert.equal(idle.output, 8);
});

// ── 算钱 ────────────────────────────────────────────────────────────────────

test("同一百万输出 token，忙时与闲时差一倍", () => {
  const price = {
    input: 2, output: 8,
    timeTiers: [{ from: "08:00", to: "22:00", output: 16 }, { output: 8 }],
  };
  const mv = { output: 1e6, assistantCount: 1 };
  assert.equal(calcCost(price, mv, at(10, 0)), 16);
  assert.equal(calcCost(price, mv, at(23, 0)), 8);
});

test("不传 at 时走基础价，不会拿到时段价也不会是 0", () => {
  const price = { input: 2, output: 8, timeTiers: [{ from: "08:00", to: "22:00", output: 16 }] };
  assert.equal(calcCost(price, { output: 1e6, assistantCount: 1 }), 8);
});

test("按次计价：次数 × 单次价，与 token 部分相加", () => {
  const price = { input: 0, output: 0, perCall: 0.05 };
  assert.equal(calcCost(price, { callCount: 10 }), 0.5);
  assert.equal(calcCost(price, { callCount: 0 }), 0);

  const mixed = { input: 1, perCall: 0.02 };
  // 1e6 input 各 1 元 + 3 次 × 0.02
  assert.equal(calcCost(mixed, { input: 1e6, callCount: 3 }), 1.06);
});

test("0 次调用不会被按成 1 次", () => {
  const price = { perCall: 1 };
  assert.equal(calcCost(price, { callCount: 0 }), 0);
  assert.equal(calcCost(price, {}), 0);
});

test("时段价与上下文分档叠加：先按时段取价，再按档位覆盖", () => {
  const price = {
    input: 2,
    timeTiers: [{ from: "08:00", to: "22:00", input: 4 }, {}],
    contextTiers: [{ maxContext: 272000, input: 8 }],
  };
  // 忙时 + 单次上下文超 272K：时段价先给 4，档位再覆盖成 8
  const ap = pickPrice(price, { input: 400000, assistantCount: 1 }, at(10, 0));
  assert.equal(ap.input, 8);
});

// ── 归一化与往返 ────────────────────────────────────────────────────────────

test("normalizePrice 保留 timeTiers 与 perCall", () => {
  const out = normalizePrice({
    input: 2,
    timeTiers: [{ from: "08:00", to: "22:00", input: 4 }, { input: 2 }],
    perCall: 0.03,
  });
  assert.equal(out.perCall, 0.03);
  assert.equal(out.timeTiers.length, 2);
  assert.equal(out.timeTiers[0].from, "08:00");
});

test("空时段表当没配，不会留一个空数组", () => {
  const out = normalizePrice({ input: 2, timeTiers: [] });
  assert.equal(out.timeTiers, undefined);
  assert.deepEqual(Object.keys(out), ["input"]);
});

test("坏段被丢掉：没价、时间写错", () => {
  const out = normalizePrice({
    input: 2,
    timeTiers: [
      { from: "08:00", to: "22:00" },        // 只有时间没有价
      { from: "25:00", to: "26:00", input: 4 }, // 时间非法
      { input: 1 },
    ],
  });
  assert.equal(out.timeTiers.length, 1, "只应剩那段没有时间窗的兜底");
  assert.equal(out.timeTiers[0].input, 1);
});

test("旧格式（只有四价）照样能读，不会因为新字段崩", () => {
  const out = normalizePrice({ input: 2, cacheRead: 0.2, output: 8 });
  assert.deepEqual(out, { input: 2, cacheRead: 0.2, output: 8 });
  assert.equal(isFlatPrice({ input: 2 }), true);
});

test("只配了时段价的模型算「已定价」", () => {
  assert.equal(isPriced({ timeTiers: [{ from: "08:00", to: "22:00", output: 16 }] }), true);
  assert.equal(isPriced({ perCall: 0.05 }), true);
  assert.equal(isPriced({ input: 0 }), false);
});

test("界面写盘这一层不能丢 timeTiers / perCall", () => {
  const stored = toStoredPrice({
    input: 2,
    perCall: 0.03,
    timeTiers: [{ from: "08:00", to: "22:00", output: 16 }, { output: 8 }],
  });
  assert.equal(stored.perCall, 0.03);
  assert.equal(stored.timeTiers.length, 2);
  assert.equal(stored.timeTiers[0].output, 16);
  assert.equal(stored.timeTiers[1].output, 8);
});
