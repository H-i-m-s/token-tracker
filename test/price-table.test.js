import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PRICE_TABLE, DEFAULT_PRICE_RATE, PRICE_KEYS, normalizePrice, isFlatPrice, isPriced,
  mergePriceTables, pickPrice, calcCost, splitKey,
} from "../lib/price-core.mjs";
import {
  readUserPrices, applyPricePatches, writePriceTable, priceFilePath, PRICE_FILE_COMMENT,
} from "../lib/price-file.mjs";
import { buildPriceCatalog } from "../lib/price-catalog.mjs";
import { loadPriceTable } from "../runtime/engine/services/price-table.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tt-price-"));
const writeJson = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));

// ─────────────────────────────────────────────────────────────────────────────
// 这一组测的是「钱有没有算对」与「价格文件能不能可靠地来回写」。
// 价格错了界面再漂亮也没用，所以每条断言都对着一个具体的算式或一个具体的字节。
//
// 三块分工（改代码前先看这个）：
//   price-core   纯算术，两个进程共用
//   price-file   唯一写盘的地方
//   price-catalog 纯视图，只会吃数据吐分组
// ─────────────────────────────────────────────────────────────────────────────

// ── 一、算钱 ──
test("四个价：input / cacheRead / cacheWrite / output，都是每百万 token 的美元价", () => {
  const price = normalizePrice({ input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 });
  assert.deepEqual(price, { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 });
  const cost = calcCost(price, { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 });
  assert.equal(+cost.toFixed(6), +(0.14 + 0.0028 + 0 + 0.28).toFixed(6));
});

test("缓存写：不填就是 0，填了才算钱", () => {
  const noWrite = normalizePrice({ input: 1, cacheRead: 0.1, output: 2 });
  assert.equal(noWrite.cacheWrite, undefined, "没填的项不该被写成 0（0 是「免费」，undefined 是「没填」）");
  const mv = { input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 };
  assert.equal(calcCost(noWrite, mv), 0, "没填缓存写价，写入一整个 M 也不收钱");

  const withWrite = normalizePrice({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 2 });
  assert.equal(calcCost(withWrite, mv), 1.25, "填了 1.25/M，写 1M 就是 1.25 美元");
});

test("算钱的每一项都按「÷ 1e6」走，不会少除或多除", () => {
  const price = { input: 3, cacheRead: 0.3, cacheWrite: 0, output: 15 };
  assert.equal(calcCost(price, { input: 1e6 }), 3);
  assert.equal(calcCost(price, { output: 1e6 }), 15);
  assert.equal(calcCost(price, { cacheRead: 1e6 }), 0.3);
  // 真实的一笔：125 万输入、8 万输出
  assert.equal(+calcCost(price, { input: 1.25e6, output: 8e4 }).toFixed(6), +(3 * 1.25 + 15 * 0.08).toFixed(6));
});

test("没价格、全 0：算出来是 0，不是 NaN", () => {
  assert.equal(calcCost(null, { input: 1e6 }), 0);
  assert.equal(calcCost(undefined, { input: 1e6 }), 0);
  assert.equal(calcCost({}, { input: 1e6 }), 0);
  assert.equal(calcCost({ input: 0, output: 0 }, { input: 1e6, output: 1e6 }), 0);
  assert.equal(calcCost({ input: 1 }, null), 0);
  assert.equal(calcCost({ input: 1 }, {}), 0);
});

test("长上下文分档：超过门槛才走高价档，不超走基础价", () => {
  const price = {
    input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2,
    contextTiers: [{ maxContext: 272000, input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 }],
  };
  assert.equal(pickPrice(price, { input: 1e5, cacheRead: 0, callCount: 1 }).input, 0.2, "单次 10 万，不超档");
  assert.equal(pickPrice(price, { input: 3e5, cacheRead: 0, callCount: 1 }).input, 0.4, "单次 30 万，超档");
  assert.equal(pickPrice(price, { input: 3e5, cacheRead: 0, callCount: 10 }).input, 0.2, "总共 30 万但分 10 次，单次不超档");
  assert.equal(pickPrice(price, { input: 3e5, callCount: 1 }).maxContext, undefined, "maxContext 不该混进价格对象里");
});

test("长上下文分档把缓存读也算进上下文量（否则高档永远触发不了）", () => {
  const price = { input: 0.2, output: 1, contextTiers: [{ maxContext: 272000, input: 0.4, output: 2 }] };
  assert.equal(pickPrice(price, { input: 1e4, cacheRead: 4e5, callCount: 1 }).input, 0.4, "输入 1 万 + 缓存读 40 万 = 41 万，超档");
});

