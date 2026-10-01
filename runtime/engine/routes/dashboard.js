import { resolveHanaHome, readTextFile } from "../services/platform.js";
import { buildVisualAnalytics } from "../services/visual-analytics.js";
import { queryTurns, queryTurnSizes } from "../services/turns-store.js";
import { readTurnCalls } from "../services/turn-calls.js";
import { loadLedger } from "../services/ledger-source.js";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  loadBalanceApis,
  fetchBalance,
  fetchMinimaxTokenPlan,
  fetchSensenovaTokenPlanPools,
  fetchSensenovaQuota,
  persistSensenovaToken,
  fetchSubscriptionQuota,
  fetchVolcengineCodingPlan,
  collectBalances,
  registerBalanceFetcher,
} from "../services/balance.js";

// OpenCode Go 官方定价表（opencode.ai/docs/go 校验，2026-08；已与官方账单实测对账）
// 价格口径：全部为 OpenCode Go 官方美元价（含 DeepSeek，实测无峰谷）
// monthlyAllowance：OpenCode Go 各模型每月使用额度（美元，官方 docs「使用额度」列）
// contextTiers：长上下文分档价格（超过 maxContext tokens 用该档，如 Luna >272K、Qwen >256K）
// cacheWritePerM：缓存写入价（官方 docs「缓存写入」列，无 - 的模型为 0）
const DEFAULT_PRICE_TABLE = {
  "opencode-go/deepseek-v4-flash": {
    currency: "USD",
    monthlyAllowance: 60,
    defaultPrice: { unit: "token", inputPerM: 0.14, inputCachePerM: 0.0028, outputPerM: 0.28, cacheWritePerM: 0 }
  },
  "opencode-go/deepseek-v4-pro": {
    currency: "USD",
    monthlyAllowance: 15,
    defaultPrice: { unit: "token", inputPerM: 0.435, inputCachePerM: 0.003625, outputPerM: 0.87, cacheWritePerM: 0 }
  },
  "opencode-go/gpt-5.6-luna": {
    currency: "USD",
    monthlyAllowance: 15,
    defaultPrice: { unit: "token", inputPerM: 0.2, inputCachePerM: 0.02, outputPerM: 1.2, cacheWritePerM: 0.25 },
    contextTiers: [
      { maxContext: 272000, price: { unit: "token", inputPerM: 0.4, inputCachePerM: 0.04, outputPerM: 1.8, cacheWritePerM: 0.5 } }
    ]
  },
  "opencode-go/grok-4.5": { currency: "USD", monthlyAllowance: 15, defaultPrice: { unit: "token", inputPerM: 2, inputCachePerM: 0.3, outputPerM: 6, cacheWritePerM: 0 } },
  "opencode-go/glm-5.2": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 1.4, inputCachePerM: 0.26, outputPerM: 4.4, cacheWritePerM: 0 } },
  "opencode-go/glm-5.1": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 1.4, inputCachePerM: 0.26, outputPerM: 4.4, cacheWritePerM: 0 } },
  "opencode-go/kimi-k3": { currency: "USD", monthlyAllowance: 15, defaultPrice: { unit: "token", inputPerM: 3, inputCachePerM: 0.3, outputPerM: 15, cacheWritePerM: 0 } },
  "opencode-go/kimi-k2.7-code": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.95, inputCachePerM: 0.19, outputPerM: 4, cacheWritePerM: 0 } },
  "opencode-go/kimi-k2.6": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.95, inputCachePerM: 0.16, outputPerM: 4, cacheWritePerM: 0 } },
  "opencode-go/mimo-v2.5": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.14, inputCachePerM: 0.0028, outputPerM: 0.28, cacheWritePerM: 0 } },
  "opencode-go/mimo-v2.5-pro": { currency: "USD", monthlyAllowance: 15, defaultPrice: { unit: "token", inputPerM: 0.435, inputCachePerM: 0.003625, outputPerM: 0.87, cacheWritePerM: 0 } },
  "opencode-go/minimax-m3": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.3, inputCachePerM: 0.06, outputPerM: 1.2, cacheWritePerM: 0 } },
  "opencode-go/minimax-m2.7": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.3, inputCachePerM: 0.06, outputPerM: 1.2, cacheWritePerM: 0.375 } },
  "opencode-go/minimax-m2.5": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.3, inputCachePerM: 0.06, outputPerM: 1.2, cacheWritePerM: 0.375 } },
  "opencode-go/qwen3.7-max": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 2.5, inputCachePerM: 0.5, outputPerM: 7.5, cacheWritePerM: 3.125 } },
  "opencode-go/qwen3.7-plus": {
    currency: "USD",
    monthlyAllowance: 60,
    defaultPrice: { unit: "token", inputPerM: 0.4, inputCachePerM: 0.04, outputPerM: 1.6, cacheWritePerM: 0.5 },
    contextTiers: [
      { maxContext: 256000, price: { unit: "token", inputPerM: 1.2, inputCachePerM: 0.12, outputPerM: 4.8, cacheWritePerM: 1.5 } }
    ]
  },
  "opencode-go/qwen3.6-plus": {
    currency: "USD",
    monthlyAllowance: 60,
    defaultPrice: { unit: "token", inputPerM: 0.5, inputCachePerM: 0.05, outputPerM: 3, cacheWritePerM: 0.625 },
    contextTiers: [
      { maxContext: 256000, price: { unit: "token", inputPerM: 2, inputCachePerM: 0.2, outputPerM: 6, cacheWritePerM: 2.5 } }
    ]
  },
  "opencode-go/hy3": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.14, inputCachePerM: 0.035, outputPerM: 0.58, cacheWritePerM: 0 } }
};

// 选择实际计费档位：长上下文分档（按平均单次输入 token 估算，插件无单次请求明细）→ 特殊时段
function pickPrice(price, mv, hour) {
  if (!price) return null;
  if (price.defaultPrice === undefined) return price;
  let ap = price.defaultPrice;
  // 长上下文分档：avgInputPerCall 超过阈值走高档（maxContext 为该档下限，多档取最高匹配档，不依赖配置顺序）
  if (price.contextTiers && price.contextTiers.length) {
    // 长上下文场景缓存命中占大头，用 input+cacheRead 反映总上下文量级，避免高档永不触发
    const perCall = ((mv.input || 0) + (mv.cacheRead || 0)) / Math.max(1, mv.callCount || mv.assistantCount || 1);
    let matched = null, matchedMax = -1;
    for (const t of price.contextTiers) {
      if (t.maxContext == null) { matched = t.price; matchedMax = Infinity; continue; }
      if (perCall > t.maxContext && t.maxContext >= matchedMax) { matched = t.price; matchedMax = t.maxContext; }
    }
    if (matched) ap = { ...ap, ...matched };
  }
  if (price.slots && price.slots.length > 0) {
    const cur = hour !== undefined ? hour * 60 + 30 : (new Date().getHours() * 60 + 30);
    for (const s of price.slots) {
      const f = (s.from||"00:00").split(":").map(Number);
      const t = (s.to||"24:00").split(":").map(Number);
      const fs = f[0]*60+(f[1]||0), ts = t[0]*60+(t[1]||0);
      let match = false;
      if (fs <= ts) { if (cur >= fs && cur < ts) match = true; }
      else { if (cur >= fs || cur < ts) match = true; }
      if (match) { ap = s; break; }
    }
  }
  return ap;
}

function calcCost(price, mv, hour) {
  if (!price) return 0;
  // 新格式：defaultPrice（非特殊时段）+ slots（特殊时段）+ contextTiers（长上下文分档）
  if (price.defaultPrice !== undefined) {
    const ap = pickPrice(price, mv, hour);
    const unit = ap.unit || "token";
    if (unit === "per_call") return (mv.callCount || mv.assistantCount || 0) * (ap.pricePerCall || 0);
    if (unit === "per_char") { const chars = (mv.output || 0) + (mv.input || 0); return chars * (ap.pricePer10K || 0) / 10000; }
    return (mv.input || 0) * (ap.inputPerM || 0) / 1e6 + (mv.cacheRead || 0) * (ap.inputCachePerM || 0) / 1e6 + (mv.cacheWrite || 0) * (ap.cacheWritePerM || 0) / 1e6 + (mv.output || 0) * (ap.outputPerM || 0) / 1e6;
  }
  // 旧格式 slots（兼容）
  if (price.slots && price.slots.length > 0) {
    const cur = hour !== undefined ? hour * 60 + 30 : (new Date().getHours() * 60 + 30);
    let slot = null;
    for (const s of price.slots) {
      const f = (s.from||"00:00").split(":").map(Number);
      const t = (s.to||"24:00").split(":").map(Number);
      const fs = f[0]*60+(f[1]||0), ts = t[0]*60+(t[1]||0);
      if (fs <= ts) { if (cur >= fs && cur < ts) { slot = s; break; } }
      else { if (cur >= fs || cur < ts) { slot = s; break; } }
    }
    if (slot) return calcCost(slot, mv);
    return 0;
  }
  const unit = price.unit || "token";
  if (unit === "per_call") {
    return (mv.callCount || mv.assistantCount || 0) * (price.pricePerCall || 0);
  }
  if (unit === "per_char") {
    const chars = (mv.output || 0) + (mv.input || 0);
    return chars * (price.pricePer10K || 0) / 10000;
  }
  return (mv.input || 0) * (price.inputPerM || 0) / 1e6 + (mv.cacheRead || 0) * (price.inputCachePerM || 0) / 1e6 + (mv.cacheWrite || 0) * (price.cacheWritePerM || 0) / 1e6 + (mv.output || 0) * (price.outputPerM || 0) / 1e6;
}

function loadPriceTable(dataDir) {
  const p = path.join(dataDir, "price-table.json");
  const merged = { ...DEFAULT_PRICE_TABLE };
  try {
    if (fs.existsSync(p)) {
      const saved = JSON.parse(readTextFile(p));
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved)) {
          if (merged[k] && v && typeof v === "object" && typeof merged[k] === "object") {
            merged[k] = { ...merged[k], ...v };
          } else {
            merged[k] = v;
          }
        }
      }
    }
  } catch {}
  return merged;
}

// ── USD→CNY 汇率（免费 API：open.er-api.com，无 key，每日更新；本地缓存 6 小时）──
// 关键：缓存必须落到磁盘。内存缓存随进程消失，而这个 App 的 runtime 每次打开都可能重启，
// 于是每次进去都要重新请求一次汇率。接口不可达时默认超时 5 秒——界面就得干等 5 秒。
const FX_TTL_MS = 6 * 3600 * 1000;
const FX_FALLBACK = 7.1;      // 既无缓存又拉不到时的垫底值，避免凭空造出 0 汇率
const FX_TIMEOUT_MS = 400;    // 首屏只给它这么点时间：拉不到就先用已知值，后台再试
let _fxCache = { rate: null, ts: 0 };
let _fxRefreshing = null;

function fxCacheFile() {
  return path.join(ENGINE_DATA || "", "fx-rate.json");
}

function readFxFromDisk() {
  try {
    const p = fxCacheFile();
    if (!ENGINE_DATA || !fs.existsSync(p)) return null;
    const saved = JSON.parse(readTextFile(p));
    if (saved && Number(saved.rate) > 0) return { rate: Number(saved.rate), ts: Number(saved.ts) || 0 };
  } catch {}
  return null;
}

function writeFxToDisk(rate, ts) {
  try {
    if (!ENGINE_DATA) return;
    fs.writeFileSync(fxCacheFile(), JSON.stringify({ rate, ts }));
  } catch {}
}

// 单次请求；失败/超时返回 null，不抛。
// 用 AbortSignal.timeout 而不是 https 的 timeout 选项：后者只管 socket 空闲，
// 管不住 DNS 解析——域名不可达时照样能把首屏拖住好几秒。
function requestFxRate(timeoutMs = FX_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = https.get("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(timeoutMs) }, (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            const cny = JSON.parse(buf)?.rates?.CNY;
            finish(cny > 0 ? cny : null);
          } catch { finish(null); }
        });
      });
    } catch { finish(null); return; }
    req.on("error", () => finish(null));
  });
}

// 后台刷新：只在已经拿得到值时用，绝不让请求等它。
function refreshFxInBackground() {
  if (_fxRefreshing) return;
  _fxRefreshing = requestFxRate(3000)
    .then((rate) => { if (rate) { _fxCache = { rate, ts: Date.now() }; writeFxToDisk(rate, _fxCache.ts); } })
    .catch(() => {})
    .finally(() => { _fxRefreshing = null; });
}

async function fetchFxRate() {
  const now = Date.now();
  if (_fxCache.rate && now - _fxCache.ts < FX_TTL_MS) return _fxCache.rate;
  // 内存没有就翻磁盘：上次跑过的汇率足够先用，不必为了它卡住首屏
  const disk = readFxFromDisk();
  if (disk) _fxCache = disk;
  if (_fxCache.rate) {
    if (now - _fxCache.ts >= FX_TTL_MS) refreshFxInBackground();
    return _fxCache.rate;
  }
  // 一个值都没有（全新安装）：只等一次，限时；拿不到就用垫底值，并丢到后台继续试
  const fresh = await requestFxRate();
  if (fresh) {
    _fxCache = { rate: fresh, ts: now };
    writeFxToDisk(fresh, now);
    return fresh;
  }
  refreshFxInBackground();
  return FX_FALLBACK;
}

const HOME = resolveHanaHome();
const ENGINE_DATA = process.env.TOKEN_TRACKER_DATA_DIR;
if (!ENGINE_DATA) throw new Error("TOKEN_TRACKER_DATA_DIR is required");
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../app");
// 下面三个文件是引擎自带那个旧看板页面的资产；该页面已不再挂载（见 service.mjs），文件已删。
// 读不到就当作空：别让模块导入失败——本模块里还住着 dashboard 的数据构建逻辑（ctx._buildDashboardData）。
const readIfExists = (f) => { try { return readTextFile(f); } catch { return ""; } };
const JS = readIfExists(path.join(APP, "dashboard-app.js"));
const BASE = readIfExists(path.join(APP, "base.css"));
const THEME = readIfExists(path.join(APP, "theme.css"));

// ── 实时监控 SSE 流创建（P0-2 修复，模块级导出供路由与 test 共用）──
export const REALTIME_CLIENT_LIMIT = 20;

