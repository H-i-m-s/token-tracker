import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PRICE_TABLE, normalizePrice, isFlatPrice, isPriced,
  readUserPriceTable, loadPriceTable, pickPrice, calcCost,
} from "../runtime/engine/services/price-table.js";
import { splitKey, buildPriceCatalog, applyPricePatches, writePriceTable } from "../runtime/engine/services/price-catalog.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tt-price-"));
const writeJson = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));

// ─────────────────────────────────────────────────────────────────────────────
// 这一组测的是「钱有没有算对」。价格错了界面再漂亮也没用，
// 所以每条断言都对着一个具体的算式，而不是「形状看起来对」。
// ─────────────────────────────────────────────────────────────────────────────

test("四个价：input / cacheRead / cacheWrite / output，都是每百万 token 的美元价", () => {
  const price = normalizePrice({ input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 });
  assert.deepEqual(price, { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 });
  // 1M 输入 + 1M 缓存读 + 1M 缓存写 + 1M 输出 = 四个单价之和
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
  assert.equal(calcCost(price, { input: 500000 }), 1.5);
  // 真实的一笔：125 万输入、8 万输出
  const real = calcCost(price, { input: 1.25e6, output: 8e4 });
  assert.equal(+real.toFixed(6), +(3 * 1.25 + 15 * 0.08).toFixed(6));
});

test("没价格、全 0：算出来是 0，不是 NaN", () => {
  assert.equal(calcCost(null, { input: 1e6 }), 0);
  assert.equal(calcCost(undefined, { input: 1e6 }), 0);
  assert.equal(calcCost({}, { input: 1e6 }), 0);
  assert.equal(calcCost({ input: 0, output: 0 }, { input: 1e6, output: 1e6 }), 0);
  // 用量缺失也不能炸
  assert.equal(calcCost({ input: 1 }, null), 0);
  assert.equal(calcCost({ input: 1 }, {}), 0);
});

test("长上下文分档：超过门槛才走高价档，不超走基础价", () => {
  const price = {
    input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2,
    contextTiers: [{ maxContext: 272000, input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 }],
  };
  // 单次 10 万 token：不超档
  assert.equal(pickPrice(price, { input: 1e5, cacheRead: 0, callCount: 1 }).input, 0.2);
  // 单次 30 万：超档
  assert.equal(pickPrice(price, { input: 3e5, cacheRead: 0, callCount: 1 }).input, 0.4);
  // 总共 30 万但分 10 次调用：单次 3 万，不超档
  assert.equal(pickPrice(price, { input: 3e5, cacheRead: 0, callCount: 10 }).input, 0.2);
  // maxContext 不该混进返回的价格对象里
  assert.equal(pickPrice(price, { input: 3e5, callCount: 1 }).maxContext, undefined);
});

test("长上下文分档把缓存读也算进上下文量（否则高档永远触发不了）", () => {
  const price = { input: 0.2, output: 1, contextTiers: [{ maxContext: 272000, input: 0.4, output: 2 }] };
  // 输入只有 1 万，但缓存读 40 万：总上下文 41 万，应该走高档
  const ap = pickPrice(price, { input: 1e4, cacheRead: 4e5, callCount: 1 });
  assert.equal(ap.input, 0.4);
});

test("归一化：坏值当没填，不写 0；负数与 Infinity 一律丢掉", () => {
  assert.deepEqual(normalizePrice({ input: "0.14", output: 0.28 }), { input: 0.14, output: 0.28 });
  assert.deepEqual(normalizePrice({ input: -1, output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: Infinity, output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: "abc", output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: "", output: 2 }), { output: 2 });
  assert.deepEqual(normalizePrice({ input: null, output: 2 }), { output: 2 });
  // 0 是合法的「免费」，要留住
  assert.deepEqual(normalizePrice({ input: 0, output: 2 }), { input: 0, output: 2 });
});

