// 价格表的币种口径：人民币。
//
// 基准是人民币 —— 不是“显示用人民币、底下存美元”。文件里存的就是人民币，
// 引擎算出来的钱也是人民币，全程没有换算。这是用户明确要求的口径。
//
// 那这个模块还留什么用：
//   1. 汇率没取到时，金额仍然能算、能显示（人民币不需要汇率）。
//   2. 需要看「折合美元」时，提供一个可选的换算（余额、官方账单那些外部美元数据）。
//   3. 界面上的单位文案（「人民币 / 每百万 token」）只有一个出处。
//
// 为什么不再做 usd↔cny 的价表换算：那个换算本身就是错的来源。
// 填 1.8 存 0.269、读出来再乘回 1.8，两步都会丢精度，还会让文件里出现
// 0.0403628048083163 这种读不懂的数。人民币基准下这一步整段不存在。

import { getFxRate, currencyInfo } from "./currency.mjs";

const PRICE_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

/** 价格表的币种：恒为人民币。 */
export const PRICE_CURRENCY = "cny";

/** 价格表单位说明用的一句话。 */
export function priceUnitLabel() {
  return "人民币";
}

/** 金额符号：¥。 */
export function priceSymbol() {
  return currencyInfo("cny").symbol;
}

/**
 * 界面上显示的价格就是文件里的价格，原样返回。
 *
 * 保留这个函数是为了让调用方读起来仍是「显示价」这个语义 ——
 * 将来若真要支持「按美元录入」，改动只落在这个函数里，不必去翻渲染代码。
 */
export function displayPrice(price) {
  return price || null;
}

/**
 * 界面上的数 → 落盘的数。人民币基准下是同一个人，只做数字整理。
 *
 * 整理成 10 位有效数字：用户填 1.8 就是 1.8，不会变成 1.7999999999999998；
 * 而 1/3 这类值也不会在文件里写成无限小数。
 */
export function toStoredPrice(displayedPrice) {
  const src = displayedPrice && typeof displayedPrice === "object" ? displayedPrice : {};
  const out = {};
  for (const k of PRICE_KEYS) {
    const n = Number(src[k]);
    if (src[k] === "" || src[k] == null || !Number.isFinite(n) || n < 0) continue;
    out[k] = tidy(n);
  }
  if (Array.isArray(src.contextTiers)) {
    out.contextTiers = src.contextTiers.map((t) => {
      const tier = { maxContext: Number(t.maxContext) };
      for (const k of PRICE_KEYS) {
        const n = Number(t[k]);
        if (Number.isFinite(n) && n >= 0) tier[k] = tidy(n);
      }
      return tier;
    });
  }
  // 分时价与按次价必须原样带过去。
  // 这一层是界面到文件的唯一通道，漏一个字段 = 详情页辛苦配的时段价
  // 在主卡某次保存时被默默抹掉，而且不会报错。
  if (Array.isArray(src.timeTiers)) {
    const tiers = src.timeTiers.map((t) => {
      if (!t || typeof t !== "object") return null;
      const tier = {};
      if (t.from) tier.from = String(t.from);
      if (t.to) tier.to = String(t.to);
      if (Array.isArray(t.days) && t.days.length) tier.days = t.days.map(Number).filter(Number.isInteger);
      let has = false;
      for (const k of PRICE_KEYS) {
        const n = Number(t[k]);
        if (t[k] === "" || t[k] == null || !Number.isFinite(n) || n < 0) continue;
        tier[k] = tidy(n);
        has = true;
      }
      return has ? tier : null;
    }).filter(Boolean);
    if (tiers.length) out.timeTiers = tiers;
    // 空数组是「明确不要分时」的标记，不能丢。丢了就等于「没配」，
    // merge 时又会从模型级默认价继承回来 —— 主卡改一格就把详情页删掉的分时复活了。
    else if (src.timeTiers.length === 0) out.timeTiers = [];
  }
  const perCall = Number(src.perCall);
  if (src.perCall !== "" && src.perCall != null && Number.isFinite(perCall) && perCall >= 0) {
    out.perCall = tidy(perCall);
  }
  return out;
}

function tidy(n) {
  if (!Number.isFinite(n)) return n;
  if (n === 0) return 0;
  return Number(n.toPrecision(10));
}

/**
 * 人民币金额 → 美元，只给「要看折合多少美元」的场合用（余额、官方账单对照）。
 * 没有汇率时返回 null：调用方该整段不显示，而不是显示一个没换算的数。
 */
export function cnyToUsd(cny, rate = getFxRate()) {
  const r = Number(rate);
  const n = Number(cny);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(n)) return null;
  return n / r;
}

/** 有没有汇率可以拿来显示「折合美元」。 */
export function hasFx() {
  const r = Number(getFxRate());
  return Number.isFinite(r) && r > 0;
}

export default {
  PRICE_CURRENCY, priceUnitLabel, priceSymbol, displayPrice, toStoredPrice, cnyToUsd, hasFx,
};