test("归一化：坏值当没填，不写 0；负数与 Infinity 一律丢掉", () => {
  assert.deepEqual(normalizePrice({ input: "0.14", output: 0.28 }), { input: 0.14, output: 0.28 });
  assert.deepEqual(normalizePrice({ input: -1, output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: Infinity, output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: "abc", output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: "", output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: null, output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: 0, output: 2 }), { input: 0, output: 2 }, "0 是合法的「免费」，要留住");
});

test("旧格式与垃圾键不再被当成价格", () => {
  assert.equal(isFlatPrice({ unit: "token", inputPerM: 0.14 }), false);
  assert.equal(isFlatPrice({ currency: "USD", monthlyAllowance: 60, defaultPrice: {} }), false);
  assert.equal(normalizePrice({ currency: "USD", monthlyAllowance: 60 }), null);
  assert.equal(normalizePrice(null), null);
  assert.equal(normalizePrice("x"), null);
  assert.equal(normalizePrice([]), null);
});

test("isPriced：全 0 等于没配，有一项大于 0 才算配了", () => {
  assert.equal(isPriced(null), false);
  assert.equal(isPriced({}), false);
  assert.equal(isPriced({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }), false);
  assert.equal(isPriced({ input: 0.14 }), true);
  assert.equal(isPriced({ cacheWrite: 0.25 }), true, "只填了缓存写也算配了 —— 它真的会产生费用");
});

test("splitKey：供应商与模型分开，模型名里可以再有斜杠", () => {
  assert.deepEqual(splitKey("deepseek/deepseek-v4-flash"), { provider: "deepseek", model: "deepseek-v4-flash" });
  assert.deepEqual(splitKey("magpie-gateway/workbuddy/deepseek-v4.1-flash"),
    { provider: "magpie-gateway", model: "workbuddy/deepseek-v4.1-flash" });
  assert.deepEqual(splitKey("nope"), { provider: "", model: "nope" });
});

// ── 二、合并与文件 ──
// 断言不写死具体数字：默认价表的基准币种与汇率都可能在将来调整，
// 写死 0.14 这种美元时代的字面量，会让“改基准”看起来像是“算错了”。
// 要验证的是「用户填的覆盖、没填的沿用」，那就直接拿默认表自己当参照物。
test("用户表按项覆盖默认：只填一格不会把另外三格清零", () => {
  const key = "opencode-go/deepseek-v4-flash";
  const def = DEFAULT_PRICE_TABLE[key];
  const merged = mergePriceTables({ [key]: { output: 1 } });
  const entry = merged[key];
  assert.equal(entry.output, 1, "用户填的覆盖默认");
  assert.equal(entry.input, def.input, "没填的项沿用默认，不能被清零");
  assert.equal(entry.cacheRead, def.cacheRead);
  assert.ok(def.input > 0, "默认表本身得是有值的，否则上面两条形同虚设");
});

test("磁盘上的合并：引擎读到的就是 App 层写下去的", () => {
  const dir = tmp();
  const key = "opencode-go/deepseek-v4-flash";
  writeJson(dir, "price-table.json", { [key]: { output: 1 } });
  const table = loadPriceTable(dir);
  assert.equal(table[key].output, 1);
  assert.equal(table[key].input, DEFAULT_PRICE_TABLE[key].input);
});

test("价格文件坏了：不抛、按默认算、文件原样留着（那是用户手改的东西）", () => {
  const dir = tmp();
  const file = priceFilePath(dir);
  fs.writeFileSync(file, "{ 这不是 JSON");
  const warnings = [];
  const table = loadPriceTable(dir, { warn: (m) => warnings.push(m) });
  assert.equal(Object.keys(table).length, Object.keys(DEFAULT_PRICE_TABLE).length, "回到全默认");
  assert.equal(fs.readFileSync(file, "utf8"), "{ 这不是 JSON", "不能偷偷改名或删除用户的文件");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /price-table\.json/);
});

test("文件顶上以 _ 开头的字段不当模型（_comment 用来说明单位）", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { _comment: ["单位：美元 / 每百万 token"], "a/b": { input: 1 } });
  assert.deepEqual(Object.keys(readUserPrices(dir)), ["a/b"]);
});