export function createRealtimeStream(cache) {
  if (!cache?.realtime) return { error: "not ready", status: 503 };
  if (!cache._realtimeClients) cache._realtimeClients = new Set();
  if (cache._realtimeClients.size >= REALTIME_CLIENT_LIMIT) {
    return { error: "SSE 客户端数已达上限（" + REALTIME_CLIENT_LIMIT + "）", status: 503 };
  }

  const encoder = new TextEncoder();
  let streamController = null;
  let closed = false;
  let hbTimer = null;

  const cleanup = () => {
    closed = true;
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    cache._realtimeClients?.delete(client);
    try { streamController?.close(); } catch {}
  };
  const safeSend = (payload) => {
    if (closed || !streamController) return false;
    try {
      streamController.enqueue(encoder.encode("data: " + JSON.stringify(payload) + "\n\n"));
      return true;
    } catch { cleanup(); return false; }
  };

  const sendUsage = () => {
    const snap = cache.realtimeSnapshot
      ? cache.realtimeSnapshot(cache.realtime, cache.data?.agentNames || {})
      : { ...cache.realtime, balances: cache.data?._balances || null, balanceUpdatedAt: cache.realtime.balanceUpdatedAt };
    if (cache.data?._subscriptionQuotas) snap.quotas = cache.data._subscriptionQuotas;
    safeSend({ type: "usage", data: snap });
  };

  const client = { send: safeSend, close: cleanup };
  const clients = cache._realtimeClients;

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      clients.add(client);
      // 首帧：controller 就绪后立即发送（老实现首帧在构造前发送进 void）
      sendUsage();
      hbTimer = setInterval(() => {
        if (!safeSend({ type: "heartbeat", ts: Date.now() })) {
          if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        }
      }, 15000);
      if (hbTimer && typeof hbTimer.unref === "function") hbTimer.unref();
    },
    cancel() {
      cleanup();
    },
  });

  return { stream };
}

