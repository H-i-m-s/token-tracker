import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js 在模块顶层就要求这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;

const registerDashboard = (await import("../runtime/engine/routes/dashboard.js")).default;
const { ROW_COLS } = await import("../runtime/engine/routes/dashboard.js");
const { createSqliteTurnsStore } = await import("../runtime/engine/services/turns-store.js");
const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");
const { shapeDashboard } = await import("../lib/snapshot-service.mjs");

const DatabaseSync = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };

const AGENTS = ["hanako", "other"];
const TYPES = ["desktop", "channel", "sub", "bridge", "background"];
const MODELS = ["m1", "m2", "m3"];
const PROVIDERS = ["p1", "p2"];

// 30 个会话 × 4 轮 = 120 条明细。时间取 12:0X:00Z（任何时区都落在同一天），日期铺在 09-20..09-27。
// 每三轮里有两轮带缓存拆分，一轮是「老记录」（整条没有 cacheRead）→ 覆盖 cache_read 为 NULL 的排序。
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
    out[`${agent}::${type}::::s${s}.jsonl`] = { agent, type, channelName: null, fileName: `s${s}.jsonl`, conversations: convs, models: { [model]: {} }, providers: { [`${provider}/${model}`]: { provider, model, totalTokens: 0, count: 1 } } };
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
const CALL = (ctx, p) => ctx._buildDashboardData({ range: "all", ...p }, OPTS);

// 参数表：覆盖四种排序两个方向、筛选、门槛、分页、越界与脏参数。
const CASES = [
  {}, { range: "all" },
  { sortKey: "time", order: "desc" }, { sortKey: "time", order: "asc" },
  { sortKey: "tokens", order: "desc" }, { sortKey: "tokens", order: "asc" },
  { sortKey: "uncached", order: "desc" }, { sortKey: "uncached", order: "asc" },
  { sortKey: "hit", order: "desc" }, { sortKey: "hit", order: "asc" },
  { agent: "hanako" }, { type: "channel" }, { model: "m2" }, { provider: "p2" },
  { model: "m2", provider: "p2", sortKey: "uncached", order: "asc" },
  { from: "2026-09-22", to: "2026-09-24" },
  { minTokens: 3000 }, { minTokens: 3000, sortKey: "uncached", order: "desc", page: 2, pageSize: 7 },
  { from: "2026-09-22", to: "2026-09-24", sortKey: "hit", order: "asc", minTokens: 2000, page: 3, pageSize: 5 },
  { page: 2, pageSize: 10 }, { page: 999, pageSize: 10 }, { page: 0, pageSize: 0 }, { pageSize: 5000 },
  { sortKey: "bogus", order: "bogus", minTokens: -5, page: -3 },
];

const DETAIL_KEYS = ["total", "sumTokens", "page", "pageSize", "totalPages", "sortKey", "order", "minTokens", "rows", "rowCols"];

test("明细块：形状、默认页大小与 rowCols 与旧载荷同序", { skip: !DatabaseSync }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-")), "cache.sqlite");
  const store = createSqliteTurnsStore({ DatabaseSync, file, log });
  store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx({ turnsStore: store });

  const d = (await CALL(ctx, {})).details;
  assert.deepEqual(Object.keys(d), DETAIL_KEYS, "details 的键就是约定那一组");
  assert.equal(d.total, 120, "30 会话 × 4 轮");
  assert.equal(d.page, 1);
  assert.equal(d.pageSize, 50, "默认页大小 50");
  assert.equal(d.totalPages, 3);
  assert.equal(d.rows.length, 50, "只发当前页");
  assert.deepEqual(d.rowCols, ROW_COLS, "与前端解码的列序一致");
  assert.equal(d.rows[0].length, ROW_COLS.length, "行是数组编码");
  assert.equal(d.sumTokens, SESSIONS && Object.values(SESSIONS).reduce((sum, s) => sum + s.conversations.reduce((a, c) => a + c.totalTokens, 0), 0));
  assert.equal(d.minTokens, 0);
  assert.equal(d.sortKey, "time");
  assert.equal(d.order, "desc");

  // 上限 200：请求 5000 也只给 200
  const big = (await CALL(ctx, { pageSize: 5000 })).details;
  assert.equal(big.pageSize, 200);
  assert.equal(big.rows.length, 120);

  store.close();
});

test("默认范围下的行载荷只有几十 KB 量级（4 MiB 硬顶）", { skip: !DatabaseSync }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-")), "cache.sqlite");
  const store = createSqliteTurnsStore({ DatabaseSync, file, log });
  store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx({ turnsStore: store });

  const dash = await CALL(ctx, { range: "all" });
  const bytes = Buffer.byteLength(JSON.stringify(dash.details));
  assert.ok(bytes < 200 * 1024, `details 载荷应远小于 200 KB，实际 ${bytes} B`);
  console.log("    [payload] 默认范围（range=all，pageSize=50）details = " + bytes + " B");
  // 对照：旧的全量行载荷（全部 120 行的对象形状）是它的多少倍
  const legacy = Buffer.byteLength(JSON.stringify(Object.values(SESSIONS).flatMap(s => s.conversations)));
  assert.ok(legacy > bytes, "分页后必然比全量小");

  store.close();
});

