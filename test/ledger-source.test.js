import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSqliteDriver } from "../runtime/engine/services/cache-store.js";
import { loadLedger } from "../runtime/engine/services/ledger-source.js";

const Driver = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tt-ledger-"));

// sqlite 的建表语句照抄宿主（只留读取需要的列）
function writeSqlite(dir, entries) {
  const db = new Driver(path.join(dir, "usage-ledger.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS usage_entries(entry_order INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, entry_json TEXT NOT NULL)");
  const ins = db.prepare("INSERT OR IGNORE INTO usage_entries(request_id, started_at, ended_at, status, provider, model_id, entry_json) VALUES (?,?,?,?,?,?,?)");
  for (const e of entries) ins.run(e.requestId, e.startedAt, e.endedAt, e.status, e.model.provider, e.model.modelId, JSON.stringify(e));
  db.close();
}

const entry = (id, kind, provider, modelId) => ({
  requestId: id, startedAt: "2026-09-09T14:00:00.000Z", endedAt: "2026-09-09T14:00:03.000Z",
  durationMs: 3000, status: "ok", attribution: { kind, agentId: "hanako" },
  model: { provider, modelId }, usage: { totalTokens: 100, input: { totalTokens: 60 }, output: { totalTokens: 40 } },
});

test("账本读取：优先 sqlite，条目原样返回", { skip: !Driver }, () => {
  const dir = tmp();
  writeSqlite(dir, [entry("r1", "memory", "deepseek", "deepseek-flash"), entry("r2", "utility", "火山引擎", "glm-5.3-flash")]);
  const led = loadLedger(dir, log);
  assert.equal(led.entries.length, 2);
  assert.deepEqual(led.entries.map((e) => e.requestId), ["r1", "r2"], "按写入顺序返回");
  assert.equal(led.entries[0].model.modelId, "deepseek-flash", "条目形状与旧 json 一致，上层不用改");
  assert.ok(led.sourcePath.endsWith("usage-ledger.sqlite"));
  assert.match(led.key, /^sqlite:/);
  assert.equal(loadLedger(dir, log).entries, led.entries, "指纹没变时复用同一份，不重复解析");
});

test("账本读取：sqlite 变了就重新解析", { skip: !Driver }, () => {
  const dir = tmp();
  writeSqlite(dir, [entry("r1", "memory", "deepseek", "deepseek-flash")]);
  const first = loadLedger(dir, log);
  assert.equal(first.entries.length, 1);
  // 追加一行（重新打开写，指纹随之变化）
  writeSqlite(dir, [entry("r1", "memory", "deepseek", "deepseek-flash"), entry("r2", "memory", "deepseek", "deepseek-pro")]);
  const second = loadLedger(dir, log);
  assert.equal(second.entries.length, 2, "账本长了要读得到");
  assert.notEqual(second.key, first.key);
});

test("账本读取：没有 sqlite 时退回 json", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "usage-ledger.json"), JSON.stringify({ version: 1, entries: [entry("j1", "memory", "deepseek", "deepseek-flash")] }));
  const led = loadLedger(dir, log);
  assert.equal(led.entries.length, 1);
  assert.equal(led.entries[0].requestId, "j1");
  assert.ok(led.sourcePath.endsWith("usage-ledger.json"));
  assert.match(led.key, /^json:/);
});

test("账本读取：两个来源都在时以 sqlite 为准", { skip: !Driver }, () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "usage-ledger.json"), JSON.stringify({ entries: [entry("json-only", "memory", "deepseek", "x")] }));
  writeSqlite(dir, [entry("sqlite-only", "memory", "deepseek", "y")]);
  assert.deepEqual(loadLedger(dir, log).entries.map((e) => e.requestId), ["sqlite-only"]);
});

test("账本读取：来源都缺失或损坏时不抛，返回空", { skip: !Driver }, () => {
  const empty = tmp();
  assert.deepEqual(loadLedger(empty, log).entries, []);
  const broken = tmp();
  fs.writeFileSync(path.join(broken, "usage-ledger.json"), "{ 不是 json");
  assert.deepEqual(loadLedger(broken, log).entries, []);
});
