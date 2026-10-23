import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPriceGroups, splitHighlight } from "../ui/price-filter.mjs";

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

// ── searchText：按「怎么计价」找模型 ──
// 这些词不在供应商/模型键里，用户搜它们是想筛出配过分时/按次的那批。
function taggedGroups() {
  return [{
    provider: "p1",
    total: 3,
    items: [
      { key: "p1/timed", model: "timed", searchText: "分时 时段 自定义" },
      { key: "p1/plain", model: "plain", searchText: "" },
      { key: "p1/call", model: "call", searchText: "按次 自定义" },
    ],
  }];
}

test("searchText 参与匹配：搜「分时」只留配过分时的", () => {
  const r = filterPriceGroups(taggedGroups(), "分时");
  assert.equal(r.matched, 1);
  assert.equal(r.groups[0].items[0].model, "timed");
});

test("searchText 的同义词也能命中，且不误伤", () => {
  assert.equal(filterPriceGroups(taggedGroups(), "按次").matched, 1);
  assert.equal(filterPriceGroups(taggedGroups(), "时段").matched, 1);
  // 「自定义」两类都带，应当都命中
  assert.equal(filterPriceGroups(taggedGroups(), "自定义").matched, 2);
  // 没有这个分组的词不应该命中
  assert.equal(filterPriceGroups(taggedGroups(), "分档").matched, 0);
});

test("searchText 不影响原本的键匹配", () => {
  const r = filterPriceGroups(taggedGroups(), "plain");
  assert.equal(r.matched, 1);
  assert.equal(r.groups[0].items[0].model, "plain");
});

test("没有 searchText 字段时行为不变", () => {
  const src = [{ provider: "p1", total: 1, items: [{ key: "p1/a", model: "a" }] }];
  assert.equal(filterPriceGroups(src, "a").matched, 1);
  assert.equal(filterPriceGroups(src, "分时").matched, 0);
});

// ── 高亮分段 ──
// 高亮只影响显示，绝不能改动用户看到的字。所以每个用例都要验「拼回去等于原文」。
const rejoin = (parts) => parts.map((p) => p.text).join("");

test("高亮：空搜索词返回整段未命中", () => {
  const parts = splitHighlight("deepseek-v4-flash", "");
  assert.deepEqual(parts, [{ text: "deepseek-v4-flash", hit: false }]);
  assert.equal(rejoin(parts), "deepseek-v4-flash");
});

test("高亮：只标命中那一段，且拼回去等于原文", () => {
  const parts = splitHighlight("deepseek-v4-flash", "flash");
  assert.deepEqual(parts, [
    { text: "deepseek-v4-", hit: false },
    { text: "flash", hit: true },
  ]);
  assert.equal(rejoin(parts), "deepseek-v4-flash");
});

test("高亮：大小写不敏感，但保留原文的大小写", () => {
  const parts = splitHighlight("OpenAI/gpt-5", "openai");
  assert.deepEqual(parts, [
    { text: "OpenAI", hit: true },
    { text: "/gpt-5", hit: false },
  ]);
  // 命中片段应当是原文的 "OpenAI" 而不是搜索词 "openai"
  assert.equal(parts[0].text, "OpenAI");
  assert.equal(rejoin(parts), "OpenAI/gpt-5");
});

test("高亮：多处命中全部标出", () => {
  const parts = splitHighlight("m-m-m", "m");
  assert.equal(parts.filter((p) => p.hit).length, 3);
  assert.equal(rejoin(parts), "m-m-m");
});

test("高亮：命中在开头与结尾都不丢字符", () => {
  const head = splitHighlight("flash-8b", "flash");
  assert.equal(head[0].hit, true);
  assert.equal(rejoin(head), "flash-8b");
  const tail = splitHighlight("8b-flash", "flash");
  assert.equal(tail[tail.length - 1].hit, true);
  assert.equal(rejoin(tail), "8b-flash");
});

test("高亮：无命中时返回单个未命中片段", () => {
  const parts = splitHighlight("deepseek-r1", "flash");
  assert.deepEqual(parts, [{ text: "deepseek-r1", hit: false }]);
});

test("高亮：异常输入不抛错", () => {
  assert.deepEqual(splitHighlight(null, "x"), [{ text: "", hit: false }]);
  assert.deepEqual(splitHighlight(undefined, "x"), [{ text: "", hit: false }]);
  assert.equal(rejoin(splitHighlight("abc", null)), "abc");
});
