// DeepSeek 官网用量/消费接口客户端。
//
// 数据来源：platform.deepseek.com 的官方账单（不是本地日志估算，也不是 api.deepseek.com 的
// API key 余额接口——那个只有余额，没有用量）。
// 鉴权：Bearer <userToken>，token 由 ds-token-source 从 Hana 内置浏览器的磁盘存储里取出。
//
// 能力与限制：
//   - 只有「天」粒度，按模型拆分；没有小时数据。
//   - 每次只能取一个月，跨历史要逐月调用。
//   - amount 接口的数字是 token 数；cost 接口复用同一结构，数字是金额（CNY）。
//
// 安全约定：token 只作为参数传入，本模块不落盘、不打日志。

const BASE = "https://platform.deepseek.com";

// 凭据失效与普通网络错误的区分，交给上层决定是「重扫 token 再试」还是「稍后重试」。
function makeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function unwrapBiz(json) {
  if (!json || typeof json !== "object") throw makeError("DS_BAD_RESPONSE", "响应不是 JSON 对象");
  if (json.code !== 0) throw makeError("DS_API_ERROR", `接口返回 code=${json.code}: ${json.msg || ""}`);
  const data = json.data || {};
  if (data.biz_code !== 0) throw makeError("DS_BIZ_ERROR", `业务返回 biz_code=${data.biz_code}: ${data.biz_msg || ""}`);
  let biz = data.biz_data;
  // cost 接口在部分月份把 biz_data 包成数组，取第一项。
  if (Array.isArray(biz)) biz = biz[0];
  if (!biz || typeof biz !== "object") throw makeError("DS_EMPTY", "响应里没有用量数据");
  return biz;
}

async function callApi(token, endpoint, { month, year, signal } = {}) {
  if (!token) throw makeError("DS_NO_TOKEN", "没有可用的 userToken");
  const url = new URL(`/api/v0/usage/${endpoint}`, BASE);
  url.searchParams.set("month", String(month));
  url.searchParams.set("year", String(year));
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
  return unwrapBiz(json);
}

// 把 biz_data 摊平成「按天、按模型、按类型」的行，便于入库与画图。
// 返回 { days: [{ date, model, type, amount }], total: [{ model, type, amount }], currency }
export function flattenUsage(biz) {
  const rows = [];
  const total = [];
  for (const m of biz.total || []) {
    for (const u of m.usage || []) {
      total.push({ model: m.model || "unknown", type: u.type || "UNKNOWN", amount: Number(u.amount) || 0 });
    }
  }
  for (const d of biz.days || []) {
    for (const m of d.data || []) {
      for (const u of m.usage || []) {
        rows.push({ date: d.date, model: m.model || "unknown", type: u.type || "UNKNOWN", amount: Number(u.amount) || 0 });
      }
    }
  }
  return { days: rows, total, currency: biz.currency || null };
}

// 取某月的 token 用量（按天/模型/类型）。
export async function fetchUsageAmount(token, { month, year, signal } = {}) {
  const biz = await callApi(token, "amount", { month, year, signal });
  return flattenUsage(biz);
}

// 取某月的消费金额（按天/模型）。
export async function fetchUsageCost(token, { month, year, signal } = {}) {
  const biz = await callApi(token, "cost", { month, year, signal });
  return flattenUsage(biz);
}

// 一次拿齐两样，任一失败不拖垮另一个。
export async function fetchUsageMonth(token, { month, year, signal } = {}) {
  const [amount, cost] = await Promise.allSettled([
    fetchUsageAmount(token, { month, year, signal }),
    fetchUsageCost(token, { month, year, signal }),
  ]);
  return {
    month, year,
    amount: amount.status === "fulfilled" ? amount.value : null,
    amountError: amount.status === "rejected" ? (amount.reason?.code || amount.reason?.message) : null,
    cost: cost.status === "fulfilled" ? cost.value : null,
    costError: cost.status === "rejected" ? (cost.reason?.code || cost.reason?.message) : null,
  };
}

export default { fetchUsageAmount, fetchUsageCost, fetchUsageMonth, flattenUsage };
