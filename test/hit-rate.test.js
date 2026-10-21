import test from "node:test";
import assert from "node:assert/strict";
import { hitRate, hitRatePercent, hitRatePercentText } from "../runtime/engine/services/hit-rate.js";
import { hitRate as uiHitRate } from "../ui/details-view.mjs";

// 命中率只有一个口径：缓存读 / 输入总量（含缓存读、不含输出）。
// 这里同时钉两件事：
//   1. 边界与百分比换算
//   2. 引擎侧（KPI / 实时面板）与前端明细行用的是同一个公式 —— 两处曾经各算一套，
//      拿明细去核对 KPI 永远对不上，而且没有一处说明它们不是一回事。

test("hitRate：缓存读 / 输入总量（含缓存读）", () => {
  // 输入 1000 里有 900 是缓存读 → 90%
  assert.equal(hitRate(900, 1000), 0.9);
  assert.equal(hitRate(0, 1000), 0);
  assert.equal(hitRate(1000, 1000), 1);
  // 缓存读不该超过输入总量；真超了也只能是 100%，不能给出 1.2 这种数
  assert.equal(hitRate(1200, 1000), 1);
});

test("hitRate：分母无效时返回 null，不用 0 冒充", () => {
  assert.equal(hitRate(100, 0), null);
  assert.equal(hitRate(100, -5), null);
  assert.equal(hitRate(100, NaN), null);
  assert.equal(hitRate(100, undefined), null);
});

test("hitRatePercent / hitRatePercentText：一位小数，分母无效时给 0（界面契约）", () => {
  assert.equal(hitRatePercent(900, 1000), 90);
  assert.equal(hitRatePercent(2, 3), 66.7);
  assert.equal(hitRatePercent(1, 0), 0);
  assert.equal(hitRatePercentText(2, 3), "66.7");
  assert.equal(hitRatePercentText(NaN, NaN), "0.0");
});

test("与明细行（ui/details-view.hitRate）同一个公式", () => {
  // 明细行传的是行里的输入列，那一列本来就把缓存读并进去了。
  const rows = [
    { cacheRead: 900, inputTokens: 1000 },
    { cacheRead: 159428, inputTokens: 159587 },
    { cacheRead: 0, inputTokens: 500 },
    { cacheRead: 250, inputTokens: 250 },
    { cacheRead: 1, inputTokens: 8246193 },
  ];
  for (const r of rows) {
    const ui = uiHitRate(r);
    const engine = hitRate(r.cacheRead, r.inputTokens);
    assert.equal(engine, ui, `cacheRead=${r.cacheRead} input=${r.inputTokens}`);
  }
});

test("KPI 的口径：分母不能带输出", () => {
  // 一个真实形状的会话：未命中输入 512,979、缓存读 82,007,936、输出 307,635
  // 旧算法 cacheRead / totalTokens（= 输入+输出+缓存读）= 96.4%，把输出算进了分母；
  // 正确口径 cacheRead /（未命中 + 缓存读）= 99.4%，与明细行一致。
  const uncached = 512979, cacheRead = 82007936, output = 307635;
  const correct = hitRate(cacheRead, uncached + cacheRead);
  const wrong = cacheRead / (uncached + cacheRead + output);
  assert.ok(correct > wrong, "带输出的分母会系统性压低命中率");
  assert.equal(hitRatePercent(cacheRead, uncached + cacheRead), 99.4);
});