export default function (app, ctx) {
  
  // /dashboard/data 构建逻辑（P1）：抽为挂在 ctx 上的可复用函数，
  // HTTP 路由与 bus handler(token-tracker.dashboard，见 index.js) 共用。
  // 挂在 ctx 是因为 ctx 是 index.js 与路由共享的同一实例（如 ctx._tokenCache）。
  ctx._buildDashboardData = async (params = {}, opts = {}) => {
    try {
      const cache = ctx._tokenCache;
      // 只要求“有数据”，不要求“本轮扫描已完成”：启动时缓存已从 SQLite 播下，
      // 直接拿它先渲染，扫描完成后 SSE 会把最新状态推上去。
      if (!cache?.data || !cache.data.sessions) return { notReady: true, error: "数据未就绪" };
      const range = params.range || "all";
      const agent = toList(params.agent);
      const model = toList(params.model);
      const type = toList(params.type);
      const from = params.from || "";
      const to = params.to || "";
      const provider = toList(params.provider);
      // 明细分页/排序参数（服务端分页）：page/pageSize/sortKey/order/minTokens，一律由 build 内部白名单化。
      const detailsParams = { page: params.page, pageSize: params.pageSize, sortKey: params.sortKey, order: params.order, minTokens: params.minTokens };
      // 确保汇率可用（内部统一美元口径计算用）；opts.fxRate 供测试注入
      const fxRate = opts.fxRate !== undefined ? opts.fxRate : await fetchFxRate();
      const result = build({ ...cache.data, dataDir: cache.dataDir }, range, { agent, model, type, provider, from, to, ...detailsParams }, fxRate, cache.turnsStore);
      // 用 agent:list 覆盖 agentNames，保证显示名正确；标记已删除的 agent
      const activeAgentIds = new Set();
      try {
        const ar = await ctx.bus.request("agent:list");
        if (ar?.agents) {
          const names = {};
          for (const a of ar.agents) { names[a.id] = a.name || a.id; activeAgentIds.add(a.id); }
          result.agentNames = names;
        }
      } catch (e) { /* non-critical */ }
      for (const a of result.agents) {
        if (!activeAgentIds.has(a.id)) a.deleted = true;
      }
      if (opts.skipBalances) return result;
      // 附上各供应商余额 + 供应商配置
      try {
        const providers = [];
        const provSeen = new Set();
        // 1) 从 provider-catalog.json 读取文本模型供应商
        const catalogPath = path.join(HOME, "provider-catalog.json");
        if (fs.existsSync(catalogPath)) {
          try {
            const catalog = JSON.parse(readTextFile(catalogPath));
            if (catalog.providers) {
              for (const [provId, provData] of Object.entries(catalog.providers)) {
                if (provSeen.has(provId)) continue;
                const models = [];
                if (Array.isArray(provData.models)) {
                  for (const m of provData.models) {
                    const mid = typeof m === "string" ? m : m.id;
                    if (mid) models.push(mid);
                  }
                }
                if (models.length) { providers.push({ id: provId, models }); provSeen.add(provId); }
              }
            }
          } catch {}
        }
        // 2) 从 preferences.json 读取多媒体供应商（imageGeneration / videoGeneration）
        const prefPath = path.join(HOME, "user", "preferences.json");
        if (fs.existsSync(prefPath)) {
          try {
            const pref = JSON.parse(readTextFile(prefPath));
            for (const cap of ["imageGeneration", "videoGeneration"]) {
              const pd = pref[cap]?.providerDefaults;
              if (!pd) continue;
              for (const [provId, provData] of Object.entries(pd)) {
                const models = [];
                if (provData.models) {
                  for (const mid of Object.keys(provData.models)) models.push(mid);
                }
                if (!models.length) continue;
                if (provSeen.has(provId)) {
                  const existing = providers.find(p => p.id === provId);
                  if (existing) { for (const m of models) { if (!existing.models.includes(m)) existing.models.push(m); } }
                } else {
                  providers.push({ id: provId, models }); provSeen.add(provId);
                }
              }
            }
          } catch {}
        }
        result._providerConfig = providers;
        // 合并 catalog/价格表中的供应商到 result.providers（前端筛选用）
        if (result.providers) {
          const seenProvs = new Set(result.providers.map(p => p.provider));
          for (const p of providers) {
            if (!seenProvs.has(p.id)) { result.providers.push({ provider: p.id, model: "", totalTokens: 0, count: 0 }); seenProvs.add(p.id); }
          }
          // 也加上价格表中的
          const pt3 = loadPriceTable(cache.dataDir || "");
          for (const pk of Object.keys(pt3)) {
            const pid = pk.split("/")[0];
            if (pid && !seenProvs.has(pid)) { result.providers.push({ provider: pid, model: "", totalTokens: 0, count: 0 }); seenProvs.add(pid); }
          }
        }
        result._balances = [];
        const balApis = loadBalanceApis(cache.dataDir || "");
        let yamlKeys = {};
        try {
          const yamlPath2 = path.join(HOME, "added-models.yaml");
          if (fs.existsSync(yamlPath2)) {
            const yaml2 = readTextFile(yamlPath2) + "\n";
            const provMatches2 = [...yaml2.matchAll(/^  (\S+):\s*\n((?:    .+\n)*)/gm)];
            for (const pm of provMatches2) {
              const keyIdx = pm[2].indexOf("api_key:");
              if (keyIdx >= 0) {
                // 取 api_key 后所有缩进 4 空格的内容，合并多行（YAML 自动折行场景）
                let block = pm[2].substring(keyIdx + 8);
                // 去掉结尾后若有下一个 key 的下一行（其它缩进 4 空格的 key），提前截断
                const nextKeyM = block.match(/\n    [a-zA-Z_][\w-]*:/);
                if (nextKeyM) block = block.substring(0, nextKeyM.index);
                // 合并 YAML 折行：移除换行 + 之后的空白
                const merged = block.replace(/\s*\n\s*/g, "").trim();
                // 去引号
                const cleaned = merged.replace(/^["']|["']$/g, "");
                yamlKeys[pm[1]] = cleaned.split(/\s/)[0];
              }
            }
          }
        } catch {}
        let catalogKeys = {};
        try {
          if (fs.existsSync(catalogPath)) {
            const cat = JSON.parse(readTextFile(catalogPath));
            if (cat.providers) for (const [pid, pd] of Object.entries(cat.providers)) { if (pd.api_key) catalogKeys[pid] = pd.api_key; }
          }
        } catch {}
        result._subscriptionQuotas = [];
        // ── 订阅余量查询（独立于 provider 列表，直接从 balance-apis 配置读取） ──
        const allApiConf = balApis;
        for (const [provId, apiConf] of Object.entries(allApiConf)) {
          // 火山方舟 Coding Plan（AK/SK + V4 签名）
          if (apiConf.responseType === "volcengine-coding-plan") {
            if (apiConf.enabled === false) continue;
            if (!apiConf.ak || !apiConf.sk) {
              result._subscriptionQuotas.push({ provider: provId, label: provId, type: "no-token", display: "未配置 AK/SK", providerId: provId });
              continue;
            }
            const q = await Promise.race([
              fetchVolcengineCodingPlan(apiConf),
              new Promise(r => setTimeout(() => r(null), 5500))
            ]);
            if (q) {
              result._subscriptionQuotas.push({ provider: provId, label: provId, ...q });
            } else {
              result._subscriptionQuotas.push({ provider: provId, label: provId, type: "error", display: "查询失败" });
            }
            continue;
          }
          // OpenCode Go（控制台 cookie 抓取）
          if (apiConf.responseType === "opencode-go") {
            if (apiConf.enabled === false) continue;
            if (!apiConf.workspaceId || !apiConf.cookie) {
              result._subscriptionQuotas.push({ provider: provId, label: "OpenCode Go", type: "no-token", display: "未配置 workspace/cookie", providerId: provId });
              continue;
            }
            // 余量优先：余量拿到后立即返回，stats 并行跑完即可，不拖后腿
            const gq = await Promise.race([
              fetchOpenCodeGoQuota(apiConf),
              new Promise(r => setTimeout(() => r(null), 12000))
            ]);
            const statsPromise = Promise.race([
              fetchOpenCodeGoStats(apiConf.cookie, apiConf.workspaceId),
              new Promise(r => setTimeout(() => r(null), 8000))
            ]).catch(() => null);
            const entry = { provider: provId, label: "OpenCode Go", providerId: provId };
            if (gq) {
              Object.assign(entry, gq);
              const stats = await statsPromise;
              if (stats) {
                entry.costs = stats.costs || [];
                entry.keys = stats.keys || [];
                // 把 key 名字持久化到 usage 缓存（getCosts 偶尔返回空时也能显示名字）
                if (stats.keys && stats.keys.length) {
                  try {
                    const uc = loadOgUsageCache();
                    if (!uc.keyNames) uc.keyNames = {};
                    let changed = false;
                    for (const k of stats.keys) {
                      if (k && k.id && k.displayName && uc.keyNames[k.id] !== k.displayName) {
                        uc.keyNames[k.id] = k.displayName;
                        changed = true;
                      }
                    }
                    if (changed) saveOgUsageCache(uc);
                  } catch {}
                }
                entry.usage = stats.usage || [];
                // 全量 usage 缓存作为模型/Key 汇总来源，时间口径与 og-models 统一
                const ogCache2 = loadOgUsageCache();
                const ogRecs = ogCache2.records || {};
                // 模型占比统计全部 key（与订阅余量口径一致，避免漏算其他 key 的消耗）
                const selKey = (ogCache2.primaryKeyId || apiConf.selectedKeyId || "");
                // 官方成本优先：getCosts 已结算账单（1e-8 美元整数，/1e8），usage 缓存只补次数/Token
                const rangeRows = aggregateOgModels(ogRecs, range, from, to, "");
                const monthRows = aggregateOgModels(ogRecs, "month", "", "", "");
                const rangeCosts = aggregateOgCostSources(stats.costs, ogRecs, range, from, to, "");
                const monthCosts = aggregateOgCostSources(stats.costs, ogRecs, "month", "", "", "");
                const rangeCostMap = rangeCosts.costs;
                const monthCostMap = monthCosts.costs;
                entry.modelSummary = mergeOgOfficialCosts(rangeRows, rangeCostMap);
                // 模型月额度固定按当月口径（不随页面筛选范围变化），默认包含全部 KEY。
                entry.monthlyModelUsage = mergeOgOfficialCosts(monthRows, monthCostMap);
                entry.officialModelCosts = rangeCostMap;
                entry.officialMonthlyModelCosts = monthCostMap;
                entry.modelCostScope = "all-keys";
                entry.modelCostSource = rangeCosts.source;
                entry.monthlyCostSource = monthCosts.source;
                entry.keySummary = aggregateOgKeys(stats.keys, ogRecs, range, from, to);
                entry.selectedKeyId = selKey;
                // plan → 套餐额度映射（getCosts 返回 plan 字段）
                if (stats.plan && PLAN_LIMITS[stats.plan]) {
                  ogLimits = { ...PLAN_LIMITS[stats.plan] };
                  ogLimitsPlan = stats.plan;
                }
                // 官方口径可用时校准本地估算系数；同时把已结算账单金额带给前端做对照（仅当月，避免两个月混进校准）
                const monthUsd = Object.values(aggregateOgOfficialCosts(stats.costs, "month", "", "", "")).reduce((s, v) => s + v, 0);
                entry._ogBilledMonth = monthUsd;
                // 当前筛选范围内的已结算账单（与消费明细合计同口径，前端据此对账，避免“全部时间合计 vs 当月账单”错位）
                const rangeUsd = Object.values(aggregateOgOfficialCosts(stats.costs, range, from, to, "")).reduce((s, v) => s + v, 0);
                entry._ogBilledRange = rangeUsd;
                // 订阅时间（UI 展示用，全部来自用户实际数据）：usage 全量缓存最早记录 → getCosts 明细最早 → key ULID 解码（近似）
                // 到期按官方滚动 30 天窗口：订阅起 +30 天（月付 $10，首月 $5）
                let subStart = 0;
                for (const ogid2 in ogRecs) { const t2 = new Date((ogRecs[ogid2].ts || "")).getTime(); if (t2 > 0 && (!subStart || t2 < subStart)) subStart = t2; }
                if (!subStart && stats.costs && stats.costs.length) {
                  for (const c2 of stats.costs) { const t2 = new Date(c2.timeCreated || c2.ts || "").getTime(); if (t2 > 0 && (!subStart || t2 < subStart)) subStart = t2; }
                }
                if (!subStart && stats.keys && stats.keys.length) {
                  for (const k2 of stats.keys) { const u2 = ulidToTs(String(k2.id || "").replace(/^key_/, "")); if (u2 && (!subStart || u2 < subStart)) subStart = u2; }
                }
                // 兜底：账本里最早的 opencode-go 记录（usage 缓存/账单明细为空时仍可给出订阅起点）
                if (!subStart) {
                  try {
                    for (const le of loadLedger(resolveHanaHome()).entries) {
                      if (!le.model || le.model.provider !== "opencode-go") continue;
                      const t2 = new Date(le.startedAt || "").getTime();
                      if (t2 > 0 && (!subStart || t2 < subStart)) subStart = t2;
                    }
                  } catch {}
                }
                if (subStart) { entry._ogSubStart = subStart; entry._ogSubEnd = subStart + 30 * 86400000; }
                // 订阅周期内已结算账单（订阅起点至今，不随筛选范围变）：与窗口实时同口径对照，
                // 避免抽屉选“今日/本周”时拿整个订阅窗口去对短周期账单
                if (subStart) {
                  const subFrom = new Date(subStart);
                  const subFromStr = subFrom.getFullYear() + "-" + String(subFrom.getMonth() + 1).padStart(2, "0") + "-" + String(subFrom.getDate()).padStart(2, "0");
                  const subUsd = Object.values(aggregateOgOfficialCosts(stats.costs, "all", subFromStr, "", "")).reduce((s, v) => s + v, 0);
                  entry._ogBilledSub = subUsd;
                } else {
                  entry._ogBilledSub = entry._ogBilledMonth || 0;
                }
                if (!gq.est) {
                  const est = estimateOpenCodeGoUsage();
                  if (est) {
                    const estWin = (est.windows || []).find(w => w.level === "monthly");
                    if (estWin) calibrateOg(estWin.usedUsd, monthUsd);
                  }
                  // 注意：不反推额度。usagePercent 是美元价值口径（实时，含预扣/未结算），
                  // 与 getCosts 账单（已结算扣费）存在天然差额，账单÷百分比反推会得出错误额度。
                }
                // 剩余预估可用次数：全部按用户实际口径 — 官方窗口剩余额度，按当月实际消耗比例拆分，
                // 再除以用户实际平均单次成本（不采用官方文档的模型额度表/请求数表）
                // 剩余预估可用次数：全部按用户实际口径 — 官方窗口剩余额度，按窗口内实际消耗比例拆分，
                // 再除以用户实际平均单次成本。窗口起点 ≈ key 创建时间（ULID 解码，7/31 15:55 北京），
                // 窗口内消耗 ≈ usage 明细全量（首笔记录 7/31 16:01），因此比例取全量而非自然月。
                const ogAgg = {};
                let ogCostTotal = 0;
                for (const ogid in ogRecs) {
                  const ogu = ogRecs[ogid];
                  if (!ogu || !ogu.model) continue;
                  if (!ogAgg[ogu.model]) ogAgg[ogu.model] = { model: ogu.model, cost: 0, count: 0 };
                  const ogc = ogu.cost || 0;
                  ogAgg[ogu.model].cost += ogc;
                  ogAgg[ogu.model].count++;
                  ogCostTotal += ogc;
                }
                // 账户剩余（月度窗口）：官方模式按 usagePercent，估算模式按 usedUsd/limitUsd
                let ogRemainUsd = 0;
                const ogMWin = (gq.windows || []).find(w => w.level === "monthly");
                if (ogMWin) {
                  ogRemainUsd = gq.est
                    ? Math.max(0, (ogMWin.limitUsd || 0) - (ogMWin.usedUsd || 0))
                    : (ogLimits.monthly || 60) * (100 - (ogMWin.usedPercent || 0)) / 100;
                }
                // ledger 实测 token（含 cache，明细接口不含 cache）→ 每 token 成本
                const ogLedgerTok = {};
                try {
                  for (const le of loadLedger(resolveHanaHome()).entries) {
                    if (!le.model || le.model.provider !== "opencode-go") continue;
                    const mid = le.model.id || le.model.modelId || "";
                    if (!mid) continue;
                    const lu = le.usage || {};
                    const ti = (lu.input && lu.input.totalTokens) || 0, to = (lu.output && lu.output.totalTokens) || 0, tc = (lu.cache && lu.cache.readTokens) || 0;
                    ogLedgerTok[mid] = (ogLedgerTok[mid] || 0) + ti + to + tc;
                  }
                } catch {}
                const remainEst = ogCostTotal > 0 && ogRemainUsd > 0 ? Object.values(ogAgg).map(a => {
                  const share = a.cost / ogCostTotal;
                  const remainUsd = ogRemainUsd * share;
                  const avgCost = a.count ? (a.cost / 1e8) / a.count : 0;
                  const remainCalls = avgCost > 0 ? Math.floor(remainUsd / avgCost) : 0;
                  const totTok = ogLedgerTok[a.model] || 0;
                  const perToken = totTok > 0 ? (a.cost / 1e8) / totTok : 0;
                  const remainTokens = perToken > 0 ? Math.floor(remainUsd / perToken) : 0;
                  return { model: a.model, sharePct: +(share * 100).toFixed(1), remainUsd: +remainUsd.toFixed(2), avgCostUsd: +avgCost.toFixed(6), remainCalls, remainTokens };
                }).filter(x => x.remainCalls > 0).sort((a, b) => b.remainCalls - a.remainCalls) : [];
                entry._ogRemainEst = remainEst;
                entry._ogLimits = { ...ogLimits };
              }
              result._subscriptionQuotas.push(entry);
              // 自动增量同步：usage 缓存超过 2 分钟未同步则后台补拉（不阻塞本次响应）
              const ogCache = loadOgUsageCache();
              if (!ogCache.syncedAt || Date.now() - ogCache.syncedAt > 120000) {
                syncOgUsage(apiConf.cookie, apiConf.workspaceId, "incremental").catch(() => {});
              }
            } else {
              entry.type = "error";
              entry.display = "查询失败";
              result._subscriptionQuotas.push(entry);
            }
            continue;
          }
          // ── Sensenova IAM 自动登录（账号密码 + OAuth2 PKCE + refresh_token 续期）──
          // 也支持 token-only 模式：手动粘贴 access_token，无需账号密码（令牌过期后需重新粘贴）
          if (apiConf.responseType === "sensenova-iam") {
            if (apiConf.enabled === false) continue;
            const hasCreds = apiConf.token || apiConf.refreshToken || (apiConf.username && apiConf.password);
            if (!hasCreds) {
              result._subscriptionQuotas.push({ provider: provId, label: "商汤", type: "no-token", display: "未配置账号密码", providerId: provId });
              continue;
            }
            // TokenPlan 积分池优先（2026-08-28 新积分规则：通用池 + Flash-Lite 专属池）
            let tpDone = false;
            try {
              const tpq = await Promise.race([
                fetchSensenovaTokenPlanPools(cache.dataDir, apiConf),
                new Promise(r => setTimeout(() => r(null), 15000))
              ]);
              if (tpq && tpq.type === "tokenplan-points") {
                result._subscriptionQuotas.push({ provider: provId, label: "商汤 TokenPlan", providerId: provId, ...tpq });
                tpDone = true;
              }
            } catch {}
            // 回退：旧 coding-plan 按模型额度（未开 TokenPlan 的账号）
            if (!tpDone) {
              const q = await Promise.race([
                fetchSensenovaQuota(cache.dataDir, apiConf),
                new Promise(r => setTimeout(() => r(null), 15000))
              ]);
              if (q && q.models) {
                result._subscriptionQuotas.push({ provider: provId, label: "商汤", providerId: provId, ...q });
              } else {
                result._subscriptionQuotas.push({ provider: provId, label: "商汤", type: "error", display: q?.display || "查询失败", providerId: provId });
              }
            }
            // 持久化 token 到 balance-apis.json（避免每次重启都走完整 OAuth2 登录）
            if (apiConf.token || apiConf.refreshToken) {
              persistSensenovaToken(cache.dataDir, apiConf).catch(() => {});
            }
            continue;
          }
          if (apiConf.responseType !== "per-model-quota") continue;
          if (apiConf.enabled === false) continue;
          if (!apiConf.url) {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "no-token", display: "未配置 URL", providerId: provId });
            continue;
          }
          if (!apiConf.token) {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "no-token", display: "未配置 Token", providerId: provId });
            continue;
          }
          const q = await Promise.race([
            fetchSubscriptionQuota(apiConf),
            new Promise(r => setTimeout(() => r(null), 2000))
          ]);
          if (q) {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "quota", ...q });
          } else {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "error", display: "查询失败", url: apiConf.url });
          }
        }
        // ── 传统余额/配额查询 ──
        for (const prov of providers) {
          const apiConf = balApis[prov.id];
          if (!apiConf || !apiConf.url) {
            result._balances.push({ provider: prov.id, label: prov.id, type: "none", display: "未配置" });
            continue;
          }
          const apiKey = (catalogKeys[prov.id] && catalogKeys[prov.id].length >= 40) ? catalogKeys[prov.id] : (yamlKeys[prov.id] || catalogKeys[prov.id]);
          if (apiConf.responseType === "token-plan") {
            try { console.error("[token-tracker/minimax] prov=" + prov.id + " yaml=" + (yamlKeys[prov.id]?"Y":"N") + " catalog=" + (catalogKeys[prov.id]?"Y":"N") + " finalLen=" + (apiKey||"").length); } catch {}
          }
          if (!apiKey) {
            result._balances.push({ provider: prov.id, label: prov.id, type: "no-key", display: "无 API Key" });
            continue;
          }
          const b = await Promise.race([
            (apiConf.responseType === "token-plan")
              ? fetchMinimaxTokenPlan(apiConf, apiKey)
              : fetchBalance(apiConf, apiKey),
            new Promise(r => setTimeout(() => r(null), 4000))
          ]);
          if (b) result._balances.push({ provider: prov.id, label: prov.id, ...b });
          else result._balances.push({ provider: prov.id, label: prov.id, type: "error", display: "查询失败", url: apiConf.url });
        }
        const pt = result._priceTable || loadPriceTable(cache.dataDir || "");
        const modelCosts = [];
        const mgMap = {};
        for (const mg of result.mediaGen || []) { mgMap[mg.provider + "/" + mg.model] = mg; }
        const ogEntryForCosts = (result._subscriptionQuotas || []).find(q => q && q.provider === "opencode-go" && q.officialModelCosts);
        const officialOgCosts = ogEntryForCosts ? ogEntryForCosts.officialModelCosts : null;
        const officialOgRows = ogEntryForCosts ? (ogEntryForCosts.modelSummary || []) : [];
        const officialOgRowMap = Object.fromEntries(officialOgRows.map(r => [r.model, r]));
        // 官方成本没有 Agent/类型维度；只有全局视图才覆盖本地 token 估算，筛选到 Agent/类型时保留本地口径。
        // 注意：此处作用域是 data 路由，filter* 变量定义在 build() 内部，直接引用会 ReferenceError；
        // 用路由内的 agent/type/provider，并限定官方成本非空对象才启用官方口径。
        const useOfficialOgCosts = !!officialOgCosts && Object.keys(officialOgCosts).length > 0 && !agent && !type && (!provider || provider === "opencode-go");
        for (const m of result.models || []) {
          let prov = "";
          for (const pc of providers) { if (pc.models.includes(m.id)) { prov = pc.id; break; } }
          let key = prov + "/" + m.id;
          let price = pt[key];
          // 如果 key 匹配不到，尝试从 priceTable 的 key 中匹配（用户手动配置的模型）
          if (!price && pt) {
            for (const pk of Object.keys(pt)) {
              if (pk.endsWith("/" + m.id)) { price = pt[pk]; key = pk; prov = pk.split("/")[0]; break; }
            }
          }
          const mgEntry = mgMap[key];
          const mv = (price?.unit === "per_call" && mgEntry) ? { ...m, callCount: mgEntry.callCount } : m;
          const unit = price?.unit || "token";
          var inputCost=0,outputCost=0,cacheCost=0;
          if(price&&unit==="token"){
            // 统一用完整用量判定分档（pickPrice 内部按平均输入 token 选档），三项同档计费，避免明细与顶部估算口径不一致
            const mvc = { input: m.input||0, output: m.output||0, cacheRead: m.cacheRead||0, cacheWrite: m.cacheWrite||0, assistantCount: m.assistantCount||0, callCount: m.assistantCount||0 };
            const tp = pickPrice(price, mvc, 12);
            if ((tp.unit || "token") === "token") {
              inputCost = mvc.input * (tp.inputPerM||0) / 1e6;
              outputCost = mvc.output * (tp.outputPerM||0) / 1e6;
              cacheCost = mvc.cacheRead * (tp.inputCachePerM||0) / 1e6 + mvc.cacheWrite * (tp.cacheWritePerM||0) / 1e6;
            } else {
              // 匹配到 per_call/per_char 特殊时段：无法按 token 拆分，总额走 calcCost
              const tot = calcCost(price, mvc, 12);
              inputCost = tot; outputCost = 0; cacheCost = 0;
            }
          }
          const estimatedCost = (unit==="token"&&price) ? inputCost+outputCost+cacheCost : calcCost(price, mv);
          const hasOfficialCost = prov === "opencode-go" && useOfficialOgCosts && Object.prototype.hasOwnProperty.call(officialOgCosts, m.id);
          const cost = hasOfficialCost ? officialOgCosts[m.id] : estimatedCost;
          const officialRow = officialOgRowMap[m.id];
          const officialHasTokens = !!officialRow && (officialRow.count > 0 || officialRow.inputTokens > 0 || officialRow.outputTokens > 0);
          modelCosts.push({ model: m.id, provider: prov, cost, estimatedCost, costSource: hasOfficialCost ? "official" : "local-estimate", officialInputTokens: officialHasTokens ? officialRow.inputTokens : null, officialOutputTokens: officialHasTokens ? officialRow.outputTokens : null, unit, inputCost, outputCost, cacheCost, callCount: mgEntry?.callCount || 0, successCount: mgEntry?.successCount || 0, currency: price?.currency || "USD" });
        }
        // KEY2 可能只调用了 Kimi 等模型，本地 Hana 日志没有对应行；补入官方费用行，保证消费明细合计可对账。
        if (useOfficialOgCosts && officialOgCosts && (!provider || provider === "opencode-go")) {
          for (const [officialModel, cost] of Object.entries(officialOgCosts)) {
            if (model && model !== officialModel) continue;
            if (modelCosts.some(mc => mc.provider === "opencode-go" && mc.model === officialModel)) continue;
            const officialRow = officialOgRowMap[officialModel];
            const officialHasTokens = !!officialRow && (officialRow.count > 0 || officialRow.inputTokens > 0 || officialRow.outputTokens > 0);
            modelCosts.push({ model: officialModel, provider: "opencode-go", cost, estimatedCost: 0, costSource: "official", officialInputTokens: officialHasTokens ? officialRow.inputTokens : null, officialOutputTokens: officialHasTokens ? officialRow.outputTokens : null, unit: "token", inputCost: 0, outputCost: 0, cacheCost: 0, callCount: officialRow?.count || 0, successCount: 0, currency: "USD" });
          }
        }
        for (const mg of result.mediaGen || []) {
          const key = mg.provider + "/" + mg.model;
          if (modelCosts.find(mc => mc.provider + "/" + mc.model === key)) continue;
          const price = pt[key];
          const cost = calcCost(price, mg);
          modelCosts.push({ model: mg.model, provider: mg.provider, cost, unit: price?.unit || "per_call", callCount: mg.callCount, successCount: mg.successCount });
        }
        result._modelCosts = modelCosts;
      } catch(e) { result._balanceError = e.message; }
      result._priceTable = loadPriceTable(cache.dataDir || "");
      result._balanceApis = loadBalanceApis(cache.dataDir || "");
      result._speedStats = cache.data?._speedStats || null;
      result._fxRate = fxRate;
      return result;
    } catch (e) {
      // 保持旧路由 500 语义：异常向上抛，由 HTTP 路由 catch 与 bus handler 各自兑底
      throw e;
    }
  };

  // 导出用：当前筛选 + 当前排序下的全部行（不分页）。给 token-tracker.details.csv 用。
  // 与 _buildDashboardData 走同一套 range 解析与明细口径，只是不切页。
  ctx._buildDetailsRows = async (params = {}) => {
    const cache = ctx._tokenCache;
    if (!cache?.data || !cache.data.sessions) return { notReady: true, error: "数据未就绪" };
    const view = { ...cache.data, dataDir: cache.dataDir, turnsStore: cache.turnsStore };
    const filters = {
      agent: toList(params.agent), model: toList(params.model), type: toList(params.type), provider: toList(params.provider),
      from: params.from || "", to: params.to || "",
      sortKey: params.sortKey, order: params.order, minTokens: params.minTokens,
    };
    const { dateFilter, from: dayFrom, to: dayTo } = resolveDateRange(params.range || "all", filters);
    let sessions = filterSessions(Object.values(view.sessions), filters);
    if (filters.model?.length) sessions = sessions.filter(s => filters.model.some(m => s.models?.[m]));
    const sessionKeys = new Map();
    for (const [k, v] of Object.entries(view.sessions)) sessionKeys.set(v, k);
    const { objectRows } = collectDetails({
      cache: view, sessions, sessionKeys, dateFilter, dayFrom, dayTo, filters, turnsStore: cache.turnsStore, allRows: true,
    });
    return { rows: objectRows };
  };

  // 只取「消费明细」这一块：界面翻页/换排序/换门槛时只重取明细，不再把整份看板
  // （analytics/heatmap/daily/hourly/agents/models/providers/summary 那些聚合）跟着重算重传。
  // 范围/筛选解析、明细口径都与 _buildDashboardData 共用同一套，差别只在载荷：只回 details。
  ctx._buildDetailsOnly = async (params = {}) => {
    const cache = ctx._tokenCache;
    if (!cache?.data || !cache.data.sessions) return { notReady: true, error: "数据未就绪" };
    const view = { ...cache.data, dataDir: cache.dataDir, turnsStore: cache.turnsStore };
    const filters = {
      agent: toList(params.agent), model: toList(params.model), type: toList(params.type), provider: toList(params.provider),
      from: params.from || "", to: params.to || "",
      page: params.page, pageSize: params.pageSize, sortKey: params.sortKey, order: params.order, minTokens: params.minTokens,
    };
    const { dateFilter, from: dayFrom, to: dayTo } = resolveDateRange(params.range || "all", filters);
    let sessions = filterSessions(Object.values(view.sessions), filters);
    if (filters.model?.length) sessions = sessions.filter(s => filters.model.some(m => s.models?.[m]));
    const sessionKeys = new Map();
    for (const [k, v] of Object.entries(view.sessions)) sessionKeys.set(v, k);
    const { details } = collectDetails({
      cache: view, sessions, sessionKeys, dateFilter, dayFrom, dayTo, filters, turnsStore: cache.turnsStore,
    });
    return { details };
  };

  // 体检（只读）：把「有没有白干」变成看得见的数字。
  // 这些值以前只有拿脚本翻 cache.sqlite 才看得到，而出问题时第一个要问的就是它们。
  // 它不挂在看板那条路上：只有界面点开体检、或点「量一次」时才会被调到。
  // params.bytes=true 时才去重算一遍整份看板拆字节 —— 那一下有代价，所以单独一次点击。
  ctx._buildDiagnostics = async (params = {}) => {
    const cache = ctx._tokenCache;
    const data = cache?.data || null;
    const out = {
      tables: { sessions: null, turns: null, ledger: null },
      db: { bytes: null, walBytes: null, file: null },
      cache: { version: data?.version ?? null, lastScan: data?.lastScan ?? null, ready: !!cache?.ready },
      ledger: { rows: null, entries: null, file: null },
      persist: cache?.persist?.stats || data?.persist || null,
      payload: null,
    };

    // 表行数走真 SQL：turns 那条连接已经在手（与缓存同一个库文件），顺手把 sessions 也数了。
    // 数不出来（没有 SQLite 驱动 / 还没建表）就不给数字，不用内存里的键数冒充表行数。
    let db = null;
    try { db = cache?.turnsStore?.open?.() || null; } catch { db = null; }
    const countOf = (sql) => {
      try { const row = db.prepare(sql).get(); return row ? Number(Object.values(row)[0]) : null; } catch { return null; }
    };
    if (db) {
      out.tables.sessions = countOf("SELECT COUNT(*) FROM sessions");
      out.tables.turns = countOf("SELECT COUNT(*) FROM turns");
    }
    if (out.tables.turns == null && typeof cache?.turnsStore?.count === "function") {
      try { out.tables.turns = cache.turnsStore.count(); } catch {}
    }

    // 库文件：优先认 SQLite（含 WAL），拿不到就报那道追加日志。不存在的就不报。
    const sqliteFile = cache?.cachePath ? path.join(path.dirname(cache.cachePath), "cache.sqlite") : null;
    const pick = [sqliteFile, cache?.cachePath].find((f) => f && fs.existsSync(f)) || null;
    if (pick) {
      out.db.file = pick;
      try { out.db.bytes = fs.statSync(pick).size; } catch {}
      try { out.db.walBytes = fs.existsSync(pick + "-wal") ? fs.statSync(pick + "-wal").size : 0; } catch {}
    }

    // 账本行：没有文件，身份就是它的内容（指纹在 size 上），所以另外给出它从哪个文件读来的。
    if (data?.sessions) {
      const rows = Object.keys(data.sessions).filter((k) => k.startsWith("__ledger__"));
      out.tables.ledger = rows.length;
      out.ledger.rows = rows.length;
      out.ledger.entries = rows.reduce((sum, k) => sum + (Number(data.sessions[k]?.msgCount) || 0), 0);
      out.ledger.file = data.sessions[rows[0]]?.fileName || null;
    }

    if (params.bytes) {
      try {
        const raw = await ctx._buildDashboardData({ range: params.range || "all" }, { skipBalances: true });
        const size = (v) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
        // 下划线开头的是路由自己用的残余（价格表、余额配置…），不过桥，不拿它们冒充载荷。
        const parts = Object.keys(raw || {})
          .filter((k) => !k.startsWith("_"))
          .map((k) => ({ key: k, bytes: size(raw[k]) }));
        // 第二层也得看一眼：整份里最大的一块（热力图）藏在 analytics 里面。
        if (raw?.analytics && typeof raw.analytics === "object") {
          for (const k of Object.keys(raw.analytics)) parts.push({ key: "analytics." + k, bytes: size(raw.analytics[k]) });
        }
        out.payload = { totalBytes: size(raw), parts };
      } catch (e) {
        out.payloadError = e.message;
      }
    }
    return out;
  };

  // 「点得开」：明细里的一行 → 该轮的会话文件与逐次调用拆解。
  // 与 _buildDashboardData 一样挂在 ctx 上（HTTP RPC / 离线对拍共用同一实例）。
  // 路径安全：只拿 sessionKey 在缓存里索引会话、取它自己的 filePath；绝不接受调用方传来的路径。
  ctx._readTurnCalls = async (sessionKey, seq) => {
    const key = typeof sessionKey === "string" ? sessionKey : "";
    const n = Number(seq);
    if (!key || !Number.isFinite(n) || n < 1) {
      return { ok: false, code: "BAD_REQUEST", message: "需要 sessionKey 与 seq（≥1）" };
    }
    const sessions = ctx._tokenCache?.data?.sessions;
    // 只认自有键：__proto__ / constructor 这类不能被当成会话命中。
    const session = sessions && Object.prototype.hasOwnProperty.call(sessions, key) ? sessions[key] : null;
    if (!session) return { ok: false, code: "NO_SESSION_FILE", message: "找不到该会话：" + key };
    const turn = readTurnCalls({ session, seq: n, log: ctx.log });
    return { ...turn, sessionKey: key, seq: n };
  };

  app.get("/dashboard/data", async c => {
    try {
      const result = await ctx._buildDashboardData({
        range: c.req.query("range") || "all",
        agent: c.req.query("agent") || "",
        model: c.req.query("model") || "",
        type: c.req.query("type") || "",
        provider: c.req.query("provider") || "",
        from: c.req.query("from") || "",
        to: c.req.query("to") || "",
      });
      if (result?.notReady) return c.json({ error: result.error }, 503);
      return c.json(result);
    } catch (e) { return c.json({ error: e.message, stack: e.stack }, 500); }
  });

  app.post("/price-table", async c => {
    try {
      const body = await c.req.json();
      const tk = ctx._tokenCache;
      const p = path.join(tk?.dataDir || "", "price-table.json");
      fs.writeFileSync(p, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch(e) { return c.json({ error: e.message }, 500); }
  });

  app.post("/balance-apis", async c => {
    try {
      const body = await c.req.json();
      const tk = ctx._tokenCache;
      const p = path.join(tk?.dataDir || "", "balance-apis.json");
      fs.writeFileSync(p, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch(e) { return c.json({ error: e.message }, 500); }
  });

  app.post("/dashboard/refresh", async c => {
    try {
      const tk = ctx._tokenCache;
      const force = c.req.query("force") === "1";
      if (force && tk?.fullScan) { await tk.fullScan(); return c.json({ ok: true, lastScan: tk.data?.lastScan, full: true }); }
      if (tk?.scan) { await tk.scan(false); return c.json({ ok: true, lastScan: tk.data?.lastScan, full: false }); }
      return c.json({ error: "unavailable" }, 503);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // 供应商余额查询代理（P0-1 修复：老实现调用了未定义的 fetchDeepSeekBalance/fetchGLMBalance 导致 500）
  // 现统一走 services/balance.js 适配层：DeepSeek/GLM 显式注册（key: added-models.yaml > provider-catalog.json），
  // MiniMax/商汤/方舟/OpenCode Go 走 balance-apis.json 配置分支；单 provider 失败只降级为 status:"error" 条目。
  // 响应契约（每 provider 一条）：{ provider, status, type, display, used, limit, remain, updatedAt, error }
  // 顶层保留旧字段 balances 数组（v1 卡片读 balances[].label/display），条目内额外携带原始明细字段。
  app.get("/dashboard/balance", async c => {
    try {
      const cache = ctx._tokenCache;
      return c.json(await collectBalances({ dataDir: cache?.dataDir || "" }));
    } catch (e) {
      // 适配层已按 provider 隔离失败；兜底也保持 200，避免旧卡片整卡白屏
      return c.json({ balances: [], error: e?.message || "查询失败" });
    }
  });

  // ── 实时监控 widget ──
  // - 首帧在 start(controller) 内 controller 就绪后发送（老实现 sendUsage 在 ReadableStream 构造前调用，首帧进 void）
  // - 心跳 interval 挂在外层作用域，cancel 时清理（老实现 hb 只在 start 闭包里，断开后泄漏）
  // - 客户端上限 REALTIME_CLIENT_LIMIT，超出拒绝（503）；断开时从 cache._realtimeClients 删除
  app.get("/widget/stream", c => {
    const r = createRealtimeStream(ctx._tokenCache);
    if (r.error) return c.json({ error: r.error }, r.status || 503);
    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    return c.body(r.stream);
  });

  app.get("/widget/data", c => {
    const cache = ctx._tokenCache;
    if (!cache?.realtime) return c.json({ error: "not ready" }, 503);
    const snap = cache.realtimeSnapshot ? cache.realtimeSnapshot(cache.realtime, cache.data?.agentNames || {}) : { ...cache.realtime, balances: cache.data?._balances || null, balanceUpdatedAt: cache.realtime.balanceUpdatedAt };
    if (cache.data?._balances) snap.balances = cache.data._balances;
    if (cache.data?._subscriptionQuotas) snap.quotas = cache.data._subscriptionQuotas;
    if (cache.data) {
      const today = cnToday();
      const todayData = cache.data.sessions && Object.values(cache.data.sessions).reduce((acc, s) => {
        const db = s.dailyBreakdown?.[today];
        if (db) { acc.input += db.input||0; acc.output += db.output||0; acc.cacheRead += db.cacheRead||0; acc.totalTokens += db.totalTokens||0; acc.assistantCount += db.assistantCount||0; }
        return acc;
      }, { input:0, output:0, cacheRead:0, totalTokens:0, assistantCount:0 });
      snap.today = todayData;
      snap.todayAgentCount = new Set(Object.values(cache.data.sessions).filter(s => s.dailyBreakdown?.[today]).map(s => s.agent)).size;
    }
    return c.json(snap);
  });

  // ── OpenCode Go 模型用量（全量同步 + 按模型聚合）──
  // POST 触发同步：mode=incremental/full，返回同步结果
  app.post("/dashboard/og-sync", async c => {
    try {
      const cache = ctx._tokenCache;
      const apis = cache?.dataDir ? loadBalanceApis(cache.dataDir) : {};
      let cookie = "", ws = "";
      for (const provId of Object.keys(apis || {})) {
        const ac = apis[provId];
        if (ac && ac.responseType === "opencode-go") { cookie = ac.cookie || ""; ws = ac.workspaceId || ""; break; }
      }
      if (!cookie || !ws) return c.json({ error: "未配置 OpenCode Go workspace/cookie" }, 400);
      const mode = c.req.query("mode") === "full" ? "full" : "incremental";
      const result = await syncOgUsage(cookie, ws, mode);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // GET 查询模型用量：?range=today/week/month/year/all&from=&to=（口径与模型/Key 汇总统一）
  app.get("/dashboard/og-models", c => {
    try {
      const cache = loadOgUsageCache();
      const range = c.req.query("range") || "all";
      const from = c.req.query("from") || "";
      const to = c.req.query("to") || "";
      const models = aggregateOgModelUsage(cache.records, range, from, to);
      return c.json({ models, total: cache.total, syncedAt: cache.syncedAt || 0, deepestPage: cache.deepestPage });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 卡片壳路由（/cards/*）与旧的 widget / 看板入口已删除：它们读的是 runtime/assets/cards/*，
  // 那个目录不存在（直接打开只会看到「卡片脚本加载失败」），界面早已换成 ui/*.html 那套 v2 页面。
  // 引擎与界面之间走 /rpc 取数据，不受影响。



}

// ── 后端数据构建 ──

// 时区格式化器只建一次。构造一个 Intl.DateTimeFormat 要几十微秒，
// 放在按行循环里就是上万次：实测 17,348 行时 1112 ms → 提到循环外 29 ms（相差 38 倍）。
// 这几个调用点（日期筛选起点、明细行、今天）用的是同一套 en-CA / Asia/Shanghai，共用这一个。
const CN_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

// 明细行的列顺序。上线前按这个顺序压成数组，前端按同一顺序解回来（对拍在 test/rows-wire.test.js）。
// 为什么不上对象：键名会在每一行里重复一遭，17k 行光键名就 1.6 MB，而宿主给托管服务的
// 响应设了 4 MiB 硬顶（实测超了整条请求直接失败，不是截断）。
export const ROW_COLS = ["time", "agent", "agentName", "provider", "model",
  "totalTokens", "inputTokens", "outputTokens", "cacheRead", "calls", "sessionKey", "seq"];

export function encodeRows(rows, cols = ROW_COLS) {
  return rows.map((r) => cols.map((k) => r[k] ?? null));
}

// 明细行 = 会话 × 一轮。抽成纯函数是为了能单独断言字段：
// 这道口漏一个字段，前端就永远看不见它（缓存拆分与调用次数就是这么加上来的）。
// 没有口径的老记录（v24 之前）给 null 而不是 0：没口径和真的是 0 不是一回事。
export function rowOf(session, conv, agentNames) {
  return {
    time: conv.time || null,
    agent: session.agent,
    agentName: agentNames?.[session.agent] || session.agent,
    provider: conv.provider || "",
    model: conv.model || "",
    totalTokens: conv.totalTokens || 0,
    inputTokens: conv.inTokens ?? null,
    outputTokens: conv.outTokens ?? null,
    cacheRead: conv.cacheRead ?? null,
    calls: conv.msgCount ?? null,
  };
}

// ── 消费明细：服务端分页 ──
// 明细从 turns 表按页取，不再把全部历史搬进载荷（宿主对响应有 4 MiB 硬顶，而历史只会更长）。
// 表拿不到（没有 SQLite 驱动）或还是空的时，回落到内存里现算 —— 两条路的输出形状与口径
// 必须一模一样，前端不该知道走的是哪条。
const DETAIL_PAGE_DEFAULT = 50;
const DETAIL_PAGE_MAX = 200;
const DETAIL_SORT_KEYS = new Set(["time", "tokens", "uncached", "hit"]);

// 多值筛选的归一（只在这一处做）：线格式是「URI 编码后的多个值用半角逗号连接」的单个查询串参数
// （如 model=DeepSeek-V3.1%2CQwen3-Coder-480B 表示两个值；单值仍是单个且编码；空串 = 不筛）。
// 归一后 filters.agent/model/provider/type 一律是 string[]（长度 0 = 不筛）。
//   - 数组：逐项 String() → decodeURIComponent（解不开就保留原样，绝不抛）→ trim → 丢空串
//   - 字符串：先按半角逗号切分再同上（这样「值里带逗号」用 %2C 表达时不会被切错）
//   - 其它类型：[]（不筛）
export function toList(v) {
  const out = [];
  const push = (raw) => {
    let s;
    try { s = decodeURIComponent(String(raw)); } catch { s = String(raw); }
    s = s.trim();
    if (s !== "") out.push(s);
  };
  if (Array.isArray(v)) {
    for (const item of v) push(item);
  } else if (typeof v === "string") {
    for (const part of v.split(",")) push(part);
  } else {
    return [];
  }
  return out;
}

// 已是 string[] 就原样用（不重复解码），否则走 toList。下游拿到的永远是数组。
function asList(v) {
  return Array.isArray(v) ? v : toList(v);
}

const maxDay = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));
const minDay = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));

// range / from / to → dateFilter（谓词）+ from/to（day 端点，含端点）。
// 每个分支都等价于一个区间谓词，所以端点与谓词永远描述同一个集合（turns 表查询直接吃端点）。
function resolveDateRange(range, filters = {}) {
  const now = new Date();
  const today = cnToday();
  let from = "", to = "";
  if (range !== "all") {
    if (/^last(3|7|30)$/.test(range)) {
      const start = new Date(today + "T00:00:00+08:00");
      start.setUTCDate(start.getUTCDate() - Number(range.slice(4)) + 1);
      from = CN_DAY.format(start); to = today;
    } else if (range === "today") {
      from = today; to = today;
    } else if (range === "yesterday") {
      const yd = new Date(now);
      yd.setDate(yd.getDate() - 1);
      const y = yd.getFullYear() + "-" + String(yd.getMonth() + 1).padStart(2, "0") + "-" + String(yd.getDate()).padStart(2, "0");
      from = y; to = y;
    } else if (range === "week") {
      const day = now.getDay();
      const ws = new Date(now);
      // 与 OpenCode Go 官方口径统一：本周从周一开始。
      ws.setDate(ws.getDate() - ((day + 6) % 7));
      from = ws.getFullYear() + "-" + String(ws.getMonth() + 1).padStart(2, "0") + "-" + String(ws.getDate()).padStart(2, "0");
    } else if (range === "year") {
      from = now.getFullYear() + "-01-01";
    } else if (range === "lyear") {
      const ly = now.getFullYear() - 1;
      from = ly + "-01-01"; to = ly + "-12-31";
    } else if (range === "month") {
      from = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
    }
  }
  if (filters.from) {
    from = maxDay(from, filters.from);
    if (filters.to) to = minDay(to, filters.to);
  }
  return { dateFilter: (from || to) ? (d => (!from || d >= from) && (!to || d <= to)) : null, from, to };
}

// 会话级筛选（Agent / Provider / Type）。明细两条路与汇总口径都吃它，抽出来避免两处漂移。
function filterSessions(list, filters) {
  // 字段内 OR（任一命中），字段间 AND。filters.* 已归一为 string[]（长度 0 = 不筛）。
  const agents = asList(filters.agent);
  const providers = asList(filters.provider);
  const types = asList(filters.type);
  let out = list;
  if (agents.length) out = out.filter(s => agents.includes(s.agent));
  if (providers.length) out = out.filter(s => s.providers && Object.keys(s.providers).some(pk => providers.some(p => pk.startsWith(p + "/"))));
  if (types.length) out = out.filter(s => types.includes(s.type));
  return out;
}

// 排序值。uncached 用「未命中输入」= input - cache_read（与 ui/details-view.mjs 的 uncachedInput 同口径，
// 负数夹到 0）；hit = cache_read / input。没有口径的行给 null，两个方向都排最后。
function detailSortValue(r, sortKey) {
  if (sortKey === "tokens") return Number(r.totalTokens) || 0;
  if (sortKey === "uncached") return Math.max(0, (Number(r.inputTokens) || 0) - (Number(r.cacheRead) || 0));
  if (sortKey === "hit") {
    const inp = Number(r.inputTokens);
    if (r.inputTokens == null || !(inp > 0)) return null;
    return r.cacheRead == null ? null : Number(r.cacheRead) / inp;
  }
  return String(r.time || "");
}

function detailCompare(a, b, sortKey, dir) {
  const va = detailSortValue(a, sortKey), vb = detailSortValue(b, sortKey);
  const na = va === null, nb = vb === null;
  if (na !== nb) return na ? 1 : -1;
  if (!na && va !== vb) return (va < vb ? -1 : 1) * dir;
  const ta = String(a.time || ""), tb = String(b.time || "");
  if (ta !== tb) return ta < tb ? 1 : -1;   // at DESC 兜底
  // 与 SQL 的 `..., session_key ASC, seq ASC` 完全对齐：完全并列时也要有确定顺序，
  // 不能靠 Array.sort 的稳定性（那等于会话迭代顺序，跨会话同一时间戳的地方会与 SQL 分岔）。
  const ka = String(a.sessionKey ?? ""), kb = String(b.sessionKey ?? "");
  if (ka !== kb) return ka < kb ? -1 : 1;
  return (a.seq || 0) - (b.seq || 0);
}

// turns 表一行 → 明细行对象（字段与 rowOf 对齐，agentName 从名册补）。
function sqlDetailRow(r, agentNames) {
  return {
    sessionKey: r.sessionKey, seq: r.seq, time: r.at,
    agent: r.agent, agentName: agentNames?.[r.agent] || r.agent,
    provider: r.provider, model: r.model,
    totalTokens: r.total, inputTokens: r.input, outputTokens: r.output,
    cacheRead: r.cacheRead, calls: r.calls,
  };
}

// 取一页（或全部）明细，并给出与明细同一筛选集的 (model, total) 对（供单轮大小分布）。
function collectDetails({ cache, sessions, sessionKeys, dateFilter, dayFrom, dayTo, filters, turnsStore, allRows = false }) {
  const agentNames = cache.agentNames || {};
  const pageSizeRaw = Math.floor(Number(filters.pageSize));
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, DETAIL_PAGE_MAX) : DETAIL_PAGE_DEFAULT;
  const sortKey = DETAIL_SORT_KEYS.has(filters.sortKey) ? filters.sortKey : "time";
  const order = filters.order === "asc" ? "asc" : "desc";
  const minRaw = Number(filters.minTokens);
  const minTokens = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 0;
  // 四个筛选列原样交给 turns-store（已归一为 string[]；空数组/undefined = 不筛）。from/to 仍是单值 day 端点。
  const where = { from: dayFrom || "", to: dayTo || "", agent: filters.agent, model: filters.model, provider: filters.provider, type: filters.type };

  let useTable = false;
  if (turnsStore && typeof turnsStore.count === "function") {
    try { useTable = turnsStore.count() > 0; } catch { useTable = false; }
  }

  let picked, turnPairs;
  if (useTable) {
    turnPairs = queryTurnSizes(turnsStore, where);
    if (allRows) {
      const res = queryTurns(turnsStore, { ...where, sortKey, order, minTokens, all: true });
      picked = { rows: res.rows.map(r => sqlDetailRow(r, agentNames)), total: res.total, sumTokens: res.sumTokens, page: 1, totalPages: 1 };
    } else {
      const want = Math.max(1, Math.floor(Number(filters.page)) || 1);
      let res = queryTurns(turnsStore, { ...where, sortKey, order, minTokens, limit: pageSize, offset: (want - 1) * pageSize });
      const totalPages = Math.max(1, Math.ceil(res.total / pageSize));
      const page = Math.min(want, totalPages);
      if (page !== want) res = queryTurns(turnsStore, { ...where, sortKey, order, minTokens, limit: pageSize, offset: (page - 1) * pageSize });
      picked = { rows: res.rows.map(r => sqlDetailRow(r, agentNames)), total: res.total, sumTokens: res.sumTokens, page, totalPages };
    }
  } else {
    // 回落：直接遍历内存里的 conversations，筛选/排序/分页语义与 SQL 路一致。
    const all = [];
    for (const s of sessions) {
      const key = sessionKeys.get(s) || "";
      const convs = s.conversations || [];
      for (let i = 0; i < convs.length; i++) {
        const c = convs[i];
        if (filters.model?.length && !filters.model.includes(c.model)) continue;
        if (filters.provider?.length && !filters.provider.includes(c.provider)) continue;
        const timestamp = c.time ? new Date(c.time) : null;
        const day = c.time && Number.isFinite(timestamp.getTime()) ? CN_DAY.format(timestamp) : "";
        if (dateFilter && (!day || !dateFilter(day))) continue;
        const r = rowOf(s, c, agentNames);
        r.sessionKey = key; r.seq = i + 1;
        all.push(r);
      }
    }
    turnPairs = all.map(r => ({ model: r.model || "", totalTokens: r.totalTokens || 0 }));
    const kept = minTokens > 0 ? all.filter(r => (r.totalTokens || 0) >= minTokens) : all;
    kept.sort((a, b) => detailCompare(a, b, sortKey, order === "asc" ? 1 : -1));
    const total = kept.length;
    const sumTokens = kept.reduce((sum, r) => sum + (r.totalTokens || 0), 0);
    if (allRows) picked = { rows: kept, total, sumTokens, page: 1, totalPages: 1 };
    else {
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(Math.max(1, Math.floor(Number(filters.page)) || 1), totalPages);
      picked = { rows: kept.slice((page - 1) * pageSize, page * pageSize), total, sumTokens, page, totalPages };
    }
  }

  return {
    details: {
      total: picked.total, sumTokens: picked.sumTokens, page: picked.page, pageSize,
      totalPages: picked.totalPages, sortKey, order, minTokens,
      rows: allRows ? [] : encodeRows(picked.rows), rowCols: ROW_COLS,
    },
    objectRows: picked.rows,
    turnPairs,
  };
}

function build(cache, range = "all", filters = {}, fxRate = null, turnsStore = null) {
  const priceTable = loadPriceTable(cache.dataDir || "");
  let sessions = Object.values(cache.sessions);

  // ── 时间范围（range + from/to）：一个谓词给内存汇总，一对 day 端点给 turns 表 ──
  const { dateFilter, from: dayFrom, to: dayTo } = resolveDateRange(range, filters);

  // ── Agent / Provider / Type 筛选 ──
  const filterModel = asList(filters.model);
  const filterProvider = asList(filters.provider);
  sessions = filterSessions(sessions, filters);

  // 保存一份不含模型筛选的 sessions，用于前端下拉选项
  const sessionPool = sessions;

  if (filterModel.length) {
    sessions = sessions.filter(s => filterModel.some(m => s.models?.[m]));
  }

  // ── 统一汇总（无论什么维度都从 dailyBreakdown 取值） ──
  const agentMap = {};
  const modelMap = {};
  const dailyMap = {};
  const sums = { totalInput: 0, totalOutput: 0, totalTokens: 0, totalCacheRead: 0, totalAssistant: 0, totalDesktop: 0, totalChannel: 0, totalBridge: 0, totalBackground: 0, totalSub: 0, totalLedger: 0 };

  for (const s of sessions) {
    const a = s.agent;

    // 会话级模型→供应商映射
    const provModels = {};
    if (s.providers) {
      for (const pk of Object.keys(s.providers)) {
        const sep = pk.indexOf("/");
        if (sep > 0) provModels[pk.slice(sep + 1)] = pk.slice(0, sep);
      }
    }

    // Agent / daily / sums <- dailyBreakdown
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      let di, dout, dcr, dtot, dasst;
      if (filterProvider.length && filterModel.length) {
        // 供应商+模型：取「供应商 ∈ 选中 且 模型 ∈ 选中」的 provider/model 组合之和（选中集合的交集）
        di = 0; dout = 0; dcr = 0; dtot = 0; dasst = 0;
        for (const [pk, pt] of Object.entries(d.providerTotals || {})) {
          const sep = pk.indexOf("/");
          const p = sep > 0 ? pk.slice(0, sep) : "";
          const m = sep > 0 ? pk.slice(sep + 1) : "";
          if (filterProvider.includes(p) && filterModel.includes(m)) {
            dtot += pt.totalTokens; di += pt.input; dout += pt.output; dcr += pt.cacheRead; dasst += pt.assistantCount || 0;
          }
        }
      } else if (filterProvider.length) {
        // 只选供应商：该供应商下所有 provider/model 项之和
        di = 0; dout = 0; dcr = 0; dtot = 0; dasst = 0;
        for (const [pk, pt] of Object.entries(d.providerTotals || {})) {
          const sep = pk.indexOf("/");
          const p = sep > 0 ? pk.slice(0, sep) : "";
          if (filterProvider.includes(p)) {
            dtot += pt.totalTokens; di += pt.input; dout += pt.output; dcr += pt.cacheRead; dasst += pt.assistantCount || 0;
          }
        }
      } else if (filterModel.length) {
        // 只选模型：各选中模型之和
        di = 0; dout = 0; dcr = 0; dtot = 0; dasst = 0;
        for (const m of filterModel) {
          const md = d.models?.[m];
          if (md) { di += md.input || 0; dout += md.output || 0; dcr += md.cacheRead || 0; dtot += md.totalTokens || 0; dasst += md.assistantCount || 0; }
        }
      } else {
        di = d.input || 0; dout = d.output || 0; dcr = d.cacheRead || 0; dtot = d.totalTokens || 0; dasst = d.assistantCount || 0;
      }

      if (!agentMap[a]) agentMap[a] = { input: 0, output: 0, totalTokens: 0, cacheRead: 0, assistantCount: 0, desktopTotal: 0, channelTotal: 0, bridgeTotal: 0, backgroundTotal: 0, subTotal: 0, ledgerTotal: 0, models: {} };
      agentMap[a].input += di; agentMap[a].output += dout; agentMap[a].totalTokens += dtot; agentMap[a].cacheRead += dcr;
      agentMap[a].assistantCount += dasst;
      if (s.type === "desktop") agentMap[a].desktopTotal += dtot;
      else if (s.type === "bridge") agentMap[a].bridgeTotal += dtot;
      else if (s.type === "background") agentMap[a].backgroundTotal += dtot;
      else if (s.type === "sub") agentMap[a].subTotal += dtot;
      else if (s.type === "ledger") agentMap[a].ledgerTotal += dtot;
      else agentMap[a].channelTotal += dtot;

      if (!dailyMap[day]) dailyMap[day] = { totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0, cacheRead: 0, assistantCount: 0 };
      dailyMap[day].totalTokens += dtot; dailyMap[day].cacheRead += dcr;
      dailyMap[day].assistantCount += dasst;
      if (s.type === "desktop") dailyMap[day].desktop += dtot;
      else if (s.type === "bridge") dailyMap[day].bridge += dtot;
      else if (s.type === "background") dailyMap[day].background += dtot;
      else if (s.type === "sub") dailyMap[day].sub += dtot;
      else if (s.type === "ledger") dailyMap[day].ledger += dtot;
      else dailyMap[day].channel += dtot;

      sums.totalInput += di; sums.totalOutput += dout; sums.totalTokens += dtot; sums.totalCacheRead += dcr;
      sums.totalAssistant += dasst;
      if (s.type === "desktop") sums.totalDesktop += dtot;
      else if (s.type === "bridge") sums.totalBridge += dtot;
      else if (s.type === "background") sums.totalBackground += dtot;
      else if (s.type === "sub") sums.totalSub += dtot;
      else if (s.type === "ledger") sums.totalLedger += dtot;
      else sums.totalChannel += dtot;

      // 模型精确统计（按日级数据，不按比例推算）
      for (const [mn, mv] of Object.entries(d.models || {})) {
        if (filterModel.length && !filterModel.includes(mn)) continue;
        if (filterProvider.length && !filterModel.length && !filterProvider.includes(provModels[mn])) continue;
        if (!modelMap[mn]) modelMap[mn] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0, totalTokens: 0 };
        modelMap[mn].input += mv.input || 0;
        modelMap[mn].output += mv.output || 0;
        modelMap[mn].cacheRead += mv.cacheRead || 0;
        modelMap[mn].cacheWrite += mv.cacheWrite || 0;
        modelMap[mn].assistantCount += mv.assistantCount || 0;
        modelMap[mn].totalTokens += mv.totalTokens || 0;
        if (agentMap[a]) {
          if (!agentMap[a].models[mn]) agentMap[a].models[mn] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
          agentMap[a].models[mn].input += mv.input || 0;
          agentMap[a].models[mn].output += mv.output || 0;
          agentMap[a].models[mn].cacheRead += mv.cacheRead || 0;
          agentMap[a].models[mn].cacheWrite += mv.cacheWrite || 0;
          agentMap[a].models[mn].totalTokens += mv.totalTokens || 0;
        }
      }
    }
  }

  // ── 模型下拉选项（排除模型筛选，让前端下拉始终显示可用模型） ──
  const modelOptMap = {};
  for (const s of sessionPool) {
    const pmo = {};
    if (s.providers) {
      for (const pk of Object.keys(s.providers)) {
        const sp = pk.indexOf("/");
        if (sp > 0) pmo[pk.slice(sp + 1)] = pk.slice(0, sp);
      }
    }
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      for (const mn of Object.keys(d.models || {})) {
        if (filterProvider.length && !filterProvider.includes(pmo[mn])) continue;
        modelOptMap[mn] = (modelOptMap[mn] || 0) + (d.models[mn].totalTokens || 0);
      }
    }
  }
  const modelOptions = Object.entries(modelOptMap).sort((a, b) => b[1] - a[1]).map(([id]) => ({ id }));

  const agents = Object.entries(agentMap).map(([id, d]) => ({ id, ...d })).sort((a, b) => b.totalTokens - a.totalTokens);
  const models = Object.entries(modelMap).map(([id, d]) => ({ id, ...d })).sort((a, b) => (b.input + b.output + (b.cacheRead || 0)) - (a.input + a.output + (a.cacheRead || 0)));
  const daily = Object.keys(dailyMap).sort().map(d => ({ date: d, totalTokens: dailyMap[d].totalTokens, desktop: dailyMap[d].desktop, channel: dailyMap[d].channel, bridge: dailyMap[d].bridge, background: dailyMap[d].background, sub: dailyMap[d].sub, ledger: dailyMap[d].ledger, cacheRead: dailyMap[d].cacheRead, assistantCount: dailyMap[d].assistantCount }));

  // ── 按小时汇总（今日或自定义单天） ──
  let hourly = null;
  let hourlyTargetDay = null;
  if (range === "today") {
    hourlyTargetDay = cnToday();
  } else if (dayFrom && dayTo && dayFrom === dayTo) {
    hourlyTargetDay = dayFrom;
  }
  if (hourlyTargetDay) {
    const hMap = {};
    const hMMap = {};
    for (const s of sessions) {
      const hb = s.hourlyBreakdown?.[hourlyTargetDay];
      if (!hb) continue;
      // 会话级模型→供应商映射
      const hp = {};
      if (s.providers) {
        for (const pk of Object.keys(s.providers)) {
          const sep = pk.indexOf("/");
          if (sep > 0) hp[pk.slice(sep + 1)] = pk.slice(0, sep);
        }
      }
      for (const [hour, v] of Object.entries(hb)) {
        if (!hMap[hour]) hMap[hour] = { totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0, cacheRead: 0, assistantCount: 0 };
        if (!hMMap[hour]) hMMap[hour] = {};
        // 模型级明细（供时段分模型对比）
        if (v.models) {
          for (const [mn, mv] of Object.entries(v.models)) {
            if (!hMMap[hour][mn]) hMMap[hour][mn] = { totalTokens: 0, cacheRead: 0 };
            hMMap[hour][mn].totalTokens += mv.totalTokens || 0;
            hMMap[hour][mn].cacheRead += mv.cacheRead || 0;
          }
        }
        if (filterProvider.length && filterModel.length) {
          // 供应商+模型：providerTotals 里「供应商 ∈ 选中 且 模型 ∈ 选中」的组合之和
          for (const [pk, vt] of Object.entries(v.providerTotals || {})) {
            const sep = pk.indexOf("/");
            const p = sep > 0 ? pk.slice(0, sep) : "";
            const m = sep > 0 ? pk.slice(sep + 1) : "";
            if (filterProvider.includes(p) && filterModel.includes(m)) {
              hMap[hour].totalTokens += vt.totalTokens;
              hMap[hour].desktop += vt.desktop || 0;
              hMap[hour].channel += vt.channel || 0;
              hMap[hour].cacheRead += vt.cacheRead;
              hMap[hour].assistantCount += vt.assistantCount || 0;
            }
          }
        } else if (filterProvider.length) {
          if (v.providerTotals) {
            // totalTokens 精确，desktop/channel/cacheRead 从 model 级推算
            for (const [pk, pt] of Object.entries(v.providerTotals)) {
              const sep = pk.indexOf("/");
              const p = sep > 0 ? pk.slice(0, sep) : "";
              if (filterProvider.includes(p)) {
                hMap[hour].totalTokens += pt.totalTokens;
                hMap[hour].desktop += pt.desktop || 0;
                hMap[hour].channel += pt.channel || 0;
                hMap[hour].cacheRead += pt.cacheRead;
                hMap[hour].assistantCount += pt.assistantCount || 0;
              }
            }
            for (const [mn, mv] of Object.entries(v.models || {})) {
              if (filterProvider.includes(hp[mn])) {
                hMap[hour].desktop += mv.desktop || 0;
                hMap[hour].channel += mv.channel || 0;
                hMap[hour].cacheRead += mv.cacheRead || 0;
              }
            }
          } else if (v.models) {
            for (const [mn, mv] of Object.entries(v.models)) {
              if (filterProvider.includes(hp[mn])) {
                hMap[hour].totalTokens += mv.totalTokens || 0; hMap[hour].desktop += mv.desktop || 0;
                hMap[hour].channel += mv.channel || 0; hMap[hour].cacheRead += mv.cacheRead || 0;
              }
            }
          }
        } else if (filterModel.length) {
          for (const m of filterModel) {
            const vm = v.models?.[m];
            if (vm) {
              hMap[hour].totalTokens += vm.totalTokens || 0; hMap[hour].desktop += vm.desktop || 0; hMap[hour].channel += vm.channel || 0; hMap[hour].cacheRead += vm.cacheRead || 0; hMap[hour].assistantCount += vm.assistantCount || 0;
            }
          }
        } else {
          hMap[hour].totalTokens += v.totalTokens; hMap[hour].desktop += v.desktop; hMap[hour].channel += v.channel; hMap[hour].bridge += v.bridge||0; hMap[hour].background += v.background||0; hMap[hour].sub += v.sub||0; hMap[hour].ledger += v.ledger||0; hMap[hour].cacheRead += (v.cacheRead || 0); hMap[hour].assistantCount += (v.assistantCount || 0);
        }
      }
    }
    hourly = Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, "0");
      return { hour: hh, totalTokens: hMap[hh]?.totalTokens || 0, desktop: hMap[hh]?.desktop || 0, channel: hMap[hh]?.channel || 0, bridge: hMap[hh]?.bridge || 0, background: hMap[hh]?.background || 0, sub: hMap[hh]?.sub || 0, ledger: hMap[hh]?.ledger || 0, cacheRead: hMap[hh]?.cacheRead || 0, assistantCount: hMap[hh]?.assistantCount || 0, models: hMMap[hh] || {} };
    });
  }

  // ── 消费明细：服务端分页（表在就用 SQL，表空/无驱动则回落内存），并给出同筛选集的单轮大小对 ──
  const sessionKeys = new Map();
  for (const [k, v] of Object.entries(cache.sessions)) sessionKeys.set(v, k);
  const { details, turnPairs } = collectDetails({
    cache, sessions, sessionKeys, dateFilter, dayFrom, dayTo, filters, turnsStore,
  });

  // ── 供应商全量列表（不受筛选影响，用于前端下拉） ──
  const allProviders = {};
  for (const s of Object.values(cache.sessions)) {
    if (s.providers) for (const [pk, pv] of Object.entries(s.providers)) {
      if (!allProviders[pk]) allProviders[pk] = { provider: pv.provider, model: pv.model, totalTokens: 0, count: 0 };
      allProviders[pk].totalTokens += pv.totalTokens;
      allProviders[pk].count += pv.count;
    }
  }
  const allProviderList = Object.values(allProviders).sort((a, b) => b.totalTokens - a.totalTokens);

  let estimatedCost = 0;
  const mediaGenMap = {};
  for (const s of sessions) {
    if (!s.providers) continue;
    const provModels = {};
    for (const pk of Object.keys(s.providers)) {
      const sep = pk.indexOf("/");
      if (sep > 0) provModels[pk.slice(sep + 1)] = pk.slice(0, sep);
    }
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      for (const [mn, mv] of Object.entries(d.models || {})) {
        if (filterModel.length && !filterModel.includes(mn)) continue;
        if (filterProvider.length && !filterProvider.includes(provModels[mn])) continue;
        const prov = provModels[mn];
        if (!prov) continue;
        const price = priceTable[prov + "/" + mn];
        let est = calcCost(price, mv, 12);
        // 本地货币转美元统一口径（DeepSeek 人民币、GPT 美元）
        if (price?.currency === "CNY" && fxRate) est = est / fxRate;
        estimatedCost += est;
      }
      if (d.mediaGen) {
        for (const [mk, mg] of Object.entries(d.mediaGen)) {
          if (filterProvider.length && !filterProvider.includes(mg.provider)) continue;
          if (!mediaGenMap[mk]) mediaGenMap[mk] = { provider: mg.provider, model: mg.model, kind: mg.kind, callCount: 0, successCount: 0 };
          mediaGenMap[mk].callCount += mg.callCount || 0;
          mediaGenMap[mk].successCount += mg.successCount || 0;
        }
      }
    }
  }
  // ── 下面的 mediaGen 只用来把媒体生成的花费计入 estimatedCost；界面不读它，所以不再进载荷 ──
  const mediaGen = Object.values(mediaGenMap);
  for (const mg of mediaGen) {
    const price = priceTable[mg.provider + "/" + mg.model];
    if (price && price.unit === "per_call") {
      mg.cost = mg.callCount * (price.pricePerCall || 0);
      let est = mg.cost;
      if (price.currency === "CNY" && fxRate) est = est / fxRate;
      estimatedCost += est;
    }
  }

  // 按小时分摊消费金额
  if (hourly && hourly.length > 0) {
    const hTotal = hourly.reduce(function(s, h) { return s + (h.totalTokens || 0); }, 0);
    if (hTotal > 0) {
      for (const h of hourly) {
        h.cost = +((h.totalTokens || 0) / hTotal * estimatedCost).toFixed(4);
      }
    }
  }

  // 载荷只带界面真正读的东西（对照 ui/ 与内嵌页对 dashboard.<字段> 的读取）：
  // 以前还发 stream / abnormal / mediaGen / providerBreakdown / earliest / 缓存下钻 / prediction，
  // 全仓界面一处都没读，属于白算白传。
  return {
    analytics: buildVisualAnalytics(sessions, dateFilter, filters, turnPairs),
    agentNames: cache.agentNames || {},
    summary: { ...sums, cacheHitRate: sums.totalTokens > 0 ? +((sums.totalCacheRead / sums.totalTokens * 100).toFixed(1)) : 0, estimatedCost },
    agents, models, modelOptions, providers: allProviderList, daily, hourly,
    // 明细改成服务端分页：只发当前页，行数组编码 + 列名（前端 decodeRows 解回对象）。
    details,
  };
}

// ── 余额查询配置 ──
// ── 余额/余量查询函数（loadBalanceApis / fetchBalance / MiniMax TokenPlan /
// Sensenova IAM+TokenPlan / per-model-quota / 火山方舟 Coding Plan）已迁往 services/balance.js，
// 由顶部 import 引入；DeepSeek/GLM/MiniMax/商汤/方舟/OpenCode Go 统一适配见 collectBalances。──

// ── OpenCode Go 套餐余量（控制台 cookie 抓取，无公开 API）──
// 页面内嵌初始状态形如：{rollingUsage:$R[0]={status:"ok",resetInSec:123,usagePercent:45},...}
const OPENCODE_GO_METER_RE = /(rollingUsage|weeklyUsage|monthlyUsage):\$R\[\d+\]=\{status:"([^"]+)",resetInSec:(\d+),usagePercent:(\d+)\}/g;

// ── OpenCode Go 用量统计（Serenity RPC，内部接口，无公开 API）──
// reference hash 随前端构建可能变化：从 https://opencode.ai/_build/assets/ 的 index-*.js 中搜 createServerReference 提取
const OPENCODE_GO_REF_COSTS = "15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205"; // getCosts(workspaceId, year, month, tzOffsetStr)
const OPENCODE_GO_REF_USAGE = "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c"; // getUsageInfo(workspaceId, page)

let ogStatsCache = { ts: 0, data: null };
let ogQuotaCache = { ts: 0, data: null };

// ── OpenCode Go 本地估算（无 cookie 兜底）──
// 官方计价规则：从 usage 明细 200 条线性回归（R²=0.9999）得出：
//   input $0.14/M + output $0.28/M + cache $0.0028/M，reasoning 免费
// 官方套餐窗口额度（opencode.ai/docs/go 明示，所有档位一致）：
//   $12 / 5h，$30 / 周，$60 / 月（美元价值额度；订阅费首月 $5、之后 $10/月）
const OPENCODE_GO_PRICING = { inputPerM: 0.14, outputPerM: 0.28, cachePerM: 0.0028 };
const PLAN_LIMITS = {
  lite: { rolling: 12, weekly: 30, monthly: 60 },
  standard: { rolling: 12, weekly: 30, monthly: 60 },
  pro: { rolling: 12, weekly: 30, monthly: 60 }
};
const DEFAULT_OG_LIMITS = { rolling: 12, weekly: 30, monthly: 60 };
let ogLimits = { ...DEFAULT_OG_LIMITS };
let ogLimitsPlan = "";
let ogCalibRatio = 1; // cookie 可用时用官方 totalCost 校准（官方/本地估算）

function ogLimitsPath() {
  return path.join(ENGINE_DATA, "og-limits.json");
}
function loadOgLimits() {
  try {
    const c = JSON.parse(readTextFile(ogLimitsPath()));
    if (c && c.limits && c.limits.monthly > 0) {
      ogLimits = { rolling: c.limits.rolling || 10, weekly: c.limits.weekly || 25, monthly: c.limits.monthly };
      ogLimitsPlan = c.plan || "";
    }
  } catch {}
}
function saveOgLimits(limits, plan) {
  if (!(limits && limits.monthly > 0)) return;
  ogLimits = { ...limits };
  ogLimitsPlan = plan || "";
  try {
    const p = ogLimitsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ limits: ogLimits, plan: ogLimitsPlan, updatedAt: Date.now() }));
  } catch {}
}
loadOgLimits();

function loadOgCalibration() {
  try {
    const p = path.join(ENGINE_DATA, "og-calib.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(readTextFile(p));
      if (c && typeof c.ratio === "number" && c.ratio > 0) ogCalibRatio = c.ratio;
    }
  } catch {}
}
function saveOgCalibration(ratio) {
  if (!(ratio > 0) || ratio > 5) return;
  ogCalibRatio = ratio;
  try {
    const p = path.join(ENGINE_DATA, "og-calib.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ratio, updatedAt: Date.now() }));
  } catch {}
}
loadOgCalibration();

// 从账本汇总 opencode-go 各窗口消耗，按官方价估算美元（来源见 services/ledger-source.js）
function estimateOpenCodeGoUsage() {
  try {
    const entries = loadLedger(resolveHanaHome()).entries;
    if (!entries.length) return null;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (now.getDay() + 6) % 7; // 周一 = 0
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - dow);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const acc = { rolling: { i: 0, o: 0, c: 0 }, weekly: { i: 0, o: 0, c: 0 }, monthly: { i: 0, o: 0, c: 0 } };
    const fiveH = now.getTime() - 5 * 3600 * 1000;
    for (const e of entries) {
      if (!e.model || e.model.provider !== "opencode-go") continue;
      const t = new Date(e.startedAt);
      if (isNaN(t.getTime())) continue;
      const u = e.usage || {};
      const i = u.input?.totalTokens || 0, o = u.output?.totalTokens || 0, c = u.cache?.readTokens || 0;
      if (t.getTime() >= fiveH) { acc.rolling.i += i; acc.rolling.o += o; acc.rolling.c += c; }
      if (t >= startOfWeek) { acc.weekly.i += i; acc.weekly.o += o; acc.weekly.c += c; }
      if (t >= startOfMonth) { acc.monthly.i += i; acc.monthly.o += o; acc.monthly.c += c; }
    }
    const p = OPENCODE_GO_PRICING;
    const usdOf = (s) => (s.i * p.inputPerM + s.o * p.outputPerM + s.c * p.cachePerM) / 1e6 * ogCalibRatio;
    // 估算窗口重置时间（自然周期）：周窗口 → 下周一 00:00，月窗口 → 下月 1 日 00:00；5 小时滚动窗口无固定起点，交给前端显示"估算"
    const nextWeek = new Date(now);
    nextWeek.setDate(now.getDate() - dow + 7);
    nextWeek.setHours(0, 0, 0, 0);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const windows = [
      { level: "rolling", usedUsd: usdOf(acc.rolling), limitUsd: ogLimits.rolling },
      { level: "weekly", usedUsd: usdOf(acc.weekly), limitUsd: ogLimits.weekly, resetInSec: Math.max(0, Math.round((nextWeek.getTime() - now.getTime()) / 1000)) },
      { level: "monthly", usedUsd: usdOf(acc.monthly), limitUsd: ogLimits.monthly, resetInSec: Math.max(0, Math.round((nextMonth.getTime() - now.getTime()) / 1000)) }
    ];
    return { type: "opencode-go-quota-est", windows, est: true, calibRatio: ogCalibRatio };
  } catch (e) {
    return null;
  }
}

// 校准：官方本月 totalCost vs 本地估算
function calibrateOg(estMonthUsd, officialMonthUsd) {
  if (estMonthUsd > 0.01 && officialMonthUsd >= 0) {
    saveOgCalibration(officialMonthUsd / estMonthUsd);
  }
}

// ── OpenCode Go 时间范围过滤（统一口径：本地时区时间戳）──
function ogRangeStartTs(range) {
  const now = new Date();
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === "yesterday") return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (range === "week") {
    const dow = (now.getDay() + 6) % 7;
    const ws = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    ws.setDate(ws.getDate() - dow);
    return ws.getTime();
  }
  if (range === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (range === "year") return new Date(now.getFullYear(), 0, 1).getTime();
  if (range === "lyear") return new Date(now.getFullYear() - 1, 0, 1).getTime();
  return 0;
}
function ogInRange(ts, range, from, to) {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  if (t < ogRangeStartTs(range)) return false;
  // yesterday 需要上限：昨日 23:59:59（否则会包含今天的数据）
  if (range === "yesterday") {
    const now = new Date();
    const ye = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59).getTime();
    if (t > ye) return false;
  }
  // lyear 需要上限：去年 12-31 23:59:59
  if (range === "lyear") {
    const now = new Date();
    const le = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59).getTime();
    if (t > le) return false;
  }
  if (from) { const f = new Date(from + "T00:00:00").getTime(); if (t < f) return false; }
  if (to) { const tt = new Date(to + "T23:59:59").getTime(); if (t > tt) return false; }
  return true;
}

// 模型汇总（按时间范围 + 可选 keyId 过滤）：次数与费用均来自官方 usage 明细缓存
function aggregateOgModels(ogRecs, range, from, to, keyId) {
  const src = ogRecs && typeof ogRecs === "object" && Object.keys(ogRecs).length ? ogRecs : null;
  if (!src) return [];
  const map = {};
  for (const id in src) {
    const u = src[id];
    if (!u || !u.model || !ogInRange(u.ts, range, from, to)) continue;
    if (keyId && u.keyId !== keyId) continue;
    if (!map[u.model]) map[u.model] = { model: u.model, cost: 0, count: 0, inputTokens: 0, outputTokens: 0 };
    map[u.model].cost += u.cost || 0;
    map[u.model].count++;
    map[u.model].inputTokens += u.inputTokens || 0;
    map[u.model].outputTokens += u.outputTokens || 0;
  }
  return Object.values(map)
    .map(x => ({ model: x.model, count: x.count, costUsd: (x.cost || 0) / 1e8, inputTokens: x.inputTokens, outputTokens: x.outputTokens }))
    .filter(x => x.count > 0 || x.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
}

// 官方成本接口按日期/模型/KEY 汇总，totalCost 与 usage.cost 同为 1e-8 美元整数（已与官方账单实测对账）。
// 费用展示优先使用这里的结果，避免本地 token 估算与官方账单产生口径差异。
function aggregateOgOfficialCosts(costs, range, from, to, keyId) {
  const map = {};
  for (const c of costs || []) {
    const day = String(c?.date || "").slice(0, 10);
    if (!day || !c?.model || !ogInRange(day + "T12:00:00", range, from, to)) continue;
    if (keyId && c.keyId !== keyId) continue;
    map[c.model] = (map[c.model] || 0) + (Number(c.totalCost) || 0);
  }
  for (const model of Object.keys(map)) map[model] /= 1e8;
  return map;
}

function mergeOgOfficialCosts(rows, costMap) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const next = { ...row };
    if (Object.prototype.hasOwnProperty.call(costMap || {}, next.model)) next.costUsd = costMap[next.model];
    out.push(next);
    seen.add(next.model);
  }
  for (const [model, costUsd] of Object.entries(costMap || {})) {
    if (seen.has(model)) continue;
    out.push({ model, count: 0, costUsd, inputTokens: 0, outputTokens: 0 });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd || b.count - a.count);
}

// 官方成本仅覆盖当前月/上月；更早日期用已同步 usage 缓存补齐，按日期去重避免重复计费。
function aggregateOgCostSources(costs, ogRecs, range, from, to, keyId) {
  const map = {};
  const officialDays = new Set();
  for (const c of costs || []) {
    const day = String(c?.date || "").slice(0, 10);
    if (!day || !c?.model || !ogInRange(day + "T12:00:00", range, from, to)) continue;
    if (keyId && c.keyId !== keyId) continue;
    officialDays.add(day);
    map[c.model] = (map[c.model] || 0) + (Number(c.totalCost) || 0) / 1e8;
  }
  let fallbackUsed = false;
  for (const r of Object.values(ogRecs || {})) {
    const rd = r?.ts ? new Date(r.ts) : null;
    const day = rd && !isNaN(rd.getTime()) ? rd.getFullYear() + "-" + String(rd.getMonth() + 1).padStart(2, "0") + "-" + String(rd.getDate()).padStart(2, "0") : "";
    if (!day || !r?.model || !ogInRange(r.ts, range, from, to)) continue;
    if (keyId && r.keyId !== keyId) continue;
    if (officialDays.has(day)) continue;
    map[r.model] = (map[r.model] || 0) + (Number(r.cost) || 0) / 1e8;
    fallbackUsed = true;
  }
  return {
    costs: map,
    source: officialDays.size ? (fallbackUsed ? "official+usage-cache" : "official") : "usage-cache"
  };
}

// Serenity server function 的参数序列化（devalue 风格）
function devalueArgs(args) {
  const a = args.map(x => typeof x === "string" ? { t: 1, s: x } : { t: 0, s: x });
  return { t: { t: 9, i: 0, l: a.length, a, o: 0 }, f: 31, m: [] };
}

// Serenity RPC 响应反序列化：;0x00000000;((self.$R=...)...,(FN)(ARGS))
// 在 vm 沙箱中求值（响应来自 opencode.ai 官方，只读数据不执行其他逻辑）
function parseSerenity(raw) {
  const m = String(raw).match(/;0x[0-9a-f]+;([\s\S]+)$/);
  if (!m) return null;
  const sandbox = { self: { $R: {} }, Date, JSON, Math, console };
  sandbox.$R = sandbox.self.$R;
  vm.createContext(sandbox);
  try {
    vm.runInContext(m[1], sandbox, { timeout: 2000 });
    const slot = sandbox.self.$R["server-fn:1"];
    return slot && slot[0];
  } catch (e) {
    return null;
  }
}

// opencode.ai 服务器响应偏慢，复用 TLS 连接减少握手开销
const ogHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

// ULID → 时间戳（订阅近似：key id / usg id 的 ULID 部分含 48bit 毫秒时间戳）
function ulidToTs(s) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(s || "")) return 0;
  const abc = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = 0n;
  for (const ch of s.slice(0, 10)) n = n * 32n + BigInt(abc.indexOf(ch));
  return Number(n);
}

// 用量记录字段规范化（兼容 camelCase / snake_case，usg_id 去重键）
function normalizeOgUsageRecord(r) {
  if (!r || typeof r !== "object") return null;
  const id = r.id || r.usg_id || r.usageId || "";
  if (!id) return null;
  const rawCost = r.cost != null ? r.cost : (r.costRaw != null ? r.costRaw : (r.totalCost != null ? r.totalCost : 0));
  return {
    id,
    ts: r.timeCreated || r.created_at || r.timestamp || r.createdAt || "",
    model: r.model || r.modelId || "unknown",
    provider: r.provider || "",
    inputTokens: r.inputTokens != null ? r.inputTokens : (r.input_tokens || 0),
    outputTokens: r.outputTokens != null ? r.outputTokens : (r.output_tokens || 0),
    cost: Number(rawCost) || 0,
    keyId: r.keyID || r.key_id || "",
    plan: r.plan || null
  };
}

// ── OpenCode Go 用量全量同步（按 usg_id 去重持久化，参考 68hub usage-sync）──
const OG_USAGE_CACHE_VERSION = 1;
const OG_USAGE_PAGE_SIZE = 50;
const OG_USAGE_MAX_PAGES = 500;   // 每页 50 条，最多 25000 条
const OG_SYNC_LOCKS = new Set();   // 防止并发同步

function ogUsageCachePath() {
  return path.join(ENGINE_DATA, "og-usage-cache.json");
}

function loadOgUsageCache() {
  try {
    const p = ogUsageCachePath();
    if (fs.existsSync(p)) {
      const c = JSON.parse(readTextFile(p));
      if (c && c.version === OG_USAGE_CACHE_VERSION && c.records) return c;
    }
  } catch {}
  return { version: OG_USAGE_CACHE_VERSION, records: {}, deepestPage: -1, syncedAt: 0, total: 0 };
}

function saveOgUsageCache(cache) {
  try {
    const p = ogUsageCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache));
  } catch {}
}

// 拉取一页 usage 记录（含超时/失败保护）
async function fetchOgUsagePage(cookie, ws, page) {
  try {
    const raw = await openCodeGoRpc(cookie, OPENCODE_GO_REF_USAGE, [ws, page]);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOgUsageRecord).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// 同步：mode=incremental 增量（默认）/ full 全量。返回 { inserted, pages, done }
async function syncOgUsage(cookie, ws, mode) {
  if (!cookie || !ws) return { inserted: 0, pages: 0, done: false, error: "未配置" };
  const lockKey = ws;
  if (OG_SYNC_LOCKS.has(lockKey)) return { inserted: 0, pages: 0, done: false, error: "同步中" };
  OG_SYNC_LOCKS.add(lockKey);
  try {
    const cache = loadOgUsageCache();
    let inserted = 0;
    let pages = 0;
    // 增量：先刷前 20 页拿最新，再从断点继续往后补（页号越大越旧）
    let deepest = cache.deepestPage;
    if (mode !== "full" && deepest >= 0) {
      const headPages = Math.min(deepest + 1, 20);
      for (let p = 0; p < headPages; p++) {
        const recs = await fetchOgUsagePage(cookie, ws, p);
        pages++;
        if (!recs.length) break;
        let hasNew = false;
        for (const r of recs) {
          if (!cache.records[r.id]) { cache.records[r.id] = r; inserted++; hasNew = true; }
        }
        if (recs.length < OG_USAGE_PAGE_SIZE) break;
        if (!hasNew && p >= 1) break;   // 头部无新数据 → 增量完成
      }
    }
    let start = Math.max(0, deepest + 1);
    const pageLimit = mode === "full" ? OG_USAGE_MAX_PAGES : Math.min(OG_USAGE_MAX_PAGES, 60);
    for (let p = start; p < start + pageLimit; p++) {
      const recs = await fetchOgUsagePage(cookie, ws, p);
      pages++;
      if (!recs.length) break;
      let hasNew = false;
      for (const r of recs) {
        if (!cache.records[r.id]) { cache.records[r.id] = r; inserted++; hasNew = true; }
      }
      deepest = p;
      if (recs.length < OG_USAGE_PAGE_SIZE) break;
      if (!hasNew) break;
    }
    cache.deepestPage = deepest;
    cache.syncedAt = Date.now();
    cache.total = Object.keys(cache.records).length;
    // 自动识别主 key：最近 24h 内调用最多的 keyId（Hana 绑定的 sk-key 对应它）
    const dayAgo = Date.now() - 86400000;
    const keyCount = {};
    for (const id in cache.records) {
      const r = cache.records[id];
      if (!r || !r.keyId || !r.ts) continue;
      const t = new Date(r.ts).getTime();
      if (isNaN(t) || t < dayAgo) continue;
      keyCount[r.keyId] = (keyCount[r.keyId] || 0) + 1;
    }
    let primaryKey = null, maxC = 0;
    for (const kid of Object.keys(keyCount)) {
      if (keyCount[kid] > maxC) { maxC = keyCount[kid]; primaryKey = kid; }
    }
    if (primaryKey) cache.primaryKeyId = primaryKey;
    saveOgUsageCache(cache);
    return { inserted, pages, done: true, total: cache.total, deepestPage: deepest, primaryKeyId: cache.primaryKeyId };
  } catch (e) {
    return { inserted: 0, pages, done: false, error: e.message || "同步失败" };
  } finally {
    OG_SYNC_LOCKS.delete(lockKey);
  }
}

// 从持久化缓存按模型聚合（请求数 + 费用 + tokens），时间口径与模型/Key 汇总统一
function aggregateOgModelUsage(records, range, from, to) {
  const map = {};
  for (const id in records) {
    const r = records[id];
    if (!r || !ogInRange(r.ts, range, from, to)) continue;
    const m = r.model || "unknown";
    if (!map[m]) map[m] = { model: m, count: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    map[m].count++;
    map[m].costUsd += r.cost / 1e8;   // usage 接口 cost 为 1e-8 美元整数（与校准口径一致）
    map[m].inputTokens += r.inputTokens || 0;
    map[m].outputTokens += r.outputTokens || 0;
  }
  return Object.values(map)
    .map(x => ({ model: x.model, count: x.count, costUsd: x.costUsd, inputTokens: x.inputTokens, outputTokens: x.outputTokens }))
    .sort((a, b) => b.costUsd - a.costUsd || b.count - a.count);
}

// 调用一个 Serenity server reference（POST /_server）
function openCodeGoRpc(cookie, refId, args) {
  const body = JSON.stringify(devalueArgs(args));
  return new Promise((resolve) => {
    const req = https.request("https://opencode.ai/_server", {
      method: "POST",
      agent: ogHttpsAgent,
      headers: {
        "Cookie": "auth=" + cookie,
        "User-Agent": "token-tracker/1.0",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Server-Id": refId,
        "X-Server-Instance": "server-fn:1"
      }
    }, res => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        resolve(parseSerenity(out));
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// 用量统计：当月+上月 Cost（按天聚合）+ 最近调用明细（第 1 页）。10 分钟缓存。
async function fetchOpenCodeGoStats(cookie, ws) {
  if (!cookie || !ws) return null;
  const now = new Date();
  const key = now.getFullYear() + "/" + now.getMonth();
  if (ogStatsCache.data && ogStatsCache.key === key && Date.now() - ogStatsCache.ts < 180000) {
    return ogStatsCache.data;
  }
  const y = now.getFullYear();
  const m = now.getMonth();
  const tz = "+08:00";
  const months = [];
  for (let i = 0; i < 2; i++) {
    let yy = y, mm = m - i;
    while (mm < 0) { mm += 12; yy--; }
    months.push([yy, mm]);
  }
  const results = await Promise.all([
    ...months.map(([yy, mm]) => openCodeGoRpc(cookie, OPENCODE_GO_REF_COSTS, [ws, yy, mm, tz])),
    ...Array.from({ length: 14 }, (_, i) => openCodeGoRpc(cookie, OPENCODE_GO_REF_USAGE, [ws, i]))
  ]);
  const costs = [];
  let keys = [];
  const keysMap = {};   // 合并两个月返回的 keys（当月为空时用上月补）
  for (let i = 0; i < 2; i++) {
    const r = results[i];
    if (r && Array.isArray(r.usage)) {
      for (const u of r.usage) costs.push(u);
      if (r.keys && r.keys.length) {
        for (const k of r.keys) {
          if (k && k.id && !keysMap[k.id]) keysMap[k.id] = k;
        }
      }
    }
  }
  keys = Object.values(keysMap);
  const usage = [];
  for (let i = 2; i < results.length; i++) {
    if (Array.isArray(results[i])) usage.push(...results[i]);
  }
  const truncated = Array.isArray(results[results.length - 1]) && results[results.length - 1].length >= 50;
  const plan = (results[0] && Array.isArray(results[0].usage) && results[0].usage.length && results[0].usage[0].plan) || "";
  const data = { costs, keys, usage, truncated, plan, fetchedAt: Date.now() };
  ogStatsCache = { key, ts: Date.now(), data };
  return data;
}

// Key 汇总（按时间范围 + 可选 keyId 过滤）：每个 key 下钻到模型明细
function aggregateOgKeys(keys, ogRecs, range, from, to, filterKeyId) {
  const idToName = {};
  for (const k of keys || []) if (k && k.id) idToName[k.id] = k.displayName || k.id;
  // 兜底：从 usage 缓存的 keyNames 补（getCosts 偶尔返回空时）
  try {
    const uc = loadOgUsageCache();
    if (uc && uc.keyNames) {
      for (const kid of Object.keys(uc.keyNames)) {
        if (!idToName[kid]) idToName[kid] = uc.keyNames[kid];
      }
    }
  } catch {}
  const src = ogRecs && typeof ogRecs === "object" && Object.keys(ogRecs).length ? ogRecs : null;
  if (!src) return [];
  const keyMap = {};
  for (const id in src) {
    const u = src[id];
    if (!u || !u.keyId || !ogInRange(u.ts, range, from, to)) continue;
    if (filterKeyId && u.keyId !== filterKeyId) continue;
    const kid = u.keyId;
    if (!keyMap[kid]) keyMap[kid] = { keyId: kid, cost: 0, count: 0, models: {} };
    keyMap[kid].cost += u.cost || 0;
    keyMap[kid].count++;
    const m = u.model || "unknown";
    if (!keyMap[kid].models[m]) keyMap[kid].models[m] = { model: m, cost: 0, count: 0, inputTokens: 0, outputTokens: 0 };
    keyMap[kid].models[m].cost += u.cost || 0;
    keyMap[kid].models[m].count++;
    keyMap[kid].models[m].inputTokens += u.inputTokens || 0;
    keyMap[kid].models[m].outputTokens += u.outputTokens || 0;
  }
  return Object.values(keyMap)
    .map(x => ({
      keyId: x.keyId,
      name: idToName[x.keyId] || x.keyId,
      count: x.count,
      costUsd: (x.cost || 0) / 1e8,
      models: Object.values(x.models)
        .map(mo => ({ model: mo.model, count: mo.count, costUsd: (mo.cost || 0) / 1e8, inputTokens: mo.inputTokens, outputTokens: mo.outputTokens }))
        .filter(mo => mo.count > 0 || mo.costUsd > 0)
        .sort((a, b) => b.costUsd - a.costUsd || b.count - a.count)
    }))
    .filter(x => x.count > 0 || x.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
}

async function fetchOpenCodeGoQuota(apiConfig) {
  const ws = apiConfig.workspaceId || "";
  const cookie = apiConfig.cookie || "";
  if (!ws || !cookie) return { type: "error", display: "未配置 workspace/cookie" };
  // 余量窗口以小时/天计，5 分钟内变化可忽略；缓存避免每次刷新都等慢速 SSR
  if (ogQuotaCache.data && Date.now() - ogQuotaCache.ts < 300000) {
    return ogQuotaCache.data;
  }
  const url = "https://opencode.ai/workspace/" + ws + "/go";
  return new Promise((resolve) => {
    const req = https.get(url, {
      agent: ogHttpsAgent,
      headers: {
        "Cookie": "auth=" + cookie,
        "Accept": "text/html",
        "User-Agent": "token-tracker/1.0"
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        const loc = res.headers.location || "";
        res.resume();
        resolve(estimateOpenCodeGoUsage() || { type: "error", display: "Cookie 过期，请更新" });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(estimateOpenCodeGoUsage() || { type: "error", display: "获取失败" });
        return;
      }
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          OPENCODE_GO_METER_RE.lastIndex = 0;
          const meters = [...body.matchAll(OPENCODE_GO_METER_RE)];
          if (!meters.length) {
            resolve(estimateOpenCodeGoUsage() || { type: "error", display: "页面无用量数据（未订阅或页面改版）" });
            return;
          }
          const windows = meters.map(m => ({
            level: m[1] === "rollingUsage" ? "rolling" : (m[1] === "weeklyUsage" ? "weekly" : "monthly"),
            usedPercent: +m[4],
            resetInSec: +m[3],
            status: m[2]
          }));
          const data = { type: "opencode-go-quota", windows };
          ogQuotaCache = { ts: Date.now(), data };
          resolve(data);
        } catch (e) {
          resolve(estimateOpenCodeGoUsage() || { type: "error", display: "解析失败" });
        }
      });
    });
    req.on("error", () => resolve(estimateOpenCodeGoUsage() || { type: "error", display: "网络错误" }));
    // 服务器 SSR 渲染慢（实测 4-9s），超时线放宽到与 race 一致
    req.setTimeout(12000, () => { req.destroy(); resolve(estimateOpenCodeGoUsage() || { type: "error", display: "超时" }); });
  });
}

function esc(v) { return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function cnToday(){return CN_DAY.format(new Date())}

// realtimeSnapshot 函数不再重复定义；使用 cache.realtimeSnapshot（由 index.js onload 时挂入到 shared）

// ── P0-1/OpenCode Go：把指标抓取函数注册进统一余额适配层（services/balance.js）──
// 页面解析窗口表、估算与校准链路保留在本模块（与 /dashboard/data 的 og 同步/成本口径共用），
// 仅在模块加载时注册，collectBalances / bus handler(token-tracker.balance) 通过注册表调用。
registerBalanceFetcher("opencode-go", (apiConfig) => fetchOpenCodeGoQuota(apiConfig));

// ── 测试缝：预填 USD→CNY 汇率缓存，离线测试不打 open.er-api.com ──
export function _setFxRateForTests(rate) {
  _fxCache = { rate, ts: Date.now() };
}
