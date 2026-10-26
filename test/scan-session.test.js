import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 引擎顶层按 HANA_HOME 解析 agents 路径，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-onesess-home-"));
process.env.HANA_HOME = home;

const log = { info() {}, warn() {}, error() {} };
const sessDir = path.join(home, "agents", "hanako", "sessions");
fs.mkdirSync(sessDir, { recursive: true });

// 真实文件名带时间前缀，sessionId 只是里面的一段 UUID —— 不能按路径拼。
const UUID_A = "01a16961-aaaa-4bbb-8ccc-000000000001";
const UUID_B = "01a16961-aaaa-4bbb-8ccc-000000000002";
const UUID_C = "01a16961-aaaa-4bbb-8ccc-000000000003";
const FILE_A = `2026-10-23T15-29-18-705Z_${UUID_A}.jsonl`;
const FILE_B = `2026-10-23T15-30-18-705Z_${UUID_B}.jsonl`;
const FILE_C = `2026-10-23T15-31-18-705Z_${UUID_C}.jsonl`;
const KEY = (fn) => `hanako::desktop::::${fn}`;

const line = (ts, message) => JSON.stringify({ type: "message", timestamp: ts, message });
const usage = (input, output) => ({ input, output, totalTokens: input + output });
const content = (input) => [
  line("2026-10-23T10:00:00.000Z", { role: "user", content: "问" }),
  line("2026-10-23T10:00:05.000Z", { role: "assistant", model: "m", provider: "p", usage: usage(input, 10) }),
].join("\n") + "\n";

/** 写文件并把 mtime 推到秒级以后的固定点，避免同毫秒被当成“没变” */
function write(file, input, mtimeSec) {
  const p = path.join(sessDir, file);
  fs.writeFileSync(p, content(input));
  const t = new Date(Date.now() + mtimeSec * 1000);
  fs.utimesSync(p, t, t);
  return t.getTime();
}

const { default: Engine } = await import("../runtime/engine/index.js");

function makeEngine(dataDir) {
  const disposers = [];
  const engine = new Engine();
  engine.ctx = {
    dataDir,
    config: { get: () => undefined },
    log,
    bus: { async request() { return { agents: [] }; }, subscribe: () => () => {}, handle: () => () => {}, emit() {} },
  };
  engine.register = (fn) => disposers.push(fn);
  return { engine, disposers };
}

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-onesess-data-"));
  const { engine, disposers } = makeEngine(dataDir);
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(false); // 首轮版本不匹配 → 全量，把三个会话都铺进缓存
  return { shared, disposers };
}

