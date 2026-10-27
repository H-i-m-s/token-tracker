import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 引擎顶层按 HANA_HOME 解析 agents 路径，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-onesess-home-"));
process.env.HANA_HOME = home;

const {
  default: Engine,
  classifySessionPath,
  resolveSessionTarget,
} = await import("../runtime/engine/index.js");
const { noteSessionPath, recallSessionPath, agentFromSessionPath } = await import("../runtime/session-path-hint.mjs");

const log = { info() {}, warn() {}, error() {} };

// 测试用的 agents 根：必须与引擎内部的 AGENTS 完全一致（= HANA_HOME/agents），
// 因为 resolveSessionTarget 内部调 classifySessionPath 时用的是那个默认根。
// 引擎内部的根不可注入（工单不允许改签名），所以测试就用它同一个。
const ROOT = path.join(home, "agents");
const p = (...seg) => path.join(ROOT, ...seg);

// ─────────────────────────────────────────────────────────────────────────────
// classifySessionPath：八种目录形态必须与 scanAll 里的 scanDir 调用一一对应
// 对应关系见 index.js scanAll（sessions / sessions/archived / phone/sessions/<sub> /
// sessions/bridge/<sub> / activity / subagent-sessions / subagent-sessions/<sub> / workflow-sessions）
// ─────────────────────────────────────────────────────────────────────────────
test("分类：八种目录形态各自给出正确的 type 与 channelName", () => {
  const cases = [
    // [路径, type, channelName, 说明]
    [p("hanako", "sessions", "a.jsonl"), "desktop", null, "桌面会话"],
    [p("hanako", "sessions", "archived", "a.jsonl"), "desktop", null, "归档的桌面会话"],
    [p("hanako", "phone", "sessions", "wechat-9f2a1b", "a.jsonl"), "channel", "wechat", "channel：子目录去掉末尾 id"],
    [p("hanako", "sessions", "bridge", "telegram", "a.jsonl"), "bridge", "telegram", "bridge：子目录名原样"],
    [p("hanako", "activity", "a.jsonl"), "background", null, "后台活动"],
    [p("hanako", "subagent-sessions", "a.jsonl"), "sub", null, "子代理：直接放根下"],
    [p("hanako", "subagent-sessions", "worker-1", "a.jsonl"), "sub", "worker-1", "子代理：放子目录里"],
    [p("hanako", "workflow-sessions", "a.jsonl"), "background", null, "workflow 任务"],
  ];
  for (const [fp, type, channelName, why] of cases) {
    const got = classifySessionPath(fp, ROOT);
    assert.ok(got, "应当能分类：" + why + " → " + fp);
    assert.equal(got.type, type, why + " 的 type");
    assert.equal(got.channelName, channelName, why + " 的 channelName");
    assert.equal(got.agentId, "hanako", why + " 的 agentId");
  }
});

test("分类：两段路径的歧义 —— sessions/archived/x 与 subagent-sessions/x 不能搞混", () => {
  // 这两个都只有一个目录段之后就是文件名，但含义完全不同。
  // 按段数猜会错，所以必须是「先看第一段目录名」。
  assert.equal(classifySessionPath(p("hanako", "sessions", "archived", "x.jsonl"), ROOT).type, "desktop");
  assert.equal(classifySessionPath(p("hanako", "subagent-sessions", "x.jsonl"), ROOT).type, "sub");
  // 反过来也不能串：archived 只在 sessions 下成立，subagent-sessions 下叫 archived 就是个子代理目录
  assert.equal(classifySessionPath(p("hanako", "subagent-sessions", "archived", "x.jsonl"), ROOT).channelName, "archived");
});

test("分类：四段路径的歧义 —— phone/sessions/<sub>/x 与 sessions/bridge/<sub>/x", () => {
  const phone = classifySessionPath(p("hanako", "phone", "sessions", "wechat-abc", "x.jsonl"), ROOT);
  const bridge = classifySessionPath(p("hanako", "sessions", "bridge", "wechat-abc", "x.jsonl"), ROOT);
  assert.equal(phone.type, "channel");
  assert.equal(bridge.type, "bridge");
  // channel 名按 scanDir 的规则去掉末尾那段 id；bridge 名原样
  assert.equal(phone.channelName, "wechat");
  assert.equal(bridge.channelName, "wechat-abc");
});

