// Mock data shaped exactly like the v1 bus contracts.
// Used for UI development / smoke tests when the v1 bridge is not ready.

export const MOCK_AGENT_NAMES = {
  coding: "coding",
  main: "main",
  backend: "backend",
  frontend: "frontend",
  review: "review",
};

export const NOW = Date.now();

export function snapTimestamp(minutesAgo = 0) {
  return NOW - minutesAgo * 60 * 1000;
}

export function mockRealtime() {
  return {
    lastTps: 847,
    avgTps: 620,
    contextPercent: 68,
    contextTokens: 12400,
    contextWindow: 64000,
    model: "deepseek-v4-flash",
    agentName: "coding",
    agentId: "coding",
    lastTotalTokens: 2048,
    lastCost: 0.0032,
    updatedAt: snapTimestamp(2),
  };
}

export function mockBalances() {
  return [
    { provider: "DeepSeek", status: "ok", type: "deepseek", display: "¥42.50", used: 2150, limit: 5000, remain: 2850, updatedAt: snapTimestamp(5) },
    { provider: "GLM", status: "ok", type: "glm", display: "¥18.20", used: 1820, limit: 5000, remain: 3180, updatedAt: snapTimestamp(5) },
    { provider: "MiniMax", status: "ok", type: "minimax", display: "¥6.40", used: 640, limit: 2000, remain: 1360, updatedAt: snapTimestamp(6) },
    { provider: "商汤 TokenPlan", status: "ok", type: "sensenova", display: "8.2K / 50K 积分", used: 8200, limit: 50000, remain: 41800, updatedAt: snapTimestamp(4) },
    { provider: "火山方舟", status: "ok", type: "volcengine", display: "¥42.50", used: 78300, limit: 100000, remain: 21700, updatedAt: snapTimestamp(5) },
    { provider: "OpenCode Go", status: "ok", type: "opencode-go", display: "$3.12 / $60.00", used: 3.12, limit: 60, remain: 56.88, updatedAt: snapTimestamp(3) },
  ];
}

export function mockSummary() {
  return {
    totalTokens: 1247000,
    inputTokens: 487000,
    outputTokens: 760000,
    cacheHitRate: 32,
    estimatedCost: 8.42,
    agentCount: 6,
  };
}

export function mockSnapshot() {
  return {
    realtime: mockRealtime(),
    balances: mockBalances(),
    agentNames: MOCK_AGENT_NAMES,
    updatedAt: NOW,
  };
}

export function mockDashboardRows(range = "today") {
  const base = range === "today" ? 24 : range === "week" ? 7 * 8 : range === "month" ? 30 : 12;
  const rows = [];
  const models = ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "minimax-text-01", "sensenova-6.8-flash-lite"];
  const agents = ["coding", "main", "backend", "frontend", "review"];
  const providers = ["DeepSeek", "GLM", "MiniMax", "商汤", "火山方舟"];
  for (let i = 0; i < base; i++) {
    const m = models[i % models.length];
    const a = agents[i % agents.length];
    const p = providers[i % providers.length];
    rows.push({
      time: new Date(NOW - i * 4 * 60 * 1000).toISOString(),
      agent: a,
      agentName: MOCK_AGENT_NAMES[a],
      provider: p,
      model: m,
      totalTokens: 1200 + (i % 5) * 450 + Math.floor(Math.random() * 300),
      inputTokens: 700 + (i % 4) * 200,
      outputTokens: 500 + (i % 4) * 250,
      cost: Number((0.02 + (i % 7) * 0.005).toFixed(4)),
    });
  }
  return rows;
}

export function mockDashboard(range = "today") {
  const rows = mockDashboardRows(range);
  const summary = mockSummary();
  const agents = Array.from(new Set(rows.map((r) => r.agent))).map((id) => ({ id, totalTokens: rows.filter((r) => r.agent === id).reduce((s, r) => s + r.totalTokens, 0) }));
  const models = Array.from(new Set(rows.map((r) => r.model)));
  const providers = Array.from(new Set(rows.map((r) => r.provider)));
  return { summary, rows, agents, models, providers };
}

export function mockBalance() {
  return { balances: mockBalances() };
}

export const DEFAULT_SETTINGS = {
  scanInterval: 60,
  highUsageThreshold: 30000,
  balanceApis: {
    deepseek: { enabled: true },
    glm: { enabled: false },
    minimax: { enabled: false },
    sensenova: { enabled: true, token: "" },
    volcengine: { enabled: false, token: "" },
    opencodeGo: { enabled: true, workspace: "", cookie: "" },
  },
  display: {
    density: "compact",
    // 与设置默认值同形（中文单位制）：mock 预览看到的数字写法跟真机默认一致。
    units: "zh",
    colorScheme: "auto",
  },
};

export function mockSettings() {
  return { ...DEFAULT_SETTINGS };
}

let mutableMockSettings = mockSettings();

export function readMockSettings() {
  return mutableMockSettings;
}

export function writeMockSettings(patch) {
  mutableMockSettings = { ...mutableMockSettings, ...patch };
  return mutableMockSettings;
}
