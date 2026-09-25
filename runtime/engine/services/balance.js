import { resolveHanaHome, readTextFile } from "./platform.js";
import { writeFileAtomic } from "./jsonl-log.js";
// ── 余额/余量统一适配层（P0-1 / P1）──
// 从 routes/dashboard.js 收拢：通用 fetchBalance（自动格式判断）、MiniMax TokenPlan、
// 商汤 Sensenova（IAM 登录/刷新 + TokenPlan 积分池 + coding-plan 回退）、火山方舟 Coding Plan。
// DeepSeek / GLM 显式注册（key 读取优先级：~/.hanako/added-models.yaml > ~/.hanako/provider-catalog.json）。
// OpenCode Go 的指标抓取（workspace 页面解析 + 本地估算链路）保留在 routes/dashboard.js，
// 通过 registerBalanceFetcher("opencode-go", fn) 注入本模块，避免逻辑重写。
//
// 统一响应契约（每个 provider 一条）：
//   { provider, status: "ok"|"error", type: "currency"|"quota"|"subscription",
//     display, used, limit, remain, updatedAt, error }
// type=currency 时 display 为金额字符串；type=quota/subscription 时 used/limit/remain 为数值。
// 单个 provider 失败仅产生 status:"error" 条目，不拖垮整次查询。
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";

const HOME = resolveHanaHome();

const DEFAULT_BALANCE_APIS = {
  deepseek: { url: "https://api.deepseek.com/user/balance" },
  glm: { url: "https://open.bigmodel.cn/api/paas/v4/users/me/balance" },
  moonshot: { url: "https://api.moonshot.cn/v1/users/me/balance" },
  minimax: { url: "https://api.minimaxi.com/v1/user/balance" },
  "minimax-token-plan": {
    url: "https://api.minimaxi.com/v1/token_plan/remains",
    responseType: "token-plan"
  },
  sensenova: {
    responseType: "sensenova-iam",
    username: "",
    password: "",
    accountId: "",
    token: "",
    refreshToken: "",
    modelIds: ["sensenova-6.7-flash-lite", "sensenova-u1-fast", "deepseek-v4-flash"],
    enabled: false
  },
  "volcengine-coding": {
    responseType: "volcengine-coding-plan",
    ak: "",
    sk: "",
    region: "cn-beijing",
    enabled: false
  },
  "opencode-go": {
    responseType: "opencode-go",
    workspaceId: "",
    cookie: "",
    enabled: false
  },
};

