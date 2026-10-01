import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTurnCalls } from "../runtime/engine/services/turn-calls.js";

// ── 造会话文件的工具 ──
const usage = (input, output, cacheRead, cacheWrite, reasoning) => ({
  input, output, cacheRead, cacheWrite, reasoning,
  totalTokens: input + output + cacheRead,
});
// 一条 message 记录（type:message + timestamp + message）
const line = (ts, message) => JSON.stringify({ type: "message", timestamp: ts, message });
const raw = (obj) => JSON.stringify(obj);
// 把一段会话正文落到临时文件，返回 { session, file }
function writeSession(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-turn-"));
  const file = path.join(dir, "2026-09-30T12-00-00-000Z_x.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { session: { type: "desktop", agent: "hanako", filePath: file }, file };
}

test("正常一轮：多条调用逐项对（合计、逐条、间隔、elapsed）", () => {
  const { session } = writeSession([
    line("2026-09-30T12:00:00.000Z", { role: "user", content: "第一轮" }),
    line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "A", provider: "P", usage: usage(1000, 200, 5000, 800, 50) }),
    line("2026-09-30T12:00:12.000Z", { role: "assistant", model: "A", provider: "P", usage: usage(500, 100, 9000, 0, 20) }),
  ]);
  const t = readTurnCalls({ session, seq: 1 });
  assert.equal(t.ok, true);
  assert.equal(t.kind, "session");
  assert.equal(t.seq, 1);
  assert.equal(t.time, "2026-09-30T12:00:00.000Z");
  assert.equal(t.model, "A");
  assert.equal(t.provider, "P");
  assert.equal(t.fileExists, true);
  assert.equal(t.calls, 2);
  assert.equal(t.failedCalls, 0);
  // 合计：input 含命中（未命中 + 命中缓存），与 conv.inTokens 同口径
  assert.deepEqual(
    { totalTokens: t.totalTokens, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, reasoning: t.reasoning },
    { totalTokens: 15800, input: 15500, output: 300, cacheRead: 14000, cacheWrite: 800, reasoning: 70 },
  );
  assert.equal(t.elapsedMs, 12000);   // 最后一条 message − 第一条
  assert.equal(t.truncated, false);
  assert.equal(t.callList.length, 2);
  // 逐条：单条 input 是「未命中」，totalTokens = input+output+cacheRead
  assert.deepEqual(t.callList[0], {
    time: "2026-09-30T12:00:05.000Z", model: "A", provider: "P",
    input: 1000, output: 200, cacheRead: 5000, cacheWrite: 800, reasoning: 50,
    totalTokens: 6200, failed: false, gapMs: 5000,     // 距上一条（user）
  });
  assert.deepEqual(t.callList[1], {
    time: "2026-09-30T12:00:12.000Z", model: "A", provider: "P",
    input: 500, output: 100, cacheRead: 9000, cacheWrite: 0, reasoning: 20,
    totalTokens: 9600, failed: false, gapMs: 7000,     // 距上一条 assistant
  });
});

test("失败调用：不计入合计，但要进 callList 并标 failed，failedCalls 单独计", () => {
  const { session } = writeSession([
    line("2026-09-30T12:00:00.000Z", { role: "user", content: "第一轮" }),
    line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "A", provider: "P", usage: usage(1000, 200, 0, 0, 0) }),
    // 三种失败判定各来一个（都带 usage）
    line("2026-09-30T12:00:09.000Z", { role: "assistant", model: "A", provider: "P", stopReason: "error", usage: usage(11, 11, 11, 0, 0) }),
    line("2026-09-30T12:00:13.000Z", { role: "assistant", model: "A", provider: "P", isError: true, usage: usage(22, 22, 22, 0, 0) }),
    line("2026-09-30T12:00:17.000Z", { role: "assistant", model: "A", provider: "P", errorMessage: "boom", usage: usage(33, 33, 33, 0, 0) }),
  ]);
  const t = readTurnCalls({ session, seq: 1 });
  assert.equal(t.calls, 1, "只有 1 次有效调用");
  assert.equal(t.failedCalls, 3);
  assert.deepEqual(
    { totalTokens: t.totalTokens, input: t.input, output: t.output },
    { totalTokens: 1200, input: 1000, output: 200 },
    "失败调用的数字一律不进合计",
  );
  assert.equal(t.callList.length, 4, "失败调用也进 callList");
  assert.deepEqual(t.callList.map((c) => c.failed), [false, true, true, true]);
  // 失败那条仍带它自己的用量（不影响合计）
  assert.equal(t.callList[1].input, 11);
});