test("按项写入：只动被点名的那几项，其余原样", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { "a/x": { input: 1 }, "a/y": { input: 2 } });
  assert.equal(applyPricePatches(dir, [{ key: "a/x", price: { input: 9, output: 8 } }]).ok, true);
  const table = readUserPrices(dir);
  assert.deepEqual(table["a/x"], { input: 9, output: 8 });
  assert.deepEqual(table["a/y"], { input: 2 }, "没点名的项不能被改");
});

test("按项写入：price 为 null 表示恢复默认，即从文件里删掉这一项", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { "a/x": { input: 1 }, "a/y": { input: 2 } });
  applyPricePatches(dir, [{ key: "a/x", price: null }]);
  const table = readUserPrices(dir);
  assert.equal(table["a/x"], undefined, "删掉了");
  assert.deepEqual(table["a/y"], { input: 2 }, "别的不动");
});

test("按项写入：坏价格会被拒，且不写盘", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { "a/x": { input: 1 } });
  const bad = applyPricePatches(dir, [{ key: "a/y", price: { input: -5 } }]);
  assert.equal(bad.ok, false, "只剩一个被丢掉的负数 = 没有有效数字，必须拒");
  assert.equal(readUserPrices(dir)["a/y"], undefined, "被拒的写入不能落盘");
  assert.deepEqual(readUserPrices(dir)["a/x"], { input: 1 });
});

test("按项写入：空数组直接拒", () => {
  const dir = tmp();
  assert.equal(applyPricePatches(dir, []).ok, false);
  assert.equal(applyPricePatches(dir, null).ok, false);
});

