import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDetailsCSV } from "../runtime/engine/services/details-csv.js";
import { hitRate } from "../ui/details-view.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// 搬迁前的实现：原样留在这里当基线。引擎那份必须与它逐字节相同 ——
// 同一批行，前后端给出不同的 CSV 或换行/转义不一样，导出的文件就对不上账。
// ─────────────────────────────────────────────────────────────────────────────
function baselineBuildDetailsCSV(rows, { currency = "cny", fxRate = null } = {}) {
  const header = ["时间", "Agent", "Provider", "模型", "输入Token", "输出Token", "缓存命中率", "调用次数", "总Token", "成本"];
  const cny = currency === "cny" && Number(fxRate) > 0;
  const toMoney = (usd) => {
    if (usd == null || usd === "") return "";
    const v = Number(usd);
    if (!Number.isFinite(v)) return "";
    return cny ? +(v * Number(fxRate)).toFixed(4) : v;
  };
  const lines = rows.map((r) => {
    // 缓存命中率是这两列里唯一需要算的：没口径就留空，不写 0%（那会读成“完全没命中”）。
    const hr = hitRate(r);
    return [r.time || "", r.agentName || r.agent || "", r.provider || "", r.model || "",
      r.inputTokens ?? "", r.outputTokens ?? "",
      hr == null ? "" : (hr * 100).toFixed(1) + "%",
      r.calls ?? "",
      r.totalTokens ?? 0, toMoney(r.cost)];
  });
  header[header.length - 1] = cny ? "成本(CNY)" : "成本(USD)";
  return "\uFEFF" + [header, ...lines].map(line => line.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

test("明细 CSV：表头含缓存命中率与调用次数两列，末列自报币种（缺省人民币）", () => {
  const csv = buildDetailsCSV([], { fxRate: 7.1 }).replace("\uFEFF", "");
  assert.equal(csv, '"时间","Agent","Provider","模型","输入Token","输出Token","缓存命中率","调用次数","总Token","成本(CNY)"');
});

test("明细 CSV：人民币口径下成本列按汇率换算，表头同步改成 CNY", () => {
  const rows = [{ time: "2026-09-30T01:00:00.000Z", model: "m", inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cost: 1 }];
  const usd = buildDetailsCSV(rows, { currency: "usd" }).replace("\uFEFF", "").split("\r\n");
  const cny = buildDetailsCSV(rows, { currency: "cny", fxRate: 7.1 }).replace("\uFEFF", "").split("\r\n");
  assert.match(usd[0], /"成本\(USD\)"$/);
  assert.match(usd[1], /"1010","1"$/, "美元口径原样写");
  assert.match(cny[0], /"成本\(CNY\)"$/);
  assert.match(cny[1], /"1010","7\.1"$/, "1 美元 × 7.1");
});

test("明细 CSV：标了人民币但没有汇率时退回美元，不拿 ¥ 去标美元的数", () => {
  const rows = [{ model: "m", totalTokens: 10, cost: 1 }];
  const csv = buildDetailsCSV(rows, { currency: "cny", fxRate: null }).replace("\uFEFF", "").split("\r\n");
  assert.match(csv[0], /"成本\(USD\)"$/, "换算不了就不声称是人民币");
  assert.match(csv[1], /"10","1"$/);
});

test("明细 CSV：命中率按命中/输入算一位小数，没有口径就留空", () => {
  const csv = buildDetailsCSV([
    { time: "2026-09-30T01:00:00.000Z", agent: "hanako", provider: "deepseek", model: "deepseek-flash",
      inputTokens: 15500, outputTokens: 300, totalTokens: 15800, cacheRead: 14000, calls: 2 },
    { time: "2026-09-30T02:00:00.000Z", agent: "hanako", inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
  ]).replace("\uFEFF", "").split("\r\n");
  assert.match(csv[1], /"90\.3%","2","15800",""$/, "14000/15500 = 90.3%，金额列留空");
  assert.match(csv[2], /"","","1010",""$/, "没有缓存口径与调用次数的记录留空，不写 0% 冒充");
});

test("对拍：引擎的 CSV 与搬迁前的实现逐字节相同", () => {
  const rows = [
    { time: "2026-09-30T12:00:00.000Z", agent: "hanako", agentName: "Hanako", provider: "deepseek", model: "deepseek-flash",
      inputTokens: 15500, outputTokens: 300, cacheRead: 14000, calls: 2, totalTokens: 15800 },
    { time: "2026-09-30T12:01:00.000Z", agent: "hanako", agentName: "Hanako", provider: "deepseek", model: "deepseek-flash",
      inputTokens: 2700, outputTokens: 300, cacheRead: 2000, calls: 1, totalTokens: 3000 },
    // 老记录：没有缓存拆分与调用次数 → 留空，且没有 cost
    { time: "2026-09-29T08:00:00.000Z", agent: "other", provider: "", model: "m", inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
    // 脏值：命中大于输入（夹到 100%）、含引号/逗号/换行的单元格、null 与 0
    { time: "2026-09-28T08:00:00.000Z", agent: "a,b", agentName: 'He said "hi"', provider: "p1", model: "m\nx",
      inputTokens: 100, outputTokens: 0, cacheRead: 300, calls: 0, totalTokens: 400, cost: 0 },
    { time: "", agent: null, agentName: "", provider: null, model: "", inputTokens: null, outputTokens: null, cacheRead: null, calls: null, totalTokens: 0 },
  ];
  const engine = buildDetailsCSV(rows);
  const baseline = baselineBuildDetailsCSV(rows);
  assert.equal(engine, baseline, "两个实现必须逐字节相同");
  assert.equal(Buffer.byteLength(engine), Buffer.byteLength(baseline));
  assert.equal(buildDetailsCSV(rows), engine, "同一输入两次输出也要一致");
});

// ─────────────────────────────────────────────────────────────────────────────
// 端到端：真起一次引擎，走 RPC token-tracker.details.csv
// ─────────────────────────────────────────────────────────────────────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-csv-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-csv-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;

const log = { info() {}, warn() {}, error() {} };
const line = (ts, message) => JSON.stringify({ type: "message", timestamp: ts, message });
const usage = (input, output, cacheRead, cacheWrite, reasoning) => ({
  input, output, cacheRead, cacheWrite, reasoning,
  totalTokens: input + output + cacheRead,
});
const sessDir = path.join(home, "agents", "hanako", "sessions");
fs.mkdirSync(sessDir, { recursive: true });
const SPLIT = "2026-09-30T12-00-00-000Z_split.jsonl";
fs.writeFileSync(path.join(sessDir, SPLIT), [
  line("2026-09-30T12:00:00.000Z", { role: "user", content: "第一轮" }),
  line("2026-09-30T12:00:05.000Z", { role: "assistant", model: "deepseek-flash", provider: "deepseek", usage: usage(1000, 200, 5000, 800, 50) }),
  line("2026-09-30T12:00:09.000Z", { role: "assistant", model: "deepseek-flash", provider: "deepseek", usage: usage(500, 100, 9000, 0, 20) }),
  line("2026-09-30T12:01:00.000Z", { role: "user", content: "第二轮" }),
  line("2026-09-30T12:01:04.000Z", { role: "assistant", model: "deepseek-flash", provider: "deepseek", usage: usage(700, 300, 2000, 0, 0) }),
].join("\n") + "\n");
const SESSION_KEY = `hanako::desktop::::${SPLIT}`;

const { default: Engine } = await import("../runtime/engine/index.js");
const { default: registerDashboard } = await import("../runtime/engine/routes/dashboard.js");
const { rowOf } = await import("../runtime/engine/routes/dashboard.js");

test("RPC token-tracker.details.csv：全量重扫后表立刻可用，导出等于「从 conversations 直接拼」", async () => {
  const handlers = new Map();
  const disposers = [];
  const engine = new Engine();
  engine.ctx = {
    dataDir,
    config: { get: () => undefined },
    log,
    bus: {
      async request() { return { agents: [] }; },
      subscribe: () => () => {},
      handle: (t, f) => { handlers.set(t, f); return () => handlers.delete(t); },
      emit() {},
    },
  };
  engine.register = (fn) => disposers.push(fn);
  await engine.onload();
  await engine.ctx._tokenCache.scan(false); // 首轮（版本不匹配）即全量
  registerDashboard({ get() {}, post() {} }, engine.ctx);

  // 时序陷阱：turns 表是在落盘时写的，而攒批是 5 分钟。全量重扫后必须已经落过盘，
  // 否则刚重建完的这几分钟里明细会是空的（回落虽能看，但表该填上）。
  assert.equal(engine.ctx._tokenCache.turnsStore.count(), 2, "全量重扫后 turns 表当场就绪");
  assert.equal(engine.ctx._tokenCache.persist.stats.lastReason, "全量重建", "落盘原因是全量重建");

  try {
    // 全量重扫后立刻落盘，不必等 5 分钟的攒批窗口：明细马上就有数据
    const dash = await engine.ctx._buildDashboardData({ range: "all" }, { skipBalances: true, fxRate: 7.1 });
    assert.equal(dash.details.total, 2, "全量重建后 turns 表已经就绪");

    // CSV 不分页：返回的是「当前筛选 + 排序」下的全部行
    const csv = await handlers.get("token-tracker.details.csv")({ range: "all" });
    assert.equal(typeof csv, "string", "RPC 返回的是 CSV 文本");
    assert.ok(csv.startsWith("\uFEFF"), "带 BOM");

    const sess = engine.ctx._tokenCache.data.sessions[SESSION_KEY];
    // 证明明细真从表里来：把内存里的 conversations 抹掉，明细仍要给得出（只可能来自 turns 表）
    const backup = sess.conversations;
    sess.conversations = [];
    const fromTable = await engine.ctx._buildDashboardData({ range: "all" }, { skipBalances: true, fxRate: 7.1 });
    assert.equal(fromTable.details.total, 2, "明细来自 turns 表而不是内存 conversations");
    sess.conversations = backup;

    const expectedRows = sess.conversations
      .map((c) => rowOf(sess, c, engine.ctx._tokenCache.data.agentNames))
      .sort((a, b) => (String(a.time) < String(b.time) ? 1 : -1)); // 默认时间倒序
    assert.equal(csv, buildDetailsCSV(expectedRows, { currency: "cny", fxRate: 7.1 }), "导出必须等于「从 conversations 直接拼」");

    const lines = csv.replace("\uFEFF", "").split("\r\n");
    assert.equal(lines.length, 3, "表头 + 两轮");
    assert.match(lines[1], /"74\.1%","1","3000"/, "时间倒序：第二轮先出，2000/2700 = 74.1%");
    assert.match(lines[2], /"90\.3%","2","15800"/, "第一轮 14000/15500 = 90.3%");

    // 门槛与排序跟着参数走
    const onlyBig = await handlers.get("token-tracker.details.csv")({ range: "all", minTokens: 10000 });
    assert.equal(onlyBig.replace("\uFEFF", "").split("\r\n").length, 2, "门槛把小的那轮滤掉");
  } finally {
    for (const fn of disposers.reverse()) { try { fn(); } catch {} }
  }
});
