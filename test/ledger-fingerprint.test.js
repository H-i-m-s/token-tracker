// 账本行的内容指纹：账本没有文件属性可比，以前靠调用方整批补报，
// 于是「账本一动」就等于「六十多行全部重写一遍」（真数据上约 236 KB，每天上百次）。
// 这里验的是它收敛后的行为：内容没变就不写，只有真正变的那一天会被重写。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 引擎顶层就要求这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-fp-home-"));
process.env.HANA_HOME = home;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-fp-data-"));
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;

const log = { info() {}, warn() {}, error() {} };
const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");
const Driver = loadSqliteDriver();
const LEDGER = path.join(home, "usage-ledger.sqlite");

// 建表语句照抄宿主（只留读取需要的列）
function openLedger() {
  const db = new Driver(LEDGER);
  db.exec("CREATE TABLE IF NOT EXISTS usage_entries(entry_order INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, entry_json TEXT NOT NULL)");
  return db;
}

const entry = (id, day) => ({
  requestId: id, startedAt: `${day}T06:00:00.000Z`, endedAt: `${day}T06:00:03.000Z`, durationMs: 3000,
  status: "ok", attribution: { kind: "memory", agentId: "hanako" },
  model: { provider: "deepseek", modelId: "deepseek-flash" },
  usage: { totalTokens: 150, input: { totalTokens: 100 }, output: { totalTokens: 50 } },
});

function append(rows) {
  const db = openLedger();
  const ins = db.prepare("INSERT OR IGNORE INTO usage_entries(request_id, started_at, ended_at, status, provider, model_id, entry_json) VALUES (?,?,?,?,?,?,?)");
  for (const e of rows) ins.run(e.requestId, e.startedAt, e.endedAt, e.status, e.model.provider, e.model.modelId, JSON.stringify(e));
  db.close();
}

// 碰一下账本文件：来源指纹（mtime/size）变了，内容一个字节没动。
function touchLedgerFile() {
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(LEDGER, t, t);
}

append([entry("r1", "2026-09-09"), entry("r2", "2026-09-09")]);

const { default: Engine } = await import("../runtime/engine/index.js");

async function boot() {
  const engine = new Engine();
  engine.ctx = {
    dataDir, config: { get: () => undefined }, log,
    bus: { async request() { return { agents: [] }; }, subscribe: () => () => {}, handle: () => () => {}, emit() {} },
  };
  engine.register = () => {};
  await engine.onload();
  return engine;
}

const flush = (engine) => {
  engine.ctx._tokenCache.persist.flushNow("测试");
  return engine.ctx._tokenCache.persist.stats;
};

test("账本行指纹：内容没变就不写，只有真正变的那一天被重写", { skip: !Driver }, async () => {
  const engine = await boot();
  await engine.ctx._tokenCache.scan(false);
  const first = flush(engine);
  assert.equal(first.lastRows, 1, "首扫写出账本那一行（同一天同 agent 聚成一行）");

  // 账本文件动了但内容没变：以前这里要把全部账本行整批补报重写，现在应当 0 行。
  touchLedgerFile();
  await engine.ctx._tokenCache.scan(false);
  const second = flush(engine);
  assert.equal(second.lastRows, 0, "账本文件属性变了、内容没变，不该写任何行");
  assert.equal(second.lastBytes, 0);

  // 真多了一条记录、落在另一天：只该重写那一天那一行。
  append([entry("r3", "2026-09-10")]);
  await engine.ctx._tokenCache.scan(false);
  const third = flush(engine);
  assert.equal(third.lastRows, 1, "只有新增记录所属的那一天需要重写");
  assert.match(third.lastDetail, /^1 行内容变过/);

  // 同一天再来一条：还是只动那一行（这是最常见的形态，账本每分钟都在长）
  append([entry("r4", "2026-09-10")]);
  await engine.ctx._tokenCache.scan(false);
  const fourth = flush(engine);
  assert.equal(fourth.lastRows, 1, "同一天的新记录仍然只重写当天那一行");

  const db = new Driver(path.join(dataDir, "cache.sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT key, record FROM sessions WHERE key LIKE '__ledger__%' ORDER BY key").all();
  db.close();
  assert.equal(rows.length, 2, "两天两行");
  const byKey = new Map(rows.map((r) => [r.key, JSON.parse(r.record)]));
  const nine = byKey.get("__ledger__hanako::memory::2026-09-09");
  const ten = byKey.get("__ledger__hanako::memory::2026-09-10");
  assert.equal(nine.totalTokens, 300, "09-09 两笔 × 150，没有因为别处改动被算重");
  assert.equal(ten.totalTokens, 300, "09-10 也是两笔");
  assert.ok(nine.size > 0 && ten.size > 0, "账本行的 size 是内容指纹，不是 0");
  assert.notEqual(nine.size, ten.size, "内容不同的两天指纹不同");

  engine.ctx._tokenCache.persist.stop();
});
