import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js 在模块顶层就要求这两个环境变量，必须先设好再 import。
// 一律用临时目录，绝不碰用户真实数据目录。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-mf-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-mf-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;

const registerDashboard = (await import("../runtime/engine/routes/dashboard.js")).default;
const { toList } = await import("../runtime/engine/routes/dashboard.js");
const { createSqliteTurnsStore, queryTurns, queryTurnSizes } = await import("../runtime/engine/services/turns-store.js");
const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");
const { buildVisualAnalytics } = await import("../runtime/engine/services/visual-analytics.js");
const { buildDetailsCSV } = await import("../runtime/engine/services/details-csv.js");

const DatabaseSync = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };
const OPTS = { skipBalances: true, fxRate: 7.1 };

// ─────────────────────────────────────────────────────────────────────────────
// 合成语料：四个会话、共 7 轮。模型 A/B 归 p1，C 归 p2，模型之间归属不重叠。
//   s1 hanako/desktop p1 A  3300（2 轮）
//   s2 hanako/desktop p1 B  1320（2 轮）
//   s3 other /sub     p1 B   330（1 轮）
//   s4 other /sub     p2 C   990（1 轮）
// 总量 5940；A=3300；B=1650；A+B=4950；hanako=4620；other=1320。
// ─────────────────────────────────────────────────────────────────────────────
const DAY = "2026-09-30";

function makeSession({ agent, type, provider, model, rounds }) {
  const conversations = rounds.map((r, i) => ({
    time: `${DAY}T12:0${i}:00.000Z`, model, provider,
    msgCount: r.calls, inTokens: r.input, outTokens: r.output,
    cacheRead: r.cacheRead, cacheWrite: 0, reasoning: 0,
    totalTokens: r.input + r.output,
  }));
  const input = rounds.reduce((s, r) => s + r.input, 0);
  const output = rounds.reduce((s, r) => s + r.output, 0);
  const cacheRead = rounds.reduce((s, r) => s + r.cacheRead, 0);
  const totalTokens = input + output;
  const assistantCount = rounds.length;
  const byType = (t) => (type === t ? totalTokens : 0);
  const bucket = {
    input, output, cacheRead, cacheWrite: 0, totalTokens, assistantCount,
    desktop: byType("desktop"), channel: byType("channel"), bridge: byType("bridge"),
    background: byType("background"), sub: byType("sub"), ledger: byType("ledger"),
    models: { [model]: { input, output, cacheRead, cacheWrite: 0, totalTokens, assistantCount } },
    providerTotals: { [`${provider}/${model}`]: { provider, model, totalTokens, input, output, cacheRead, assistantCount } },
  };
  return {
    agent, type, fileName: "s.jsonl", conversations,
    models: { [model]: {} },
    providers: { [`${provider}/${model}`]: { provider, model, totalTokens, count: assistantCount } },
    dailyBreakdown: { [DAY]: bucket },
  };
}

const SESSIONS = {
  "hanako::desktop::::s1.jsonl": makeSession({ agent: "hanako", type: "desktop", provider: "p1", model: "A",
    rounds: [{ input: 1000, output: 100, cacheRead: 400, calls: 2 }, { input: 2000, output: 200, cacheRead: 500, calls: 1 }] }),
  "hanako::desktop::::s2.jsonl": makeSession({ agent: "hanako", type: "desktop", provider: "p1", model: "B",
    rounds: [{ input: 500, output: 50, cacheRead: 0, calls: 1 }, { input: 700, output: 70, cacheRead: 100, calls: 3 }] }),
  "other::sub::::s3.jsonl": makeSession({ agent: "other", type: "sub", provider: "p1", model: "B",
    rounds: [{ input: 300, output: 30, cacheRead: 0, calls: 1 }] }),
  "other::sub::::s4.jsonl": makeSession({ agent: "other", type: "sub", provider: "p2", model: "C",
    rounds: [{ input: 900, output: 90, cacheRead: 300, calls: 2 }] }),
};
const AGENT_NAMES = { hanako: "Hanako", other: "Other" };

function makeCtx(turnsStore) {
  const ctx = {
    _tokenCache: { data: { sessions: SESSIONS, agentNames: AGENT_NAMES }, dataDir, turnsStore },
    bus: { async request() { return { agents: ["hanako", "other"].map((id) => ({ id, name: AGENT_NAMES[id] })) }; } },
  };
  registerDashboard({ get() {}, post() {} }, ctx);
  return ctx;
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-mf-store-"));
  return createSqliteTurnsStore({ DatabaseSync, file: path.join(dir, "cache.sqlite"), log });
}

const dash = (ctx, params) => ctx._buildDashboardData({ range: "all", ...params }, OPTS);
const rowKey = (r) => `${r.sessionKey}#${r.seq}`;