test("SQL 路径与回落路径：全部参数组合下 details 逐项一致", { skip: !DatabaseSync }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-")), "cache.sqlite");
  const store = createSqliteTurnsStore({ DatabaseSync, file, log });
  store.rebuild({ sessions: SESSIONS });
  // 空表（拿得到驱动但表是空的）也走回落
  const emptyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-")), "empty.sqlite");
  const emptyStore = createSqliteTurnsStore({ DatabaseSync, file: emptyFile, log });

  const ctxSql = makeCtx({ turnsStore: store });
  const ctxMem = makeCtx({ turnsStore: null });
  const ctxEmpty = makeCtx({ turnsStore: emptyStore });

  for (const c of CASES) {
    const label = JSON.stringify(c);
    const sql = await CALL(ctxSql, c);
    const mem = await CALL(ctxMem, c);
    const empty = await CALL(ctxEmpty, c);
    assert.deepEqual(sql.details, mem.details, "表路径 vs 内存回落不一致：" + label);
    assert.deepEqual(sql.details, empty.details, "表路径 vs 空表回落不一致：" + label);
    // 单轮请求大小分布也必须与内存算出来的一字不差（SQL 取 (model,total) 对 → summarizeTurns）
    assert.deepEqual(sql.analytics.turnSize, mem.analytics.turnSize, "turnSize 口径不一致：" + label);
  }

  // turnSize 看的是「与明细同一筛选集、但不设门槛」的全部轮次（与旧行为一致）
  const d = await CALL(ctxSql, { minTokens: 999999 });
  assert.equal(d.details.total, 0, "门槛高到没行");
  assert.equal(d.analytics.turnSize.turnCount, 120, "分布不受门槛影响（旧行为）");

  store.close();
  emptyStore.close();
});

test("明细口径：total/sumTokens 是过滤后全量，排序与门槛按约定", { skip: !DatabaseSync }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-db-")), "cache.sqlite");
  const store = createSqliteTurnsStore({ DatabaseSync, file, log });
  store.rebuild({ sessions: SESSIONS });
  const ctx = makeCtx({ turnsStore: store });

  const rows = Object.values(SESSIONS).flatMap(s => s.conversations);
  const expectedSum = rows.reduce((a, c) => a + c.totalTokens, 0);

  const filtered = (await CALL(ctx, { page: 2, pageSize: 10 })).details;
  assert.equal(filtered.total, 120, "total 不受 limit/offset 影响");
  assert.equal(filtered.sumTokens, expectedSum, "sumTokens 是过滤后全量合计");
  assert.equal(filtered.page, 2);

  const threshold = (await CALL(ctx, { minTokens: 3000 })).details;
  const expectKept = rows.filter(c => c.totalTokens >= 3000).length;
  assert.equal(threshold.total, expectKept, "门槛是「大于等于」");
  assert.equal(threshold.sumTokens, rows.filter(c => c.totalTokens >= 3000).reduce((a, c) => a + c.totalTokens, 0));

  // 越界页码夹回最后一页
  const over = (await CALL(ctx, { page: 999, pageSize: 10 })).details;
  assert.equal(over.page, over.totalPages);
  assert.equal(over.totalPages, 12);

  // 门槛过滤后页数不足 → 页码继续夹
  const clamped = (await CALL(ctx, { minTokens: 3000, page: 999, pageSize: 10 })).details;
  assert.equal(clamped.page, clamped.totalPages);
  assert.ok(clamped.rows.length > 0, "夹回后不能是空页");

  store.close();
});

test("过桥：details 原样带过去，mock 路径 details 为 null", () => {
  const raw = {
    details: { total: 3, sumTokens: 9, page: 1, pageSize: 50, totalPages: 1, sortKey: "time", order: "desc", minTokens: 0, rows: [[1, 2]], rowCols: ROW_COLS },
    summary: {},
  };
  const out = shapeDashboard(raw);
  assert.deepEqual(out.details, raw.details, "不过桥就得原样，不展开也不丢 rowCols");
  assert.deepEqual(out.details.rowCols, ROW_COLS);

  // mock：没有服务端分页，details 缺省为 null（前端继续用它本地那套算）
  const mock = shapeDashboard({ rows: [{ time: "t" }], models: ["m"] });
  assert.equal(mock.details, null);
  assert.deepEqual(mock.rows, [{ time: "t" }], "对象行路径不变");
});
