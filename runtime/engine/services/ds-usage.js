// DeepSeek 官网用量/消费接口客户端。
//
// 数据来源：platform.deepseek.com 的官方账单（不是本地日志估算，也不是 api.deepseek.com 的
// API key 余额接口——那个只有余额，没有用量）。
// 鉴权：Bearer <userToken>，token 由 ds-token-source 从 Hana 内置浏览器的磁盘存储里取出。
//
// 接口（官网用量页面实际使用的那一套）：
//   GET /api/v0/usage/by_api_key/amount?start=<unix秒>&end=<unix秒>&tz=<时区偏移秒>
//   GET /api/v0/usage/by_api_key/cost?start=<unix秒>&end=<unix秒>&tz=<时区偏移秒>
//
// 关键：**粒度由服务器按区间长度自己决定**，返回值里的 bucket 字段说明它给了什么：
//   bucket = 86400 → 按天；bucket = 3600 → 按小时。
// 实测：整月/三天 → 86400，单日 → 3600。所以「看小时」不需要额外数据源，把区间收窄即可。
//
// 返回结构：biz_data = { start, end, bucket, models, series }
//   series[] = { api_key:{...}, model, buckets:[{ time, usage:{ TYPE: amount } }] }
//
// 安全约定：token 只作为参数传入，本模块不落盘、不打日志。
import { findUserToken } from "./ds-token-source.js";

const BASE = "https://platform.deepseek.com";

// 官网用到的 5 类计数。聚合时原样保留，缺的按 0 处理。
export const USAGE_TYPES = [
  "PROMPT_TOKEN",
  "PROMPT_CACHE_HIT_TOKEN",
  "PROMPT_CACHE_MISS_TOKEN",
  "RESPONSE_TOKEN",
  "REQUEST",
];

function makeError(code, message) {
  return Object.assign(new Error(message), { code });
}

// 与浏览器同源的时区偏移（秒）。默认取本机偏移，服务器按它切桶边界。
export function localTzOffsetSeconds(date = new Date()) {
  return -date.getTimezoneOffset() * 60;
}

async function callApi(token, kind, { start, end, tz, signal } = {}) {
  if (!token) throw makeError("DS_NO_TOKEN", "没有可用的 userToken");
  const url = new URL(`/api/v0/usage/by_api_key/${kind}`, BASE);
  url.searchParams.set("start", String(Math.floor(start)));
  url.searchParams.set("end", String(Math.floor(end)));
  url.searchParams.set("tz", String(Math.floor(tz)));
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw makeError("DS_NETWORK", "请求官网失败：" + (e?.message || e));
  }
  if (res.status === 401 || res.status === 403) throw makeError("DS_TOKEN_INVALID", "官网拒绝了这枚 token（可能已过期）");
  if (!res.ok) throw makeError("DS_HTTP_" + res.status, "官网返回 HTTP " + res.status);
  let json;
  try {
    json = await res.json();
  } catch {
    throw makeError("DS_BAD_JSON", "官网响应不是合法 JSON");
  }
  if (!json || typeof json !== "object") throw makeError("DS_BAD_RESPONSE", "响应不是 JSON 对象");
  if (json.code !== 0) throw makeError("DS_API_ERROR", `接口返回 code=${json.code}: ${json.msg || ""}`);
  const data = json.data || {};
  if (data.biz_code !== 0) throw makeError("DS_BIZ_ERROR", `业务返回 biz_code=${data.biz_code}: ${data.biz_msg || ""}`);
  const biz = data.biz_data;
  if (!biz || typeof biz !== "object") throw makeError("DS_EMPTY", "响应里没有用量数据");
  return biz;
}

// 把 series（按 API Key × 模型的桶列表）压平成「按时间桶」的合计，同时保留模型明细。
// 同一时刻、多个 key、多个模型会合并到同一个桶。
// 两种响应形状都要认：
//   amount → biz.series，桶字段 usage:{TYPE:amount}
//   cost   → biz.data[0].series，桶字段 cost:"0.123"（单值，带币种）
export function flattenWindow(biz) {
  const wrapped = Array.isArray(biz.data) ? biz.data[0] : null;
  const series = Array.isArray(biz.series) ? biz.series : (wrapped?.series || []);
  const currency = wrapped?.currency || null;
  const byTime = new Map();
  for (const s of series) {
    const model = s?.model || "unknown";
    for (const b of s?.buckets || []) {
      const t = Number(b?.time);
      if (!Number.isFinite(t)) continue;
      let rec = byTime.get(t);
      if (!rec) { rec = { t, byType: {}, byModel: {} }; byTime.set(t, rec); }
      const add = (type, a) => {
        if (!a) return;
        rec.byType[type] = (rec.byType[type] || 0) + a;
        if (!rec.byModel[model]) rec.byModel[model] = {};
        rec.byModel[model][type] = (rec.byModel[model][type] || 0) + a;
      };
      if (b.usage && typeof b.usage === "object") {
        for (const [type, amount] of Object.entries(b.usage)) add(type, Number(amount) || 0);
      }
      if (b.cost != null) add("COST", Number(b.cost) || 0);
    }
  }
  const points = [...byTime.values()].sort((a, b) => a.t - b.t);
  return {
    bucket: Number(biz.bucket) || 0,
    start: Number(biz.start) || 0,
    end: Number(biz.end) || 0,
    models: Array.isArray(biz.models) ? biz.models : [],
    currency,
    points,
  };
}

// 取一段区间的 token 用量（粒度由服务器定）。
export async function fetchAmountWindow(token, { start, end, tz, signal } = {}) {
  const tzOffset = tz == null ? localTzOffsetSeconds() : tz;
  return flattenWindow(await callApi(token, "amount", { start, end, tz: tzOffset, signal }));
}

// 取一段区间的消费金额（粒度由服务器定）。
export async function fetchCostWindow(token, { start, end, tz, signal } = {}) {
  const tzOffset = tz == null ? localTzOffsetSeconds() : tz;
  return flattenWindow(await callApi(token, "cost", { start, end, tz: tzOffset, signal }));
}

// 一次拿齐两样，任一失败不拖垮另一个。
export async function fetchWindowPair(token, { start, end, tz, signal } = {}) {
  const [amount, cost] = await Promise.allSettled([
    fetchAmountWindow(token, { start, end, tz, signal }),
    fetchCostWindow(token, { start, end, tz, signal }),
  ]);
  return {
    start, end,
    amount: amount.status === "fulfilled" ? amount.value : null,
    amountError: amount.status === "rejected" ? (amount.reason?.code || amount.reason?.message) : null,
    cost: cost.status === "fulfilled" ? cost.value : null,
    costError: cost.status === "rejected" ? (cost.reason?.code || cost.reason?.message) : null,
  };
}

// 便捷：拿 token 并拉一个区间（供服务层直接用）。
export async function fetchWindowWithToken({ token, ...rest } = {}) {
  const tk = token || findUserToken()?.token;
  if (!tk) throw makeError("DS_NO_TOKEN", "没有可用的 userToken");
  return fetchWindowPair(tk, rest);
}

export default { fetchAmountWindow, fetchCostWindow, fetchWindowPair, flattenWindow, localTzOffsetSeconds, USAGE_TYPES };
