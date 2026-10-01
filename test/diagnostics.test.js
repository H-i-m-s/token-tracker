import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js 在模块顶层就要求这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-diag-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-diag-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;

const registerDashboard = (await import("../runtime/engine/routes/dashboard.js")).default;
const { createSqliteTurnsStore } = await import("../runtime/engine/services/turns-store.js");
const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");

const DatabaseSync = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };

// 两个文件会话 + 两个账本行（账本是按天聚合的，没有文件、身份在指纹上）。
function makeSessions() {
  const conv = (time, inTokens, outTokens) => ({
    time, model: "m1", provider: "p1", msgCount: 2,
    inTokens, outTokens, totalTokens: inTokens + outTokens, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  });
  return {
    "hanako::desktop::::a.jsonl": {
      agent: "hanako", type: "desktop", fileName: "a.jsonl",
      conversations: [conv("2026-09-20T12:00:00.000Z", 1000, 100), conv("2026-09-21T12:00:00.000Z", 2000, 200)],
      models: { m1: {} }, providers: { "p1/m1": { provider: "p1", model: "m1", totalTokens: 0, count: 2 } },
    },
    "other::channel::::b.jsonl": {
      agent: "other", type: "channel", fileName: "b.jsonl",
      conversations: [conv("2026-09-22T12:00:00.000Z", 3000, 300)],
      models: { m1: {} }, providers: { "p1/m1": { provider: "p1", model: "m1", totalTokens: 0, count: 1 } },
    },
    "__ledger__hanako::memory::2026-09-20": {
      agent: "hanako", type: "ledger", fileName: "usage-ledger.sqlite",
      mtime: 0, size: 12345, msgCount: 7, conversations: [],
    },
    "__ledger__hanako::utility::2026-09-21": {
      agent: "hanako", type: "ledger", fileName: "usage-ledger.sqlite",
      mtime: 0, size: 67890, msgCount: 3, conversations: [],
    },
  };
}

const PERSIST = {
  writes: 458, bytes: 193_000_000, day: "2026-10-01", dayWrites: 18, dayBytes: 31_000_000,
  lastReason: "定时", lastRows: 4, lastBytes: 28_000, lastMs: 4,
  lastDetail: "4 行内容变过 · 0 行补报 · 0 行移除", lastScope: "增量",
};

// 缓存目录里同时放一个真的 cache.sqlite（体检要报它的字节数），并让 cachePath 指到同目录。
function makeCtx({ turnsStore, cachePath }) {
  const ctx = {
    _tokenCache: {
      data: { sessions: makeSessions(), version: 25, lastScan: "2026-10-01T03:58:41.606Z" },
      dataDir, turnsStore, cachePath, ready: true,
      persist: { stats: PERSIST },
    },
    bus: { async request() { return { agents: [] }; } },
  };
  registerDashboard({ get() {}, post() {} }, ctx);
  return ctx;
}

function makeStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-diag-db-")), "cache.sqlite");
  const store = createSqliteTurnsStore({ DatabaseSync, file, log });
  store.rebuild({ sessions: makeSessions() });
  // 真机上这个库文件里同时有 sessions 与 turns 两张表（同一文件、两个连接）。
  // 体检只对 sessions 做 COUNT(*)，所以这里把那张表建出来、按上面的会话数填上。
  const db = store.open();
  db.exec("CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, mtime REAL, size REAL, record TEXT)");
  const ins = db.prepare("INSERT OR REPLACE INTO sessions(key, mtime, size, record) VALUES (?, 0, 0, '')");
  for (const k of Object.keys(makeSessions())) ins.run(k);
  return { store, file, cachePath: path.join(path.dirname(file), "token-cache.json") };
}

test("体检：表行数/库文件/账本/落盘都对得上；不传 bytes 就不算载荷", { skip: !DatabaseSync }, async () => {
  const { store, file, cachePath } = makeStore();
  const ctx = makeCtx({ turnsStore: store, cachePath });

  const d = await ctx._buildDiagnostics({});

  // 表行数走真 SQL：两个文件会话 + 两个账本行 = 4 行 sessions；明细 3 轮 = 3 行 turns。
  assert.equal(d.tables.sessions, 4);
  assert.equal(d.tables.turns, 3, "轮次行数来自 turns 表本身");
  assert.equal(d.tables.ledger, 2);

  // 库文件认 SQLite（含 WAL 字段），字节数就是那个文件的大小。
  assert.equal(d.db.file, file);
  assert.equal(d.db.bytes, fs.statSync(file).size);
  assert.equal(d.db.walBytes, fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0);

  // 账本：行数之外，还要给出条目数（msgCount 之和）与来源文件。
  assert.equal(d.ledger.rows, 2);
  assert.equal(d.ledger.entries, 10);
  assert.equal(d.ledger.file, "usage-ledger.sqlite");

  assert.deepEqual(d.cache, { version: 25, lastScan: "2026-10-01T03:58:41.606Z", ready: true });
  assert.equal(d.persist, PERSIST, "落盘统计原样带出来");
  assert.equal(d.payload, null, "不点「量一次」就不重算整份看板");

  store.close();
});

test("体检：bytes=1 才拆载荷，且只拆过桥的键（不拿下划线开头的残余冒充）", { skip: !DatabaseSync }, async () => {
  const { store, cachePath } = makeStore();
  const ctx = makeCtx({ turnsStore: store, cachePath });

  const d = await ctx._buildDiagnostics({ bytes: true, range: "all" });
  assert.ok(d.payload, "要有载荷分解");
  assert.ok(d.payload.totalBytes > 0);
  assert.ok(Array.isArray(d.payload.parts) && d.payload.parts.length > 0);
  for (const p of d.payload.parts) {
    assert.equal(typeof p.key, "string");
    assert.ok(Number.isFinite(p.bytes) && p.bytes >= 0, p.key + " 的字节数要是个数");
    assert.ok(!p.key.startsWith("_"), "下划线开头的是路由自用残余，不该算进载荷：" + p.key);
  }
  // 明细那一块必定在：它本来就是整份看板的一部分。
  assert.ok(d.payload.parts.some((p) => p.key === "details"));

  store.close();
});

test("体检：没有缓存时不抛，也不编数字", async () => {
  const ctx = { _tokenCache: undefined };
  registerDashboard({ get() {}, post() {} }, ctx);
  const d = await ctx._buildDiagnostics({});
  assert.deepEqual(d.tables, { sessions: null, turns: null, ledger: null });
  assert.deepEqual(d.db, { bytes: null, walBytes: null, file: null });
  assert.deepEqual(d.ledger, { rows: null, entries: null, file: null });
  assert.equal(d.cache.version, null);
  assert.equal(d.payload, null);
});