test("user 边界：两轮之间不串，各自 time 与本轮调用独立", () => {
  const { session } = writeSession([
    line("2026-09-30T12:00:00.000Z", { role: "user", content: "A" }),
    line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "A", provider: "P", usage: usage(100, 10, 0, 0, 0) }),
    line("2026-09-30T12:01:00.000Z", { role: "user", content: "B" }),
    line("2026-09-30T12:01:05.000Z", { role: "assistant", model: "B", provider: "Q", usage: usage(200, 20, 0, 0, 0) }),
  ]);
  const t1 = readTurnCalls({ session, seq: 1 });
  const t2 = readTurnCalls({ session, seq: 2 });
  assert.equal(t1.time, "2026-09-30T12:00:00.000Z");
  assert.equal(t2.time, "2026-09-30T12:01:00.000Z");
  assert.equal(t1.calls, 1);
  assert.equal(t2.calls, 1);
  assert.equal(t1.callList.length, 1);
  assert.equal(t1.callList[0].input, 100, "第一轮不该混进第二轮的调用");
  assert.equal(t2.callList[0].input, 200);
  assert.equal(t1.model, "A");
  assert.equal(t2.model, "B");
});

test("末尾未收尾的一轮：user 之后没有 assistant 也要补上", () => {
  const { session } = writeSession([
    line("2026-09-30T12:00:00.000Z", { role: "user", content: "A" }),
    line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "A", provider: "P", usage: usage(100, 10, 0, 0, 0) }),
    line("2026-09-30T12:02:00.000Z", { role: "user", content: "C（没有回复就断了）" }),
  ]);
  const t2 = readTurnCalls({ session, seq: 2 });
  assert.equal(t2.ok, true, "第 2 轮存在（末尾补上）");
  assert.equal(t2.time, "2026-09-30T12:02:00.000Z");
  assert.equal(t2.calls, 0);
  assert.equal(t2.callList.length, 0);
  assert.equal(t2.elapsedMs, 0, "只有一条 message 时首尾相同");
  // 第 3 轮不存在
  assert.deepEqual(
    (({ ok, code }) => ({ ok, code }))(readTurnCalls({ session, seq: 3 })),
    { ok: false, code: "TURN_NOT_FOUND" },
  );
});

test("seq 越界 / 非法：TURN_NOT_FOUND，不抛", () => {
  const { session } = writeSession([
    line("2026-09-30T12:00:00.000Z", { role: "user", content: "A" }),
    line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "A", provider: "P", usage: usage(1, 1, 0, 0, 0) }),
  ]);
  for (const seq of [2, 99, 0, -1, NaN]) {
    const t = readTurnCalls({ session, seq });
    assert.equal(t.ok, false, "seq=" + seq);
    assert.equal(t.code, "TURN_NOT_FOUND", "seq=" + seq);
  }
});

test("账本聚合行：kind:'ledger'，不读文件，callList 空", () => {
  // filePath 故意指向一个「不是 JSONL」的文件：若被当会话读就会炸
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ledger-"));
  const notJsonl = path.join(dir, "usage-ledger.sqlite");
  fs.writeFileSync(notJsonl, "\u0000\u0001 not jsonl at all");
  const session = { type: "ledger", filePath: notJsonl };
  const t = readTurnCalls({ session, seq: 1 });
  assert.equal(t.ok, true);
  assert.equal(t.kind, "ledger");
  assert.deepEqual(t.callList, []);
  assert.equal(t.calls, 0);
  assert.equal(t.filePath, notJsonl, "账本行仍给出账本文件路径");
});

test("文件不存在：ok:true、fileExists:false、空壳，不抛", () => {
  const session = { type: "desktop", filePath: path.join(os.tmpdir(), "tt-nonexistent-" + Date.now() + ".jsonl") };
  const t = readTurnCalls({ session, seq: 1 });
  assert.equal(t.ok, true);
  assert.equal(t.kind, "session");
  assert.equal(t.fileExists, false);
  assert.deepEqual(t.callList, []);
  assert.equal(t.calls, 0);
  assert.equal(t.totalTokens, 0);
  // session 为空 → NO_SESSION_FILE（仍不抛）
  assert.deepEqual((( { ok, code } ) => ({ ok, code }))(readTurnCalls({ session: null, seq: 1 })), { ok: false, code: "NO_SESSION_FILE" });
});