test("单会话扫描：只处理目标文件，别的会话连 mtime 都不动", async () => {
  write(FILE_A, 100, 10);
  write(FILE_B, 200, 20);
  write(FILE_C, 300, 30);
  const { shared, disposers } = await boot();

  try {
    assert.ok(shared.data.sessions[KEY(FILE_A)], "首轮应扫到 A");
    assert.equal(shared.data.sessions[KEY(FILE_B)].totalTokens, 210, "首轮应扫到 B");
    const beforeB = { mtime: shared.data.sessions[KEY(FILE_B)].mtime, total: shared.data.sessions[KEY(FILE_B)].totalTokens };

    // 三份文件全都改（内容 + mtime），但只对 A 发单会话扫描请求
    write(FILE_A, 999, 40);
    const mtimeB = write(FILE_B, 777, 50);
    const mtimeC = write(FILE_C, 888, 60);

    const p = shared.scanSession({ agentId: "hanako", sessionId: UUID_A });
    assert.ok(p && typeof p.then === "function", "单会话扫描返回 promise");
    await p;

    assert.equal(shared.data.sessions[KEY(FILE_B)].mtime, beforeB.mtime, "B 的 mtime 不该被碰");
    assert.equal(shared.data.sessions[KEY(FILE_B)].totalTokens, beforeB.total, "B 的 record 不该被重解析");
    assert.equal(shared.data.sessions[KEY(FILE_B)].mtime !== mtimeB, true, "B 在磁盘上确实变了，只是没扫它");
    assert.equal(shared.data.sessions[KEY(FILE_C)].mtime !== mtimeC, true, "C 也不该被扫");
    assert.equal(shared.data.sessions[KEY(FILE_C)].totalTokens, 310, "C 保持旧值");

    assert.equal(shared.data.sessions[KEY(FILE_A)].totalTokens, 1009, "A 被重新解析成新内容");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("单会话扫描走的是单文件路径：别的会话没改也照样不动", async () => {
  const { shared, disposers } = await boot();
  try {
    const beforeB = shared.data.sessions[KEY(FILE_B)].mtime;
    // 只改 A（B 一个字节都不动），单会话扫 A 之后 B 的 mtime 仍与缓存里一致
    write(FILE_A, 555, 70);
    await shared.scanSession({ agentId: "hanako", sessionId: UUID_A });
    assert.equal(shared.data.sessions[KEY(FILE_B)].mtime, beforeB);
    assert.equal(shared.data.sessions[KEY(FILE_A)].totalTokens, 565);
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("反查不到 sessionId 时退回全量扫描，不能漏", async () => {
  const { shared, disposers } = await boot();
  try {
    const beforeB = shared.data.sessions[KEY(FILE_B)].mtime;
    write(FILE_B, 424, 80);

    // 一个根本不存在的 sessionId：反查必然落空
    await shared.scanSession({ agentId: "hanako", sessionId: "ffffffff-0000-0000-0000-000000000000" });
    assert.notEqual(shared.data.sessions[KEY(FILE_B)].mtime, beforeB, "兜底全扫应该把改过的 B 捞到");
    assert.equal(shared.data.sessions[KEY(FILE_B)].totalTokens, 434);
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("并发不吞：扫描进行中连来两个不同会话的请求，两个都扫到", async () => {
  // 先把三个会话的文件都摆成“已改过”的样子，但只对 A、B 发请求
  write(FILE_A, 111, 90);
  write(FILE_B, 222, 100);
  write(FILE_C, 333, 110);
  const { shared, disposers } = await boot();

  try {
    write(FILE_A, 1111, 120);
    write(FILE_B, 2222, 130);
    const beforeC = shared.data.sessions[KEY(FILE_C)].mtime;

    // 不 await，连发两个：第二个请求正好落在第一个的扫描进行中
    const pA = shared.scanSession({ agentId: "hanako", sessionId: UUID_A });
    const pB = shared.scanSession({ agentId: "hanako", sessionId: UUID_B });
    await Promise.all([pA, pB]);

    assert.equal(shared.data.sessions[KEY(FILE_A)].totalTokens, 1121, "A 扫到新内容");
    assert.equal(shared.data.sessions[KEY(FILE_B)].totalTokens, 2232, "B 也必须扫到，不能被合并吞掉");
    assert.equal(shared.data.sessions[KEY(FILE_C)].mtime, beforeC, "C 没被请求，仍是单文件路径");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("并发不吞：第一个会话扫到一半时再来的请求，当前这轮结束后会被补扫", async () => {
  const { shared, disposers } = await boot();
  try {
    write(FILE_A, 1234, 160);
    write(FILE_B, 5678, 170);

    // 第一轮先跑起来，隔两拍再发第二个：那时 drain 已经在 while 里跑过至少一次跌代，
    // 集合已经处理掉第一个。这就测到「补扫期间新来的继续进集合」。
    const pA = shared.scanSession({ agentId: "hanako", sessionId: UUID_A });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const pB = shared.scanSession({ agentId: "hanako", sessionId: UUID_B });
    await Promise.all([pA, pB]);

    assert.equal(shared.data.sessions[KEY(FILE_A)].totalTokens, 1244, "A 扫到");
    assert.equal(shared.data.sessions[KEY(FILE_B)].totalTokens, 5688, "后来的 B 也在同一串队列里补扫了");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("反查不把 agentId 当硬条件：agentId 对不上时放全找，不白退回全扫", async () => {
  const { shared, disposers } = await boot();
  try {
    write(FILE_A, 606, 180);
    write(FILE_B, 707, 190);
    const beforeB = shared.data.sessions[KEY(FILE_B)].mtime;

    // 事件报的 agentId 与实际目录不一致（子代理会报父代理的 id 之类）：
    // 仍应只扫 A，不能因为 agentId 对不上就退成全扫把 B 也捞进来。
    await shared.scanSession({ agentId: "someone-else", sessionId: UUID_A });
    assert.equal(shared.data.sessions[KEY(FILE_A)].totalTokens, 616, "A 按文件名反查到了");
    assert.equal(shared.data.sessions[KEY(FILE_B)].mtime, beforeB, "没退成全扫，B 不该被动");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("并发不吞：全量扫描进行中进来的单会话请求也不会丢", async () => {
  const { shared, disposers } = await boot();
  try {
    write(FILE_A, 4321, 140);
    write(FILE_B, 8765, 150);

    // 先起一轮增量全扫（scanAll 内部会 await 让出事件循环），期间再排两个单会话请求
    const pScan = shared.scan(false);
    const pA = shared.scanSession({ agentId: "hanako", sessionId: UUID_A });
    const pB = shared.scanSession({ agentId: "hanako", sessionId: UUID_B });
    await Promise.all([pScan, pA, pB]);

    assert.equal(shared.data.sessions[KEY(FILE_A)].totalTokens, 4331);
    assert.equal(shared.data.sessions[KEY(FILE_B)].totalTokens, 8775);
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});