// ───────────────────────────── 1. 单值等价 ─────────────────────────────
test("单值等价：model 'A' 与 ['A'] 在五条路上逐字段相同", { skip: !DatabaseSync }, async () => {
  const store = tempStore(); store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx(store);
  try {
    const d1 = await dash(ctx, { model: "A" });
    const d2 = await dash(ctx, { model: ["A"] });
    // 看板汇总
    for (const k of ["analytics", "summary", "agents", "models", "modelOptions", "providers", "daily", "hourly", "details"]) {
      assert.deepEqual(d2[k], d1[k], `看板字段 ${k} 必须一致`);
    }
    // 显式核对：A 只属 s1（3300，两轮），防止「一模一样地错」
    assert.equal(d1.summary.totalTokens, 3300);
    assert.equal(d1.details.total, 2);
    assert.equal(d1.details.sumTokens, 3300);

    // details 对象路（导出用）
    const r1 = await ctx._buildDetailsRows({ range: "all", model: "A" });
    const r2 = await ctx._buildDetailsRows({ range: "all", model: ["A"] });
    assert.deepEqual(r2.rows, r1.rows);
    assert.deepEqual(r1.rows.map(rowKey).sort(), ["hanako::desktop::::s1.jsonl#1", "hanako::desktop::::s1.jsonl#2"]);

    // details 只取路
    const o1 = await ctx._buildDetailsOnly({ range: "all", model: "A" });
    const o2 = await ctx._buildDetailsOnly({ range: "all", model: ["A"] });
    assert.deepEqual(o2, o1);

    // details.csv
    assert.equal(buildDetailsCSV(r2.rows), buildDetailsCSV(r1.rows));

    // queryTurnSizes
    const s1 = queryTurnSizes(store, { model: "A" });
    const s2 = queryTurnSizes(store, { model: ["A"] });
    assert.deepEqual(s2, s1);
    assert.equal(s1.length, 2);
  } finally { store.close(); }
});

// ───────────────────────────── 2. 并集 ─────────────────────────────
test("并集：A+B 的总量 = A + B，明细行 = 两边缘的并集", { skip: !DatabaseSync }, async () => {
  const store = tempStore(); store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx(store);
  try {
    const a = await dash(ctx, { model: "A" });
    const b = await dash(ctx, { model: "B" });
    const ab = await dash(ctx, { model: ["A", "B"] });
    assert.equal(ab.summary.totalTokens, a.summary.totalTokens + b.summary.totalTokens, "总量是可加的");
    assert.equal(ab.summary.totalTokens, 3300 + 1650);

    const ra = await ctx._buildDetailsRows({ range: "all", model: "A" });
    const rb = await ctx._buildDetailsRows({ range: "all", model: "B" });
    const rab = await ctx._buildDetailsRows({ range: "all", model: ["A", "B"] });
    assert.equal(rab.rows.length, ra.rows.length + rb.rows.length);
    assert.deepEqual(rab.rows.map(rowKey).sort(),
      [...new Set([...ra.rows.map(rowKey), ...rb.rows.map(rowKey)])].sort());
  } finally { store.close(); }
});

// ───────────────────────────── 3. 字段间 AND ─────────────────────────────
test("字段间 AND：agent=[X] 与 model=[A,B] 同时生效", { skip: !DatabaseSync }, async () => {
  const store = tempStore(); store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx(store);
  try {
    const han = await dash(ctx, { agent: ["hanako"], model: ["A", "B"] });
    assert.equal(han.summary.totalTokens, 4620);
    const hRows = (await ctx._buildDetailsRows({ range: "all", agent: ["hanako"], model: ["A", "B"] })).rows;
    assert.equal(hRows.length, 4, "s1(2) + s2(2)");
    assert.ok(hRows.every((r) => r.agent === "hanako" && (r.model === "A" || r.model === "B")));

    const other = await dash(ctx, { agent: ["other"], model: ["A", "B"] });
    assert.equal(other.summary.totalTokens, 330, "other 只有 B");
    const oRows = (await ctx._buildDetailsRows({ range: "all", agent: ["other"], model: ["A", "B"] })).rows;
    assert.ok(oRows.every((r) => r.model === "B"));
    assert.ok(!oRows.some((r) => r.model === "C"), "C 不在 [A,B] 里，不能漏出");

    // 供应商 + 模型：交集
    assert.equal((await dash(ctx, { provider: ["p1"], model: ["A", "B"] })).summary.totalTokens, 4950);
    assert.equal((await dash(ctx, { provider: ["p2"], model: ["B"] })).summary.totalTokens, 0, "p2 下没有 B");
    assert.equal((await dash(ctx, { provider: ["p1", "p2"] })).summary.totalTokens, 5940, "两家供应商 = 全部");
  } finally { store.close(); }
});

