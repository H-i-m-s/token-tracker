import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import 引擎前指定 HOME，引擎顶层会据此解析 agents / usage-ledger.json 路径。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-data-"));
fs.mkdirSync(path.join(home, "agents"), { recursive: true });
process.env.HANA_HOME = home;

const { default: Engine } = await import("../runtime/engine/index.js");
const { openArchiveStore, journalPathForArchive } = await import("../runtime/engine/services/archive-store.js");

const log = { info() {}, warn() {}, error() {} };
const disposers = [];

function makeEngine() {
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

test("onload 把旧 usage-archive.json 迁移为追加日志，账本并入后重复扫描不重复归档", async () => {
  const archivePath = path.join(dataDir, "usage-archive.json");
  // 旧版单文件归档：一条历史
  fs.writeFileSync(archivePath, JSON.stringify({
    version: 1,
    updatedAt: "2026-07-01T00:00:00.000Z",
    entries: { "legacy-1": { t: "2026-07-01T00:00:00.000Z", a: "hanako", k: "utility", i: 1, o: 2, tot: 3 } },
  }));
  // 账本：一条新记录，应被并入归档
  fs.writeFileSync(path.join(home, "usage-ledger.json"), JSON.stringify({
    entries: [{
      requestId: "req-1",
      startedAt: "2026-08-01T10:00:00.000Z",
      endedAt: "2026-08-01T10:00:05.000Z",
      durationMs: 5000,
      attribution: { agentId: "hanako", kind: "utility" },
      model: { provider: "deepseek", modelId: "deepseek-chat" },
      source: { subsystem: "memory" },
      usage: { input: { totalTokens: 100 }, output: { totalTokens: 50 }, totalTokens: 150, costTotal: 0.01 },
    }],
  }));

  const engine = makeEngine();
  await engine.onload();
  await engine.ctx._tokenCache.scan(false); // 等首轮扫描落定

  // 迁移发生：旧文件改名留底，日志生成
  assert.ok(fs.existsSync(archivePath + ".imported"), "旧归档应改名留底");
  assert.ok(!fs.existsSync(archivePath), "旧归档不应原位保留");
  const journal = journalPathForArchive(archivePath);
  assert.ok(fs.existsSync(journal), "应生成追加日志");

  const store = openArchiveStore(archivePath, log);
  assert.ok(store.entries["legacy-1"], "迁移的历史必须保留");
  assert.ok(store.entries["req-1"], "账本新记录应并入归档");
  const sizeAfterFirst = store.size();

  // 再扫一次：账本没变，不应重复归档
  await engine.ctx._tokenCache.scan(true);
  const reopened = openArchiveStore(archivePath, log);
  assert.equal(reopened.size(), sizeAfterFirst, "重复扫描不应重复归档");

  // 退出清理
  for (const fn of disposers.reverse()) { try { fn(); } catch {} }
});
