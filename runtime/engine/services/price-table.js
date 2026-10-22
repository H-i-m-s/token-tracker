// 模型价格表：唯一的读写口。
//
// 背景与边界：
//   1. 价格是**用户资产**，不是程序常量。它有自己的文件（price-table.json），
//      用户可以直接拿编辑器改；这里所有写入都保证那份文件仍然是人能读的 JSON。
//   2. 金额一律美元 / 每百万 token。这是内部唯一口径 —— 界面按当前货币换算只是显示层的事
//      （见 ui/currency.mjs），价格表本身永远不写人民币，否则汇率一变历史成本就跟着变。
//   3. 「四个价」是 input（缓存未命中）、cacheRead（缓存命中）、cacheWrite（缓存写入）、output。
//      其中 cacheWrite 在绝大多数模型上是 0，只有极少数（如部分 GPT 系）收费。缺省即 0。
//
// 为什么从 routes/dashboard.js 里搬出来：
//   它在那个 2200 行的文件里散成三处（默认表、calcCost、loadPriceTable），
//   而设置页要独立地读「有哪些模型、各自什么价」，不该为了一个价格查询把整个看板路由加载起来。
//   搬出来之后 dashboard.js 只剩「拿着价格去算钱」。
import fs from "node:fs";
import path from "node:path";
import { readTextFile } from "./platform.js";

// ── 出厂自带的价格（OpenCode Go 官方定价，2026-08 校验过）──
// 这些都是「用户没填时」的兜底值。用户填的一律覆盖它们，且界面上能区分出哪个是哪个。
export const DEFAULT_PRICE_TABLE = {
  "opencode-go/deepseek-v4-flash": {
    input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28,
  },
  "opencode-go/deepseek-v4-pro": {
    input: 0.435, cacheRead: 0.003625, cacheWrite: 0, output: 0.87,
  },
  "opencode-go/gpt-5.6-luna": {
    input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2,
    // 长上下文分档：单次请求的上下文超过 272K 之后走这一档。
    contextTiers: [
      { maxContext: 272000, input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 },
    ],
  },
  "opencode-go/grok-4.5": { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  "opencode-go/glm-5.2": { input: 1.4, cacheRead: 0.26, cacheWrite: 0, output: 4.4 },
  "opencode-go/glm-5.1": { input: 1.4, cacheRead: 0.26, cacheWrite: 0, output: 4.4 },
  "opencode-go/kimi-k3": { input: 3, cacheRead: 0.3, cacheWrite: 0, output: 15 },
  "opencode-go/kimi-k2.7-code": { input: 0.95, cacheRead: 0.19, cacheWrite: 0, output: 4 },
  "opencode-go/kimi-k2.6": { input: 0.95, cacheRead: 0.16, cacheWrite: 0, output: 4 },
  "opencode-go/mimo-v2.5": { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 },
  "opencode-go/mimo-v2.5-pro": { input: 0.435, cacheRead: 0.003625, cacheWrite: 0, output: 0.87 },
  "opencode-go/minimax-m3": { input: 0.3, cacheRead: 0.06, cacheWrite: 0, output: 1.2 },
  "opencode-go/minimax-m2.7": { input: 0.3, cacheRead: 0.06, cacheWrite: 0.375, output: 1.2 },
  "opencode-go/minimax-m2.5": { input: 0.3, cacheRead: 0.06, cacheWrite: 0.375, output: 1.2 },
  "opencode-go/qwen3.7-max": { input: 2.5, cacheRead: 0.5, cacheWrite: 3.125, output: 7.5 },
  "opencode-go/hy3": { input: 0.14, cacheRead: 0.035, cacheWrite: 0, output: 0.58 },
};

// 磁盘格式的说明，写在文件顶上。用户直接打开这个文件时，第一眼要能知道单位是什么。
export const PRICE_FILE_COMMENT = [
  "模型价格表。可以手动改，改完存盘即生效（不需要重启）。",
  "",
  "格式：\"供应商/模型\": { input, cacheRead, cacheWrite, output }",
  "四个数字都是「美元 / 每百万 token」：",
  "  input      输入（缓存未命中）",
  "  cacheRead  缓存命中（读缓存），通常比 input 低一个量级",
  "  cacheWrite 缓存写入，绝大多数模型不收费，留空或写 0",
  "  output     输出",
  "不写的项按 0 算。只填你关心的项即可，没写的沿用程序里自带的价格。",
  "",
  "想删掉某一项、让它回到程序默认：把这一项删掉，或在界面上点该行的「恢复默认」。",
];

const PRICE_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

// 一个价格对象是否是「四价」形态（新格式）。
export function isFlatPrice(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return PRICE_KEYS.some((k) => v[k] !== undefined) || Array.isArray(v.contextTiers);
}

// 归一化：只保留四个数字 + contextTiers，其余字段（比如历史上混进来的 currency、
// 已经死掉的 monthlyAllowance、那个字面量 "undefined" 键）一律丢掉。
// 非数字、负数、Infinity 全按「没填」处理（undefined），不写 0 —— 0 是「免费」，不是「不知道」。
export function normalizePrice(raw) {
  if (!isFlatPrice(raw)) return null;
  const out = {};
  for (const k of PRICE_KEYS) {
    const n = Number(raw[k]);
    if (raw[k] === "" || raw[k] == null || !Number.isFinite(n) || n < 0) continue;
    out[k] = n;
  }
  if (Array.isArray(raw.contextTiers)) {
    const tiers = raw.contextTiers
      .map((t) => {
        if (!t || typeof t !== "object") return null;
        const max = Number(t.maxContext);
        if (!Number.isFinite(max) || max <= 0) return null;
        const price = {};
        for (const k of PRICE_KEYS) {
          const n = Number(t[k]);
          if (Number.isFinite(n) && n >= 0) price[k] = n;
        }
        return { maxContext: max, ...price };
      })
      .filter(Boolean);
    if (tiers.length) out.contextTiers = tiers;
  }
  return out;
}

// 磁盘上那份 → 归一化后的表。坏文件当不存在（不抛，不让一张价格表拖死整个应用）。
export function readUserPriceTable(dataDir, log) {
  if (!dataDir) return {};
  const file = path.join(dataDir, "price-table.json");
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readTextFile(file));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("内容不是 JSON 对象");
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      // 文件顶上的说明字段以 _ 开头，不当模型。
      if (key.startsWith("_")) continue;
      const norm = normalizePrice(value);
      if (norm) out[key] = norm;
    }
    return out;
  } catch (e) {
    // 不自动改名：这是用户手改的文件，改名等于把他的东西藏起来。只警告，按「没有自定义价格」继续。
    log?.warn?.(`price-table.json 读不了（${e?.message || e}），本次按默认价格计算；文件原样保留`);
    return {};
  }
}

