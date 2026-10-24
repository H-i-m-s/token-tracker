// 价格的纯算术：没有文件、没有网络、没有数据库。
//
// 为什么单独一个文件并且被两个进程共用：
//   引擎要拿价格算钱（每个看板请求都算），App 层要拿价格显示「默认价 / 已定价」并落盘。
//   这两边必须用同一套换算与合并规则 —— 若各留一份，早晚漂成
//   「界面上说已定价，看板上却算不出钱」这种查半天的问题。
//
// 谁写谁读：
//   能写价格的只有 App 层（lib/price-file.mjs）。这里只负责算，不碰盘。
//
// 四条口径，改之前先看这里：
//   1. 金额单位是「美元 / 每百万 token」。价格表永远存美元，换人民币只是显示层的事
//      （见 ui/currency.mjs），否则汇率一变动历史成本就跟着变。
//      注意：设置页按人民币录入，写盘前用 priceCnyToUsd 除一次汇率 ——
//      「存美元」这条不变，变的只是「用户用什么币种填」。
//   2. 四个价：input（缓存未命中）、cacheRead（命中）、cacheWrite（写入）、output。
//      缺省即 0。cacheWrite 绝大多数模型不收费，只有极少数收。
//   3. 用户表**按项**覆盖默认表：他只填了 output，input 仍然用默认的。
//      整条覆盖会让「填一格」等于「把另外三格清零」，成本凭空少算。
//   4. 「没填」与「0」是两件事。0 是免费，undefined 是不知道 —— 归一化时不要把前者变成后者。

export const PRICE_KEYS = ["input", "cacheRead", "cacheWrite", "output"];

// ── 时分定价：同一份 token，不同时段不同价 ──
//
// 形状：price.timeTiers = [
//   { from: "08:00", to: "22:00", input: 4, output: 16 },   // 忙时
//   { input: 2, output: 8 },                                 // 其余时段（没有 from/to 就是兜底）
// ]
//
// 三条口径：
//   1. 从左到右取第一个匹配的段，都不匹配就用没有时间条件的兜底段。
//   2. from/to 左闭右开；to <= from 表示跨午夜（如 22:00→08:00）。
//   3. 段里没写的价沿用基础四价 —— 只改 output 可以只写 output。
//
// 为什么不用「忙时/闲时」两个固定字段：供应商并不统一，阿里云百炼是
// 08:00–22:00 忙时，别家可能拆成三段或按工作日/周末分。写成数组就不用改结构。

/** "08:30" → 510（当日分钟数）。认不出或越界返回 null。 */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 归一化一段。时间窗必须成对给齐；一个价都没有的段返回 null（只有时间没有价没意义）。 */
function normalizeTimeTier(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  const from = parseClock(raw.from);
  const to = parseClock(raw.to);
  // 给了时间窗就必须写对。写错（25:00、08:60、两端相等）一律整段丢弃，
  // 不能降级成「没有时间窗」—— 那会变成兜底段，把用户的忙时价
  // 默默变成全时段价，算出来的钱偏高而且看不出错在哪里。
  const hasWindowInput = raw.from != null || raw.to != null;
  if (hasWindowInput) {
    if (from == null || to == null || from === to) return null;
    out.from = String(raw.from).trim();
    out.to = String(raw.to).trim();
  }
  if (Array.isArray(raw.days)) {
    const days = raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length) out.days = [...new Set(days)].sort((a, b) => a - b);
  }
  let hasPrice = false;
  for (const k of PRICE_KEYS) {
    const n = Number(raw[k]);
    if (raw[k] === "" || raw[k] == null || !Number.isFinite(n) || n < 0) continue;
    out[k] = n;
    hasPrice = true;
  }
  return hasPrice ? out : null;
}

/** 归一化整张时段表。全是坏段时返回 null，表示「这张表不存在」。 */
export function normalizeTimeTiers(list) {
  if (!Array.isArray(list)) return null;
  const out = list.map(normalizeTimeTier).filter(Boolean);
  return out.length ? out : null;
}