test("旧格式与垃圾键不再被当成价格", () => {
  // 老文件里那套 defaultPrice/inputPerM 结构、以及字面量 "undefined" 键混进来的东西
  assert.equal(isFlatPrice({ unit: "token", inputPerM: 0.14 }), false);
  assert.equal(isFlatPrice({ currency: "USD", monthlyAllowance: 60, defaultPrice: {} }), false);
  assert.equal(isFlatPrice({ unit: "single" }), false);
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

test("用户表按项覆盖默认：只填一格不会把另外三格清零", () => {
  const dir = tmp();
  // opencode-go/deepseek-v4-flash 的默认价是 input 0.14 / cacheRead 0.0028 / output 0.28
  writeJson(dir, "price-table.json", { "opencode-go/deepseek-v4-flash": { output: 1 } });
  const table = loadPriceTable(dir);
  const entry = table["opencode-go/deepseek-v4-flash"];
  assert.equal(entry.output, 1, "用户填的覆盖默认");
  assert.equal(entry.input, 0.14, "没填的项沿用默认，不能被清零");
  assert.equal(entry.cacheRead, 0.0028);
});

test("价格文件坏了：不抛、按默认算、文件原样留着（那是用户手改的东西）", () => {
  const dir = tmp();
  const file = path.join(dir, "price-table.json");
  fs.writeFileSync(file, "{ 这不是 JSON");
  const warnings = [];
  const table = loadPriceTable(dir, { warn: (m) => warnings.push(m) });
  assert.equal(Object.keys(table).length, Object.keys(DEFAULT_PRICE_TABLE).length, "回到全默认");
  assert.equal(fs.existsSync(file), true, "不能偷偷改名或删除用户的文件");
  assert.equal(fs.readFileSync(file, "utf8"), "{ 这不是 JSON");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /price-table\.json/);
});

test("文件顶上以 _ 开头的字段不当模型（_comment 用来说明单位）", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", {
    _comment: ["单位：美元 / 每百万 token"],
    "a/b": { input: 1 },
  });
  const table = readUserPriceTable(dir);
  assert.deepEqual(Object.keys(table), ["a/b"]);
});

test("splitKey：供应商与模型分开，模型名里可以再有斜杠", () => {
  assert.deepEqual(splitKey("deepseek/deepseek-v4-flash"), { provider: "deepseek", model: "deepseek-v4-flash" });
  assert.deepEqual(splitKey("magpie-gateway/workbuddy/deepseek-v4.1-flash"),
    { provider: "magpie-gateway", model: "workbuddy/deepseek-v4.1-flash" });
  assert.deepEqual(splitKey("nope"), { provider: "", model: "nope" });
  assert.deepEqual(splitKey(""), { provider: "", model: "" });
});

// ── 并集清单 ──
// 用假的 store 与 home：这段逻辑的输入是「用过哪些」「展示哪些」，
// 不该为了测它去碰真实的缓存库和 provider-catalog。
function fakeStore(turns) {
  return {
    open: () => ({
      prepare: () => ({
        all: () => turns.map(([p, m, total, turns_, first, last]) => ({
          provider: p, model: m, tokens: total, turns: turns_, firstDay: first, lastDay: last,
        })),
      }),
    }),
  };
}

function fakeHome(models) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "user"), { recursive: true });
  fs.writeFileSync(path.join(dir, "provider-catalog.json"), JSON.stringify({
    providers: Object.fromEntries(Object.entries(models).map(([p, ms]) => [p, { models: ms.map((id) => ({ id })) }])),
  }));
  fs.writeFileSync(path.join(dir, "user", "preferences.json"), JSON.stringify({}));
  return dir;
}

test("并集 = 用过的 ∪ 现在展示的：两边都收，去重", () => {
  const dir = tmp();
  const home = fakeHome({ deepseek: ["deepseek-flash"], agnes: ["agnes-image-2.1-flash"] });
  const store = fakeStore([
    ["deepseek", "deepseek-flash", 100, 2, "2026-10-01", "2026-10-20"],  // 两边都有
    ["codekey", "gpt-5.6-terra", 50, 1, "2026-08-12", "2026-08-15"],     // 只在「用过」里
  ]);
  const cat = buildPriceCatalog({ dataDir: dir, store, home });
  assert.equal(cat.count, 3);
  const all = cat.groups.flatMap((g) => g.items);
  const keys = all.map((i) => i.key).sort();
  assert.deepEqual(keys, ["agnes/agnes-image-2.1-flash", "codekey/gpt-5.6-terra", "deepseek/deepseek-flash"]);
  // 两边都有的那条，origin 记着两个来源
  const shared = all.find((i) => i.key === "deepseek/deepseek-flash");
  assert.deepEqual(shared.origin.sort(), ["shown", "used"]);
  // 只用过的，用量与日期都带过来
  const usedOnly = all.find((i) => i.key === "codekey/gpt-5.6-terra");
  assert.equal(usedOnly.tokens, 50);
  assert.equal(usedOnly.lastDay, "2026-08-15");
  assert.equal(usedOnly.origin.includes("used"), true);
});