function loadBalanceApis(dataDir) {
  const p = path.join(dataDir, "balance-apis.json");
  const saved = {};
  try {
    if (fs.existsSync(p)) Object.assign(saved, JSON.parse(readTextFile(p)));
  } catch {}
  // 合并默认配置，保留用户覆盖的字段
  const merged = structuredClone(DEFAULT_BALANCE_APIS);
  for (const [k, v] of Object.entries(saved)) {
    if (merged[k] && typeof v === "object" && typeof merged[k] === "object") {
      merged[k] = { ...merged[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  // 清洗 opencode-go 配置：cookie 可能被粘贴成 "opencode cookie:  Fe26.2**..." 这种带说明文字的形式，
  // workspaceId 也可能被粘贴成完整 URL。清洗后统一为纯 cookie 值 / 纯 ws id，否则官方请求全被 302 踢回登录。
  for (const [k, v] of Object.entries(merged)) {
    if (v && v.responseType === "opencode-go") {
      if (typeof v.cookie === "string") {
        v.cookie = v.cookie.replace(/^(opencode\s+cookie\s*[:：]?\s*|cookie\s*[:：]?\s*)/i, "").trim();
      }
      if (typeof v.workspaceId === "string" && /^https?:\/\//i.test(v.workspaceId)) {
        v.workspaceId = v.workspaceId.replace(/^https?:\/\/opencode\.ai\/workspace\//i, "").replace(/\/go$/, "");
      }
    }
  }
  return merged;
}

// 余额响应解析（从 fetchBalance 抽出，便于 fixture 离线测试）：
// DeepSeek 货币格式 / GLM 配额格式 / 通用货币字段；无法识别时返回 null。
export function parseBalanceBody(d) {
  if (!d || typeof d !== "object" || d.success === false || d.error) return null;
  // DeepSeek 格式
  if (d.balance_infos && d.balance_infos.length) {
    let total = 0; const details = [];
    for (const bi of d.balance_infos) {
      const t = parseFloat(bi.total_balance) || 0;
      total += t;
      const label = bi.label || (bi.currency === "CNY" ? "余额" : bi.currency);
      details.push({ label, amount: t, currency: bi.currency || "CNY" });
    }
    const totals = new Map();
    for (const detail of details) totals.set(detail.currency, (totals.get(detail.currency) || 0) + detail.amount);
    const display = [...totals].map(([currency, amount]) => (currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency + " ") + amount.toFixed(2)).join(" + ");
    const currency = totals.size === 1 ? details[0].currency : null;
    return { type: "money", total: currency ? total : null, currency, display, details };
  }
  // GLM/智谱 配额格式
  if (d.success && d.data && d.data.limits) {
    const tokenLimit = d.data.limits.find(l => l.type === "TOKENS_LIMIT");
    if (tokenLimit && typeof tokenLimit.percentage === "number") {
      const used = tokenLimit.percentage; const remain = 100 - used;
      return { type: "quota", remain, used, display: "剩余 " + remain.toFixed(0) + "%" };
    }
    return null;
  }
  // 通用货币格式：尝试常见字段
  const value = d.data?.available_balance ?? d.data?.balance ?? d.available_balance ?? d.balance ?? d.total_balance;
  const avail = value == null || value === "" ? NaN : Number(value);
  if (Number.isFinite(avail)) {
    const currency = d.currency || d.data?.currency || "CNY";
    return { type: "money", total: avail, currency, display: (currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency + " ") + avail.toFixed(2) };
  }
  return null;
}

async function fetchBalance(apiConfig, apiKey) {
  return new Promise((resolve) => {
    const req = https.get(apiConfig.url, {
      headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" }
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); resolve({ type: "error", display: "HTTP " + res.statusCode }); return; }
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          resolve(parseBalanceBody(JSON.parse(body)));
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

// ── MiniMax Token Plan 查询：5 小时 + 周限额双窗口 ──
function parseMinimaxWindow(total, used, remainPercent, status) {
  const totalN = parseInt(total, 10) || 0;
  const usedN = parseInt(used, 10) || 0;
  let remainPct = parseFloat(remainPercent);
  if (!isFinite(remainPct) || remainPct < 0 || remainPct > 100) remainPct = null;
  const usedPercent = remainPct != null ? +Math.min(100, Math.max(0, (100 - remainPct))).toFixed(1) : null;
  return {
    total: totalN,
    used: usedN,
    remain: Math.max(0, totalN - usedN),
    percent: usedPercent,        // 已用百分比
    remainPercent: remainPct,   // 剩余百分比（API 原始）
    countBased: totalN > 0,
    status: typeof status === "number" ? status : null
  };
}

async function fetchMinimaxTokenPlan(apiConfig, apiKey) {
  if (!apiKey) return Promise.resolve({ type: "error", display: "API Key 为空" });
  return new Promise((resolve) => {
    const req = https.get(apiConfig.url, {
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          if (!d || d.base_resp?.status_code !== 0 || !Array.isArray(d.model_remains)) {
            const msg = d?.base_resp?.status_msg || "查询失败";
            resolve({ type: "error", display: msg });
            return;
          }
          const plan = d.current_subscribe_title || d.plan_name || d.plan || null;
          const models = d.model_remains.map(m => {
            const name = m.model_name || m.model || "";
            const interval = parseMinimaxWindow(
              m.current_interval_total_count,
              m.current_interval_usage_count,
              m.current_interval_remaining_percent,
              m.current_interval_status
            );
            const weekly = parseMinimaxWindow(
              m.current_weekly_total_count,
              m.current_weekly_usage_count,
              m.current_weekly_remaining_percent,
              m.current_weekly_status
            );
            return {
              modelName: name,
              interval: {
                ...interval,
                endTime: m.current_interval_end_time || m.end_time || null,
                remainsMs: m.remains_time || null,
              },
              weekly: {
                ...weekly,
                endTime: m.current_weekly_end_time || m.weekly_end_time || null,
                remainsMs: m.weekly_remains_time || null,
              }
            };
          });
          resolve({ type: "token-plan", plan, models });
        } catch (e) {
          resolve({ type: "error", display: "解析失败" });
        }
      });
    });
    req.on("error", () => resolve({ type: "error", display: "网络错误" }));
    req.setTimeout(3500, () => { req.destroy(); resolve({ type: "error", display: "超时" }); });
  });
}

// ── Sensenova IAM 登录 + OAuth2 令牌获取/刷新 ──
// 官网账号密码登录（IAM + OAuth2 PKCE），access_token 有效期约 3 小时，refresh_token 可续期。
// balance-apis.json 中 sensenova 配置：username + password + accountId + modelIds，查询时自动登录/刷新。
const SENSENOVA_IAM = "https://iam.sensecoreapi.cn";
const SENSENOVA_PLATFORM = "https://platform.sensenova.cn";
const SENSENOVA_CLIENT_ID = "nova";
const SENSENOVA_REDIRECT = "https://platform.sensenova.cn";

function sensenovaPkce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let verifier = "";
  for (let i = 0; i < 64; i++) verifier += chars[Math.floor(Math.random() * chars.length)];
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// 简易 Cookie Jar（OAuth2 流程需要跨请求携带会话 cookie）
function makeCookieJar() {
  const cookies = {};
  return {
    set(resp) {
      const sc = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
      for (const c of sc) {
        const parts = String(c).split(";");
        const eq = parts[0].indexOf("=");
        if (eq < 0) continue;
        cookies[parts[0].slice(0, eq).trim()] = parts[0].slice(eq + 1).trim();
      }
    },
    header() {
      const parts = Object.entries(cookies).map(([k, v]) => k + "=" + v);
      return parts.length ? parts.join("; ") : "";
    }
  };
}

async function sensenovaFetch(url, jar, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const c = jar.header();
  if (c) headers["Cookie"] = c;
  const resp = await fetch(url, { redirect: "manual", headers, ...opts });
  jar.set(resp);
  return resp;
}

// 完整登录：OAuth2 auth → IAM 登录 → 授权 code → 交换 token
async function sensenovaLogin(username, password) {
  const jar = makeCookieJar();
  const p = sensenovaPkce();

  const authUrl = `${SENSENOVA_PLATFORM}/oauth2/auth?client_id=${SENSENOVA_CLIENT_ID}&response_type=code&code_challenge=${p.challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(SENSENOVA_REDIRECT)}&scope=openid+offline+offline_access&state=12345678`;
  let resp = await sensenovaFetch(authUrl, jar);
  let loc = resp.headers.get("location") || "";
  const m = loc.match(/login_challenge=([a-f0-9]+)/);
  if (!m) throw new Error("无法获取登录挑战");

  resp = await sensenovaFetch(`${SENSENOVA_IAM}/iam/authn/v1/auth/nova/login`, jar, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, challenge: m[1], is_encrypt: false })
  });
  const loginData = await resp.json();
  if (loginData.access_token) return loginData;
  if (!loginData.redirect) {
    const msg = loginData.message || loginData.code || JSON.stringify(loginData);
    throw new Error("登录失败: " + msg);
  }

  let cur = loginData.redirect;
  let code = null;
  for (let i = 0; i < 8 && !code; i++) {
    resp = await sensenovaFetch(cur, jar);
    loc = resp.headers.get("location") || "";
    const cm = loc.match(/[?&]code=([^&\s]+)/);
    if (cm) { code = cm[1]; break; }
    if (resp.status === 200) {
      const body = await resp.text();
      const bm = body.match(/[?&]code=([^&"'\s]+)/);
      if (bm) { code = bm[1]; break; }
      break;
    }
    if (!loc) break;
    cur = loc.startsWith("http") ? loc : new URL(loc, cur).href;
  }
  if (!code) throw new Error("未获取到授权码");

  resp = await sensenovaFetch(`${SENSENOVA_PLATFORM}/oauth2/token`, jar, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(SENSENOVA_REDIRECT)}&client_id=${SENSENOVA_CLIENT_ID}&code_verifier=${p.verifier}`
  });
  const token = await resp.json();
  if (token.error) throw new Error("令牌交换失败: " + (token.error_description || token.error));
  return token;
}

// 用 refresh_token 续期 access_token
async function sensenovaRefresh(refreshToken) {
  const jar = makeCookieJar();
  const resp = await sensenovaFetch(`${SENSENOVA_PLATFORM}/oauth2/token`, jar, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${SENSENOVA_CLIENT_ID}`
  });
  const data = await resp.json();
  if (data.error) throw new Error("刷新令牌失败");
  return data;
}

// 从 access_token 提取 account_id（tenant_id）
function sensenovaAccountIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString());
    return payload.ext?.tenant_id || payload.ext?.principal_id || "";
  } catch { return ""; }
}