/**
 * 某一刻落在哪一段。at = { minutes, weekday }，weekday 用 0（周日）–6。
 * 按顺序取第一个匹配；没有时间条件的段当兜底。都不匹配返回 null（用基础四价）。
 */
export function matchTimeTier(tiers, at) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const minutes = Number.isFinite(at?.minutes) ? at.minutes : null;
  const weekday = Number.isInteger(at?.weekday) ? at.weekday : null;
  let fallback = null;
  for (const tier of tiers) {
    if (Array.isArray(tier.days) && weekday != null && !tier.days.includes(weekday)) continue;
    const from = parseClock(tier.from);
    const to = parseClock(tier.to);
    if (from == null || to == null) { fallback = fallback || tier; continue; }
    if (minutes == null) continue;
    // to < from 是跨午夜：22:00→08:00 命中 [22:00,24:00) 与 [00:00,08:00)。
    const inside = from < to
      ? minutes >= from && minutes < to
      : minutes >= from || minutes < to;
    if (inside) return tier;
  }
  return fallback;
}


// 价格表的基准币种：人民币。
//
// 这是用户明确要的「默认人民币」的完整含义 —— 不只是显示用人民币，
// 账本身就记在人民币上：文件里存人民币，算出来的钱也是人民币。
//
// 与外部美元数据的关系（这是唯一需要小心的地方）：
//   opencode-go 的官方已结算账单是从供应商拿的美元值（1e-8 美元整数）。
//   它不会与价格表算出的人民币金额相加 —— summary.estimatedCost 只累计 calcCost 的结果，
//   官方成本单独走 modelCosts[].cost（source 标为 official）。
//   两边各有自己的币种标记，界面按标记决定要不要换算。

/**
 * 价表项里没有小数位的问题：价格表存人民币，用户填多少就存多少，不做任何换算。
 * 这个函数只做一件事 —— 把数字收成 10 位有效数字，避免 1/3 这类值写出无限小数。
 *
 * 为什么还要收：用户填的是 1.8、0.27 这种十进制数，收一下不影响；
 * 但若将来有按费率反算的地方，不收就会在文件里留下 0.3333333333333333。
 */
export function tidyPriceNumber(n) {
  if (!Number.isFinite(n)) return n;
  if (n === 0) return 0;
  return Number(n.toPrecision(10));
}

// 写盘与计算都用人民币，不做任何币种换算。
// 这个函数只负责把数字收一下，避免反算出来的值在文件里写成无限小数。
function tidyNumber(n) {
  if (!Number.isFinite(n)) return n;
  if (n === 0) return 0;
  return Number(n.toPrecision(10));
}

/**
 * 出厂默认价表从美元换算成人民币。
 *
 * 为什么要一个函数而不是把换算后的数直接写死在表里：
 *   1. 源码里保留官网原价（美元），能直接对照供应商页面校对 ——
 *      一堆 0.93650578 这种数，几个月后没人能看出它对不对。
 *   2. 默认价的换算基准是个“当前汇率快照”，不是账。它在启动时算一次，
 *      写成常量的话汇率变了要改代码。
 *
 * 传进来的 USD 表保持原样不动，返回一份新的 CNY 表。
 */
export function usdTableToCny(usdTable, rate) {
  const r = Number(rate);
  const src = usdTable && typeof usdTable === "object" ? usdTable : {};
  if (!Number.isFinite(r) || r <= 0) return {};
  const out = {};
  for (const [key, price] of Object.entries(src)) {
    const next = {};
    for (const k of PRICE_KEYS) {
      const n = Number(price?.[k]);
      if (price?.[k] == null || !Number.isFinite(n)) continue;
      next[k] = tidyNumber(n * r);
    }
    if (Array.isArray(price?.contextTiers)) {
      next.contextTiers = price.contextTiers.map((t) => {
        const tier = { maxContext: Number(t.maxContext) };
        for (const k of PRICE_KEYS) {
          const n = Number(t[k]);
          if (Number.isFinite(n)) tier[k] = tidyNumber(n * r);
        }
        return tier;
      });
    }
    // 分时价与按次价同样要随基准货币换算，否则默认表一旦开始带时段，
    // 会只有基础四价被换成人民币、时段价还是美元。
    if (Array.isArray(price?.timeTiers)) {
      next.timeTiers = price.timeTiers.map((t) => {
        const tier = {};
        if (t.from != null) tier.from = t.from;
        if (t.to != null) tier.to = t.to;
        if (Array.isArray(t.days)) tier.days = [...t.days];
        for (const k of PRICE_KEYS) {
          const n = Number(t[k]);
          if (t[k] != null && Number.isFinite(n)) tier[k] = tidyNumber(n * r);
        }
        return tier;
      });
    }
    if (price?.perCall != null && Number.isFinite(Number(price.perCall))) {
      next.perCall = tidyNumber(Number(price.perCall) * r);
    }
    out[key] = next;
  }
  return out;
}