test("程序自带的默认价不会凭自己进清单（否则会铺出一堆用不上的行）", () => {
  const dir = tmp();
  const home = fakeHome({});
  const store = fakeStore([]);
  const cat = buildPriceCatalog({ dataDir: dir, store, home });
  assert.equal(cat.count, 0, "没有任何用量、没配任何展示模型时，清单是空的");
});

test("用户自己写进文件的键会出现在清单里（能看见、能改、能删）", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { "我的供应商/我的模型": { input: 1, output: 2 } });
  const cat = buildPriceCatalog({ dataDir: dir, store: fakeStore([]), home: fakeHome({}) });
  assert.equal(cat.count, 1);
  const item = cat.groups[0].items[0];
  assert.equal(item.key, "我的供应商/我的模型");
  assert.equal(item.source, "user");
  assert.equal(item.priced, true);
});

test("清单里每项都带来源标记：填过 / 默认 / 未填", () => {
  const dir = tmp();
  const home = fakeHome({});
  // 用户填一个、默认表里有一个、剩下的谁都没给
  writeJson(dir, "price-table.json", { "a/mine": { input: 1 } });
  const store = fakeStore([
    ["opencode-go", "deepseek-v4-flash", 10, 1, "2026-10-01", "2026-10-02"], // 默认表里有
    ["b", "nothing", 5, 1, "2026-10-01", "2026-10-01"],                        // 谁都没给
  ]);
  const cat = buildPriceCatalog({ dataDir: dir, store, home });
  const byKey = new Map(cat.groups.flatMap((g) => g.items).map((i) => [i.key, i]));
  assert.equal(byKey.get("a/mine").source, "user");
  assert.equal(byKey.get("opencode-go/deepseek-v4-flash").source, "default");
  assert.equal(byKey.get("b/nothing").source, "none");
  // 默认价也要带过去，界面才能把它当占位符显示
  assert.equal(byKey.get("opencode-go/deepseek-v4-flash").defaultPrice.input, 0.14);
  // 用户填的那条，price 有值，effective 也该有
  assert.equal(byKey.get("a/mine").price.input, 1);
  assert.equal(byKey.get("a/mine").effective.input, 1);
});

test("按项写入：只动被点名的那几项，其余原样", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { "a/x": { input: 1 }, "a/y": { input: 2 } });
  const result = applyPricePatches(dir, [{ key: "a/x", price: { input: 9, output: 8 } }]);
  assert.equal(result.ok, true);
  const table = readUserPriceTable(dir);
  assert.deepEqual(table["a/x"], { input: 9, output: 8 });
  assert.deepEqual(table["a/y"], { input: 2 }, "没点名的项不能被改");
});

test("按项写入：price 为 null 表示恢复默认，即从文件里删掉这一项", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { "a/x": { input: 1 }, "a/y": { input: 2 } });
  applyPricePatches(dir, [{ key: "a/x", price: null }]);
  const table = readUserPriceTable(dir);
  assert.equal(table["a/x"], undefined, "删掉了");
  assert.deepEqual(table["a/y"], { input: 2 }, "别的不动");
  // 删掉之后，默认价自动回来（如果这个键在默认表里）
  const eff = loadPriceTable(dir);
  assert.equal(eff["opencode-go/deepseek-v4-flash"].input, 0.14);
});

test("按项写入：坏价格会被拒，且不写盘", () => {
  const dir = tmp();
  writeJson(dir, "price-table.json", { "a/x": { input: 1 } });
  const bad = applyPricePatches(dir, [{ key: "a/y", price: { input: -5 } }]);
  // -5 被归一化丢掉，剩空对象 → normalizePrice 返回 {}，这里应当拒
  assert.equal(bad.ok, false);
  const table = readUserPriceTable(dir);
  assert.equal(table["a/y"], undefined, "被拒的写入不能落盘");
  assert.deepEqual(table["a/x"], { input: 1 });
});

