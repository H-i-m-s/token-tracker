// Shape raw v1 bus responses into the UI view model.
// Keeps UI layers free of provider-specific field names.

export function modelName(m) {
  if (!m) return "—";
  return String(m)
    .replace(/deepseek/gi, "DS")
    .replace(/^([a-z])/, (_, c) => c.toUpperCase());
}

export function providerAlias(p) {
  const map = {
    deepseek: "DeepSeek",
    glm: "GLM",
    minimax: "MiniMax",
    sensenova: "商汤",
    volcengine: "火山方舟",
    "opencode-go": "OpenCode Go",
  };
  return map[p] || String(p || "—");
}

export function pickBarColor(percent) {
  const p = Number(percent) || 0;
  if (p >= 75) return "var(--tt-red)";
  if (p >= 50) return "var(--tt-orange)";
  return "var(--tt-green)";
}

export function shapeBalance(item) {
  const used = Number(item.used) || 0;
  const limit = Number(item.limit) || 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const remainPct = limit > 0 ? Math.min(100, Math.max(0, 100 - pct)) : 0;
  return {
    provider: item.provider || providerAlias(item.type),
    type: item.type,
    status: item.status,
    display: item.display || "—",
    used,
    limit,
    remain: item.remain != null && Number.isFinite(Number(item.remain)) ? Number(item.remain) : (item.limit != null && item.used != null ? limit - used : null),
    usedPercent: pct,
    remainPercent: remainPct,
    barColor: pickBarColor(pct),
    updatedAt: item.updatedAt || null,
    error: item.error || null,
  };
}

export function shapeBalances(data) {
  const list = Array.isArray(data) ? data : data?.balances || [];
  return list.map(shapeBalance);
}

export function shapeRealtime(realtime) {
  if (!realtime) {
    return { connected: false, tps: 0, ttft: 0, contextPercent: 0, model: "—", agentName: "—" };
  }
  return {
    connected: !!realtime.agentId,
    tps: realtime.lastTps || realtime.avgTps || 0,
    avgTps: realtime.avgTps || 0,
    // 首字响应时间：实时测出来的最近一次（钩子侧写入，重启后重新开始）
    ttft: realtime.lastTtft || 0,
    avgTtft: realtime.avgTtft || 0,
    contextPercent: parseFloat(realtime.contextPercent) || 0,
    contextTokens: realtime.contextTokens || 0,
    contextWindow: realtime.contextWindow || 0,
    model: modelName(realtime.model),
    rawModel: realtime.model || "",
    agentName: realtime.agentName || realtime.agentId || "—",
    agentId: realtime.agentId || "",
    lastTotalTokens: realtime.lastTotalTokens || 0,
    lastCost: realtime.lastCost || 0,
    updatedAt: realtime.updatedAt || null,
  };
}

export function shapeSnapshot(raw) {
  const balances = shapeBalances(raw?.balances || []);
  const realtime = shapeRealtime(raw?.realtime);
  return {
    realtime,
    balances,
    agentNames: raw?.agentNames || {},
    updatedAt: raw?.updatedAt || raw?.lastScan || null,
    // 缓存落盘统计（第 0 步可观测性）：写入次数、字节、上次原因与耗时、今日累计
    persist: raw?.persist || null,
    // 数字单位原样过桥（前几层都不解释它，只有页面自己拿它决定万/亿还是 K/M/B）。
    display: raw?.display || null,
    ready: raw?.ready !== false,
  };
}

export function shapeDashboard(raw) {
  if (raw?.error) throw new Error(raw.error?.message || raw.error);
  // 明细行不在这一层展开：引擎发上来的是「列名 + 数组行」，展开成对象会让载荷在
  // 引擎→插件→卡片两跳里都胖回去（宿主对托管服务的响应有 4 MiB 硬顶）。
  // 解回对象由前端 decodeRows 做（ui/details-view.mjs），那里只解一次。
  // 兼容两种形状：引擎给数组行，mock 数据给对象行。
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];
  const summary = raw?.summary || {};
  const agents = (raw?.agents || []).map(a => ({ ...a, name: raw?.agentNames?.[a.id] || a.name || a.id }));
  return {
    summary: {
      // 引擎一定给 summary.totalTokens，不给就从行里现算 —— 行现在是数组，那种兜底算不出东西。
      totalTokens: summary.totalTokens ?? 0,
      inputTokens: summary.inputTokens ?? summary.totalInput ?? 0,
      outputTokens: summary.outputTokens ?? summary.totalOutput ?? 0,
      cacheHitRate: summary.cacheHitRate ?? 0,
      estimatedCost: summary.estimatedCost ?? 0,
      // estimatedCost 的币种：人民币。
      //
      // 这个字段以前写的是 "USD"（价格表存美元时代）。改基准而不改它，
      // 界面会拿 $ 去标一个人民币值 —— 6.7 倍的错，而且看上去完全正常。
      // 它必须跟着价格表的基准币种走，不是跟着「用户选了什么显示币种」走。
      currency: "cny",
      // 汇率现在的用途反过来了：不再是「把美元换算成目标币种」，
      // 而是「人民币金额想看折合多少美元」时才用。没有它不影响任何金额计算。
      fxRate: Number(summary.fxRate) > 0 ? Number(summary.fxRate) : null,
      agentCount: summary.agentCount ?? agents.length,
      assistantCount: summary.totalAssistant ?? null,
      cacheRead: summary.totalCacheRead ?? null,
      highUsageThreshold: summary.highUsageThreshold ?? 30000,
      // 顶部合计与明细表合计的差额（几乎全是账本用量：没有会话文件，进不了明细表）。
      // 界面靠它把「另有 X 未列入明细」写出来，而不是让两个对不上的总数默默并存。
      excludedTokens: summary.excludedTokens ?? 0,
      excludedLedgerTokens: summary.excludedLedgerTokens ?? 0,
    },
    analytics: raw?.analytics || null,
    updatedAt: raw?.lastScan || null,
    // rowCols 必须跟着行一起过桥：前端靠它把数组行解回对象，丢了列名就只剩一堆数。
    // details 是服务端分页的那一块（引擎新路）：原样过桥，不展开也不丢 rowCols。
    // mock 数据没有服务端分页，details 缺省为 null，前端继续用它本地那套算。
    rows, rowCols: Array.isArray(raw?.rowCols) ? raw.rowCols : null,
    details: raw?.details ?? null,
    agents, daily: raw?.daily || [], hourly: raw?.hourly || [],
    models: [...new Set((raw?.models || []).map(m => typeof m === 'string' ? m : m.id).filter(Boolean))],
    providers: [...new Set((raw?.providers || []).map(p => typeof p === 'string' ? p : p.provider || p.id).filter(Boolean))],
    // 下拉选项的源：上面的 models / agents 都是“按当前筛选算出来的结果集”，选中一个后里面就只剩它自己，
    // 拿来当下拉源会自我坍缩（选完就换不了别的）。这两个字段是后端特意给下拉准备的、
    // 不受模型筛选影响（modelOptions 取的是模型筛选之前的 sessionPool，agentNames 是宿主 agent 名册），
    // 之前在这里被过滤掉，补上。
    modelOptions: [...new Set((raw?.modelOptions || []).map(m => typeof m === 'string' ? m : m.id).filter(Boolean))],
    agentNames: raw?.agentNames || {},
    rowCount: rows.length,
  };
}

export { rankAgents } from "../ui/components.mjs";
