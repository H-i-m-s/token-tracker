import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js / engine 顶层就要求这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sync-home-"));
process.env.HANA_HOME = home;
const engineDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sync-data-"));
process.env.TOKEN_TRACKER_DATA_DIR = engineDataDir;

const log = { info() {}, warn() {}, error() {} };
const line = (ts, message) => JSON.stringify({ type: "message", timestamp: ts, message });
const usage = (input, output, cacheRead, cacheWrite, reasoning) => ({
  input, output, cacheRead, cacheWrite, reasoning,
  totalTokens: input + output + cacheRead,
});

const sessDir = path.join(home, "agents", "hanako", "sessions");
fs.mkdirSync(sessDir, { recursive: true });
const FILE_A = "2026-09-30T12-00-00-000Z_split.jsonl";
const FILE_B = "2026-09-30T13-00-00-000Z_second.jsonl";
const KEY_A = `hanako::desktop::::${FILE_A}`;
const KEY_B = `hanako::desktop::::${FILE_B}`;
const turnLines = (h, m, input, cacheRead) => [
  line(`2026-09-30T${h}:${m}:00.000Z`, { role: "user", content: "问" }),
  line(`2026-09-30T${h}:${m}:05.000Z`, { role: "assistant", model: "deepseek-flash", provider: "deepseek", usage: usage(input, 100, cacheRead, 0, 0) }),
];
fs.writeFileSync(path.join(sessDir, FILE_A), [
  ...turnLines("12", "00", 1000, 5000),
  ...turnLines("12", "01", 700, 2000),
].join("\n") + "\n");

const { default: Engine } = await import("../runtime/engine/index.js");
const { createSqliteTurnsStore } = await import("../runtime/engine/services/turns-store.js");
const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");

const DatabaseSync = loadSqliteDriver();

// 本地时区取日（与写入端同一套写法）。
function localDay(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d.getTime())) return "unknown";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// 「内存里的 conversations 应该长成什么表」——逐项列出来，跟表里读出来的比。
function expectedRows(sessions) {
  const out = [];
  for (const [key, s] of Object.entries(sessions)) {
    (s.conversations || []).forEach((c, i) => out.push({
      sessionKey: key, seq: i + 1, at: c.time, day: localDay(c.time),
      total: c.totalTokens || 0, input: c.inTokens ?? null, cacheRead: c.cacheRead ?? null, calls: c.msgCount ?? null,
    }));
  }
  return out.sort((a, b) => (a.sessionKey === b.sessionKey ? a.seq - b.seq : a.sessionKey < b.sessionKey ? -1 : 1));
}
function actualRows(store) {
  return store.query({ all: true, sortKey: "time", order: "asc" }).rows
    .map((r) => ({ sessionKey: r.sessionKey, seq: r.seq, at: r.at, day: r.day, total: r.total, input: r.input, cacheRead: r.cacheRead, calls: r.calls }))
    .sort((a, b) => (a.sessionKey === b.sessionKey ? a.seq - b.seq : a.sessionKey < b.sessionKey ? -1 : 1));
}

