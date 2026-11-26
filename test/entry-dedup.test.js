import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import 引擎前指定 HOME，引擎顶层会据此解析 agents 路径。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dedup-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dedup-data-"));
process.env.HANA_HOME = home;

const sessionsDir = path.join(home, "agents", "hanako", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(path.join(home, "agents"), { recursive: true });

const { default: Engine } = await import("../runtime/engine/index.js");

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

// ── 造会话文件：Hana 的 fork 就是把父会话的历史整行复制进新文件 ──
function header(id, ts, parent) {
  const o = { type: "session", id, timestamp: ts, version: 3, cwd: "D:/Agent" };
  if (parent) o.parentSession = parent;
  return JSON.stringify(o);
}

function userMsg(id, ts) {
  return JSON.stringify({ type: "message", id, timestamp: ts, message: { role: "user", timestamp: ts, content: [] } });
}

function assistantMsg(id, ts, total) {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: ts,
    message: {
      role: "assistant",
      timestamp: ts,
      model: "test-model",
      provider: "test-provider",
      content: [],
      usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total },
    },
  });
}

const DAY = "2026-11-25";
const T = (h) => `${DAY}T0${h}:00:00.000Z`;

// 父会话：两次带用量的调用，共 100 + 200 = 300
const parentLines = [
  header("sess-a", T(1)),
  userMsg("u1", T(1)),
  assistantMsg("a1", T(1), 100),
  userMsg("u2", T(2)),
  assistantMsg("a2", T(2), 200),
];
// 子会话：整段复制父的历史，末尾多一轮 300
const childLines = [
  header("sess-b", T(3), path.join(sessionsDir, "2026-11-25T01-00-00-000Z_sess-a.jsonl")),
  userMsg("u1", T(1)),
  assistantMsg("a1", T(1), 100),
  userMsg("u2", T(2)),
  assistantMsg("a2", T(2), 200),
  userMsg("u3", T(3)),
  assistantMsg("a3", T(3), 300),
];

fs.writeFileSync(path.join(sessionsDir, "2026-11-25T01-00-00-000Z_sess-a.jsonl"), parentLines.join("\n") + "\n");
fs.writeFileSync(path.join(sessionsDir, "2026-11-25T03-00-00-000Z_sess-b.jsonl"), childLines.join("\n") + "\n");

test("会话分叉复制的历史只统计一次，重复扫描也不再加", async () => {
  const engine = makeEngine();
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(true);

  const sum = () => {
    let n = 0;
    for (const row of Object.values(shared.data.sessions)) n += row.totalTokens || 0;
    return n;
  };

  // 100 + 200 + 300：父的历史被复制进子文件，但只算一遍
  assert.equal(sum(), 600, "重复的 entry 只应统计一次");

  // 子会话自己那一轮照常算在它名下
  const child = shared.data.sessions["hanako::desktop::::2026-11-25T03-00-00-000Z_sess-b.jsonl"];
  assert.equal(child.totalTokens, 300, "子会话只留它自己的新增");
  const parent = shared.data.sessions["hanako::desktop::::2026-11-25T01-00-00-000Z_sess-a.jsonl"];
  assert.equal(parent.totalTokens, 300, "父会话保留自己的全部");

  // 再扫一次：mtime 没变，结果不变
  await shared.scan(true);
  assert.equal(sum(), 600, "重复扫描不应把量翻倍");
});

test("会话文件继续增长时，只加新增那一轮", async () => {
  const engine = makeEngine();
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(true);

  // 父会话在 fork 之后又被继续聊了：追加一轮 400
  fs.appendFileSync(
    path.join(sessionsDir, "2026-11-25T01-00-00-000Z_sess-a.jsonl"),
    userMsg("u4", T(4)) + "\n" + assistantMsg("a4", T(4), 400) + "\n",
  );
  await shared.scan(false);

  const sum = () => {
    let n = 0;
    for (const row of Object.values(shared.data.sessions)) n += row.totalTokens || 0;
    return n;
  };
  assert.equal(sum(), 1000, "600 + 新增的 400");
});

test("entry_owner 表随扫描落库，重启后仍认得已统计过的 entry", async () => {
  const { createEntryOwnerStore, hashEntryId } = await import("../runtime/engine/services/entry-owner.js");
  const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");
  const DatabaseSync = loadSqliteDriver();
  assert.ok(DatabaseSync, "本机应有 node:sqlite");

  const store = createEntryOwnerStore({ DatabaseSync, file: path.join(dataDir, "probe.sqlite"), log });
  assert.equal(store.claim("x1", "owner-1"), true, "第一次认领成功");
  assert.equal(store.claim("x1", "owner-2"), false, "同一个 id 第二次被拒");
  store.flushDelta();

  const again = createEntryOwnerStore({ DatabaseSync, file: path.join(dataDir, "probe.sqlite"), log });
  again.ensureLoaded();
  assert.equal(again.claim("x1", "owner-3"), false, "重新打开后仍认得");
  assert.equal(again.claim("x2", "owner-3"), true);
  assert.equal(again.count(), 1, "落库的只有已提交的那一条");
  again.close();
  store.close();

  // 指纹函数本身要稳定且落在这个精度里
  assert.equal(hashEntryId("abc"), hashEntryId("abc"));
  assert.notEqual(hashEntryId("abc"), hashEntryId("abd"));
  assert.ok(hashEntryId("abc") < 2 ** 53);
});

test("全量重建中途失败不会留下半张表", async () => {
  const { createEntryOwnerStore } = await import("../runtime/engine/services/entry-owner.js");
  const { loadSqliteDriver } = await import("../runtime/engine/services/cache-store.js");
  const DatabaseSync = loadSqliteDriver();
  const file = path.join(dataDir, "probe2.sqlite");
  const store = createEntryOwnerStore({ DatabaseSync, file, log });

  store.claim("keep-1", "o1");
  store.flushDelta();
  assert.equal(store.count(), 1);

  // 开始重建但不 commit：库里的旧表必须原样保留
  store.beginRebuild();
  store.claim("new-1", "o2");
  assert.equal(store.count(), 1, "重建期间不碰库");
  assert.equal(store.isRebuilding(), true);
  store.close();
});

test.after(() => { for (const d of disposers) { try { d(); } catch {} } });
