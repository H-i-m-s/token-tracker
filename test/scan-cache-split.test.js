import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 引擎顶层按 HANA_HOME 解析 agents 路径，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-split-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-split-data-"));
process.env.HANA_HOME = home;

// ── 造一份会话文件：两轮，第一轮两次调用 ──
const line = (ts, message) => JSON.stringify({ type: "message", timestamp: ts, message });
const usage = (input, output, cacheRead, cacheWrite, reasoning) => ({
  input, output, cacheRead, cacheWrite, reasoning,
  // 与真实记录一致：总数 = 未命中输入 + 命中输入 + 输出（cacheWrite 不计入总数）
  totalTokens: input + output + cacheRead,
});
const dir = path.join(home, "agents", "hanako", "sessions");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "2026-09-30T12-00-00-000Z_split.jsonl"), [
  line("2026-09-30T12:00:00.000Z", { role: "user", content: "第一轮" }),
  line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "deepseek-flash", provider: "deepseek", usage: usage(1000, 200, 5000, 800, 50) }),
  line("2026-09-30T12:00:09.000Z", { role: "assistant", model: "deepseek-flash", provider: "deepseek", usage: usage(500, 100, 9000, 0, 20) }),
  line("2026-09-30T12:01:00.000Z", { role: "user", content: "第二轮" }),
  line("2026-09-30T12:01:04.000Z", { role: "assistant", model: "deepseek-flash", provider: "deepseek", usage: usage(700, 300, 2000, 0, 0) }),
].join("\n") + "\n");

const { default: Engine } = await import("../runtime/engine/index.js");

test("扫描把缓存拆分留在轮次记录里，且不影响原有口径", async () => {
  const engine = new Engine();
  const disposers = [];
  engine.ctx = {
    dataDir,
    config: { get: () => undefined },
    log: { info() {}, warn() {}, error() {} },
    bus: { async request() { return { agents: [] }; }, subscribe: () => () => {}, handle: () => () => {}, emit() {} },
  };
  engine.register = (fn) => disposers.push(fn);
  await engine.onload();
  await engine.ctx._tokenCache.scan(false);

  const sessions = engine.ctx._tokenCache.data?.sessions || {};
  const sess = Object.values(sessions).find((s) => s.conversations?.length);
  assert.ok(sess, "应该扫到那份会话");
  assert.equal(sess.conversations.length, 2, "两轮");

  const [t1, t2] = sess.conversations;
  // 第一轮：两次调用
  assert.equal(t1.msgCount, 2, "调用次数");
  assert.equal(t1.cacheRead, 14000, "命中缓存的输入 = 5000 + 9000");
  assert.equal(t1.cacheWrite, 800, "写缓存的令牌 = 800 + 0");
  assert.equal(t1.reasoning, 70, "推理令牌 = 50 + 20");
  // 老口径不许动：输入仍是「未命中 + 命中」，总数仍是三次之和
  assert.equal(t1.inTokens, 15500, "输入 = (1000+5000) + (500+9000)，老口径不变");
  assert.equal(t1.outTokens, 300, "输出不变");
  assert.equal(t1.totalTokens, 15800, "总数不变");
  assert.equal(t1.inTokens + t1.outTokens, t1.totalTokens, "输入 + 输出 = 总数（逐条实测成立的关系要保住）");

  // 第二轮：一次调用
  assert.equal(t2.msgCount, 1);
  assert.equal(t2.cacheRead, 2000);
  assert.equal(t2.cacheWrite, 0, "缺失的字段按 0 计，不产生 NaN");
  assert.equal(t2.reasoning, 0);
  assert.equal(t2.inTokens, 2700);
  assert.equal(t2.inTokens + t2.outTokens, t2.totalTokens);

  for (const fn of disposers.reverse()) { try { fn(); } catch {} }
});