// ───────────────────────────── 4. 编码 ─────────────────────────────
test("编码：逗号连接 + URI 解码，非法 % 不抛", () => {
  assert.deepEqual(toList("a%2Cb,c"), ["a,b", "c"]);
  assert.deepEqual(toList("A"), ["A"]);
  assert.deepEqual(toList("A,B,C"), ["A", "B", "C"]);
  assert.deepEqual(toList(["A", "B"]), ["A", "B"]);
  assert.deepEqual(toList("%E4%B8%AD"), ["中"], "解码出中文");
  assert.deepEqual(toList("  A  "), ["A"], "trim");
  assert.deepEqual(toList("") , []);
  assert.deepEqual(toList([]), []);
  assert.deepEqual(toList(["A", "", " B "]), ["A", "B"], "丢空串");
  assert.deepEqual(toList(undefined), []);
  assert.deepEqual(toList(null), []);
  assert.deepEqual(toList(42), []);
  // 非法 % 不抛，原样保留
  assert.deepEqual(toList("bad%"), ["bad%"]);
  assert.deepEqual(toList("%"), ["%"]);
});

// ───────────────────────────── 5. 空值不筛 ─────────────────────────────
test("空值：[]、''、undefined、null 都不筛", { skip: !DatabaseSync }, async () => {
  const store = tempStore(); store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx(store);
  try {
    const base = await dash(ctx, {});
    assert.equal(base.summary.totalTokens, 5940);
    for (const v of [[], "", undefined, null]) {
      const d = await dash(ctx, { model: v, agent: v, provider: v, type: v });
      assert.equal(d.summary.totalTokens, 5940, `空值不筛：${JSON.stringify(v)}`);
      assert.deepEqual(d.details, base.details, `空值不筛（details）：${JSON.stringify(v)}`);
    }
  } finally { store.close(); }
});

// ───────────────────────────── 6. turns 表路 ─────────────────────────────
test("turns 表：IN 子句在 query 与 queryTurnSizes 生效，且与内存路一致", { skip: !DatabaseSync }, async () => {
  const store = tempStore(); store.rebuild({ sessions: SESSIONS });
  try {
    const q = queryTurns(store, { model: ["A", "B"], sortKey: "time", order: "asc" });
    assert.equal(q.total, 5, "s1(2) + s2(2) + s3(1)");
    assert.ok(q.rows.every((r) => r.model === "A" || r.model === "B"));

    // 与「遍历 conversations 直接算」对拍
    const mem = [];
    for (const [key, s] of Object.entries(SESSIONS)) {
      s.conversations.forEach((c, i) => { if (c.model === "A" || c.model === "B") mem.push(`${key}#${i + 1}`); });
    }
    assert.deepEqual(q.rows.map(rowKey).sort(), mem.sort());

    // queryTurnSizes 的 IN 生效
    assert.equal(queryTurnSizes(store, { model: ["A", "B"] }).length, 5);
    const inter = queryTurnSizes(store, { provider: ["p1"], model: ["A"] });
    assert.equal(inter.length, 2, "p1∩A = s1 两轮");
    assert.deepEqual([...new Set(inter.map((r) => r.model))], ["A"]);
    assert.equal(queryTurnSizes(store, { provider: ["p2"], model: ["B"] }).length, 0);

    // 单值仍走 col = ?（旧路径不能坏）
    assert.equal(queryTurns(store, { model: "A" }).total, 2);
  } finally { store.close(); }

  // 看板：表路 vs 内存路
  const store2 = tempStore(); store2.rebuild({ sessions: SESSIONS });
  const ctxTable = makeCtx(store2);
  const ctxMem = makeCtx(null);
  try {
    const t = await dash(ctxTable, { model: ["A", "B"] });
    const m = await dash(ctxMem, { model: ["A", "B"] });
    assert.deepEqual(t.details, m.details, "表路与内存路的 details 必须一致");
    assert.deepEqual(t.summary, m.summary, "表路与内存路的 summary 必须一致");
    assert.deepEqual(t.analytics.turnSize, m.analytics.turnSize, "单轮分布同口径");
  } finally { store2.close(); }
});

// ───────────────────────────── 7. canSplit ─────────────────────────────
test("canSplit：多模型/供应商筛选为 false，不筛为 true", () => {
  const bucket = {
    totalTokens: 100, desktop: 100,
    models: { A: { totalTokens: 100, assistantCount: 1 } },
    providerTotals: { "p1/A": { totalTokens: 100, assistantCount: 1 } },
  };
  const session = { agent: "hanako", type: "desktop", dailyBreakdown: { [DAY]: bucket } };
  const f = () => true;
  assert.equal(buildVisualAnalytics([session], f, { model: [], provider: [] }, []).canSplit, true);
  assert.equal(buildVisualAnalytics([session], f, { model: ["A"], provider: [] }, []).canSplit, false);
  assert.equal(buildVisualAnalytics([session], f, { model: [], provider: ["p1"] }, []).canSplit, false);
  assert.equal(buildVisualAnalytics([session], f, {}, []).canSplit, true, "未给字段 = 不筛");

  // agent / type 的多值也是「任一命中」
  assert.equal(buildVisualAnalytics([session], f, { agent: ["hanako"] }, []).sessionCount, 1);
  assert.equal(buildVisualAnalytics([session], f, { agent: ["other"] }, []).sessionCount, 0);
  assert.equal(buildVisualAnalytics([session], f, { model: ["A", "B"] }, []).dailyTotal, 100, "A+B 只有 A 命中");
});