test("新鲜度：扫描同步写表，不等落盘；再扫表跟着变", { skip: !DatabaseSync }, async () => {
  const disposers = [];
  const engine = new Engine();
  engine.ctx = {
    dataDir: engineDataDir,
    config: { get: () => undefined },
    log,
    bus: { async request() { return { agents: [] }; }, subscribe: () => () => {}, handle: () => () => {}, emit() {} },
  };
  engine.register = (fn) => disposers.push(fn);
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(false); // 首轮（版本不匹配）即全量

  try {
    assert.equal(shared.turnsStore.count(), 2, "扫描完当场就有 2 行，不必等落盘");
    assert.deepEqual(actualRows(shared.turnsStore), expectedRows(shared.data.sessions), "表内容 == 内存 conversations");

    // 增量扫描：改一份会话 + 新增一份会话。注意这里**不落盘**（persist 的攒批窗口是 5 分钟）。
    const writesBefore = shared.persist.stats.writes;
    fs.writeFileSync(path.join(sessDir, FILE_A), [
      ...turnLines("12", "00", 1000, 5000),
      ...turnLines("12", "01", 700, 2000),
      ...turnLines("12", "02", 300, 0),
    ].join("\n") + "\n");
    // 立刻写盘时 mtime 可能同毫秒，显式挪一下，确保增量扫描认得出这个文件变了。
    const ft = new Date(Date.now() + 4000);
    fs.utimesSync(path.join(sessDir, FILE_A), ft, ft);
    fs.writeFileSync(path.join(sessDir, FILE_B), turnLines("13", "00", 900, 100).join("\n") + "\n");

    await shared.scan(false);

    assert.equal(shared.persist.stats.writes, writesBefore, "增量扫描没有触发任何落盘（表不是靠落盘写的）");
    assert.ok(shared.data.sessions[KEY_B], "新会话进了内存");
    assert.equal(shared.data.sessions[KEY_A].conversations.length, 3, "老会话重建出 3 轮");
    assert.equal(shared.turnsStore.count(), 4, "表跟着扫描一起长到 4 行");
    assert.deepEqual(actualRows(shared.turnsStore), expectedRows(shared.data.sessions), "重扫后表内容仍 == 内存 conversations");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 并列排序：两个会话，轮次时间戳完全相同，而且排序值也完全相同。
// SQL 的兜底是 `..., session_key ASC, seq ASC`；内存回落必须给出同一顺序。
// 会话在对象里故意按 z 在前、a 在后来写，避免「恰好等于迭代顺序」蒙对。
// ─────────────────────────────────────────────────────────────────────────────
const TIE_SESSIONS = {
  "z::desktop::::z.jsonl": {
    agent: "z", type: "desktop",
    conversations: [
      { time: "2026-09-30T12:00:00.000Z", model: "m", provider: "p", totalTokens: 100, msgCount: 1, inTokens: 100, outTokens: 0, cacheRead: 0 },
      { time: "2026-09-30T12:00:00.000Z", model: "m", provider: "p", totalTokens: 100, msgCount: 1, inTokens: 100, outTokens: 0, cacheRead: 0 },
    ],
  },
  "a::desktop::::a.jsonl": {
    agent: "a", type: "desktop",
    conversations: [
      { time: "2026-09-30T12:00:00.000Z", model: "m", provider: "p", totalTokens: 100, msgCount: 1, inTokens: 100, outTokens: 0, cacheRead: 0 },
    ],
  },
};

test("并列排序：完全同时间戳（且排序值相同）时，SQL 路与回落路行序逐项相同", { skip: !DatabaseSync }, async () => {
  const { default: registerDashboard, ROW_COLS } = await import("../runtime/engine/routes/dashboard.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-tie-"));
  const store = createSqliteTurnsStore({ DatabaseSync, file: path.join(dir, "cache.sqlite"), log });
  store.rebuild({ sessions: TIE_SESSIONS });

  const makeCtx = (turnsStore) => {
    const ctx = {
      _tokenCache: { data: { sessions: TIE_SESSIONS, agentNames: {} }, dataDir: dir, turnsStore },
      bus: { async request() { return { agents: [] }; } },
    };
    registerDashboard({ get() {}, post() {} }, ctx);
    return ctx;
  };
  const ctxSql = makeCtx(store);
  const ctxMem = makeCtx(null);
  const opts = { skipBalances: true, fxRate: 7.1 };

  // 期望顺序：session_key ASC，然后 seq ASC —— 与 SQL 的兜底完全一致
  for (const sort of [{ sortKey: "time", order: "desc" }, { sortKey: "time", order: "asc" }, { sortKey: "tokens", order: "desc" }, { sortKey: "uncached", order: "asc" }, { sortKey: "hit", order: "asc" }]) {
    const sql = (await ctxSql._buildDashboardData({ range: "all", ...sort }, opts)).details;
    const mem = (await ctxMem._buildDashboardData({ range: "all", ...sort }, opts)).details;
    assert.deepEqual(sql, mem, "SQL 路与回落路必须逐项相同：" + JSON.stringify(sort));
    // 行序：a 的 seq1 → z 的 seq1 → z 的 seq2（三联完全并列，只能靠主键收尾）
    const order = sql.rows.map((r) => `${r[ROW_COLS.indexOf("agent")]}:${r[ROW_COLS.indexOf("totalTokens")]}`);
    assert.deepEqual(order, ["a:100", "z:100", "z:100"], "并列时按 session_key ASC、seq ASC 收尾：" + JSON.stringify(sort));
  }

  store.close();
});
