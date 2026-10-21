import test from "node:test";
import assert from "node:assert/strict";
import { presentFiles, sweepVanished } from "../runtime/engine/services/scan-sweep.js";

// 会话文件被删掉之后，缓存里那一行必须跟着消失。
// 不删的后果不是少一条记录：它的用量会永久留在总量、日图、模型榜与 turns 表里，
// 于是「清掉旧会话让统计干净」这件事永远不生效。

const win = (dir, name) => `${dir}\\${name}`;

test("文件还在：一条都不动", () => {
  const dir = "C:\\H\\agents\\hanako\\sessions";
  const cache = { sessions: { a: { filePath: win(dir, "s1.jsonl") } } };
  const touched = new Set();
  const changed = sweepVanished(cache, touched, [{ dir, present: presentFiles(dir, ["s1.jsonl"]) }]);
  assert.equal(changed, false);
  assert.equal(Object.keys(cache.sessions).length, 1);
  assert.equal(touched.size, 0);
});

test("文件没了：删掉缓存行，并记进 touched（turns 表按它删行）", () => {
  const dir = "C:\\H\\agents\\hanako\\sessions";
  const cache = { sessions: { a: { filePath: win(dir, "gone.jsonl") }, b: { filePath: win(dir, "stay.jsonl") } } };
  const touched = new Set();
  const changed = sweepVanished(cache, touched, [{ dir, present: presentFiles(dir, ["stay.jsonl"]) }]);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(cache.sessions), ["b"]);
  assert.deepEqual([...touched], ["a"]);
});

test("sessions/ 与 sessions/archived/ 同名文件：只按目录归属删，不按目录名猜", () => {
  // 真实键是 agent::desktop::::文件名，两个目录会撞同一个键，缓存里只留得下一条
  //（filePath 指向后扫到的那个）。扫 sessions/ 时不能因为“这个名字不在 sessions/ 里”
  // 就把 archived/ 里那条删掉。
  const live = "C:\\H\\agents\\hanako\\sessions";
  const arch = "C:\\H\\agents\\hanako\\sessions\\archived";
  const cache = { sessions: { same: { filePath: win(arch, "2026-10-01T00-00-00.jsonl") } } };
  const changed = sweepVanished(cache, new Set(), [
    { dir: live, present: presentFiles(live, ["2026-10-02T00-00-00.jsonl"]) },
    { dir: arch, present: presentFiles(arch, ["2026-10-01T00-00-00.jsonl"]) },
  ]);
  assert.equal(changed, false);
  assert.ok(cache.sessions.same, "archived/ 里的会话不能因为扫 sessions/ 而被删");
});

test("账本条目（没有 filePath）一律不动", () => {
  const dir = "C:\\H\\agents\\hanako\\sessions";
  const cache = { sessions: { __ledger__x: { entries: [1, 2, 3] } } };
  const changed = sweepVanished(cache, new Set(), [{ dir, present: presentFiles(dir, []) }]);
  assert.equal(changed, false);
  assert.ok(cache.sessions.__ledger__x);
});

test("本轮没扫到那个目录：里面的一律不动", () => {
  // 目录整个不存在（比如 agent 被移除）时不该顺手清空它的历史
  const missing = "C:\\H\\agents\\gone\\sessions";
  const cache = { sessions: { a: { filePath: win(missing, "s.jsonl") } } };
  const changed = sweepVanished(cache, new Set(), [
    { dir: "C:\\H\\agents\\hanako\\sessions", present: new Set() },
  ]);
  assert.equal(changed, false);
  assert.ok(cache.sessions.a);
});

test("没扫任何目录 / 缓存形状不对：安全返回 false", () => {
  assert.equal(sweepVanished({ sessions: {} }, new Set(), []), false);
  assert.equal(sweepVanished({ sessions: {} }, new Set(), null), false);
  assert.equal(sweepVanished({}, new Set(), [{ dir: "x", present: new Set() }]), false);
  assert.equal(sweepVanished(null, new Set(), [{ dir: "x", present: new Set() }]), false);
});