// 从 access_token 解析过期时间（秒）
function sensenovaTokenExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : 0;
  } catch { return 0; }
}

// 获取有效 access_token：优先 refresh，其次重登；并持久化回 balance-apis.json
async function sensenovaEnsureToken(dataDir, apiConfig) {
  const now = Date.now();
  let changed = false;
  // 1) 现有 access_token 未过期直接用
  if (apiConfig.token && sensenovaTokenExp(apiConfig.token) > now + 60000) {
    return { token: apiConfig.token, refreshToken: apiConfig.refreshToken };
  }
  // 2) 用 refresh_token 续期
  if (apiConfig.refreshToken) {
    try {
      const d = await sensenovaRefresh(apiConfig.refreshToken);
      if (d.access_token) {
        apiConfig.token = d.access_token;
        if (d.refresh_token) apiConfig.refreshToken = d.refresh_token;
        changed = true;
        return { token: apiConfig.token, refreshToken: apiConfig.refreshToken };
      }
    } catch {}
  }
  // 3) 账号密码重新登录
  if (apiConfig.username && apiConfig.password) {
    const d = await sensenovaLogin(apiConfig.username, apiConfig.password);
    if (d.access_token) {
      apiConfig.token = d.access_token;
      if (d.refresh_token) apiConfig.refreshToken = d.refresh_token;
      if (!apiConfig.accountId) apiConfig.accountId = sensenovaAccountIdFromToken(d.access_token);
      changed = true;
      return { token: apiConfig.token, refreshToken: apiConfig.refreshToken };
    }
  }
  throw new Error("未配置账号密码，无法获取令牌");
}

