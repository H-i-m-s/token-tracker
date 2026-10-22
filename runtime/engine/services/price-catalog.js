// 价格表的「编辑器」那一半：并集清单、按项读写、批量套用。
//
// 为什么和 price-table.js 分开：
//   那一半是「拿价格算钱」（纯函数，看板每个请求都在用）；
//   这一半是「给界面用的一张可编辑清单」（要读 catalog、要查用量、要落盘）。
//   一个是计算，一个是编辑，混在一起会让算钱那条路径无缘无故带上 fs 和对 catalog 的依赖。
//
// 清单的口径（这是本文件最要紧的一条）：
//   并集 = 统计过的 ∪ 现在展示的
//   - 统计过：turns 表里出现过的 provider/model，含早已不用、甚至供应商已经不存在的
//     （用户按月的账要能对到底，砍掉历史就等于让历史账目无价可算）
//   - 现在展示：provider-catalog.json 里的文本模型 + preferences.json 里 image/video 的默认供应商模型
//     （新加的模型还没用过，但用户马上就会想给它填价）
//   两边的键都是 "provider/model"。同一个键只出现一次，来源记在 origin 里。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveHanaHome, readTextFile } from "./platform.js";
import {
  DEFAULT_PRICE_TABLE, PRICE_FILE_COMMENT, loadPriceTable, readUserPriceTable,
  normalizePrice, isPriced,
} from "./price-table.js";

const PRICE_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

export function splitKey(key) {
  const at = String(key ?? "").indexOf("/");
  if (at <= 0) return { provider: "", model: String(key ?? "") };
  return { provider: key.slice(0, at), model: key.slice(at + 1) };
}

// provider-catalog.json：Hana 里配置的文本模型供应商
// preferences.json：imageGeneration / videoGeneration 两个能力的默认供应商模型
// 两处都读不到就不当回事（返回空），不因为一个文件缺失就让整张价格表空掉。
export function readShownModels(home = resolveHanaHome()) {
  const shown = new Map();
  const add = (provider, model, source) => {
    if (!provider || !model) return;
    const key = provider + "/" + model;
    if (!shown.has(key)) shown.set(key, source);
  };
  try {
    const catalog = JSON.parse(readTextFile(path.join(home, "provider-catalog.json")));
    for (const [pid, pd] of Object.entries(catalog.providers || {})) {
      for (const m of pd?.models || []) {
        const mid = typeof m === "string" ? m : m?.id;
        add(pid, mid, "catalog");
      }
    }
  } catch {}
  try {
    const pref = JSON.parse(readTextFile(path.join(home, "user", "preferences.json")));
    for (const cap of ["imageGeneration", "videoGeneration"]) {
      const defaults = pref?.[cap]?.providerDefaults || {};
      for (const [pid, pv] of Object.entries(defaults)) {
        for (const mid of Object.keys(pv?.models || {})) add(pid, mid, cap);
      }
    }
  } catch {}
  return shown;
}

// 从 turns 表读「统计过的」：每个 provider/model 的总量、首次与最后使用日。
// 用 store 而不是缓存里的 sessions：turns 是长期表，sessions 里那些会话被扫掉之后
// 历史模型名就跟着消失了，而价格恰恰要对的是历史。
export function readUsedModels(store) {
  const used = new Map();
  if (!store || typeof store.open !== "function") return used;
  try {
    const db = store.open();
    const rows = db.prepare(
      "SELECT provider, model, SUM(total) AS tokens, COUNT(*) AS turns, MIN(day) AS firstDay, MAX(day) AS lastDay " +
      "FROM turns WHERE provider <> '' AND model <> '' GROUP BY provider, model",
    ).all();
    for (const r of rows) {
      used.set(r.provider + "/" + r.model, {
        tokens: Number(r.tokens) || 0,
        turns: Number(r.turns) || 0,
        firstDay: r.firstDay || "",
        lastDay: r.lastDay || "",
      });
    }
  } catch {
    // 表还没建 / 驱动不可用：当作「没有历史」，清单靠 catalog 那一半照样能用。
  }
  return used;
}

