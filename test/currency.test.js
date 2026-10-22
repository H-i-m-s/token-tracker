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

test("formatMoney：符号、小数位、0 与「取不到」分得清（人民币基准）", () => {
  // 默认就是人民币，入参也是人民币，不需要汇率。
  setCurrency("cny");
  assert.equal(formatMoney(0), "¥0");
  // 0 与取不到必须长得不一样：前者是真的没花钱，后者是不知道。
  assert.equal(formatMoney(null), "—");
  assert.equal(formatMoney(undefined), "—");
  assert.equal(formatMoney("abc"), "—");
  assert.equal(formatMoney(NaN), "—");
  // 费用常常在千分位以下，两位会写成 0，所以要留四位
  assert.equal(formatMoney(0.0032), "¥0.0032");
  assert.equal(formatMoney(0.1), "¥0.1");
  assert.equal(formatMoney(1.2), "¥1.2");
  assert.equal(formatMoney(12.345), "¥12.35");
  assert.equal(formatMoney(1234.5), "¥1234.5");
});

test("formatMoney：人民币是基准，不乘汇率；选美元才除一次", () => {
  setCurrency("cny");
  // 关键回归点：基准改人民币后，如果还在乘汇率，1 元会被写成 ¥7.1 —— 7 倍放大。
  assert.equal(formatMoney(1, { rate: 7.1 }), "¥1", "人民币是基准，不得乘汇率");
  assert.equal(formatMoney(10, { rate: 7.1 }), "¥10");
  assert.equal(formatMoney(0, { rate: 7.1 }), "¥0", "0 换完还是 0，不是取不到");
  assert.equal(formatMoney(0.001, { rate: 7.1 }), "¥0.001");
  // 切到美元：入参还是人民币，除一次汇率。
  assert.equal(formatMoney(7.1, { currency: "usd", rate: 7.1 }), "$1");
  assert.equal(formatMoney(71, { currency: "usd", rate: 7.1 }), "$10");
  setCurrency("usd");
  assert.equal(formatMoney(7.1, { rate: 7.1 }), "$1", "当前币种是美元时也一样");
  setCurrency("cny");
});

test("选美元但没有汇率：退回人民币，不拿 $ 标人民币的数", () => {
  assert.equal(formatMoney(1, { currency: "usd", rate: null }), "¥1");
  assert.equal(formatMoney(1, { currency: "usd", rate: 0 }), "¥1");
  assert.equal(formatMoney(1, { currency: "usd", rate: "abc" }), "¥1");
  assert.equal(canConvert("usd"), false, "没有汇率就折算不出美元");
  setFxRate(7.1);
  assert.equal(canConvert("usd"), true);
  assert.equal(formatMoney(7.1, { currency: "usd" }), "$1", "记下汇率之后默认就用它");
  assert.equal(canConvert("cny"), true, "人民币是基准，任何时候都能显示");
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

test("moneyHint：基准是人民币就不提汇率，选美元时才说清是折算值", () => {
  // 人民币是账上的数，不需要解释换算。
  const cny = moneyHint("cny", { rate: 6.689327 });
  assert.doesNotMatch(cny, /≈|折算/, "人民币是基准，不应说成换算结果");

  const usd = moneyHint("usd", { rate: 7.1 });
  assert.match(usd, /折算/);
  assert.match(usd, /1 美元 ≈ 7\.10 元/, "两位小数，不把 7.1 全摊出来");

  const noRate = moneyHint("usd", { rate: null });
  assert.match(noRate, /按人民币显示/, "折算不了要说清楚");
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

test("选美元但没有汇率时退回人民币（不依赖模块里的当前汇率）", () => {
  // 这里刻意只用显式参数：setFxRate(null) 按设计是忽略坏值（不抹掉已知汇率），
  // 拿它来「清空」汇率是错的用法，会把测试变成依赖前面用例留下的状态。
  setCurrency("cny");
  assert.equal(formatMoney(1, { currency: "usd", rate: null }), "¥1");
  assert.equal(formatMoney(1, { currency: "usd", rate: 0 }), "¥1");
  assert.equal(formatMoney(1, { currency: "usd", rate: "abc" }), "¥1");
});
