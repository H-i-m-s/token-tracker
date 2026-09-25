import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistScheduler } from "../runtime/engine/index.js";
import { createJsonJournalStore } from "../runtime/engine/services/json-journal-store.js";
import { readJsonLines } from "../runtime/engine/services/jsonl-log.js";

const log = { info() {}, warn() {}, error() {} };

test("调度器 + JSON 追加日志：落盘只追加变化会话，不整库重写", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sched-"));
  const cachePath = path.join(dir, "token-cache.json");
  const store = createJsonJournalStore({ file: cachePath, log });
  store.load(); // 空库

  let current = { version: 21, lastScan: "x", agentNames: {}, sessions: { a: { mtime: 1, size: 1, v: 1 } } };
  const sched = createPersistScheduler({ cachePath, log, getData: () => current, store, flushMs: 600000 });

  sched.markDirty(["a"]);
  assert.equal(sched.flushNow("t1"), true);
  // 首次落盘走全量（rows 为空），但介质是追加日志，基线文件不该出现
  assert.ok(!fs.existsSync(cachePath), "增量介质不应写整份基线");
  const journal = cachePath + ".journal";
  assert.ok(fs.existsSync(journal), "应生成追加日志");

  // 第二轮：只变了一个会话，日志只多一行
  const before = readJsonLines(journal).records.length;
  current = { ...current, sessions: { a: { mtime: 1, size: 1, v: 1 }, b: { mtime: 2, size: 2, v: 2 } } };
  sched.markDirty(["b"]);
  sched.flushNow("t2");
  assert.equal(readJsonLines(journal).records.length, before + 1);

  // 重新打开能看到全部会话与 meta
  const loaded = createJsonJournalStore({ file: cachePath, log }).load();
  assert.deepEqual(Object.keys(loaded.sessions).sort(), ["a", "b"]);
  assert.equal(loaded.lastScan, "x");

  sched.stop();
});