// 并集清单。每个供应商一块，块内按用量降序（没用量、只在 catalog 里的排后面按名字排）。
export function buildPriceCatalog({ dataDir, store, home, log } = {}) {
  const user = readUserPriceTable(dataDir, log);
  const effective = loadPriceTable(dataDir, log);
  const used = readUsedModels(store);
  const shown = readShownModels(home);

  // 并集口径严格按「用过的 ∪ 现在展示的 ∪ 用户自己写进文件的」。
  // 默认价格表（DEFAULT_PRICE_TABLE）的键**不进**这个并集：那是程序自带的兜底值，
  // 不是用户的模型。opencode-go 那 16 个默认项从没用过也没在 catalog 里，
  // 把它们铺在清单上等于让用户面对一堆跟自己无关的行。
  // 用户表手动写的键要进：他自己加进去的东西，得能看见、能改、能删。
  const keys = new Set([...used.keys(), ...shown.keys(), ...Object.keys(user)]);
  const groups = new Map();
  for (const key of keys) {
    const { provider, model } = splitKey(key);
    if (!provider || !model) continue;
    const u = used.get(key) || null;
    const def = DEFAULT_PRICE_TABLE[key] || null;
    const usr = user[key] || null;
    const eff = effective[key] || null;
    // 每一项价格的来源：「填过」= 用户表里有；「默认」= 程序自带；「没配」= 都没有。
    const source = usr ? "user" : (def ? "default" : "none");
    const item = {
      key, provider, model,
      price: usr || null,          // 只有用户填过的才回显到输入框里
      effective: eff || null,      // 实际参与计算的价（用户值覆盖默认之后）
      defaultPrice: def || null,   // 「恢复默认」要知道默认是什么
      source,
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
    items.sort((a, b) => (b.tokens - a.tokens) || a.model.localeCompare(b.model));
    return {
      provider,
      items,
      // 块级统计：这一块里有几项能算出钱、一共烧了多少 token。界面上块头用。
      total: items.length,
      pricedCount: items.filter((i) => i.priced).length,
      tokens: items.reduce((s, i) => s + i.tokens, 0),
    };
  }).sort((a, b) => (b.tokens - a.tokens) || a.provider.localeCompare(b.provider));

  return {
    groups: list,
    count: list.reduce((s, g) => s + g.total, 0),
    pricedCount: list.reduce((s, g) => s + g.pricedCount, 0),
    // 用于「额度」那种场景的合计单位说明，前端拼提示语时不用自己猜。
    unit: "USD per 1M tokens",
  };
}

// 落盘。整个文件重写：价格表是用户手改的文件，必须保持人能读的形状（缩进 2、带顶部说明）。
// 写入用「临时文件 + rename」，中途断电不会留下半截 JSON。
function writePriceFile(dataDir, table) {
  const file = path.join(dataDir, "price-table.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { _comment: PRICE_FILE_COMMENT };
  for (const key of Object.keys(table).sort()) body[key] = table[key];
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// 按项写：patches 是 [{ key, price } | { key, price: null }]。
// price 为 null 表示「恢复默认」= 把这个键从用户表里删掉（不是写 0）。
// 只动被点名的项，其余原样保留 —— 这是「58 项没法整表提交」的解法。
export function applyPricePatches(dataDir, patches, log) {
  if (!Array.isArray(patches) || !patches.length) {
    return { ok: false, error: "没有要写入的价格项" };
  }
  const table = readUserPriceTable(dataDir, log);
  let changed = 0;
  for (const patch of patches) {
    const key = String(patch?.key ?? "").trim();
    if (!key) continue;
    if (patch.price === null) {
      if (table[key]) { delete table[key]; changed += 1; }
      continue;
    }
    const norm = normalizePrice(patch.price);
    // 归一化后一个字段都不剩 = 提交的价格里没有一个是有效数字。
    // 不能当「空价格」写进去：那会把这一项的所有价抹成空，与「恢复默认」混成同一件事，
    // 而用户真正想做的「清空这一行」走的是 price: null 那条路。
    if (!norm || !Object.keys(norm).length) {
      return { ok: false, error: `价格不合法：${key}（至少要有一个不小于 0 的数字）` };
    }
    table[key] = norm;
    changed += 1;
  }
  writePriceFile(dataDir, table);
  return { ok: true, changed };
}

// 供测试与「第一次打开时把当前值搬进文件」用：把内存里的一张表整体写出去。
export function writePriceTable(dataDir, table, log) {
  const norm = {};
  for (const [key, value] of Object.entries(table || {})) {
    if (key.startsWith("_")) continue;
    const n = normalizePrice(value);
    if (n) norm[key] = n;
  }
  writePriceFile(dataDir, norm);
  return { ok: true, count: Object.keys(norm).length };
}

export default {
  buildPriceCatalog, applyPricePatches, writePriceTable, readShownModels, readUsedModels, splitKey,
};