// 出厂自带的价格：OpenCode Go 官网原价，单位是**美元 / 每百万 token**。
//
// 注意这里的币种：这是供应商官网的原始报价，故意保持美元，因为它是要拿来校对的东西。
// 真正的默认价表由 defaultPriceTableIn(rate) 换算成人民币后给出，
// 不要把这张表当成可用的价格直接读数 —— 它只是“原价快照”。
//
// 校验时间：2026-08。
export const USD_SOURCE_PRICE_TABLE = {
  "opencode-go/deepseek-v4-flash": { input: 0.14, cacheRead: 0.0028, cacheWrite: 0, output: 0.28 },
  "opencode-go/deepseek-v4-pro": { input: 0.435, cacheRead: 0.003625, cacheWrite: 0, output: 0.87 },
  "opencode-go/gpt-5.6-luna": {
    input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2,
    // 长上下文分档：单次上下文超过 272K 之后走这一档。
    contextTiers: [{ maxContext: 272000, input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 }],
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

// 默认价表的基准汇率。
//
// 为什么不能直接用运行时汇率：默认价表是**代码里的一部分**，它参与了「用户没填时算多少钱」
// 这件很基础的事。如果它每天跟着汇率变，同一个月的估算费用会自己飘 ——
// 而这不是汇率造成的真实变化，是我们自己没把默认价稳定下来。
// 默认价按一个固定基准换算，用户想用实时汇率就自己填价（填的是人民币，不再换算）。
//
// 改这个值等于改所有“用户没填”的模型的历史估算，改之前想清楚。
export const DEFAULT_PRICE_RATE = 6.689327;

// ── 模型级默认价（按模型名，不按供应商） ──
//
// 价格表里用户填的键是「供应商/模型」，但同一条价往往被多个供应商共用：
// deepseek-flash 走官方、走中转，标价是同一份。为每个供应商各写一遍既难维护，
// 也会在新增中转时被迫补一行。
//
// 所以这里按**模型名**登记一份，查找时作为最后一级回退：
//   用户填的 provider/model  >  内置的 provider/model  >  内置的 model
// 前两级保持原样，新增的只有第三级 —— 既不动用户已填的键，也不改现有表的含义。
//
// 别名各写一条，不做自动归一化。glm-5.3-flash 与 glm-5-3-flash 确实是同一个模型，
// 但「去点号、去日期后缀」这种规则一旦把两个真不同的模型合到一起，这张表就没人敢信了。
// 大小写变体也单独列，因为查找是精确匹配。
//
// 人民币来源的价（DeepSeek、智谱、阶跃官方页就是人民币）直接写进 CNY 表，
// 美元来源的（OpenAI、xAI、Anthropic）写进 USD 表走同一个基准汇率换算。
// 混着放会让「这条是换算来的还是原生的」变得看不出来。

// DeepSeek Flash：官方分时。工作日 9:00–12:00、14:00–18:00 双倍，其余时段（含周末节假日）半价。
// 基础四价写平峰档，timeTiers 只列高峰段 —— matchTimeTier 从上往下取第一个命中，
// 没命中的自然回落到底价，不需要再写一条「其余时段」。
const DS_FLASH = {
  input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4,
  timeTiers: [
    { from: "09:00", to: "12:00", days: [1, 2, 3, 4, 5], input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    { from: "14:00", to: "18:00", days: [1, 2, 3, 4, 5], input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
  ],
};

// 智谱 GLM-5.3-Flash。缓存存储限时免费，所以 cacheWrite 记 0。
const GLM_53_FLASH = { input: 0.8, cacheRead: 0.23, cacheWrite: 0, output: 2.8 };

// 阶跃 Step-5-Preview。缓存读 0.70；2026-10-14 起从 0.35 上调，老账户仍按 0.35。
const STEP_5_PREVIEW = { input: 7, cacheRead: 0.7, cacheWrite: 0, output: 20 };

// 小米 MiMo。
//
// 官方页（mimo.mi.com/docs/zh-CN/pricing）已把 V2.5 系列标为「2026.10.21 10:00 正式下线，
// 原模型名称已失效」，现役表里只剩 V2.6 三档。V2.5 的价按同档继任型号取：
// 2026-05 那次大降价后，V2.5-Pro 输出 6 元 / V2.5 输出 2 元，与 V2.6-Pro / V2.6-Flash 一致，
// 相当于换名不换价。
//
// 取国内人民币价（官方国内、海外是两套独立定价，不按汇率对应）。
// 批量推理五折、缓存写入限时免费；前者价格表没有这个维度，后者记 0。
const MIMO_FLASH = { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 2 };
const MIMO_PRO = { input: 3, cacheRead: 0.025, cacheWrite: 0, output: 6 };
const MIMO_PRO_ULTRA = { input: 30, cacheRead: 0.25, cacheWrite: 0, output: 60 };

/** 人民币原生价。官方页就是人民币，不经过汇率，换算只在国内侧发生。 */
export const CNY_MODEL_PRICE_TABLE = {
  // DeepSeek。官方页写明旧名已下线、请求由 V4.1-Flash-1017 承接并按 Flash 价计费，
  // 所以这几个旧名与别名都指向同一份价。
  "deepseek-flash": { ...DS_FLASH },
  "deepseek-v4-flash": { ...DS_FLASH },
  "deepseek-v4-flash-vision-exp": { ...DS_FLASH },
  "deepseek-v4.1-flash": { ...DS_FLASH },
  "DeepSeek-V4-Flash": { ...DS_FLASH },
  "DeepSeek-V4.1-Flash": { ...DS_FLASH },
  // 官方页上写的完整型号名就是带 -1017 的那个，同一个价。
  "DeepSeek-V4.1-Flash-1017": { ...DS_FLASH },
  "x-deepseek-flash": { ...DS_FLASH },
  "workbuddy/deepseek-v4.1-flash": { ...DS_FLASH },
  // raccoon 中转把连符换成短横并挂了日期后缀，同一条价。
  "sn-deepseek-v4-1-flash-1017": { ...DS_FLASH },

  // 智谱：点号、连字符、日期后缀三种写法在数据里都出现过。
  "glm-5.3-flash": { ...GLM_53_FLASH },
  "glm-5-3-flash": { ...GLM_53_FLASH },
  "glm-5-3-flash-260828": { ...GLM_53_FLASH },
  "GLM-5.3-Flash": { ...GLM_53_FLASH },
  "sn-glm-5-3-flash": { ...GLM_53_FLASH },

  "step-5-preview": { ...STEP_5_PREVIEW },

  // 小米。归档里 V2.5 两个名字已停用，留着让历史账能对到底；V2.6 是现役。
  "mimo-v2.5": { ...MIMO_FLASH },
  "mimo-v2.5-pro": { ...MIMO_PRO },
  "mimo-v2.6-flash": { ...MIMO_FLASH },
  "mimo-v2.6-pro": { ...MIMO_PRO },
  "mimo-v2.6-pro-ultraspeed": { ...MIMO_PRO_ULTRA },
};

// xAI Grok：单次 prompt 到 200k token 时**整单**按长上下文价计费，不是超出部分单独算。
const GROK = {
  input: 2, cacheRead: 0.5, cacheWrite: 0, output: 6,
  contextTiers: [{ maxContext: 200000, input: 4, cacheRead: 1, cacheWrite: 0, output: 12 }],
};

/** 美元原生价。经 DEFAULT_PRICE_RATE 换算成人民币。 */
export const USD_MODEL_PRICE_TABLE = {
  // OpenAI。缓存写分 30 分钟档与 12 小时档（$5 / $10），表里只能存一个，取 30 分钟档。
  // 官方注明这是促销价，至少延续到 2026-11-21。
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },

  "grok-4.6": { ...GROK },
  "grok-4.7": { ...GROK },

  // Anthropic Fable 5。缓存读是输入价的 0.1 倍。
  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
};

/**
 * 默认价表（人民币）。按固定基准汇率从官网美元价换算，不随运行时汇率浮动。
 *
 * 三份拼起来：OpenCode Go 的供应商级旧表、新增的模型级美元表、新增的模型级人民币表。
 * 人民币那份放最后，保证它不被换算值覆盖。
 *
 * 模型级的键是纯模型名，不会出现在价格清单的并集里（那份并集只取用过的、展示的、
 * 用户写的），所以多出这些键不会让界面多出一批跟用户无关的行。
 */
export const DEFAULT_PRICE_TABLE = {
  ...usdTableToCny(USD_SOURCE_PRICE_TABLE, DEFAULT_PRICE_RATE),
  ...usdTableToCny(USD_MODEL_PRICE_TABLE, DEFAULT_PRICE_RATE),
  ...CNY_MODEL_PRICE_TABLE,
};

/**
 * 是否「四价」形态。
 * 空对象也算：它表示「这个模型立了键、四价都还没填」，用户自行添加时就是这个状态。
 * 不把空对象算进来的话，新加的模型下次刷新就凭空消失。
 */
export function isFlatPrice(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (Object.keys(v).length === 0) return true;
  return PRICE_KEYS.some((k) => v[k] !== undefined)
    || Array.isArray(v.contextTiers)
    || Array.isArray(v.timeTiers)
    || v.perCall !== undefined;
}

/**
 * 归一化：只留四个数字 + contextTiers。
 * 非数字、负数、Infinity、空串一律当作「没填」丢掉，不写 0。
 */
export function normalizePrice(raw) {
  if (!isFlatPrice(raw)) return null;
  const out = {};
  for (const k of PRICE_KEYS) {
    const n = Number(raw[k]);
    if (raw[k] === "" || raw[k] == null || !Number.isFinite(n) || n < 0) continue;
    out[k] = n;
  }
  if (Array.isArray(raw.contextTiers)) {
    const tiers = raw.contextTiers.map((t) => {
      if (!t || typeof t !== "object") return null;
      const max = Number(t.maxContext);
      if (!Number.isFinite(max) || max <= 0) return null;
      const tier = { maxContext: max };
      for (const k of PRICE_KEYS) {
        const n = Number(t[k]);
        if (Number.isFinite(n) && n >= 0) tier[k] = n;
      }
      return tier;
    }).filter(Boolean);
    if (tiers.length) out.contextTiers = tiers;
  }
  // 分时定价。空数组当「没配」丢掉，否则界面上会多出一个永远不生效的开关。
  const timeTiers = normalizeTimeTiers(raw.timeTiers);
  if (timeTiers) out.timeTiers = timeTiers;
  // 按次计价：元 / 次。与 token 单价并存（有的模型两头都收）。
  const perCall = Number(raw.perCall);
  if (raw.perCall !== "" && raw.perCall != null && Number.isFinite(perCall) && perCall >= 0) {
    out.perCall = perCall;
  }
  return out;
}

/**
 * 用户表覆盖默认表，**按项**合并。
 * 这是「界面允许只填一格」的前提：只填 output 时，另外三格仍是默认价。
 */
export function mergePriceTables(userTable, defaults = DEFAULT_PRICE_TABLE) {
  const merged = {};
  for (const [key, value] of Object.entries(defaults || {})) merged[key] = { ...value };
  for (const [key, value] of Object.entries(userTable || {})) {
    // 用户只填了一部分时的底子：先取供应商级，没有就退到同名模型级默认价。
    //
    // 不退这一步的后果很具体：用户只配了分时、没填基础四价，
    // 合并后底子是空对象，于是时段外的那些小时按 0 算钱 —— 界面上看着正常，账却少一大截。
    // 这也让「只填一格不清零」的语义延伸到模型级：给某个中转的 deepseek-flash 只改输入价，
    // 输出价能从同一模型的默认价里继承下来。
    const model = splitKey(key).model;
    const base = merged[key] || (model ? merged[model] : null) || {};
    merged[key] = { ...base, ...value };
  }
  return merged;
}

/**
 * 选价：先看时段，再看上下文分档。
 *
 * `at` = { minutes, weekday }，描述“这笔量发生在哪一刻”。
 * 不传 at（旧调用方、按天聚合的路径）就跳过时段，用基础四价 ——
 * 这时若价格里真配了 timeTiers，意味着算出来的钱会偏高或偏低，但不会算错成负数。
 * 所以 dashboard 那边的分时路径必须把 at 传下来。
 */
export function pickPrice(price, mv, at = null) {
  if (!price) return null;
  let base = price;
  const slot = matchTimeTier(price.timeTiers, at);
  if (slot) {
    const { from, to, days, ...slotPrice } = slot;
    base = { ...price, ...slotPrice };
  }
  if (!Array.isArray(base.contextTiers) || !base.contextTiers.length) return base;
  const calls = Math.max(1, mv.callCount || mv.assistantCount || 1);
  const perCall = ((mv.input || 0) + (mv.cacheRead || 0)) / calls;
  let ap = base;
  let matchedMax = -1;
  for (const tier of base.contextTiers) {
    // maxContext 是这一档的**下限**（超过它才进这档），不是上限。
    // 写成 maxContext > perCall 就是反的 —— 这个方向已经错过两次（一次是初版，
    // 一次是重写时），所以把比较写成「单次量 < 门槛 → 跳过」这种正向说法，
    // 读起来不容易再错。
    if (perCall <= tier.maxContext) continue;
    if (tier.maxContext < matchedMax) continue;
    const { maxContext, ...tierPrice } = tier;
    ap = { ...base, ...tierPrice };
    matchedMax = tier.maxContext;
  }
  return ap;
}

/**
 * 算一笔钱。
 * mv：{ input, cacheRead, cacheWrite, output, callCount / assistantCount }
 * at：{ minutes, weekday }，这笔量发生在哪一刻；不传就不走分时。
 * 缺项按 0 算；没价就 0。永远不返回 NaN。
 */
export function calcCost(price, mv, at = null) {
  if (!price || !mv) return 0;
  const ap = pickPrice(price, mv, at);
  if (!ap) return 0;
  const tokenCost = (mv.input || 0) * (ap.input || 0) / 1e6
    + (mv.cacheRead || 0) * (ap.cacheRead || 0) / 1e6
    + (mv.cacheWrite || 0) * (ap.cacheWrite || 0) / 1e6
    + (mv.output || 0) * (ap.output || 0) / 1e6;
  // 按次：拿真实次数乘，不能用 Math.max(1, …) ——
  // 那个 1 是 pickPrice 里防除零用的，挪到这里会把「0 次调用」算成一次。
  const calls = mv.callCount || mv.assistantCount || 0;
  const callCost = calls * (ap.perCall || 0);
  return tokenCost + callCost;
}

/** 有没有「真的能算出钱」的项。全 0 = 没配（界面上那句「未完整定价」靠它判）。 */
export function isPriced(price) {
  if (!price) return false;
  if (PRICE_KEYS.some((k) => Number(price[k]) > 0)) return true;
  if (Number(price.perCall) > 0) return true;
  // 只配了分时段价、基础价留空的模型也是「定了价」的，不能显示成未定价。
  if (Array.isArray(price.timeTiers) && price.timeTiers.some((t) => PRICE_KEYS.some((k) => Number(t?.[k]) > 0))) return true;
  return false;
}

/** 价格键 → 供应商与模型。模型名里允许再带斜杠，所以只切第一个。 */
export function splitKey(key) {
  const s = String(key ?? "");
  const at = s.indexOf("/");
  if (at <= 0) return { provider: "", model: s };
  return { provider: s.slice(0, at), model: s.slice(at + 1) };
}