// ── Sensenova TokenPlan 积分池查询（2026-08-28 新积分规则：通用池 + Flash-Lite 专属池）──
// 接口：GET /lite/console/v1/tokenplan/pool-usage，Bearer OAuth2 access_token（与 IAM 登录共用同一令牌）。
// 响应：{ plan, pools: [{ id, name, model_ids, pool_type: "default"|"dedicated",
//   window_5h: {limit, used, remaining, reset_at}, window_7d: {...},
//   grant_balance, nearest_grant_expiry, nearest_grant_expiring_balance }] }
// 注意：数值字段全部为字符串，reset_at / expiry 为 Unix 秒。
function tpNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function tpParseWindow(w) {
  if (!w) return null;
  return { limit: tpNum(w.limit), used: tpNum(w.used), remaining: tpNum(w.remaining), resetAt: tpNum(w.reset_at) * 1000 };
}
async function fetchSensenovaTokenPlanPools(dataDir, apiConfig) {
  try {
    const { token } = await sensenovaEnsureToken(dataDir, apiConfig);
    const resp = await fetch(`${SENSENOVA_PLATFORM}/lite/console/v1/tokenplan/pool-usage`, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" }
    });
    if (!resp.ok) return { type: "error", display: "HTTP " + resp.status };
    const data = await resp.json();
    const raw = Array.isArray(data.pools) ? data.pools : [];
    if (!raw.length) return { type: "error", display: "响应无积分池" };
    return {
      type: "tokenplan-points",
      plan: (data.plan && (data.plan.name || data.plan.id)) || "",
      pools: raw.map(p => ({
        name: p.name || "积分池",
        poolType: p.pool_type || "default",
        modelIds: Array.isArray(p.model_ids) ? p.model_ids : [],
        win5h: tpParseWindow(p.window_5h),
        win7d: tpParseWindow(p.window_7d),
        grantBalance: tpNum(p.grant_balance),
        grantExpiry: tpNum(p.nearest_grant_expiry) * 1000
      }))
    };
  } catch (e) {
    return { type: "error", display: e.message || "查询失败" };
  }
}

// 查询 Sensenova 订阅余量（自动登录/刷新）
async function fetchSensenovaQuota(dataDir, apiConfig) {
  try {
    const { token } = await sensenovaEnsureToken(dataDir, apiConfig);
    const accountId = apiConfig.accountId || sensenovaAccountIdFromToken(token);
    if (!accountId) return { type: "error", display: "无法获取账号 ID" };
    const modelIds = (apiConfig.modelIds && apiConfig.modelIds.length) ? apiConfig.modelIds : ["sensenova-6.7-flash-lite", "sensenova-u1-fast", "deepseek-v4-flash"];
    let url = `${SENSENOVA_PLATFORM}/lite/console/v1/user/coding-plan/usages?account_id=${encodeURIComponent(accountId)}`;
    for (const mid of modelIds) url += `&model_ids=${encodeURIComponent(mid)}`;
    const resp = await fetch(url, { headers: { "Authorization": "Bearer " + token, "Accept": "application/json" } });
    const data = await resp.json();
    const models = parsePerModelQuota(data);
    if (models && models.length) {
      const totalUsed = models.reduce((s, m) => s + (m.used || 0), 0);
      const totalLimit = models.reduce((s, m) => s + (m.limit || 0), 0);
      return { models, totalUsed, totalLimit, type: "quota" };
    }
    return { type: "error", display: "响应解析失败" };
  } catch (e) {
    return { type: "error", display: e.message || "查询失败" };
  }
}

// 判断入参 access_token 是否比已存的更新：以 JWT 的 exp 比较；
// 同值不覆盖；任一侧解析不出过期时间时不覆盖（宁可保守，也不让旧副本写回）。
function sensenovaTokenIsNewer(savedToken, incomingToken) {
  if (!incomingToken) return false;
  if (!savedToken) return true;
  if (savedToken === incomingToken) return false;
  const se = sensenovaTokenExp(savedToken);
  const ie = sensenovaTokenExp(incomingToken);
  if (se && ie) return ie > se;
  return false;
}

// 持久化 sensenova 令牌回 balance-apis.json（登录/刷新后更新，避免每次都走 OAuth2）。
// 原子写 + 串行化：多个余额查询可能同时登录/刷新，若各自 read-modify-write 会互相覆盖。
// 用一个进程内写入队列把「读最新文件 → 合并 → 原子替换」整体串起来，后一次基于前一次的结果，
// 且只有确实更新的令牌才会写回——旧调用方副本不能覆盖新令牌（按 exp 选新），任一次失败也不
// 会破坏旧文件（读不出旧文件就放弃写入，写走 tmp + rename）。
let sensenovaTokenWriteQueue = Promise.resolve();

