import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js 在模块顶层就要求这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-do-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-do-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;

const registerDashboard = (await import("../runtime/engine/routes/dashboard.js")).default;
const { createSqliteTurnsStore } = await import("../runtime/engine/services/turns-store.js");
const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");

const DatabaseSync = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };

const AGENTS = ["hanako", "other"];
const TYPES = ["desktop", "channel", "sub", "bridge", "background"];
const MODELS = ["m1", "m2", "m3"];
const PROVIDERS = ["p1", "p2"];

// 30 个会话 × 4 轮 = 120 条明细。每三轮里有两轮带缓存拆分、一轮是「老记录」（没有 cacheRead），
// 正好覆盖 uncached 排序里 NULL 那一支。
function makeSessions() {
  const out = {};
  for (let s = 0; s < 30; s++) {
    const agent = AGENTS[s % AGENTS.length];
    const type = TYPES[s % TYPES.length];
    const provider = PROVIDERS[s % PROVIDERS.length];
    const model = MODELS[s % MODELS.length];
    const convs = [];
    for (let c = 0; c < 4; c++) {
      const day = String(20 + ((s + c) % 8)).padStart(2, "0");
      const uncached = 1000 + s * 100 + c * 10;
      const hasSplit = (s + c) % 3 !== 0;
      const cacheRead = hasSplit ? Math.floor(uncached * 0.5) : 0;
      const inTokens = uncached + cacheRead;
      const outTokens = 50 + c * 5;
      const conv = {
        time: `2026-09-${day}T12:0${c}:00.000Z`, model, provider,
        msgCount: 1 + (c % 2), inTokens, outTokens, totalTokens: inTokens + outTokens,
        cacheWrite: 0, reasoning: 0,
      };
      if (hasSplit) conv.cacheRead = cacheRead;
      convs.push(conv);
    }
    out[`${agent}::${type}::::s${s}.jsonl`] = {
      agent, type, channelName: null, fileName: `s${s}.jsonl`, conversations: convs,
      models: { [model]: {} }, providers: { [`${provider}/${model}`]: { provider, model, totalTokens: 0, count: 1 } },
    };
  }
  return out;
}

const SESSIONS = makeSessions();
const AGENT_NAMES = { hanako: "Hanako", other: "Other" };

function makeCtx({ turnsStore }) {
  const ctx = {
    _tokenCache: { data: { sessions: SESSIONS, agentNames: AGENT_NAMES }, dataDir, turnsStore },
    bus: { async request() { return { agents: AGENTS.map(id => ({ id, name: AGENT_NAMES[id] })) }; } },
  };
  registerDashboard({ get() {}, post() {} }, ctx);
  return ctx;
}

const OPTS = { skipBalances: true, fxRate: 7.1 };

// 四种要覆盖的情形：翻到中间某页、门槛、未命中降序、越界页。
const CASES = [
  { page: 3, pageSize: 20 },
  { minTokens: 4000 },
  { sortKey: "uncached", order: "desc" },
  { page: 9999, pageSize: 10 },
];

// 两条路必须收敛到同一份 details：只回明细不能改口径。
async function assertParity(ctx, params) {
  const label = JSON.stringify(params);
  const only = await ctx._buildDetailsOnly({ range: "all", ...params });
  const full = await ctx._buildDashboardData({ range: "all", ...params }, OPTS);
  assert.deepEqual(only.details, full.details, "只取明细 vs 整份看板，details 必须深相等：" + label);
  // 这条路的全部意义就是不算那些聚合：载荷里除了 details 不该再有别的。
  assert.deepEqual(Object.keys(only), ["details"], "只回 details，不多算别的：" + label);
  for (const absent of ["analytics", "daily", "agents", "providers", "summary", "heatmap"]) {
    assert.ok(!(absent in only), "不该带聚合字段 " + absent + "：" + label);
  }
}

test("只取明细：四种情形下与整份看板的 details 逐项一致（turns 表路径）", { skip: !DatabaseSync }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-do-")), "cache.sqlite");
  const store = createSqliteTurnsStore({ DatabaseSync, file, log });
  store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx({ turnsStore: store });

  for (const c of CASES) await assertParity(ctx, c);

  // 越界页要夹回最后一页，页码与整份看板一致（不是空页、也不是原样 9999）。
  const clamped = (await ctx._buildDetailsOnly({ range: "all", page: 9999, pageSize: 10 })).details;
  assert.equal(clamped.page, clamped.totalPages);

  store.close();
});

test("只取明细：没有 turns 表（内存回落）时四种情形同样一致", async () => {
  const ctx = makeCtx({ turnsStore: null });
  for (const c of CASES) await assertParity(ctx, c);
});

test("只取明细：未就绪时沿用既有写法，不抛", async () => {
  const ctx = { _tokenCache: undefined };
  registerDashboard({ get() {}, post() {} }, ctx);
  const out = await ctx._buildDetailsOnly({ range: "all" });
  assert.deepEqual(out, { notReady: true, error: "数据未就绪" });
});
