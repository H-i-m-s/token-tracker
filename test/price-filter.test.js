import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPriceGroups } from "../ui/price-filter.mjs";

// 造一个形状与 buildPriceCatalog 一致的最小清单。
function groups() {
  return [
    {
      provider: "deepseek",
      total: 3,
      items: [
        { key: "deepseek/deepseek-v4-flash", model: "deepseek-v4-flash" },
        { key: "deepseek/deepseek-v5-pro", model: "deepseek-v5-pro" },
        { key: "deepseek/deepseek-r1", model: "deepseek-r1" },
      ],
    },
    {
      provider: "agnes",
      total: 2,
      items: [
        { key: "agnes/agnes-2.0-flash", model: "agnes-2.0-flash" },
        { key: "agnes/agnes-video-v2.0", model: "agnes-video-v2.0" },
      ],
    },
    {
      provider: "OpenAI",
      total: 1,
      items: [{ key: "OpenAI/gpt-5", model: "gpt-5" }],
    },
  ];
}

test("空搜索词返回全量，matched 是模型总数", () => {
  const r = filterPriceGroups(groups(), "");
  assert.equal(r.groups.length, 3);
  assert.equal(r.matched, 6);
  assert.equal(r.providerCount, 3);
});

test("只含空白的搜索词等同于不过滤", () => {
  const r = filterPriceGroups(groups(), "   ");
  assert.equal(r.matched, 6);
  assert.equal(r.providerCount, 3);
});

test("按模型名片段过滤，只留下命中的行", () => {
  const r = filterPriceGroups(groups(), "flash");
  assert.equal(r.matched, 2);
  assert.equal(r.providerCount, 2);
  const names = r.groups.flatMap((g) => g.items.map((i) => i.model));
  assert.deepEqual(names.sort(), ["agnes-2.0-flash", "deepseek-v4-flash"]);
});

test("按供应商名能筛出整块，这是搜「某家全部模型」的路子", () => {
  const r = filterPriceGroups(groups(), "deepseek");
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].provider, "deepseek");
  assert.equal(r.matched, 3);
});

test("大小写不敏感：搜 FLASH 与 flash 结果一致", () => {
  const lower = filterPriceGroups(groups(), "flash");
  const upper = filterPriceGroups(groups(), "FLASH");
  assert.equal(lower.matched, upper.matched);
  assert.deepEqual(
    lower.groups.map((g) => g.provider),
    upper.groups.map((g) => g.provider),
  );
});

test("供应商名的大小写也能匹配：openai 应当命中 OpenAI", () => {
  const r = filterPriceGroups(groups(), "openai");
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].provider, "OpenAI");
});

test("匹配范围含供应商前缀，所以搜供应商词也能命中其全部模型", () => {
  const r = filterPriceGroups(groups(), "agnes");
  assert.equal(r.matched, 2);
});

test("没有命中时返回空分组，不返回 null", () => {
  const r = filterPriceGroups(groups(), "zzzz-nope");
  assert.deepEqual(r.groups, []);
  assert.equal(r.matched, 0);
  assert.equal(r.providerCount, 0);
});

test("过滤后仍保留原 total，界面靠它写「3 个模型 / 共 12」", () => {
  const r = filterPriceGroups(groups(), "flash");
  const ds = r.groups.find((g) => g.provider === "deepseek");
  assert.equal(ds.items.length, 1);
  assert.equal(ds.total, 3, "total 必须是过滤前的供应商总数，不能跟着 items 缩");
});

test("不修改输入数据", () => {
  const src = groups();
  const before = JSON.stringify(src);
  filterPriceGroups(src, "flash");
  assert.equal(JSON.stringify(src), before);
});

test("输入不合法时不抛错", () => {
  assert.equal(filterPriceGroups(null, "x").matched, 0);
  assert.equal(filterPriceGroups(undefined, "x").matched, 0);
  assert.equal(filterPriceGroups([], "x").matched, 0);
  // query 非字符串时按字符串处理，不炸
  assert.equal(filterPriceGroups(groups(), null).matched, 6);
  assert.equal(filterPriceGroups(groups(), 123).matched, 0);
});

test("分组里 items 缺失时跳过该组而不是崩", () => {
  const r = filterPriceGroups([{ provider: "x", total: 0 }, { provider: "deepseek", total: 1, items: [{ key: "deepseek/a", model: "a" }] }], "deepseek");
  assert.equal(r.groups.length, 1);
  assert.equal(r.matched, 1);
});
