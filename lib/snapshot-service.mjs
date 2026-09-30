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
    ready: raw?.ready !== false,
  };
}

export function shapeDashboard(raw) {
  if (raw?.error) throw new Error(raw.error?.message || raw.error);
  const number = (v) => v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  const rows = (raw?.rows || raw?.stream || []).map((r) => ({
    time: r.time || r.createdAt || null,
    agent: r.agent || r.agentId || "—",
    agentName: raw?.agentNames?.[r.agent || r.agentId] || r.agentName || r.agent || "—",
    provider: r.provider || "—",
    model: r.model || "—",
    totalTokens: number(r.totalTokens) ?? 0,
    inputTokens: number(r.inputTokens ?? r.input),
    outputTokens: number(r.outputTokens ?? r.output),
    cost: number(r.cost),
  }));
  const summary = raw?.summary || {};
  const agents = (raw?.agents || []).map(a => ({ ...a, name: raw?.agentNames?.[a.id] || a.name || a.id }));
  return {
    summary: {
      totalTokens: summary.totalTokens ?? rows.reduce((s, r) => s + r.totalTokens, 0),
      inputTokens: summary.inputTokens ?? summary.totalInput ?? 0,
      outputTokens: summary.outputTokens ?? summary.totalOutput ?? 0,
      cacheHitRate: summary.cacheHitRate ?? 0,
      estimatedCost: summary.estimatedCost ?? 0,
      agentCount: summary.agentCount ?? agents.length,
      assistantCount: summary.totalAssistant ?? null,
      cacheRead: summary.totalCacheRead ?? null,
      currency: "USD",
      highUsageThreshold: summary.highUsageThreshold ?? 30000,
    },
    analytics: raw?.analytics || null,
    updatedAt: raw?.lastScan || null,
    rows, agents, daily: raw?.daily || [], hourly: raw?.hourly || [],
    models: [...new Set((raw?.models || rows.map(r => r.model)).map(m => typeof m === 'string' ? m : m.id).filter(Boolean))],
    providers: [...new Set((raw?.providers || rows.map(r => r.provider)).map(p => typeof p === 'string' ? p : p.provider || p.id).filter(Boolean))],
    // 下拉选项的源：上面的 models / agents 都是“按当前筛选算出来的结果集”，选中一个后里面就只剩它自己，
    // 拿来当下拉源会自我坍缩（选完就换不了别的）。这两个字段是后端特意给下拉准备的、
    // 不受模型筛选影响（modelOptions 取的是模型筛选之前的 sessionPool，agentNames 是宿主 agent 名册），
    // 之前在这里被过滤掉，补上。
    modelOptions: [...new Set((raw?.modelOptions || []).map(m => typeof m === 'string' ? m : m.id).filter(Boolean))],
    agentNames: raw?.agentNames || {},
    truncated: (raw?.streamTotal ?? rows.length) > rows.length,
    rowCount: raw?.streamTotal ?? rows.length,
  };
}

export { rankAgents } from "../ui/components.mjs";
