import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENCIES, DEFAULT_CURRENCY, normalizeCurrency, setCurrency, getCurrency, currencyInfo,
  setFxRate, getFxRate, canConvert, currencyFromSnapshot, moneyCode, moneySymbol,
  formatMoney, moneyHint,
} from "../ui/currency.mjs";

// 货币口径的纯逻辑层。这里只管三件事：
//   1) 词表与缺省；
//   2) 金额怎么写（符号、小数位、0 与「取不到」）；
//   3) 换算不了时的行为 —— 这一条最要紧：宁可显示真实但币种不同的数，
//      也不能拿 ¥ 去标一个美元的数。

test("词表：两种货币，默认人民币，人民币排第一", () => {
  assert.deepEqual(CURRENCIES.map((c) => c.key), ["cny", "usd"]);
  assert.deepEqual(CURRENCIES.map((c) => c.code), ["CNY", "USD"]);
  assert.deepEqual(CURRENCIES.map((c) => c.symbol), ["¥", "$"]);
  assert.equal(DEFAULT_CURRENCY, "cny");
  assert.equal(normalizeCurrency("usd"), "usd");
  for (const bad of [undefined, null, "", "CNY", "rmb", "jpy", 0, {}]) {
    assert.equal(normalizeCurrency(bad), "cny", `坏值 ${String(bad)} 回默认`);
  }
});

test("setCurrency / getCurrency 是同一份当前值，坏值不生效", () => {
  setCurrency("usd");
  assert.equal(getCurrency(), "usd");
  assert.equal(moneyCode(), "USD");
  assert.equal(moneySymbol(), "$");
  setCurrency("rmb");
  assert.equal(getCurrency(), "cny", "认不出来就回到默认");
  setCurrency("cny");
  assert.equal(getCurrency(), "cny");
});

test("formatMoney：符号、小数位、0 与「取不到」分得清", () => {
  setCurrency("usd");
  assert.equal(formatMoney(0), "$0");
  // 0 与取不到必须长得不一样：前者是真的没花钱，后者是不知道。
  assert.equal(formatMoney(null), "—");
  assert.equal(formatMoney(undefined), "—");
  assert.equal(formatMoney("abc"), "—");
  assert.equal(formatMoney(NaN), "—");
  // 费用常常在千分位以下，两位会写成 0，所以要留四位
  assert.equal(formatMoney(0.0032), "$0.0032");
  assert.equal(formatMoney(0.1), "$0.1");
  assert.equal(formatMoney(1.2), "$1.2");
  assert.equal(formatMoney(12.345), "$12.35");
  assert.equal(formatMoney(1234.5), "$1234.5");
});

test("formatMoney：人民币按汇率换算，符号跟着换", () => {
  setCurrency("cny");
  assert.equal(formatMoney(1, { rate: 7.1 }), "¥7.1");
  assert.equal(formatMoney(10, { rate: 7.1 }), "¥71");
  assert.equal(formatMoney(0, { rate: 7.1 }), "¥0", "0 换完还是 0，不是取不到");
  assert.equal(formatMoney(0.001, { rate: 7.1 }), "¥0.0071");
  setCurrency("usd");
});

test("换算不了时不冒充人民币：退回美元符号与数值", () => {
  // 没有汇率（还没取到 / 全新安装且网络不可用）
  assert.equal(formatMoney(1, { currency: "cny", rate: null }), "$1");
  assert.equal(formatMoney(1, { currency: "cny", rate: 0 }), "$1");
  assert.equal(formatMoney(1, { currency: "cny", rate: "abc" }), "$1");
  assert.equal(canConvert("cny"), false, "没有汇率就是换算不了");
  setFxRate(7.1);
  assert.equal(canConvert("cny"), true);
  assert.equal(formatMoney(1, { currency: "cny" }), "¥7.1", "记下汇率之后默认就用它");
  assert.equal(canConvert("usd"), true, "美元任何时候都不需要汇率");
});

test("setFxRate 不接受坏值，也不会把已知汇率抹掉", () => {
  setFxRate(6.9);
  assert.equal(getFxRate(), 6.9);
  for (const bad of [null, undefined, 0, -1, NaN, "abc"]) setFxRate(bad);
  assert.equal(getFxRate(), 6.9, "坏值不该把已有的汇率变成 0");
  setFxRate(7.1);
});

test("currencyFromSnapshot：没带就是 null，带了要认出汇率", () => {
  assert.equal(currencyFromSnapshot(null), null);
  assert.equal(currencyFromSnapshot({}), null);
  assert.equal(currencyFromSnapshot({ display: {} }), null);
  assert.equal(currencyFromSnapshot({ display: { currency: "rmb" } }), null, "认不出来当没带");
  assert.deepEqual(currencyFromSnapshot({ display: { currency: "cny" } }), { currency: "cny", fxRate: null });
  assert.deepEqual(
    currencyFromSnapshot({ display: { currency: "cny", fxRate: 7.1 } }),
    { currency: "cny", fxRate: 7.1 },
  );
  assert.deepEqual(
    currencyFromSnapshot({ display: { currency: "cny", fxRate: 0 } }),
    { currency: "cny", fxRate: null },
    "0 汇率是坏数据，当成没有",
  );
});

test("moneyHint：人民币要把汇率写出来，因为那是个会变的数", () => {
  const usd = moneyHint("usd", { rate: 7.1 });
  assert.doesNotMatch(usd, /汇率|换算/, "美元口径不需要解释换算");

  const cny = moneyHint("cny", { rate: 6.689327 });
  assert.match(cny, /1 美元 ≈ 6\.69 元/, "两位小数，不把 6.689327 全摊出来");
  assert.match(cny, /汇率每日更新/);

  const noRate = moneyHint("cny", { rate: null });
  assert.match(noRate, /按美元显示/, "换算不了要说清楚");
  assert.doesNotMatch(noRate, /≈/, "别写一个不存在的汇率");
});

test("currencyInfo：认不出的键回缺省项；不带参数时跟随当前值", () => {
  assert.equal(currencyInfo("usd").code, "USD");
  assert.equal(currencyInfo("jpy").code, "CNY", "认不出来就回缺省（人民币）");
  // 不带参数 = 当前生效的那一个，而不是永远回缺省。
  // 之前这里断言成 DEFAULT_CURRENCY，只要前面某个用例 setCurrency("usd") 过就会挂 ——
  // 错在断言，不在实现。
  setCurrency("usd");
  assert.equal(currencyInfo().key, "usd", "跟随当前值");
  setCurrency("cny");
  assert.equal(currencyInfo().key, DEFAULT_CURRENCY);
});

test("显式传 rate 时，换算不了就退回美元符号（不依赖模块里的当前汇率）", () => {
  // 这里刻意只用显式参数：setFxRate(null) 按设计是忽略坏值（不抹掉已知汇率），
  // 拿它来「清空」汇率是错的用法，会把测试变成依赖前面用例留下的状态。
  setCurrency("cny");
  assert.equal(formatMoney(1, { currency: "cny", rate: null }), "$1");
  assert.equal(formatMoney(1, { currency: "cny", rate: 0 }), "$1");
  assert.equal(formatMoney(1, { currency: "cny", rate: "abc" }), "$1");
});
