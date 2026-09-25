import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSqliteDriver } from "../runtime/engine/services/cache-store.js";

// 必须在 import 引擎前指定 HOME（引擎顶层据此解析 agents / usage-ledger.json 路径）。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-home-"));
fs.mkdirSync(path.join(home, "agents"), { recursive: true });
process.env.HANA_HOME = home;

const { default: Engine } = await import("../runtime/engine/index.js");
const hasSqlite = !!loadSqliteDriver();

function makeEngine(log, disposers, dataDir) {
  const engine = new Engine();
  const bus = {
    async request() { return { agents: [] }; },
    subscribe() { return () => {}; },
    handle() { return () => {}; },
    emit() {},
  };
  engine.ctx = { dataDir, config: { get: () => undefined }, log, bus };
  engine.register = (fn) => disposers.push(fn);
  return engine;
}

const log = { info() {}, warn() {}, error() {} };

test("sqlite 导入旧快照后清理 .journal / .meta 边车，留下自洽的 .imported", { skip: !hasSqlite }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-data-"));
  const cachePath = path.join(dataDir, "token-cache.json");
  fs.writeFileSync(cachePath, JSON.stringify({ version: 21, lastScan: "legacy", sessions: { a: { mtime: 1, size: 1 } } }));
  fs.writeFileSync(cachePath + ".journal", JSON.stringify({ k: "b", m: 2, s: 2, v: { mtime: 2, size: 2 } }) + "\n");
  fs.writeFileSync(cachePath + ".meta", JSON.stringify({ lastScan: "stale-meta", persist: { writes: 99 } }));

  const disposers = [];
  const engine = makeEngine(log, disposers, dataDir);
  await engine.onload();

  assert.ok(!fs.existsSync(cachePath), "旧 JSON 应被改名");
  assert.ok(!fs.existsSync(cachePath + ".meta"), "遗留 meta 应被清理，避免日后降级复活 stale");
  assert.ok(!fs.existsSync(cachePath + ".journal"), "遗留 journal 应被清理");
  const imported = JSON.parse(fs.readFileSync(cachePath + ".imported", "utf8"));
  assert.ok(imported.sessions.a, "留底应含基线会话");
  assert.ok(imported.sessions.b, "留底应含日志里的会话（自洽）");

  for (const fn of disposers.reverse()) { try { fn(); } catch {} }
});

test("sqlite 导入时已存在的 .imported 备份不被删除，改用带时间戳的新备份", { skip: !hasSqlite }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-data-"));
  const cachePath = path.join(dataDir, "token-cache.json");
  fs.writeFileSync(cachePath, JSON.stringify({ version: 21, lastScan: "legacy", sessions: { a: { mtime: 1, size: 1 } } }));
  fs.writeFileSync(cachePath + ".imported", "OLD-CACHE-BACKUP");

  const disposers = [];
  const engine = makeEngine(log, disposers, dataDir);
  await engine.onload();

  assert.equal(fs.readFileSync(cachePath + ".imported", "utf8"), "OLD-CACHE-BACKUP", "既有备份必须原样保留");
  const ts = fs.readdirSync(dataDir).filter((n) => n.startsWith("token-cache.json.imported-"));
  assert.equal(ts.length, 1, "本次快照应落到带时间戳的新备份");
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, ts[0]), "utf8")).sessions.a);

  for (const fn of disposers.reverse()) { try { fn(); } catch {} }
});