// 用户表覆盖默认表。**按项合并**：用户只填了 output，input 仍然用默认的，
// 而不是把整条默认价作废。这一点很重要 —— 界面允许只填一格，
// 若整条覆盖，填一格等于把另外三格清零，成本会凭空少算。
export function loadPriceTable(dataDir, log) {
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULT_PRICE_TABLE)) merged[key] = { ...value };
  const user = readUserPriceTable(dataDir, log);
  for (const [key, value] of Object.entries(user)) {
    merged[key] = { ...(merged[key] || {}), ...value };
  }
  return merged;
}

// ── 算钱 ──
// price 是归一化后的扁平四价（可选 contextTiers）。mv 是这一档用量：
//   { input, cacheRead, cacheWrite, output, callCount / assistantCount }
// 长上下文分档：单次请求的上下文量**超过**某档的 maxContext 就走那一档（长上下文更贵），
// 多档都命中时取门槛最高的那档。maxContext 本身不进结果，别把它当成价格字段传下去。
// 为什么加上缓存读：长上下文场景缓存命中往往占大头，只拿 input 判，高档永远触发不了。
export function pickPrice(price, mv) {
  if (!price) return null;
  if (!Array.isArray(price.contextTiers) || !price.contextTiers.length) return price;
  const calls = Math.max(1, mv.callCount || mv.assistantCount || 1);
  const perCall = ((mv.input || 0) + (mv.cacheRead || 0)) / calls;
  let ap = price;
  let matchedMax = -1;
  for (const tier of price.contextTiers) {
    // 单次上下文**超过**这一档的门槛才换用这档的价；多档都命中时取门槛最高的那档。
    if (perCall > tier.maxContext && tier.maxContext >= matchedMax) {
      const { maxContext, ...tierPrice } = tier;
      ap = { ...price, ...tierPrice };
      matchedMax = maxContext;
    }
  }
  return ap;
}

export function calcCost(price, mv) {
  if (!price || !mv) return 0;
  const ap = pickPrice(price, mv);
  if (!ap) return 0;
  const million = 1e6;
  return (mv.input || 0) * (ap.input || 0) / million
    + (mv.cacheRead || 0) * (ap.cacheRead || 0) / million
    + (mv.cacheWrite || 0) * (ap.cacheWrite || 0) / million
    + (mv.output || 0) * (ap.output || 0) / million;
}

// 一条价格里有没有「真的能算出钱」的项。全 0 等于没配（界面上那句「未完整定价」靠它判断）。
export function isPriced(price) {
  if (!price) return false;
  return PRICE_KEYS.some((k) => Number(price[k]) > 0);
}