function persistSensenovaToken(dataDir, apiConfig) {
  const run = () => {
    const p = path.join(dataDir, "balance-apis.json");
    let saved;
    if (fs.existsSync(p)) {
      // 读不出来就放弃这次写入，绝不覆盖一份读不懂的旧文件。
      saved = JSON.parse(readTextFile(p));
      if (!saved || typeof saved !== "object") throw new Error("balance-apis.json 内容不是对象");
    } else {
      saved = {};
    }
    if (!saved.sensenova || typeof saved.sensenova !== "object") saved.sensenova = {};
    let changed = false;
    // 只在入参令牌确实比已存的“新”时才覆盖 token。
    const acceptToken = sensenovaTokenIsNewer(saved.sensenova.token, apiConfig.token);
    if (acceptToken) { saved.sensenova.token = apiConfig.token; changed = true; }
    // refresh_token 只在本次确实接受了新 token、或原本没有时写入，
    // 避免一次较旧的登录把新登录轮换出来的刷新令牌覆盖回去。
    if (apiConfig.refreshToken && apiConfig.refreshToken !== saved.sensenova.refreshToken
      && (acceptToken || !saved.sensenova.refreshToken)) {
      saved.sensenova.refreshToken = apiConfig.refreshToken;
      changed = true;
    }
    if (!changed) return false;
    writeFileAtomic(p, JSON.stringify(saved, null, 2));
    return true;
  };
  const next = sensenovaTokenWriteQueue.then(run, run);
  // 队列不能因为一次失败而卡死后续写入（失败由调用方的 .catch 处理）。
  sensenovaTokenWriteQueue = next.catch(() => {});
  return next;
}

// ── 订阅余量查询（Sensenova 等 per-model-quota 类型） ──
async function fetchSubscriptionQuota(apiConfig) {
  const url = new URL(apiConfig.url);
  // 如果配置字段为空，保留 URL 上已有的查询参数
  if (apiConfig.accountId) url.searchParams.set("account_id", apiConfig.accountId);
  if (apiConfig.modelIds && apiConfig.modelIds.length) {
    // 清除 URL 中原有的 model_ids 参数，用配置的替换
    url.searchParams.delete("model_ids");
    for (const mid of apiConfig.modelIds) {
      url.searchParams.append("model_ids", mid);
    }
  }

  const headers = { "Accept": "application/json" };
  if (apiConfig.authType === "bearer-token") {
    headers["Authorization"] = "Bearer " + apiConfig.token;
  } else if (apiConfig.authType === "cookie") {
    headers["Cookie"] = "oauth2_authentication_session=" + apiConfig.token;
  }

  return new Promise((resolve) => {
    const req = https.get(url.toString(), { headers }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          const models = parsePerModelQuota(d);
          if (models && models.length) {
            const totalUsed = models.reduce((s, m) => s + (m.used || 0), 0);
            const totalLimit = models.reduce((s, m) => s + (m.limit || 0), 0);
            resolve({ models, totalUsed, totalLimit });
          } else resolve(null);
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

function parsePerModelQuota(data) {
  if (!data || typeof data !== "object") return null;
  let items = null;
  // 尝试多种常见响应结构
  if (data.data && Array.isArray(data.data)) items = data.data;
  else if (data.usages && Array.isArray(data.usages)) items = data.usages;
  else if (Array.isArray(data.data?.usages)) items = data.data.usages;
  else if (Array.isArray(data.data?.list)) items = data.data.list;
  else if (Array.isArray(data.list)) items = data.list;
  // Sensenova 格式：{ "model_remaining_percent": { "model_id": 75.4, ... } }
  else if (data.model_remaining_percent && typeof data.model_remaining_percent === "object") {
    return Object.entries(data.model_remaining_percent).map(([modelId, pct]) => {
      const remainPct = parseFloat(pct) || 0;
      const usedPct = +(100 - remainPct).toFixed(1);
      // 不知道总限额，显示百分比
      return {
        modelId,
        used: usedPct,
        limit: 100,
        remain: remainPct,
        pct: usedPct,
        display: "剩余 " + remainPct.toFixed(1) + "%",
        _isPercent: true
      };
    }).filter(Boolean);
  }
  // 兜底：找第一个数组字段
  if (!items) {
    for (const k of Object.keys(data)) {
      if (Array.isArray(data[k]) && data[k].length > 0 && data[k][0].model_id !== undefined) {
        items = data[k]; break;
      }
    }
  }
  if (!items) return null;

  return items.map(item => {
    const modelId = item.model_id || item.modelId || item.model || item.id || "";
    const used = parseInt(item.used || item.used_calls || item.consumed || item.usage || item.usedTokens || 0, 10);
    const limit = parseInt(item.limit || item.total || item.total_calls || item.quota || item.limit_calls || item.maxCalls || 0, 10);
    const remain = parseInt(item.remaining || item.remaining_calls || (limit - used), 10);
    if (!modelId || !limit) return null;
    const pct = limit > 0 ? ((used / limit) * 100).toFixed(1) : "0";
    return { modelId, used, limit, remain, pct, display: remain + "/" + limit };
  }).filter(Boolean);
}

// ── 火山方舟 V4 签名 + Coding Plan 用量查询 ──
function signVolcengineV4(ak, sk, region, service, host, method, path, queryString, body) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const shortDate = xDate.slice(0, 8);
  const bodyHash = crypto.createHash("sha256").update(body || "").digest("hex");
  const credentialScope = shortDate + "/" + region + "/" + service + "/request";
  const canonicalHeaders = "host:" + host + "\nx-content-sha256:" + bodyHash + "\nx-date:" + xDate + "\n";
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalRequest = [method, path, queryString, canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const kDate = crypto.createHmac("sha256", sk).update(shortDate).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("request").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = "HMAC-SHA256 Credential=" + ak + "/" + credentialScope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  return { authorization, xDate, bodyHash };
}

async function fetchVolcengineCodingPlan(apiConfig) {
  const ak = apiConfig.ak || "";
  const sk = apiConfig.sk || "";
  const region = apiConfig.region || "cn-beijing";
  if (!ak || !sk) return { type: "error", display: "未配置 AK/SK" };
  const host = "open.volcengineapi.com";
  const qs = "Action=GetCodingPlanUsage&Version=2024-01-01";
  const sig = signVolcengineV4(ak, sk, region, "ark", host, "GET", "/", qs, "");
  return new Promise((resolve) => {
    const req = https.get({
      hostname: host,
      path: "/?" + qs,
      headers: { Authorization: sig.authorization, "X-Date": sig.xDate, "X-Content-Sha256": sig.bodyHash, Host: host }
    }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          if (d.ResponseMetadata?.Error) {
            resolve({ type: "error", display: d.ResponseMetadata.Error.Message || "查询失败" });
            return;
          }
          const result = d.Result;
          if (!result || !Array.isArray(result.QuotaUsage)) {
            resolve({ type: "error", display: "响应格式异常" });
            return;
          }
          const windows = result.QuotaUsage.map(q => ({
            level: q.Level,
            usedPercent: +parseFloat(q.Percent).toFixed(2),
            remainPercent: +(100 - parseFloat(q.Percent)).toFixed(2),
            resetAt: q.ResetTimestamp
          }));
          resolve({
            type: "coding-plan-quota",
            status: result.Status || "Unknown",
            updateTimestamp: result.UpdateTimestamp || null,
            windows
          });
        } catch (e) {
          resolve({ type: "error", display: "解析失败" });
        }
      });
    });
    req.on("error", () => resolve({ type: "error", display: "网络错误" }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ type: "error", display: "超时" }); });
  });
}

