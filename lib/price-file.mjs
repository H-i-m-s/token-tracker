// 价格文件唯一的读写口。
//
// 「能读的可以有很多处，能写的只许一处」—— 这里是那一处。
// 引擎只读（它算钱要价），写盘只发生在这个文件里。
//
// 为什么写在 App 层而不是引擎层：
//   引擎是常驻子进程，改它的代码要重启才能生效。价格表是个会被反复调整的东西
//   （新增模型、调价、加供应商），锁在重启门槛后面等于每次改需求都要重启一次 Hana。
//   读写文件不需要引擎 —— App 层本来就在写 app-settings.json、input-status.json。
import fs from "node:fs";
import path from "node:path";
import { normalizePrice, PRICE_KEYS } from "./price-core.mjs";

export const PRICE_FILE_NAME = "price-table.json";

// 文件顶上的说明。用户直接拿编辑器打开这个文件时，第一眼要能知道单位是什么。
// 以 _ 开头的键不是模型，读的时候会跳过。
export const PRICE_FILE_COMMENT = [
  "模型价格表。可以手动改，改完存盘即生效（价格在下一次刷新看板时生效）。",
  "",
  "格式：\"供应商/模型\": { input, cacheRead, cacheWrite, output }",
  "四个数字都是「人民币 / 每百万 token」，填多少就是多少，不做币种换算：",
  "  input      输入（缓存未命中）",
  "  cacheRead  缓存命中（读缓存），通常比 input 低一个量级",
  "  cacheWrite 缓存写入，绝大多数模型不收费，留空或写 0",
  "  output     输出",
  "不写的项按 0 算。只填你关心的项即可，没写的沿用程序里自带的价格。",
  "",
  "想删掉某一项、让它回到程序默认：把这一项删掉即可（在界面上把四格清空也是同理）。",
];

export function priceFilePath(dataDir) {
  return path.join(dataDir, PRICE_FILE_NAME);
}

// Windows 编辑器可能写 BOM 和 CRLF，JSON.parse 不认 BOM。
function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * 读用户表（只含用户自己写的那部分，不含默认）。
 * 坏文件按「没有自定义价格」处理，并且**原样保留文件** ——
 * 那是用户手改的东西，改名或删除等于把他的东西藏起来。
 */
export function readUserPrices(dataDir, log) {
  if (!dataDir) return {};
  const file = priceFilePath(dataDir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readText(file));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("内容不是 JSON 对象");
    }
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("_")) continue;
      const norm = normalizePrice(value);
      if (norm) out[key] = norm;
    }
    return out;
  } catch (e) {
    log?.warn?.(`price-table.json 读不了（${e?.message || e}），本次按默认价格计算；文件原样保留`);
    return {};
  }
}

/**
 * 落盘。整份重写：这是用户会手改的文件，必须保持人能读的形状（带顶部说明、缩进 2、键有序）。
 * 先写临时文件再 rename，中途断电不会留下半截 JSON。
 */
function writeFile(dataDir, userTable) {
  const file = priceFilePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { _comment: PRICE_FILE_COMMENT };
  for (const key of Object.keys(userTable).sort()) body[key] = userTable[key];
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 按项写。patches: [{ key, price, declare? }]
 *   price 是对象 → 归一化后写入（按项覆盖，不动的项保留）
 *   price 是 null → 恢复默认，即从这个文件里删掉该键
 *   declare: true → 只立键不写数字（用户自行添加模型时用）
 *
 * 为什么按项而不是整表：几十上百个模型、每个四个框，整表提交意味着改一格要重写全部，
 * 而且两个窗口同时开着时后写的会抹掉先写的。
 */
export function applyPricePatches(dataDir, patches, log) {
  if (!Array.isArray(patches) || !patches.length) {
    return { ok: false, error: "没有要写入的价格项" };
  }
  const table = readUserPrices(dataDir, log);
  let changed = 0;
  for (const patch of patches) {
    const key = String(patch?.key ?? "").trim();
    if (!key) continue;
    if (patch.price === null) {
      if (table[key]) { delete table[key]; changed += 1; }
      continue;
    }
    if (patch.declare === true) {
      table[key] = table[key] || {};
      changed += 1;
      continue;
    }
    const norm = normalizePrice(patch.price);
    // 归一化后一个字段都不剩 = 提交的东西里没有一个是有效数字。
    // 不能当「空价格」写进去：那会把这一项的所有价抹掉，与「恢复默认」混成一件事。
    if (!norm || !Object.keys(norm).length) {
      return { ok: false, error: `价格不合法：${key}（至少要有一个不小于 0 的数字）` };
    }
    table[key] = norm;
    changed += 1;
  }
  writeFile(dataDir, table);
  return { ok: true, changed };
}

/** 整表写（旧客户端兼容 + 测试用）。 */
export function writePriceTable(dataDir, table, log) {
  const norm = {};
  for (const [key, value] of Object.entries(table || {})) {
    if (key.startsWith("_")) continue;
    const n = normalizePrice(value);
    if (n) norm[key] = n;
  }
  writeFile(dataDir, norm);
  return { ok: true, count: Object.keys(norm).length };
}
