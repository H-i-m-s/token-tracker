import test from "node:test";
import assert from "node:assert/strict";
import { providerModelMatcher, sumProviderTotals } from "../runtime/engine/services/dashboard-filter.js";

// 供应商/模型筛选只有一个谓词与一种取数方式。这一层错了就是数字错，而且错误方式很隐蔽：
// 时段图里 desktop 正好翻倍、模型榜与顶部总量对不上，都是从这里长出来的。

test("providerModelMatcher：都不选时返回 null（走桶自带的合计）", () => {
  assert.equal(providerModelMatcher([], []), null);
  assert.equal(providerModelMatcher(undefined, undefined), null);
});

test("providerModelMatcher：只选供应商", () => {
  const m = providerModelMatcher(["deepseek"], []);
  assert.equal(m("deepseek/deepseek-v4-flash"), true);
  assert.equal(m("deepseek/deepseek-v4-pro"), true);
  assert.equal(m("商汤科技/deepseek-v4-flash"), false);
  // 模型同名但供应商不同，不该混进来
  assert.equal(m("mimo/mimo-v2.5"), false);
});

test("providerModelMatcher：只选模型（同名模型跨供应商都算）", () => {
  const m = providerModelMatcher([], ["gpt-5.6-terra"]);
  assert.equal(m("这就是ai-gpt/gpt-5.6-terra"), true);
  assert.equal(m("codekey/gpt-5.6-terra"), true);
  assert.equal(m("deepseek/gpt-5.6-terra"), true);
  assert.equal(m("deepseek/deepseek-v4-flash"), false);
});

test("providerModelMatcher：供应商+模型取交集，不是并集", () => {
  const m = providerModelMatcher(["这就是ai-gpt"], ["gpt-5.6-terra"]);
  assert.equal(m("这就是ai-gpt/gpt-5.6-terra"), true);
  // 同一个模型挂在别的供应商下：不是交集，必须排除
  assert.equal(m("codekey/gpt-5.6-terra"), false);
  // 同一个供应商下的别的模型：也不是交集
  assert.equal(m("这就是ai-gpt/gpt-5.6-luna-xhigh"), false);
});

test("providerModelMatcher：模型 id 自带斜杠时只按第一个斜杠切", () => {
  // 真实数据里有 magpie-gateway/workbuddy/deepseek-v4.1-flash 这种键
  const m = providerModelMatcher(["magpie-gateway"], ["workbuddy/deepseek-v4.1-flash"]);
  assert.equal(m("magpie-gateway/workbuddy/deepseek-v4.1-flash"), true);
  assert.equal(providerModelMatcher(["magpie-gateway"], [])("magpie-gateway/workbuddy/deepseek-v4.1-flash"), true);
  assert.equal(providerModelMatcher(["magpie"], ["workbuddy/deepseek-v4.1-flash"])("magpie-gateway/workbuddy/deepseek-v4.1-flash"), false);
});

test("sumProviderTotals：只加命中的项，缺字段/null/NaN 一律当 0", () => {
  const bucket = {
    providerTotals: {
      "a/m1": { totalTokens: 10, input: 6, output: 4, cacheRead: 3, assistantCount: 1 },
      "a/m2": { totalTokens: 5, input: 2, output: 3, cacheRead: null, assistantCount: NaN },
      "b/m1": { totalTokens: 100, input: 90, output: 10, cacheRead: 80, assistantCount: 9 },
      "c/m3": { totalTokens: 7 }, // 字段缺一大半
    },
  };
  const a = sumProviderTotals(bucket, providerModelMatcher(["a"], []));
  assert.deepEqual(a, { totalTokens: 15, input: 8, output: 7, cacheRead: 3, cacheWrite: 0, assistantCount: 1 });

  const c = sumProviderTotals(bucket, providerModelMatcher(["c"], []));
  assert.deepEqual(c, { totalTokens: 7, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0 });

  // 空桶 / 没传谓词都不能炸
  assert.equal(sumProviderTotals({}, providerModelMatcher(["a"], [])).totalTokens, 0);
  assert.equal(sumProviderTotals(bucket, null).totalTokens, 0);
});

test("sumProviderTotals：只认 providerTotals 一层，不再去 models 二次累加", () => {
  // 这条是回归测试：时段图的 desktop/channel 曾经被 providerTotals 与 models 各加一次，
  // 按供应商筛选时正好翻倍（实测 150,929,360 vs 75,464,680）。
  // 桶里故意让两层携带同样的数，结果必须等于 providerTotals 那一层，不能是两倍。
  const bucket = {
    providerTotals: {
      "a/m1": { totalTokens: 10, desktop: 8, channel: 2, cacheRead: 5, assistantCount: 1 },
    },
    models: {
      m1: { totalTokens: 10, desktop: 8, channel: 2, cacheRead: 5, assistantCount: 1 },
    },
  };
  const fields = ["totalTokens", "desktop", "channel", "cacheRead", "assistantCount"];
  const t = sumProviderTotals(bucket, providerModelMatcher(["a"], []), fields);
  assert.deepEqual(t, { totalTokens: 10, desktop: 8, channel: 2, cacheRead: 5, assistantCount: 1 });
});

test("sumProviderTotals：时段桶的 type 拆分也能按筛选加起来", () => {
  const bucket = {
    providerTotals: {
      "a/m1": { totalTokens: 100, desktop: 60, channel: 10, bridge: 5, background: 20, sub: 3, ledger: 2, cacheRead: 40, assistantCount: 4 },
      "b/m2": { totalTokens: 50, desktop: 50, channel: 0, cacheRead: 20, assistantCount: 2 },
    },
  };
  const fields = ["totalTokens", "desktop", "channel", "bridge", "background", "sub", "ledger", "cacheRead", "assistantCount"];
  const t = sumProviderTotals(bucket, providerModelMatcher(["a"], []), fields);
  assert.equal(t.totalTokens, 100);
  assert.equal(t.desktop, 60);
  assert.equal(t.bridge, 5);
  assert.equal(t.ledger, 2);
  // 各 type 之和必须回到总量
  assert.equal(t.desktop + t.channel + t.bridge + t.background + t.sub + t.ledger, t.totalTokens);
});

