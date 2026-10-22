import test from "node:test";
import assert from "node:assert/strict";
import { shapeSnapshot } from "../lib/snapshot-service.mjs";

// 显示口径（数字单位 / 货币 / 汇率）是过桥到页面的那几项设置：由引擎搭在快照上，
// 页面靠它们决定万/亿 还是 K/M/B、写美元 还是人民币。这一层只是过桥，
// 所以只盯两件事：带的原样过去，没带就是 null
//（null 与 "zh" 是两回事：前者不该让页面把数字按中文重画一遍）。
test("快照把 display 原样带过去", () => {
  const shaped = shapeSnapshot({ display: { units: "en", currency: "cny", fxRate: 7.1 }, realtime: null, balances: [], agentNames: {} });
  assert.deepEqual(shaped.display, { units: "en", currency: "cny", fxRate: 7.1 });
});

test("货币与汇率没带时不该凭空补上（页面要能分辨「没告诉我」与「用美元」）", () => {
  const shaped = shapeSnapshot({ display: { units: "zh" }, realtime: null, balances: [], agentNames: {} });
  assert.equal(shaped.display.currency, undefined);
  assert.equal(shaped.display.fxRate, undefined);
});

test("引擎没带 display 时是 null，不是默认值", () => {
  assert.equal(shapeSnapshot({ realtime: null, balances: [] }).display, null);
  assert.equal(shapeSnapshot({}).display, null);
});

test("过桥不影响快照原有的字段", () => {
  const shaped = shapeSnapshot({ realtime: null, balances: [], agentNames: { a: "甲" }, lastScan: 123, ready: true, persist: { writes: 3 } });
  assert.deepEqual(shaped.agentNames, { a: "甲" });
  assert.equal(shaped.updatedAt, 123);
  assert.equal(shaped.ready, true);
  assert.deepEqual(shaped.persist, { writes: 3 });
  assert.equal(shaped.realtime.connected, false);
  assert.deepEqual(shaped.balances, []);
});