test("写出来的文件是人能读的：带顶部说明、缩进 2、键有序", () => {
  const dir = tmp();
  writePriceTable(dir, { "b/z": { input: 2 }, "a/x": { input: 1 } });
  const text = fs.readFileSync(priceFilePath(dir), "utf8");
  assert.match(text, /"_comment"/, "顶上要写清单位，用户直接打开文件时第一眼能看到");
  // 单位口径跟着代码里的说明走，而不是在测试里另写一份 ——
  // 写死「美元」的结果就是改基准时测试报错，而代码其实是对的。
  assert.ok(text.includes("人民币 / 每百万 token"), "单位要写人民币");
  assert.match(text, /^\{\n {2}"_comment"/m, "缩进 2");
  assert.ok(text.indexOf('"a/x"') < text.indexOf('"b/z"'), "键按字母序，diff 才不会每次变");
  assert.ok(Array.isArray(PRICE_FILE_COMMENT) && PRICE_FILE_COMMENT.length > 5);
});

// ── 三、用户自己添加 ──
test("用户自己加一个模型：立键 → 出现在清单 → 填价 → 能删", () => {
  const dir = tmp();

  assert.equal(applyPricePatches(dir, [{ key: "v/m", price: {}, declare: true }]).ok, true);
  let cat = buildPriceCatalog({ userPrices: readUserPrices(dir) });
  assert.equal(cat.count, 1, "空价也要出现在清单里，否则用户没法接着填");
  assert.equal(cat.groups[0].items[0].source, "user");
  assert.equal(cat.groups[0].items[0].priced, false, "四个价都没填 = 未定价");

  assert.equal(applyPricePatches(dir, [{ key: "v/m", price: { input: 1, output: 2 } }]).ok, true);
  cat = buildPriceCatalog({ userPrices: readUserPrices(dir) });
  assert.equal(cat.pricedCount, 1);
  assert.equal(cat.groups[0].items[0].price.input, 1);

  assert.equal(applyPricePatches(dir, [{ key: "v/m", price: null }]).ok, true);
  assert.equal(buildPriceCatalog({ userPrices: readUserPrices(dir) }).count, 0);
});

test("空价格对象不能被当成垃圾数据丢掉（否则新加的模型下次刷新就消失）", () => {
  assert.equal(isFlatPrice({}), true);
  assert.deepEqual(normalizePrice({}), {});
  const dir = tmp();
  writeJson(dir, "price-table.json", { "v/m": {} });
  assert.deepEqual(Object.keys(readUserPrices(dir)), ["v/m"]);
});

// ── 四、清单视图（纯数据，不碰 fs） ──
test("并集 = 用过的 ∪ 现在展示的 ∪ 用户写的：三边都收，去重", () => {
  const cat = buildPriceCatalog({
    userPrices: { "mine/own": { input: 1 } },
    shownModels: [
      { provider: "deepseek", model: "deepseek-flash", source: "catalog" },
      { provider: "agnes", model: "agnes-image-2.1-flash", source: "imageGeneration" },
    ],
    usedPairs: [
      { provider: "deepseek", model: "deepseek-flash", tokens: 100, turns: 2, firstDay: "2026-10-01", lastDay: "2026-10-20" },
      { provider: "codekey", model: "gpt-5.6-terra", tokens: 50, turns: 1, firstDay: "2026-08-12", lastDay: "2026-08-15" },
    ],
  });
  const keys = cat.groups.flatMap((g) => g.items).map((i) => i.key).sort();
  assert.deepEqual(keys, ["agnes/agnes-image-2.1-flash", "codekey/gpt-5.6-terra", "deepseek/deepseek-flash", "mine/own"]);
  const shared = cat.groups.flatMap((g) => g.items).find((i) => i.key === "deepseek/deepseek-flash");
  assert.deepEqual(shared.origin.sort(), ["shown", "used"]);
});

test("程序自带的默认价不会凭自己进清单（否则会铺出一堆用不上的行）", () => {
  const cat = buildPriceCatalog({ userPrices: {}, shownModels: [], usedPairs: [] });
  assert.equal(cat.count, 0, "没有任何用量、没配任何展示模型时，清单是空的");
  assert.equal(Object.keys(DEFAULT_PRICE_TABLE).length > 10, true, "但默认表本身是有内容的");
});

test("清单里每项都带来源标记：填过 / 默认 / 未填", () => {
  const cat = buildPriceCatalog({
    userPrices: { "a/mine": { input: 1 } },
    usedPairs: [
      { provider: "opencode-go", model: "deepseek-v4-flash", tokens: 10, turns: 1 },
      { provider: "b", model: "nothing", tokens: 5, turns: 1 },
    ],
  });
  const byKey = new Map(cat.groups.flatMap((g) => g.items).map((i) => [i.key, i]));
  assert.equal(byKey.get("a/mine").source, "user");
  assert.equal(byKey.get("opencode-go/deepseek-v4-flash").source, "default");
  assert.equal(byKey.get("b/nothing").source, "none");
  assert.equal(
    byKey.get("opencode-go/deepseek-v4-flash").defaultPrice.input,
    DEFAULT_PRICE_TABLE["opencode-go/deepseek-v4-flash"].input,
    "默认价要原样带过去，界面才能当占位符",
  );
});

test("块内按用量降序；块自己带统计（界面上块头要用）", () => {
  const cat = buildPriceCatalog({
    userPrices: { "a/m1": { input: 1 } },
    usedPairs: [
      { provider: "a", model: "m1", tokens: 100, turns: 5 },
      { provider: "a", model: "m2", tokens: 50, turns: 2 },
    ],
  });
  const group = cat.groups.find((g) => g.provider === "a");
  assert.deepEqual(group.items.map((i) => i.model), ["m1", "m2"]);
  assert.equal(group.total, 2);
  assert.equal(group.pricedCount, 1);
  assert.equal(group.tokens, 150);
});

test("同一个键在 used 与 shown 都出现时只算一次，不重复出行", () => {
  const cat = buildPriceCatalog({
    shownModels: [{ provider: "x", model: "y", source: "catalog" }, { provider: "x", model: "y", source: "catalog" }],
    usedPairs: [{ provider: "x", model: "y", tokens: 1, turns: 1 }],
  });
  assert.equal(cat.count, 1);
});

// ── 模型级默认价：按模型名回退 ──
// 同一条价常被多个供应商共用（官方、自建中转、聚合网关），
// 内置表里因此有一份只按模型名登记的价，作为 provider/model 查不到时的回退。

test("模型级默认价：供应商级没登记时按模型名回退", () => {
  const cat = buildPriceCatalog({
    usedPairs: [{ provider: "some-proxy", model: "deepseek-flash", tokens: 100, turns: 1 }],
  });
  const item = cat.groups.flatMap((g) => g.items).find((i) => i.key === "some-proxy/deepseek-flash");
  assert.equal(item.source, "default", "应当从模型级默认价取到");
  assert.equal(item.defaultPrice.input, 1);
  assert.equal(item.priced, true);
});

test("模型级默认价：用户填的 provider/model 仍然压过它", () => {
  const cat = buildPriceCatalog({
    userPrices: { "some-proxy/deepseek-flash": { input: 9 } },
    usedPairs: [{ provider: "some-proxy", model: "deepseek-flash", tokens: 100, turns: 1 }],
  });
  const item = cat.groups.flatMap((g) => g.items).find((i) => i.key === "some-proxy/deepseek-flash");
  assert.equal(item.source, "user");
  assert.equal(item.effective.input, 9, "用户值不能被默认价盖回去");
});

test("模型级默认价：供应商级内置价优先于模型级", () => {
  // opencode-go/deepseek-v4-flash 在旧表里有专门的供应商级价，不能被新增的
  // 模型级 deepseek-v4-flash 顶掉。
  const vendor = DEFAULT_PRICE_TABLE["opencode-go/deepseek-v4-flash"];
  const modelLevel = DEFAULT_PRICE_TABLE["deepseek-v4-flash"];
  assert.ok(vendor && modelLevel);
  assert.notEqual(vendor.input, modelLevel.input, "两份价本来就不同，否则这条断言没意义");
  const cat = buildPriceCatalog({
    usedPairs: [{ provider: "opencode-go", model: "deepseek-v4-flash", tokens: 1, turns: 1 }],
  });
  const item = cat.groups.flatMap((g) => g.items).find((i) => i.key === "opencode-go/deepseek-v4-flash");
  assert.equal(item.defaultPrice.input, vendor.input, "优先取供应商级");
});

test("模型级别名各有一条价，不做自动归一化", () => {
  for (const m of [
    "deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp",
    "deepseek-v4.1-flash", "DeepSeek-V4-Flash", "DeepSeek-V4.1-Flash", "DeepSeek-V4.1-Flash-1017",
    "x-deepseek-flash", "sn-deepseek-v4-1-flash-1017",
  ]) {
    assert.ok(DEFAULT_PRICE_TABLE[m], `${m} 应当有价`);
    assert.equal(DEFAULT_PRICE_TABLE[m].input, 1, `${m} 应当与 deepseek-flash 同价`);
  }
  for (const m of [
    "glm-5.3-flash", "glm-5-3-flash", "glm-5-3-flash-260828", "GLM-5.3-Flash", "sn-glm-5-3-flash",
  ]) {
    assert.ok(DEFAULT_PRICE_TABLE[m], `${m} 应当有价`);
    assert.equal(DEFAULT_PRICE_TABLE[m].output, 2.8);
  }
});

test("小米 MiMo 已下线但保留历史价，同档型号价一致", () => {
  assert.deepEqual(
    DEFAULT_PRICE_TABLE["mimo-v2.5"],
    { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 2 },
  );
  assert.deepEqual(
    DEFAULT_PRICE_TABLE["mimo-v2.5-pro"],
    { input: 3, cacheRead: 0.025, cacheWrite: 0, output: 6 },
  );
});

test("raccoon 中转的 sn-* 名能按模型级查到价", () => {
  const cat = buildPriceCatalog({
    usedPairs: [
      { provider: "raccoon", model: "sn-deepseek-v4-1-flash-1017", tokens: 2, turns: 1 },
      { provider: "raccoon", model: "sn-glm-5-3-flash", tokens: 1, turns: 1 },
    ],
  });
  const byKey = new Map(cat.groups.flatMap((g) => g.items).map((i) => [i.key, i]));
  assert.equal(byKey.get("raccoon/sn-deepseek-v4-1-flash-1017").priced, true);
  assert.equal(byKey.get("raccoon/sn-glm-5-3-flash").priced, true);
});

test("DeepSeek 分时：工作日高峰双倍，其余时段与周末按平峰", () => {
  const p = DEFAULT_PRICE_TABLE["deepseek-flash"];
  const morning = { minutes: 10 * 60, weekday: 3 };   // 周三 10:00，高峰
  const noon = { minutes: 13 * 60, weekday: 3 };      // 周三 13:00，午间平峰
  const weekend = { minutes: 10 * 60, weekday: 6 };   // 周六 10:00，全天平峰
  assert.equal(pickPrice(p, { input: 1_000_000 }, morning).input, 2, "工作日 9–12 是高峰");
  assert.equal(pickPrice(p, { input: 1_000_000 }, noon).input, 1, "午间回落平峰");
  assert.equal(pickPrice(p, { input: 1_000_000 }, weekend).input, 1, "周末全天平峰");
  assert.equal(pickPrice(p, { input: 1_000_000 }, morning).output, 8);
});

test("美元来源的模型级价按基准汇率换算，人民币来源的保持原值", () => {
  const gpt = DEFAULT_PRICE_TABLE["gpt-5.6-sol"];
  assert.ok(Math.abs(gpt.input - 4 * DEFAULT_PRICE_RATE) < 0.01);
  assert.ok(Math.abs(gpt.output - 20 * DEFAULT_PRICE_RATE) < 0.01);
  assert.equal(DEFAULT_PRICE_TABLE["glm-5.3-flash"].input, 0.8, "人民币原价不该被乘汇率");
});