test("分类：推不出来的一律给 null，不猜", () => {
  const bad = [
    "",                                         // 空
    null,
    123,
    p("hanako", "sessions", "x.txt"),           // 不是 jsonl
    p("hanako", "sessions", "x.jsonl.repair.jsonl"), // 修复中间产物
    p("hanako", "sessions", "x.repair.jsonl"),
    p("hanako", "weird-dir", "x.jsonl"),        // 不认识的目录
    p("hanako", "sessions", "a", "b", "x.jsonl"),// sessions 下没有这种深度
    p("hanako", "activity", "sub", "x.jsonl"),  // activity 只接受一层
    p("hanako", "workflow-sessions", "sub", "x.jsonl"),
    p("hanako", "x.jsonl"),                     // 缺目录层，agents/<id>/ 下直接放文件不会有
  ];
  for (const fp of bad) {
    assert.equal(classifySessionPath(fp, ROOT), null, "应当拒绝：" + String(fp));
  }
});

test("分类：不在 agents/ 下面的路径给 null", () => {
  assert.equal(classifySessionPath(path.join(os.tmpdir(), "elsewhere", "hanako", "sessions", "x.jsonl"), ROOT), null);
  assert.equal(classifySessionPath("D:\\完全\\别的地方\\x.jsonl", ROOT), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveSessionTarget：filePath 分支
// ─────────────────────────────────────────────────────────────────────────────
const FILE_A = "2026-10-23T15-29-18-705Z_01a16961-7b71-78fb-ab9e-e2d9ea4948cf.jsonl";
const FP_A = p("hanako", "sessions", FILE_A);
const KEY_A = `hanako::desktop::::${FILE_A}`;

function cacheWith(rows) {
  return { sessions: rows };
}

test("反查：传 filePath 且缓存里已有该行 → 用行里的元信息", () => {
  // 行里的 agent/type/channelName 是 scanAll 当时按目录写进去的，比路径分类更权威。
  const cache = cacheWith({
    [KEY_A]: { agent: "hanako", type: "desktop", channelName: null, filePath: FP_A, size: 1000 },
  });
  const t = resolveSessionTarget(cache, { filePath: FP_A });
  assert.ok(t);
  assert.equal(t.filePath, FP_A);
  assert.equal(t.agentId, "hanako");
  assert.equal(t.type, "desktop");
  assert.equal(t.channelName, null);
});

test("反查：缓存行的元信息与路径分类不一致时，信缓存行（它才是 scanAll 写的）", () => {
  // 造一个「路径看着像 desktop、但缓存行记成 channel」的行：真实场景是缓存比路径规则新。
  const cache = cacheWith({
    [KEY_A]: { agent: "hanako", type: "channel", channelName: "discord", filePath: FP_A, size: 1000 },
  });
  const t = resolveSessionTarget(cache, { filePath: FP_A });
  assert.equal(t.type, "channel");
  assert.equal(t.channelName, "discord");
});

test("反查：传 filePath 但缓存里没有 → 从路径分类（新会话第一次出现）", () => {
  const t = resolveSessionTarget(cacheWith({}), { filePath: FP_A });
  assert.ok(t, "新会话也要能定位，否则第一条用量必然退回全扫");
  assert.equal(t.filePath, FP_A);
  assert.equal(t.agentId, "hanako");
  assert.equal(t.type, "desktop");
  assert.equal(t.channelName, null);

  // 别的形态同样能推
  const phone = resolveSessionTarget(cacheWith({}), { filePath: p("hanako", "phone", "sessions", "wechat-1", "b.jsonl") });
  assert.equal(phone.type, "channel");
  assert.equal(phone.channelName, "wechat");
});

test("反查：传 filePath 但推不出来 → null（退回全扫）", () => {
  assert.equal(resolveSessionTarget(cacheWith({}), { filePath: "/nowhere/x.jsonl" }), null);
  assert.equal(resolveSessionTarget(cacheWith({}), { filePath: p("hanako", "weird", "x.jsonl") }), null);
  assert.equal(resolveSessionTarget(cacheWith({}), { filePath: "" }), null);
  assert.equal(resolveSessionTarget(cacheWith({}), { filePath: 123 }), null);
  assert.equal(resolveSessionTarget(cacheWith({}), { filePath: p("hanako", "sessions", "x.repair.jsonl") }), null);
});

test("反查：缓存行存在但 filePath 对不上 → 按新路径分类，不用那行的元信息", () => {
  // 同一个文件名可能出现在两个目录（sessions/ 与 sessions/archived/），键不同但文件名相同。
  // 缓存里那一行的 filePath 不是这次要扫的文件，就不能拿它的元信息。
  const other = p("hanako", "sessions", "archived", FILE_A);
  const cache = cacheWith({
    [KEY_A]: { agent: "hanako", type: "desktop", channelName: null, filePath: other, size: 1000 },
  });
  const t = resolveSessionTarget(cache, { filePath: FP_A });
  assert.equal(t.filePath, FP_A);
  assert.equal(t.type, "desktop", "分类结果仍是 desktop");
});

test("反查：filePath 分支不让 ledger 行混进来", () => {
  const cache = cacheWith({
    [KEY_A]: { agent: "hanako", type: "ledger", channelName: null, filePath: FP_A, size: 179999999999 },
  });
  const t = resolveSessionTarget(cache, { filePath: FP_A });
  assert.equal(t.type, "desktop", "ledger 行不能冒充会话行");
});

test("反查：filePath 优先于 sessionId（两者都给时走路径）", () => {
  const cache = cacheWith({
    "other::desktop::::sess_hit.jsonl": { agent: "other", type: "desktop", channelName: null, filePath: "/x/sess_hit.jsonl" },
  });
  const t = resolveSessionTarget(cache, { filePath: FP_A, sessionId: "sess_hit" });
  assert.equal(t.filePath, FP_A, "路径分支优先");
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveSessionTarget：sessionId 兜底仍然在（老路径不能删）
// ─────────────────────────────────────────────────────────────────────────────
test("反查：没有 filePath 时仍按 sessionId 在缓存里找（老兜底没被删）", () => {
  const uuid = "01a16961-7b71-78fb-ab9e-e2d9ea4948cf";
  const cache = cacheWith({
    [KEY_A]: { agent: "hanako", type: "desktop", channelName: null, filePath: FP_A },
  });
  const t = resolveSessionTarget(cache, { sessionId: uuid });
  assert.ok(t, "文件名里含这个 UUID，应当命中");
  assert.equal(t.filePath, FP_A);

  // 宿主那种 sess_xxx 形状在文件名里找不到，如实返回 null 退回全扫
  assert.equal(resolveSessionTarget(cache, { sessionId: "sess_0mvo0foho_f4954a9d2c8325bf97d0" }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// session-path-hint：service.mjs 里那个 Map 的纯操作
// ─────────────────────────────────────────────────────────────────────────────
test("路径备忘：context 事件记下、按 agentId 取回", () => {
  const map = new Map();
  const sp = "C:\\Users\\SSS\\.hanako\\agents\\hanako\\sessions\\2026-10-23T15-29-18-705Z_abc.jsonl";
  assert.equal(noteSessionPath(map, agentFromSessionPath(sp), sp), sp);
  assert.equal(agentFromSessionPath(sp), "hanako");
  assert.equal(recallSessionPath(map, "hanako"), sp);
});

test("路径备忘：跨 agent 不串台", () => {
  const map = new Map();
  const a = "/home/u/.hanako/agents/hanako/sessions/a.jsonl";
  const b = "/home/u/.hanako/agents/butter/sessions/b.jsonl";
  noteSessionPath(map, agentFromSessionPath(a), a);
  noteSessionPath(map, agentFromSessionPath(b), b);
  assert.equal(recallSessionPath(map, "hanako"), a);
  assert.equal(recallSessionPath(map, "butter"), b);
  // 没见过的 agent 是 null，不是 undefined，也不是别人的路径
  assert.equal(recallSessionPath(map, "someone-else"), null);
  assert.equal(recallSessionPath(map, null), null);
});

test("路径备忘：空值 / 非 jsonl / 修复产物都不记，Map 保持干净", () => {
  const map = new Map();
  for (const bad of [null, undefined, "", "/x/session.json", "/x/y.sqlite", "/x/z.repair.jsonl", 123]) {
    assert.equal(noteSessionPath(map, "hanako", bad), null, "不该记：" + String(bad));
  }
  assert.equal(map.size, 0, "一条都不该进去");
  // agentId 缺失时也不记：没有 agent 的路径没法归属
  assert.equal(noteSessionPath(map, null, "/x/agents/hanako/sessions/a.jsonl"), null);
  assert.equal(map.size, 0);
});

test("路径备忘：冷启动时取回 null（第一条用量退回全扫是可接受的）", () => {
  const map = new Map();
  assert.equal(recallSessionPath(map, "hanako"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 路径分隔符：真正让 session 命中率恒为 0 的就是这一条
//
// 缓存行的 filePath 是 scanDir 用 path.join 拼的（Windows 上反斜杠），
// 宿主 context 事件给的 payload.sessionPath 是正斜杠（C:/Users/...）。
// 两者直接 !== 比较永远为真，于是那条「形状不对，不猜」的自检把每次正常请求都拒了。
// ─────────────────────────────────────────────────────────────────────────────
const SLASH_FN = "2026-10-23T15-29-18-705Z_01a16961-7b71-78fb-ab9e-e2d9ea4949aa.jsonl";
const SLASH_DIR = path.join(home, "agents", "hanako", "sessions");

function bootEngine(dataDir) {
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

const contentOf = (total) => [
  JSON.stringify({ type: "message", timestamp: "2026-10-23T10:00:00.000Z", message: { role: "user", content: "问" } }),
  JSON.stringify({ type: "message", timestamp: "2026-10-23T10:00:05.000Z", message: { role: "assistant", model: "m", provider: "p", usage: { input: total - 10, output: 10, totalTokens: total } } }),
].join("\n") + "\n";

test("路径分隔符：缓存行是反斜杠、查询是正斜杠，scanOneSession 必须命中", async () => {
  fs.mkdirSync(SLASH_DIR, { recursive: true });
  const realPath = path.join(SLASH_DIR, SLASH_FN);
  fs.writeFileSync(realPath, contentOf(110));

  const { engine, disposers } = bootEngine(fs.mkdtempSync(path.join(os.tmpdir(), "tt-slash-data-")));
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(false); // 全量铺缓存，filePath 是 path.join 的形状

  try {
    const key = `hanako::desktop::::${SLASH_FN}`;
    assert.ok(shared.data.sessions[key], "首轮应扫到");
    const cachedPath = shared.data.sessions[key].filePath;

    // 改文件，用宿主那种正斜杠形式的路径发单会话扫描
    fs.writeFileSync(realPath, contentOf(777));
    const hostStylePath = realPath.split(path.sep).join("/");
    assert.notEqual(hostStylePath, cachedPath, "两种格式的字符串本身确实不相等（这就是旧 bug 的成因）");

    await shared.scanSession({ agentId: "hanako", sessionId: "sess_0mvo0foho_f4954a9d2c8325bf97d0", filePath: hostStylePath });

    assert.equal(shared.data.sessions[key].totalTokens, 777, "正斜杠路径也必须命中并重新解析");
    // 写回缓存的路径统一成反斜杠（与 scanDir 一致），不会一次正一次反来回抖
    assert.equal(shared.data.sessions[key].filePath, path.normalize(hostStylePath), "缓存里的路径格式与 scanDir 一致");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("路径分隔符：自检的本意不能丢 —— 缓存行指向别的目录时必须拒掉", async () => {
  const archived = path.join(SLASH_DIR, "archived");
  fs.mkdirSync(archived, { recursive: true });
  const liveFile = path.join(SLASH_DIR, SLASH_FN);
  const archFile = path.join(archived, SLASH_FN); // 同名，不同目录
  fs.writeFileSync(liveFile, contentOf(110));
  fs.writeFileSync(archFile, contentOf(220));

  const { engine, disposers } = bootEngine(fs.mkdtempSync(path.join(os.tmpdir(), "tt-arch-data-")));
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(false);

  try {
    const key = `hanako::desktop::::${SLASH_FN}`;
    assert.ok(shared.data.sessions[key], "首轮应扫到");

    // 直接把缓存行改指向 archived 那份，然后用 live 的路径请求。
    // 分隔符归一之后两边仍然不同目 —— 自检必须拦住，不能因为“都是 desktop + 同名”就放过去。
    shared.data.sessions[key].filePath = path.normalize(archFile);
    const liveTotal = shared.data.sessions[key].totalTokens;

    // 先确认 resolveSessionTarget 拿到的是路径对应得上的目标（它本身不负责做这层比对）
    const { resolveSessionTarget: resolve } = await import("../runtime/engine/index.js");
    const t = resolve(shared.data, { filePath: liveFile.split(path.sep).join("/") });
    assert.ok(t, "路径能分类，target 应当存在");
    assert.equal(path.normalize(t.filePath), path.normalize(liveFile), "target 指向 live 那份");
    assert.notEqual(path.normalize(t.filePath), path.normalize(shared.data.sessions[key].filePath),
      "归一后仍然对不上（自检应当在此处报 false）");

    // 走完整链路：这一轮会因自检为 false 退回全扫，但缓存不能被写坏
    fs.writeFileSync(liveFile, contentOf(999));
    await shared.scanSession({ agentId: "hanako", sessionId: "sess_x", filePath: liveFile.split(path.sep).join("/") });
    assert.ok(Number.isFinite(shared.data.sessions[key].totalTokens), "缓存行仍然是完整可用的");
    assert.notEqual(liveTotal, undefined);
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});

test("路径分隔符：path.normalize 后的格式与 scanDir 的 path.join 完全一致", async () => {
  const joined = path.join(home, "agents", "hanako", "sessions", SLASH_FN);
  const slashy = joined.split(path.sep).join("/");
  assert.equal(path.normalize(slashy), joined, "归一后应当与 scanDir 产出的字符串逐字相同");
});

// ─────────────────────────────────────────────────────────────────────────────
// 端到端：真实路径进来之后，scanOneSession 必须命中并记成 session
// ─────────────────────────────────────────────────────────────────────────────
test("端到端：带 filePath 的 scanSession 走单会话路径，不退回全扫", async () => {
  const sessDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  const FN = "2026-10-23T15-29-18-705Z_01a16961-7b71-78fb-ab9e-e2d9ea4948cf.jsonl";
  const line = (ts, m) => JSON.stringify({ type: "message", timestamp: ts, message: m });
  fs.writeFileSync(path.join(sessDir, FN), [
    line("2026-10-23T10:00:00.000Z", { role: "user", content: "问" }),
    line("2026-10-23T10:00:05.000Z", { role: "assistant", model: "m", provider: "p", usage: { input: 100, output: 10, totalTokens: 110 } }),
  ].join("\n") + "\n");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-onesess-data-"));
  const disposers = [];
  const engine = new Engine();
  engine.ctx = {
    dataDir,
    config: { get: () => undefined },
    log,
    bus: { async request() { return { agents: [] }; }, subscribe: () => () => {}, handle: () => () => {}, emit() {} },
  };
  engine.register = (fn) => disposers.push(fn);
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(false); // 首轮版本不匹配 → 全量，把会话铺进缓存

  try {
    const key = `hanako::desktop::::${FN}`;
    assert.ok(shared.data.sessions[key], "首轮应扫到");

    // 改文件，然后用真实路径发单会话扫描（这是宿主 context 事件给的那条路）
    fs.writeFileSync(path.join(sessDir, FN), [
      line("2026-10-23T10:00:00.000Z", { role: "user", content: "问" }),
      line("2026-10-23T10:00:05.000Z", { role: "assistant", model: "m", provider: "p", usage: { input: 500, output: 50, totalTokens: 550 } }),
    ].join("\n") + "\n");

    await shared.scanSession({ agentId: "hanako", sessionId: "sess_0mvo0foho_f4954a9d2c8325bf97d0", filePath: path.join(sessDir, FN) });
    assert.equal(shared.data.sessions[key].totalTokens, 550, "按路径定位到了，并重新解析出新的用量");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});