// ══════════ 以下为统一适配层（P0-1 新增，HTTP /dashboard/balance 与 bus handler 共用） ══════════

// API key 解析：优先 added-models.yaml，其次 provider-catalog.json（解析方式与 /dashboard/data 保持一致）
export function resolveApiKeys(homeDir = HOME) {
  const yamlKeys = {};
  try {
    const yamlPath = path.join(homeDir, "added-models.yaml");
    if (fs.existsSync(yamlPath)) {
      const yaml = readTextFile(yamlPath) + "\n";
      const provMatches = [...yaml.matchAll(/^  (\S+):\s*\n((?:    .+\n)*)/gm)];
      for (const pm of provMatches) {
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
  const catalogKeys = {};
  try {
    const catalogPath = path.join(homeDir, "provider-catalog.json");
    if (fs.existsSync(catalogPath)) {
      const cat = JSON.parse(readTextFile(catalogPath));
      if (cat.providers) for (const [pid, pd] of Object.entries(cat.providers)) { if (pd.api_key) catalogKeys[pid] = pd.api_key; }
    }
  } catch {}
  const merged = { ...catalogKeys };
  for (const [k, v] of Object.entries(yamlKeys)) { if (v) merged[k] = v; } // yaml 优先
  return { yaml: yamlKeys, catalog: catalogKeys, merged };
}

// 外部查询器注册（responseType → fn）。routes/dashboard.js 用它注入 OpenCode Go 指标抓取，
// 避免把 op 的页面解析/估算/同步链路重写进本模块。
const BALANCE_FETCHERS = new Map();
export function registerBalanceFetcher(responseType, fn) {
  if (typeof fn === "function") BALANCE_FETCHERS.set(responseType, fn);
}

const PROVIDER_LABELS = {
  deepseek: "DeepSeek",
  glm: "GLM",
  moonshot: "Moonshot",
  minimax: "MiniMax",
  "minimax-token-plan": "MiniMax",
  sensenova: "商汤",
  "sensenova-iam": "商汤",
  "volcengine-coding": "火山方舟",
  "opencode-go": "OpenCode Go"
};

// 按统一契约归一化一条 provider 结果（原始字段原样透传，契约字段覆盖在最后）
function normalizeEntry(provider, label, raw, now) {
  const t = typeof now === "function" ? now() : Date.now();
  const base = {
    provider,
    label,
    status: "ok",
    type: "quota",
    display: "—",
    used: null,
    limit: null,
    remain: null,
    updatedAt: t,
    error: null,
    ...(raw && typeof raw === "object" ? raw : {}),
    rawType: raw?.type || null,
    provider, label, status: "ok", providerStatus: raw?.status || null, updatedAt: t
  };
  if (!raw) return { ...base, status: "error", display: "查询失败", error: "查询失败" };
  if (raw.status === "error") return { ...base, status: "error", type: "quota", display: raw.display || "查询失败", error: raw.display || "查询失败" };
  switch (raw.type) {
    case "error":
      return { ...base, status: "error", type: "quota", display: raw.display || "查询失败", error: raw.display || "查询失败" };
    case "money":
      return { ...base, type: "currency", display: raw.display || "—", amount: raw.total, remain: raw.total, currency: raw.currency };
    case "no-token":
    case "no-key":
      return { ...base, status: "error", type: "quota", display: raw.display || "未配置", error: raw.display || "未配置" };
    case "quota": {
      const used = typeof raw.used === "number" ? raw.used : (raw.totalUsed != null ? raw.totalUsed : null);
      const limit = typeof raw.limit === "number" ? raw.limit : (raw.totalLimit != null ? raw.totalLimit : (used != null ? 100 : null));
      const remain = typeof raw.remain === "number" ? raw.remain : ((used != null && limit != null) ? Math.max(0, limit - used) : null);
      return { ...base, type: "quota", used, limit, remain, display: raw.display || (remain != null && limit != null ? remain + "/" + limit : "—") };
    }
    case "token-plan": {
      // MiniMax：汇总 5h 窗口（models[].interval），plan/model 明细透传
      const models = Array.isArray(raw.models) ? raw.models : [];
      let used = 0, limit = 0, remain = 0;
      for (const m of models) {
        const iv = m.interval || {};
        used += Number(iv.used) || 0;
        limit += Number(iv.total) || 0;
        remain += Number(iv.remain) || 0;
      }
      return { ...base, type: "subscription", used, limit, remain, display: raw.plan || raw.display || "token plan" };
    }
    case "tokenplan-points": {
      // 商汤 TokenPlan：汇总通用池 + 专属池的 5h 窗口，pools 明细透传
      const pools = Array.isArray(raw.pools) ? raw.pools : [];
      let used = 0, limit = 0, remain = 0;
      for (const p of pools) {
        const w = p.win5h || {};
        used += w.used || 0;
        limit += w.limit || 0;
        remain += Number(w.remaining ?? w.remain) || 0;
      }
      return { ...base, type: "subscription", used, limit, remain, display: raw.plan || "TokenPlan" };
    }
    case "coding-plan-quota": {
      // 火山方舟：取第一个窗口的百分比，windows 明细透传
      const w = Array.isArray(raw.windows) && raw.windows[0] ? raw.windows[0] : {};
      const used = typeof w.usedPercent === "number" ? w.usedPercent : null;
      const remain = typeof w.remainPercent === "number" ? w.remainPercent : (used != null ? Math.max(0, 100 - used) : null);
      return { ...base, type: "subscription", used, limit: used != null ? 100 : null, remain, display: raw.display || (used != null ? "已用 " + used.toFixed(1) + "%" : "查询失败") };
    }
    case "opencode-go-quota":
    case "opencode-go-quota-est": {
      const wins = Array.isArray(raw.windows) ? raw.windows : [];
      const m = wins.find(x => x.level === "monthly") || wins[0] || {};
      if (raw.est && typeof m.usedUsd === "number") {
        const limit = typeof m.limitUsd === "number" ? m.limitUsd : null;
        return { ...base, type: "subscription", used: m.usedUsd, limit, remain: limit != null ? Math.max(0, limit - m.usedUsd) : null, display: "$" + (+m.usedUsd.toFixed(2)) + (limit != null ? " / $" + limit : "") };
      }
      const used = typeof m.usedPercent === "number" ? m.usedPercent : null;
      return { ...base, type: "subscription", used, limit: used != null ? 100 : null, remain: used != null ? Math.max(0, 100 - used) : null, display: used != null ? "已用 " + used.toFixed(0) + "%" : "查询失败" };
    }
    default:
      // 未知类型：原样透传，display 兜底
      return { ...base, type: "quota", status: "error", display: raw.display || "无法识别的余额响应", error: "无法识别的余额响应" };
  }
}

function entryError(provider, label, msg, now) {
  return {
    provider,
    label,
    status: "error",
    type: "quota",
    display: msg,
    used: null,
    limit: null,
    remain: null,
    updatedAt: typeof now === "function" ? now() : Date.now(),
    error: msg
  };
}

async function withTimeout(p, ms) {
  let timer;
  try { return await Promise.race([p, new Promise(r => { timer = setTimeout(() => r(null), ms); })]); }
  finally { clearTimeout(timer); }
}

// 统一入口：HTTP /dashboard/balance 与 bus handler(token-tracker.balance) 共用。
// opts:
//   dataDir  插件数据目录（读 balance-apis.json）
//   homeDir  宿主目录（读 added-models.yaml / provider-catalog.json），缺省 ~/.hanako
//   now      时间函数（测试注入）
//   fetchers { [providerId]: async (apiConf, key) => raw } 测试注入，命中则不打真网
//   apis     balance-apis 配置覆盖（测试注入）
//   keys     API key 映射覆盖（测试注入）
export async function collectBalances(opts = {}) {
  const dataDir = opts.dataDir || "";
  const homeDir = opts.homeDir || HOME;
  const now = opts.now || (() => Date.now());
  const hooks = opts.fetchers || null;
  const apis = opts.apis || loadBalanceApis(dataDir);
  const keys = opts.keys || resolveApiKeys(homeDir).merged;

  const targets = [];
  // 1) 显式注册：DeepSeek / GLM（key：added-models.yaml > provider-catalog.json）
  for (const id of ["deepseek", "glm"]) {
    const conf = apis[id] || {};
    if (conf && conf.enabled === false) continue;
    targets.push({ id, label: PROVIDER_LABELS[id] || id, conf, key: keys[id] || "" });
  }
  // 2) balance-apis.json 配置分支：MiniMax token-plan / 商汤 / 方舟 / OpenCode Go / 通用 URL
  for (const [provId, conf] of Object.entries(apis)) {
    if (provId === "deepseek" || provId === "glm") continue;
    if (!conf || typeof conf !== "object" || conf.enabled === false) continue;
    const label = conf.label || PROVIDER_LABELS[provId] || provId;
    const rt = conf.responseType;
    if (rt === "token-plan" || rt === "sensenova-iam" || rt === "volcengine-coding-plan" || rt === "opencode-go") {
      // 只查已配置的：显式 enabled === true，或带 key 的 token-plan；
      // 否则（如默认配置里无 key 的 minimax-token-plan）不出噪声 error 条目
      const explicit = conf.enabled === true;
      if (!explicit && !(rt === "token-plan" && keys[provId])) continue;
      targets.push({ id: provId, label, conf, key: keys[provId] || "" });
    } else if (conf.url) {
      const k = keys[provId];
      if (k) targets.push({ id: provId, label, conf, key: k });
    }
  }

  async function runTarget(t) {
    // 测试注入：直接替换整条查询，不打真网
    if (hooks && typeof hooks[t.id] === "function") {
      try {
        return normalizeEntry(t.id, t.label, await hooks[t.id](t.conf, t.key), now);
      } catch (e) {
        return entryError(t.id, t.label, e?.message || "查询失败", now);
      }
    }
    const rt = t.conf?.responseType;
    try {
      if (rt === "token-plan") {
        if (!t.key) return entryError(t.id, t.label, "无 API Key", now);
        const raw = await withTimeout(fetchMinimaxTokenPlan(t.conf, t.key), 4000);
        return normalizeEntry(t.id, t.label, raw, now);
      }
      if (rt === "sensenova-iam") {
        const hasCreds = t.conf.token || t.conf.refreshToken || (t.conf.username && t.conf.password);
        if (!hasCreds) return entryError(t.id, t.label, "未配置账号密码", now);
        let raw = await withTimeout(fetchSensenovaTokenPlanPools(dataDir, t.conf), 15000);
        if (!raw || raw.type === "error") {
          // 回退：旧 coding-plan 按模型额度（未开 TokenPlan 的账号）
          const q = await withTimeout(fetchSensenovaQuota(dataDir, t.conf), 15000);
          if (q && q.models) raw = q;
        }
        if (t.conf.token || t.conf.refreshToken) persistSensenovaToken(dataDir, t.conf).catch(() => {});
        return normalizeEntry(t.id, t.label, raw, now);
      }
      if (rt === "volcengine-coding-plan") {
        if (!t.conf.ak || !t.conf.sk) return entryError(t.id, t.label, "未配置 AK/SK", now);
        const raw = await withTimeout(fetchVolcengineCodingPlan(t.conf), 5500);
        return normalizeEntry(t.id, t.label, raw, now);
      }
      if (rt === "opencode-go") {
        if (!t.conf.workspaceId || !t.conf.cookie) return entryError(t.id, t.label, "未配置 workspace/cookie", now);
        const fn = BALANCE_FETCHERS.get("opencode-go");
        if (typeof fn !== "function") return entryError(t.id, t.label, "OpenCode Go 查询器未注册", now);
        const raw = await withTimeout(fn(t.conf), 12000);
        return normalizeEntry(t.id, t.label, raw, now);
      }
      // 通用货币/配额查询（DeepSeek/GLM/Moonshot 等，自动格式判断）
      if (!t.conf.url) return entryError(t.id, t.label, "未配置 URL", now);
      if (!t.key) return entryError(t.id, t.label, "无 API Key", now);
      const raw = await withTimeout(fetchBalance(t.conf, t.key), 4000);
      return normalizeEntry(t.id, t.label, raw, now);
    } catch (e) {
      return entryError(t.id, t.label, e?.message || "查询失败", now);
    }
  }

  const balances = await Promise.all(targets.map(runTarget));
  return { balances, updatedAt: now() };
}

export {
  DEFAULT_BALANCE_APIS,
  loadBalanceApis,
  fetchBalance,
  parseMinimaxWindow,
  fetchMinimaxTokenPlan,
  fetchSensenovaTokenPlanPools,
  fetchSensenovaQuota,
  persistSensenovaToken,
  fetchSubscriptionQuota,
  signVolcengineV4,
  fetchVolcengineCodingPlan,
  parsePerModelQuota,
};
