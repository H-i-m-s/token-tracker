// 价格清单的视图层：把四份数据拼成「按供应商分组、每项带来源标记」的形状。
//
// 这个文件刻意不认识 fs、不认识数据库、不认识进程。
// 它的输入全是数据，输出是给界面直接渲染的结构 ——
// 于是它既能在 App 层跑，也能在测试里喂假数据跑，不需要任何环境准备。
//
// 清单口径（这是本文件最要紧的一条）：
//   并集 = 用过的 ∪ 现在展示的 ∪ 用户自己写进文件的
//   · 用过的：turns 表里出现过的 provider/model，含早已不用的。
//     用户按月的账要能对到底，砍掉历史就等于让历史账目无价可算。
//   · 现在展示的：provider-catalog.json 里的文本模型 + preferences.json 里 image/video 的默认模型。
//     新加的模型还没用过，但用户马上就会想给它填价。
//   · 用户写的：他自己加进来的键，得能看见、能改、能删。
//   程序自带的默认价**不进**并集：那是兜底值，不是用户的模型。
//   把 16 个从没用过的 opencode-go 默认项铺出来，只是让用户面对一堆跟自己无关的行。
import { DEFAULT_PRICE_TABLE, mergePriceTables, isPriced, splitKey } from "./price-core.mjs";

/**
 * @param {object}   input
 * @param {object}   input.userPrices   用户表（lib/price-file.mjs 读出来的）
 * @param {object[]} input.shownModels  [{ provider, model, source }] 现在展示的模型
 * @param {object[]} input.usedPairs    [{ provider, model, tokens, turns, firstDay, lastDay }] 用过的
 * @param {object}   [input.defaults]   默认价格表
 */
export function buildPriceCatalog({ userPrices = {}, shownModels = [], usedPairs = [], defaults = DEFAULT_PRICE_TABLE } = {}) {
  const effective = mergePriceTables(userPrices, defaults);
  const used = new Map();
  for (const p of usedPairs) {
    if (!p?.provider || !p?.model) continue;
    used.set(`${p.provider}/${p.model}`, p);
  }
  const shown = new Map();
  for (const m of shownModels) {
    if (!m?.provider || !m?.model) continue;
    if (!shown.has(`${m.provider}/${m.model}`)) shown.set(`${m.provider}/${m.model}`, m.source || "catalog");
  }

  const keys = new Set([...used.keys(), ...shown.keys(), ...Object.keys(userPrices)]);
  const groups = new Map();
  for (const key of keys) {
    const { provider, model } = splitKey(key);
    if (!provider || !model) continue;
    const u = used.get(key) || null;
    const usr = userPrices[key] || null;
    // 三级查找：用户填的 provider/model > 内置的 provider/model > 内置的 model。
    // 第三级才叫得上「不看供应商」—— 同一条价被多个供应商共用时不必逐家写一遍。
    const def = defaults[key] || defaults[model] || null;
    const eff = effective[key] || effective[model] || null;
    const item = {
      key, provider, model,
      price: usr,                 // 只有用户填过的才回显到输入框
      effective: eff,             // 实际参与计算的价（用户值覆盖默认后）
      defaultPrice: def,          // 「恢复默认」要知道默认是什么
      source: usr ? "user" : (def ? "default" : "none"),
      priced: isPriced(eff),
      tokens: u?.tokens || 0,
      turns: u?.turns || 0,
      firstDay: u?.firstDay || "",
      lastDay: u?.lastDay || "",
      origin: [u ? "used" : null, shown.has(key) ? "shown" : null].filter(Boolean),
      shownAs: shown.get(key) || "",
    };
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(item);
  }

  const list = [...groups.entries()].map(([provider, items]) => {
    // 块内按用量降序，没用过的按名字排在后面 —— 用户扫一眼就知道哪几个值得填。
    items.sort((a, b) => (b.tokens - a.tokens) || a.model.localeCompare(b.model));
    return {
      provider,
      items,
      total: items.length,
      pricedCount: items.filter((i) => i.priced).length,
      tokens: items.reduce((s, i) => s + i.tokens, 0),
    };
  }).sort((a, b) => (b.tokens - a.tokens) || a.provider.localeCompare(b.provider));

  return {
    groups: list,
    count: list.reduce((s, g) => s + g.total, 0),
    pricedCount: list.reduce((s, g) => s + g.pricedCount, 0),
    // 币种不再是美元：价格表与算出来的成本都是人民币。
    unit: "CNY per 1M tokens",
  };
}

/**
 * 现在展示的模型：由**引擎**给（App 进程被限制在自己的 dataDir 内，读不了 ~/.hanako 根）。
 * 这里只做去重与形状整理，不读文件。
 */
export function normalizeShownModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list || []) {
    const provider = m?.provider;
    const model = m?.model;
    if (!provider || !model) continue;
    const key = provider + "/" + model;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model, source: m.source || "catalog" });
  }
  return out;
}