test("非 message / model_change / 解析失败行都跳过；provider 取调用自身而非 model_change", () => {
  const { session } = writeSession([
    raw({ type: "model_change", provider: "SHOULD-NOT-BE-USED" }),
    "这不是 JSON{",
    raw({ type: "message", timestamp: "2026-09-30T12:00:00.000Z", message: { role: "user", content: "A" } }),
    raw({ type: "custom", timestamp: "2026-09-30T12:00:01.000Z", customType: "whatever", data: {} }),
    raw({ type: "message", timestamp: "2026-09-30T12:00:02.000Z", message: { role: "toolResult", toolName: "x", content: [] } }),
    line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "A", provider: "REAL", usage: usage(10, 1, 0, 0, 0) }),
  ]);
  const t = readTurnCalls({ session, seq: 1 });
  assert.equal(t.calls, 1);
  assert.equal(t.provider, "REAL", "provider 来自调用自身，不用 model_change 兜底");
  assert.equal(t.callList.length, 1);
});

test("ctx._readTurnCalls：registerDashboard 后离线可用；越界/缺参有码；路径安全", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rpc-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rpc-data-"));
  process.env.HANA_HOME = home;
  process.env.TOKEN_TRACKER_DATA_DIR = dataDir;
  const sessDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  const fn = "2026-09-30T12-00-00-000Z_y.jsonl";
  fs.writeFileSync(path.join(sessDir, fn), [
    line("2026-09-30T12:00:00.000Z", { role: "user", content: "A" }),
    line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "A", provider: "P", usage: usage(100, 10, 0, 0, 0) }),
  ].join("\n") + "\n");

  const disposers = [];
  const { default: Engine } = await import("../runtime/engine/index.js");
  const { default: registerDashboard } = await import("../runtime/engine/routes/dashboard.js");
  const engine = new Engine();
  engine.ctx = {
    dataDir, config: { get: () => undefined },
    log: { info() {}, warn() {}, error() {} },
    bus: {
      async request() { return { agents: [] }; }, subscribe: () => () => {},
      handle: () => () => {}, emit() {},
    },
  };
  engine.register = (off) => disposers.push(off);
  try {
    await engine.onload();
    await engine.ctx._tokenCache.scan(true);
    // 挂法与 _buildDashboardData 同：registerDashboard 在 ctx 上放 _readTurnCalls，离线可直调。
    registerDashboard({ get() {}, post() {} }, engine.ctx);
    const read = engine.ctx._readTurnCalls;
    assert.equal(typeof read, "function", "registerDashboard 后 ctx 上有 _readTurnCalls");
    const key = `hanako::desktop::::${fn}`;

    const t = await read(key, 1);
    assert.equal(t.ok, true);
    assert.equal(t.sessionKey, key, "回带 sessionKey");
    assert.equal(t.seq, 1);
    assert.equal(t.calls, 1);
    assert.equal(t.totalTokens, 110);
    assert.equal(t.callList.length, 1);

    // 越界 → TURN_NOT_FOUND；缺参 → BAD_REQUEST
    const pick = ({ ok, code }) => ({ ok, code });
    assert.deepEqual(pick(await read(key, 9)), { ok: false, code: "TURN_NOT_FOUND" });
    assert.deepEqual(pick(await read("", 1)), { ok: false, code: "BAD_REQUEST" });
    assert.deepEqual(pick(await read(key, 0)), { ok: false, code: "BAD_REQUEST" });
    // 路径安全：把文件路径当 sessionKey 传进来 → 不认，绝不读它
    assert.deepEqual(pick(await read(path.join(sessDir, fn), 1)), { ok: false, code: "NO_SESSION_FILE" });
    // seq 也接受字符串（HTTP query 传进来就是字符串）
    assert.equal((await read(key, "1")).ok, true);
  } finally {
    for (const off of disposers.reverse()) { try { off(); } catch {} }
  }
});

test("callList 上限 400：超出时截前 400 条并标 truncated", () => {
  const lines = [line("2026-09-30T12:00:00.000Z", { role: "user", content: "A" })];
  for (let i = 0; i < 405; i++) {
    const s = String(i).padStart(2, "0");
    lines.push(line(`2026-09-30T12:01:${s}.000Z`, { role: "assistant", model: "A", provider: "P", usage: usage(1, 1, 0, 0, 0) }));
  }
  const { session } = writeSession(lines);
  const t = readTurnCalls({ session, seq: 1 });
  assert.equal(t.truncated, true);
  assert.equal(t.callList.length, 400);
  assert.equal(t.calls, 405, "合计仍按全部有效调用计");
});
