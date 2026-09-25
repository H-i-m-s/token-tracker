import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonJournalStore } from "../runtime/engine/services/json-journal-store.js";

const silent = () => {};
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "tt-cache-")); }
const sess = (mtime, size, v) => ({ mtime, size, v });

test("旧 token-cache.json 可直接作为基线读取", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  fs.writeFileSync(file, JSON.stringify({ version: 21, lastScan: "x", sessions: { a: sess(1, 10, 1) } }));

  const d = createJsonJournalStore({ file, log: silent }).load();
  assert.equal(d.version, 21);
  assert.equal(d.lastScan, "x");
  assert.deepEqual(Object.keys(d.sessions), ["a"]);
});

test("增量只追加变化会话，基线不改写；重新打开能看到变化", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  fs.writeFileSync(file, JSON.stringify({ version: 21, sessions: { a: sess(1, 10, 1) } }));
  const baseText = fs.readFileSync(file, "utf8");

  const s = createJsonJournalStore({ file, log: silent });
  const d = s.load();
  d.sessions.a = sess(2, 20, 2);   // 变更
  d.sessions.b = sess(3, 30, 3);   // 新增
  const r = s.save(d, [], false);
  assert.equal(r.rows, 2);
  assert.equal(r.scope, "增量");
  assert.equal(fs.readFileSync(file, "utf8"), baseText, "基线文件不应被改写");
  assert.ok(fs.existsSync(file + ".journal"));

  const d2 = createJsonJournalStore({ file, log: silent }).load();
  assert.deepEqual(d2.sessions.a, sess(2, 20, 2));
  assert.deepEqual(Object.keys(d2.sessions).sort(), ["a", "b"]);
});

test("删除会话会写入删除记录并生效", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  fs.writeFileSync(file, JSON.stringify({ version: 21, sessions: { a: sess(1, 10, 1), b: sess(1, 11, 1) } }));

  const s = createJsonJournalStore({ file, log: silent });
  const d = s.load();
  delete d.sessions.b;
  const r = s.save(d, [], false);
  assert.equal(r.rows, 1);
  assert.equal(r.why.gone, 1);

  const d2 = createJsonJournalStore({ file, log: silent }).load();
  assert.deepEqual(Object.keys(d2.sessions), ["a"]);
  assert.equal(d2.sessions.b, undefined);
});

test("saveMeta 单独保存非 sessions 字段，load 可见", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  fs.writeFileSync(file, JSON.stringify({ version: 21, sessions: { a: sess(1, 10, 1) } }));

  const s = createJsonJournalStore({ file, log: silent });
  s.load();
  s.saveMeta({ version: 21, lastScan: "y", persist: { writes: 5 }, agentNames: { z: "Z" } });

  const d2 = createJsonJournalStore({ file, log: silent }).load();
  assert.equal(d2.lastScan, "y");
  assert.deepEqual(d2.persist, { writes: 5 });
  assert.deepEqual(d2.agentNames, { z: "Z" });
  assert.deepEqual(Object.keys(d2.sessions), ["a"]);
});

test("日志达到阈值自动合并：基线自洽、日志清空、内容一致", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  fs.writeFileSync(file, JSON.stringify({ version: 21, sessions: { a: sess(1, 10, 1) } }));

  const s = createJsonJournalStore({ file, log: silent, compactRecords: 2 });
  const d = s.load();
  d.sessions.b = sess(2, 20, 2);
  d.sessions.c = sess(3, 30, 3);
  s.save(d, [], false); // 追加 2 行 → 达到阈值 → 合并
  assert.ok(!fs.existsSync(file + ".journal"), "合并后日志应被清空");

  const d2 = createJsonJournalStore({ file, log: silent }).load();
  assert.deepEqual(Object.keys(d2.sessions).sort(), ["a", "b", "c"]);
  assert.equal(d2.version, 21);
});

test("半截尾行不影响读取，且下次追加先封口不污染", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  const journal = file + ".journal";
  fs.writeFileSync(file, JSON.stringify({ version: 21, sessions: { a: sess(1, 10, 1) } }));
  fs.writeFileSync(journal, [
    JSON.stringify({ k: "b", m: 2, s: 2, v: sess(2, 2, 2) }),
    '{"k":"c","m":3,"s":3', // 半截行，无换行
  ].join("\n"));

  const s = createJsonJournalStore({ file, log: silent });
  const d = s.load();
  assert.ok(d.sessions.b);
  assert.equal(d.sessions.c, undefined);

  d.sessions.e = sess(5, 5, 5);
  s.save(d, [], false);

  const d2 = createJsonJournalStore({ file, log: silent }).load();
  assert.ok(d2.sessions.e);
  assert.ok(d2.sessions.b);
  assert.equal(d2.sessions.c, undefined);
});

test("只有 meta 时 load 返回 null（不被误判为有效），但 readMeta 仍可读、meta 文件保留", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  createJsonJournalStore({ file, log: silent }).saveMeta({ version: 21, lastScan: "z", persist: { writes: 2 } });

  const store = createJsonJournalStore({ file, log: silent });
  assert.equal(store.load(), null, "无会话不应被当作有效缓存");
  assert.deepEqual(store.readMeta(), { version: 21, lastScan: "z", persist: { writes: 2 } });
  assert.ok(fs.existsSync(file + ".meta"), "meta 文件应保留，不静默丢失");
});

test("readMeta 合并基线里的非会话字段，日志仍影响 sessions", () => {
  const dir = tmp();
  const file = path.join(dir, "token-cache.json");
  fs.writeFileSync(file, JSON.stringify({ version: 21, lastScan: "base", sessions: { a: sess(1, 10, 1) } }));
  const s = createJsonJournalStore({ file, log: silent });
  s.load();
  s.saveMeta({ lastScan: "meta", persist: { writes: 1 } });

  const store = createJsonJournalStore({ file, log: silent });
  assert.deepEqual(store.readMeta(), { version: 21, lastScan: "meta", persist: { writes: 1 } });
  assert.deepEqual(Object.keys(store.load().sessions), ["a"]);
});