test("按项写入：空数组直接拒", () => {
  const dir = tmp();
  assert.equal(applyPricePatches(dir, []).ok, false);
  assert.equal(applyPricePatches(dir, null).ok, false);
});

test("写出来的文件是人能读的：带顶部说明、缩进 2、键有序", () => {
  const dir = tmp();
  writePriceTable(dir, { "b/z": { input: 2 }, "a/x": { input: 1 } });
  const text = fs.readFileSync(path.join(dir, "price-table.json"), "utf8");
  assert.match(text, /"_comment"/, "顶上要写清单位，用户直接打开文件时第一眼能看到");
  assert.match(text, /美元 \/ 每百万 token/);
  assert.match(text, /^\{\n {2}"_comment"/m, "缩进 2");
  // 键按字母序，不能因为写入顺序不同而每次 diff 都变
  assert.ok(text.indexOf('"a/x"') < text.indexOf('"b/z"'));
});

test("并集清单里每个供应商块都带自己的统计（界面上块头要用）", () => {
  const dir = tmp();
  const home = fakeHome({});
  const store = fakeStore([
    ["a", "m1", 100, 5, "2026-10-01", "2026-10-02"],
    ["a", "m2", 50, 2, "2026-10-01", "2026-10-02"],
  ]);
  writeJson(dir, "price-table.json", { "a/m1": { input: 1 } });
  const cat = buildPriceCatalog({ dataDir: dir, store, home });
  const group = cat.groups.find((g) => g.provider === "a");
  assert.equal(group.total, 2);
  assert.equal(group.pricedCount, 1);
  assert.equal(group.tokens, 150);
  // 块内按用量降序
  assert.deepEqual(group.items.map((i) => i.model), ["m1", "m2"]);
});

// ── 用户自己添加清单里没有的模型 ──
// 并集只能盖住「用过的」与「catalog 里配过的」。用户手里总有第三个来源：
// 刚签的供应商、手动算的套餐。这条路径必须通，否则整张表只能改不能加。
test("用户自己加一个模型：立键 → 出现在清单 → 填价 → 能删", () => {
  const dir = tmp();
  const home = fakeHome({});
  const store = fakeStore([]);

  // 1. 立键（还没有任何价格）
  assert.equal(applyPricePatches(dir, [{ key: "v/m", price: {}, declare: true }]).ok, true);
  let cat = buildPriceCatalog({ dataDir: dir, store, home });
  assert.equal(cat.count, 1, "空价也要出现在清单里，否则用户没法接着填");
  const item = cat.groups[0].items[0];
  assert.equal(item.key, "v/m");
  assert.equal(item.source, "user");
  assert.equal(item.priced, false, "四个价都没填 = 未定价");

  // 2. 填价
  assert.equal(applyPricePatches(dir, [{ key: "v/m", price: { input: 1, output: 2 } }]).ok, true);
  cat = buildPriceCatalog({ dataDir: dir, store, home });
  assert.equal(cat.pricedCount, 1);
  assert.equal(cat.groups[0].items[0].price.input, 1);

  // 3. 删掉
  assert.equal(applyPricePatches(dir, [{ key: "v/m", price: null }]).ok, true);
  cat = buildPriceCatalog({ dataDir: dir, store, home });
  assert.equal(cat.count, 0);
});

test("空价格对象不能被当成垃圾数据丢掉（否则新加的模型下次刷新就消失）", () => {
  assert.equal(isFlatPrice({}), true);
  assert.deepEqual(normalizePrice({}), {});
  const dir = tmp();
  writeJson(dir, "price-table.json", { "v/m": {} });
  assert.deepEqual(Object.keys(readUserPriceTable(dir)), ["v/m"]);
});

test("自己加的模型放在哪个供应商块：按斜杠前半段归块，模型名里的斜杠不拆", () => {
  const dir = tmp();
  const home = fakeHome({});
  applyPricePatches(dir, [{ key: "magpie-gateway/workbuddy/space-bunny", price: { input: 3 }, declare: true }]);
  const cat = buildPriceCatalog({ dataDir: dir, store: fakeStore([]), home });
  const item = cat.groups[0].items[0];
  assert.equal(item.provider, "magpie-gateway");
  assert.equal(item.model, "workbuddy/space-bunny");
});
