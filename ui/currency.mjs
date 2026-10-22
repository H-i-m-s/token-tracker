// 货币口径的唯一出处：美元（USD）与人民币（CNY）。
//
// 与 ui/units.mjs 同一个模式：词表、规范化、当前生效值、从快照读新值，都只在这一个文件里。
// 区别只有一点 —— 货币换算需要汇率，而汇率是引擎从网络取来的（见 routes/dashboard.js 的
// fetchFxRate），所以这里多一份「当前汇率」的落点，由页面拿到看板数据时注入。
//
// 为什么钱要有自己的模块而不是塞进 units.mjs：
//   量级单位决定「数怎么写」（1.2 亿 / 1.2 B），货币决定「这个数是什么钱」（$ / ¥）。
//   两者可以各自独立地换，混在一起会让「美元 + 中文单位」这种组合没有地方表达。

// 顺序不是装饰：设置页下拉、以及任何「认不出来就用 CURRENCIES[0]」的地方都读这个数组。
// 人民币排第一，因为它是缺省项。
export const CURRENCIES = [
  { key: "cny", label: "人民币（¥）", code: "CNY", symbol: "¥" },
  { key: "usd", label: "美元（$）", code: "USD", symbol: "$" },
];

// 缺省是人民币：这个 App 的用户就是国内按人民币记账的人，
// 每次先看到美元再手动切一次，是把默认值定反了。
export const DEFAULT_CURRENCY = "cny";

// 认不出来的值一律回到默认：设置是磁盘上的字符串，坏值不该让整页金额变成 NaN。
export function normalizeCurrency(value) {
  return CURRENCIES.some((c) => c.key === value) ? value : DEFAULT_CURRENCY;
}

let current = DEFAULT_CURRENCY;

// 1 美元 = rate 元人民币。null 表示「还不知道」——它和「汇率是 0」是两件事，
// 前者要退回美元显示，后者是坏数据。
let fxRate = null;

export function setCurrency(value) {
  current = normalizeCurrency(value);
  return current;
}

export function getCurrency() {
  return current;
}

// 认不出来的键不抛错、也不返回 undefined：直接给缺省项。
// 注意别写成 `find(c => c.key === normalizeCurrency(key))` —— normalizeCurrency 会把坏值
// 换成缺省值 "cny"，而 "cny" 在词表里是找得到的，逻辑上没错；但一旦将来缺省值不在词表里，
// 这条路就变成「找一个不存在的键」。直接用键本身匹配，找不到再回缺省，更直。
export function currencyInfo(key = current) {
  const k = CURRENCIES.some((c) => c.key === key) ? key : DEFAULT_CURRENCY;
  return CURRENCIES.find((c) => c.key === k) || CURRENCIES[0];
}

// 页面拿到看板数据时调一次。传 null / 非正数就当没拿到（不让它把已有的汇率抹成 0）。
export function setFxRate(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) fxRate = n;
  return fxRate;
}

export function getFxRate() {
  return fxRate;
}

// 现在能不能把人民币金额换成目标显示币种。
// 人民币是基准，任何时候都能显示（不需要汇率）；
// 美元是折算值，没有汇率就显示不了。
export function canConvert(key = current) {
  return normalizeCurrency(key) === "cny" || fxRate > 0;
}

// 快照里带的货币口径（引擎把设置里的这一项搭在 /snapshot 上）。
// 没有这一项就返回 null：「这次没告诉我」不等于「告诉我用美元」——
// 前者不该让页面把金额重画一遍（mock、旧引擎都不会带这一项）。
export function currencyFromSnapshot(snapshot) {
  const value = snapshot?.display?.currency;
  if (value !== "usd" && value !== "cny") return null;
  const rate = Number(snapshot?.display?.fxRate);
  return { currency: value, fxRate: Number.isFinite(rate) && rate > 0 ? rate : null };
}

/** 标签上那个币种代码：`USD` / `CNY`。 */
export function moneyCode(key = current) {
  return currencyInfo(key).code;
}

/** 币种符号：`$` / `¥`。 */
export function moneySymbol(key = current) {
  return currencyInfo(key).symbol;
}

/**
 * 把一笔金额写成当前显示币种。
 *
 * **入参是人民币**（价格表与 estimatedCost 的基准币种）。
 * 这一点与上一版相反，是本轮最容易搞错的地方：
 *   上一版入参是美元、人民币靠乘汇率得到；
 *   现在是入参人民币、美元靠除汇率得到。
 * 弄反了就是 6.7 倍的错，而且符号完全正常，看不出来。
 *
 *   没给值 / 不是有限数  → 「—」
 *   0                    → 「¥0」/「$0」
 *   小于 0.01            → 留四位（费用常常是 0.0032 这种量级，两位会写成 0）
 *   其余                 → 两位，去掉多余的尾零
 *
 * 选了美元但没有汇率时**退回人民币**：宁可显示一个真实但币种不同的数，
 * 也不拿 $ 去标人民币的数。
 */
export function formatMoney(cnyAmount, options = {}) {
  const { currency = current, rate = fxRate } = options;
  if (cnyAmount == null) return "—";
  const key = normalizeCurrency(currency);
  const raw = Number(cnyAmount);
  if (!Number.isFinite(raw)) return "—";

  const r = Number(rate);
  const canToUsd = Number.isFinite(r) && r > 0;
  const useUsd = key === "usd" && canToUsd;
  const unit = useUsd ? currencyInfo("usd") : currencyInfo("cny");
  const value = useUsd ? raw / r : raw;

  if (value === 0) return unit.symbol + "0";
  const abs = Math.abs(value);
  const text = abs < 0.01
    ? value.toFixed(4).replace(/\.?0+$/, "")
    : value.toFixed(2).replace(/\.?0+$/, "").replace(/\.$/, "");
  return unit.symbol + text;
}

/**
 * 金额的口径说明，给悬停用。
 *
 * 现在基准是人民币，所以「人民币」不需要再提汇率 —— 那个数就是账上的数。
 * 反而是「选了美元」时才需要说清它是折算值。
 */
export function moneyHint(key = current, options = {}) {
  const { rate = fxRate, base = "按已配置价格估算；不是供应商结算账单" } = options;
  const info = currencyInfo(key);
  if (info.key !== "usd") return base;
  const r = Number(rate);
  if (!(r > 0)) return base + "。汇率还没取到，暂时按人民币显示";
  return `${base}。美元金额是折算值（1 美元 ≈ ${r.toFixed(2)} 元），不是账上的原始数值`;
}

export default {
  CURRENCIES, DEFAULT_CURRENCY, normalizeCurrency, setCurrency, getCurrency,
  currencyInfo, setFxRate, getFxRate, canConvert, currencyFromSnapshot,
  moneyCode, moneySymbol, formatMoney, moneyHint,
};
