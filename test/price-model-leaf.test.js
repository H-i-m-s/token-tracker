// 默认价按「型号」认，不按供应商认。
//
// 起因很具体：magpie-gateway 下的模型 id 是 zcode/GLM-5.3-Flash、raccoon/sn-glm-5-3-flash，
// 中转把自家路由写进了模型名。splitKey 只切第一个斜杠，模型名于是还剩一层前缀，
// 拿全名去默认表里找永远空着。结果是同一款 GLM-5.3-Flash，在火山引擎下配了价、
// 在 magpie-gateway 下显示「未定价」。
import test from "node:test";
import assert from "node:assert/strict";

import { modelLeaf, splitKey, DEFAULT_PRICE_TABLE, mergePriceTables, pickPrice } from "../lib/price-core.mjs";
import { buildPriceCatalog } from "../lib/price-catalog.mjs";

test("modelLeaf 剥到模型名最后一段", () => {
  assert.equal(modelLeaf("zcode/GLM-5.3-Flash"), "GLM-5.3-Flash");
  assert.equal(modelLeaf("raccoon/sn-glm-5-3-flash"), "sn-glm-5-3-flash");
  assert.equal(modelLeaf("a/b/c"), "c");
  assert.equal(modelLeaf("deepseek-v4-flash"), "deepseek-v4-flash", "没有斜杠就是它自己");
  assert.equal(modelLeaf(""), "");
  assert.equal(modelLeaf(null), "");
});

test("splitKey 仍然只切第一个斜杠", () => {
  assert.deepEqual(splitKey("magpie-gateway/zcode/GLM-5.3-Flash"), {
    provider: "magpie-gateway",
    model: "zcode/GLM-5.3-Flash",
  });
});

test("带路由前缀的模型名也拿得到默认价", () => {
  const { groups } = buildPriceCatalog({
    userPrices: {},
    usedPairs: [
      { provider: "magpie-gateway", model: "zcode/GLM-5.3-Flash", tokens: 100 },
      { provider: "火山引擎", model: "glm-5-3-flash", tokens: 100 },
      { provider: "magpie-gateway", model: "raccoon/sn-glm-5-3-flash", tokens: 100 },
    ],
  });
  const byProvider = Object.fromEntries(groups.map((g) => [g.provider, g.items]));
  const zcode = byProvider["magpie-gateway"].find((i) => i.model === "zcode/GLM-5.3-Flash");
  const volcano = byProvider["火山引擎"].find((i) => i.model === "glm-5-3-flash");
  assert.equal(zcode.source, "default", "带前缀的那家也该认得出默认价");
  assert.equal(zcode.effective.input, 0.8);
  assert.equal(volcano.effective.output, 2.8);
  assert.equal(zcode.effective.output, volcano.effective.output, "同一款型号的价必须一致");
});

test("用户填的整键仍然优先于默认价", () => {
  const { groups } = buildPriceCatalog({
    userPrices: { "magpie-gateway/zcode/GLM-5.3-Flash": { input: 9, cacheRead: 1, cacheWrite: 0, output: 9 } },
    usedPairs: [{ provider: "magpie-gateway", model: "zcode/GLM-5.3-Flash", tokens: 100 }],
  });
  const item = groups[0].items[0];
  assert.equal(item.source, "user");
  assert.equal(item.effective.input, 9);
  assert.equal(item.defaultPrice.input, 0.8, "恢复默认要拿得到默认价");
});

test("mergePriceTables 的底子也会剥前缀继承", () => {
  const merged = mergePriceTables({
    // 只填了输入价，其它三格应当从同型号的默认价继承，而不是当 0
    "magpie-gateway/zcode/GLM-5.3-Flash": { input: 1.5 },
  });
  const price = merged["magpie-gateway/zcode/GLM-5.3-Flash"];
  assert.equal(price.input, 1.5);
  assert.equal(price.output, DEFAULT_PRICE_TABLE["GLM-5.3-Flash"].output ?? 2.8);
  assert.equal(price.cacheRead, 0.23);
});

test("固化后的实付价：四价齐全，分时只出现在真配了分时的那几个", () => {
  const sol = DEFAULT_PRICE_TABLE["gpt-5.6-sol"];
  assert.deepEqual(sol, { input: 1.15, cacheRead: 0.115, cacheWrite: 0, output: 6.9 });

  const pro = DEFAULT_PRICE_TABLE["deepseek-v4-pro"];
  assert.equal(pro.input, 4.5);
  assert.equal(pro.output, 13.5);
  assert.equal(pro.timeTiers.length, 2);
  assert.equal(pickPrice(pro, { input: 1_000_000 }, { minutes: 10 * 60, weekday: 3 }).input, 9);
  assert.equal(pickPrice(pro, { input: 1_000_000 }, { minutes: 13 * 60, weekday: 3 }).input, 4.5);

  // V4-Flash 的输出价是 2，和 deepseek-flash 那档的 4 不是一回事。
  assert.equal(DEFAULT_PRICE_TABLE["deepseek-v4-flash"].output, 2);
  assert.equal(DEFAULT_PRICE_TABLE["deepseek-flash"].output, 4);

  // 没填分时的型号不能凭空长出一个 timeTiers。
  assert.equal(DEFAULT_PRICE_TABLE["gpt-5.6-luna"].timeTiers, undefined);
  assert.equal(DEFAULT_PRICE_TABLE["grok-4.7-build-fast"].output, 1.02);
});
