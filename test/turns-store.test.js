import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqliteTurnsStore, queryTurns } from "../runtime/engine/services/turns-store.js";
import { loadSqliteDriver } from "../runtime/engine/services/cache-store.js";

const DatabaseSync = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };

// ─────────────────────────────────────────────────────────────────────────────
// 一份合成语料：三个会话、四轮，覆盖多调用轮、命中缓存、老记录（没有 cacheRead）。
// 时间一律取 12:00Z —— 任何时区都落在同一天，day 断言不随宿主时区漂。
// ─────────────────────────────────────────────────────────────────────────────
const SESSIONS = {
  "s-a": {
    agent: "hanako", type: "desktop",
    conversations: [
      { time: "2026-09-28T12:00:00.000Z", model: "m1", provider: "p1", totalTokens: 1000000, msgCount: 1, inTokens: 900000, outTokens: 100000, cacheRead: 800000, cacheWrite: 0, reasoning: 0 },
      { time: "2026-09-29T12:00:00.000Z", model: "m2", provider: "p1", totalTokens: 5000000, msgCount: 2, inTokens: 4000000, outTokens: 1000000, cacheRead: 500000, cacheWrite: 0, reasoning: 0 },
    ],
  },
  "s-b": {
    agent: "hanako", type: "channel",
    conversations: [
      { time: "2026-09-30T12:00:00.000Z", model: "m1", provider: "p2", totalTokens: 6000000, msgCount: 1, inTokens: 1000000, outTokens: 5000000, cacheRead: 100000, cacheWrite: 0, reasoning: 0 },
    ],
  },
  // 老记录：没有 cacheRead / cacheWrite / reasoning 这几个字段
  "s-c": {
    agent: "other", type: "sub",
    conversations: [
      { time: "2026-10-01T12:00:00.000Z", model: "m3", provider: "p1", totalTokens: 3000000, msgCount: 3, inTokens: 3000000, outTokens: 0 },
    ],
  },
};

const LABEL = { "s-a": "sa", "s-b": "sb", "s-c": "sc" };
const tags = (rows) => rows.map((r) => LABEL[r.sessionKey] + r.seq);

// 本地时区取日，与引擎写入时同一套写法。
function localDayOf(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d.getTime())) return "unknown";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// 与 queryTurns 对拍用的「笨办法」：遍历 record.conversations 直接在内存里筛、排、切。
// 这是本期最重要的验收口径 —— SQL 的结果必须逐项等于这里算出来的。
function brute(sessions, opts = {}) {
  const o = opts;
  const all = [];
  for (const [key, s] of Object.entries(sessions)) {
    const convs = Array.isArray(s?.conversations) ? s.conversations : [];
    for (let i = 0; i < convs.length; i++) {
      const c = convs[i] || {};
      const at = c.time == null ? "" : String(c.time);
      all.push({
        sessionKey: key, seq: i + 1, at, day: localDayOf(at),
        agent: s.agent == null ? "" : String(s.agent),
        type: s.type == null ? "" : String(s.type),
        provider: c.provider == null ? "" : String(c.provider),
        model: c.model == null ? "" : String(c.model),
        total: Number(c.totalTokens) || 0,
        input: c.inTokens == null ? null : Number(c.inTokens) || 0,
        output: c.outTokens == null ? null : Number(c.outTokens) || 0,
        cacheRead: c.cacheRead == null ? null : Number(c.cacheRead) || 0,
        calls: c.msgCount == null ? null : Number(c.msgCount) || 0,
      });
    }
  }
  const kept = all.filter((r) => {
    if (typeof o.from === "string" && o.from !== "" && !(r.day >= o.from)) return false;
    if (typeof o.to === "string" && o.to !== "" && !(r.day <= o.to)) return false;
    for (const col of ["agent", "model", "provider", "type"]) {
      const v = o[col];
      if (typeof v === "string" && v !== "" && r[col] !== v) return false;
    }
    const min = Number(o.minTokens);
    if (Number.isFinite(min) && min > 0 && !(r.total >= min)) return false;
    return true;
  });
  const sortKey = Object.prototype.hasOwnProperty.call({ time: 1, tokens: 1, uncached: 1, hit: 1 }, o.sortKey) ? o.sortKey : "time";
  const val = (r) => sortKey === "time" ? r.at
    : sortKey === "tokens" ? r.total
      : sortKey === "uncached" ? Math.max(0, (r.input || 0) - (r.cacheRead || 0))
        : (r.input != null && r.input > 0 ? (r.cacheRead == null ? null : r.cacheRead / r.input) : null);
  const dir = o.order === "asc" ? 1 : -1;
  const cmp = (a, b) => {
    const va = val(a), vb = val(b);
    const na = va == null, nb = vb == null;
    if (na !== nb) return na ? 1 : -1; // 空值一律排最后
    if (!na && va !== vb) return (va < vb ? -1 : 1) * dir;
    if (a.at !== b.at) return a.at < b.at ? 1 : -1; // at DESC 兜底
    if (a.sessionKey !== b.sessionKey) return a.sessionKey < b.sessionKey ? -1 : 1;
    return a.seq - b.seq;
  };
  const sorted = [...kept].sort(cmp);
  const lim = Number(o.limit);
  const limit = Number.isFinite(lim) && lim > 0 ? Math.min(Math.floor(lim), 1000) : 50;
  const offRaw = Number(o.offset);
  const offset = Number.isFinite(offRaw) && offRaw > 0 ? Math.floor(offRaw) : 0;
  return {
    rows: sorted.slice(offset, offset + limit),
    total: sorted.length,
    sumTokens: sorted.reduce((s, r) => s + r.total, 0),
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-turns-"));
  return createSqliteTurnsStore({ DatabaseSync, file: path.join(dir, "cache.sqlite"), log });
}

// ───────────────────────────── 存储层 ─────────────────────────────

test("建表 + 整表重建：行数、字段、day 本地日期、cache_read 缺省为 NULL", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  store.rebuild({ sessions: SESSIONS });

  assert.equal(store.count(), 4, "三个会话共四轮");

  const r = store.query({ sortKey: "time", order: "asc" });
  assert.equal(r.total, 4);
  assert.deepEqual(tags(r.rows), ["sa1", "sa2", "sb1", "sc1"]);

  const [a1, a2, b1, c1] = r.rows;
  assert.deepEqual(
    { key: a1.sessionKey, at: a1.at, day: a1.day, agent: a1.agent, type: a1.type, provider: a1.provider, model: a1.model, total: a1.total, input: a1.input, output: a1.output, cacheRead: a1.cacheRead, calls: a1.calls },
    { key: "s-a", at: "2026-09-28T12:00:00.000Z", day: "2026-09-28", agent: "hanako", type: "desktop", provider: "p1", model: "m1", total: 1000000, input: 900000, output: 100000, cacheRead: 800000, calls: 1 }
  );
  assert.equal(a2.seq, 2, "seq 是会话内轮次顺序号");
  assert.equal(a2.calls, 2, "调用次数");
  assert.equal(a2.cacheRead, 500000);
  assert.equal(b1.day, "2026-09-30", "day 用本地时区算到日");
  assert.equal(b1.type, "channel");
  // 老记录没有缓存口径 → NULL，不是 0
  assert.equal(c1.cacheRead, null, "cache_read 缺省必须是 NULL 而不是 0");
  assert.equal(c1.calls, 3);
  assert.equal(c1.day, "2026-10-01");

  store.close();
});

test("重扫同一会话不产生重复行；会话消失时它的行被清掉", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  store.rebuild({ sessions: SESSIONS });
  assert.equal(store.count(), 4);

  // 同一会话重扫（整表重建）→ 行数不变
  store.rebuild({ sessions: SESSIONS });
  assert.equal(store.count(), 4, "重扫不能翻倍");

  // 增量路径：会话内容改了 → 先删后插，行数仍对
  const changed = { ...SESSIONS, "s-b": { agent: "hanako", type: "channel", conversations: [...SESSIONS["s-b"].conversations, { time: "2026-09-30T13:00:00.000Z", model: "m4", provider: "p2", totalTokens: 4000000, msgCount: 1, inTokens: 4000000, outTokens: 0, cacheRead: 0 }] } };
  store.apply({ sessions: changed }, { keys: ["s-b"] });
  assert.equal(store.count(), 5, "只重建 s-b：它的 2 行换掉了原来的 1 行");
  store.apply({ sessions: SESSIONS }, { keys: ["s-b"] });
  assert.equal(store.count(), 4, "改回来行数也跟着回去");

  // 会话被移除（0 行移除那条路径）→ 删掉它的行
  const without = { ...SESSIONS };
  delete without["s-c"];
  store.apply({ sessions: without }, { keys: ["s-c"] });
  assert.equal(store.count(), 3);
  assert.equal(store.query({ agent: "other" }).total, 0, "被删的会话不该再有行");

  store.removeSession("s-a");
  assert.equal(store.count(), 1);

  store.close();
});

// ───────────────────────────── 查询层 ─────────────────────────────

test("过滤：day 范围（含端点）、agent/model/provider/type", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  store.rebuild({ sessions: SESSIONS });

  assert.deepEqual(tags(store.query({ from: "2026-09-29", to: "2026-09-30" }).rows), ["sb1", "sa2"], "day 范围含端点，默认时间倒序");
  assert.deepEqual(tags(store.query({ from: "2026-09-29" }).rows), ["sc1", "sb1", "sa2"]);
  assert.deepEqual(tags(store.query({ to: "2026-09-28" }).rows), ["sa1"]);
  assert.deepEqual(tags(store.query({ agent: "other" }).rows), ["sc1"]);
  assert.deepEqual(tags(store.query({ type: "channel" }).rows), ["sb1"]);
  assert.deepEqual(tags(store.query({ model: "m1" }).rows), ["sb1", "sa1"]);
  assert.deepEqual(tags(store.query({ provider: "p1" }).rows), ["sc1", "sa2", "sa1"]);
  assert.deepEqual(tags(store.query({ agent: "hanako", type: "desktop" }).rows), ["sa2", "sa1"], "多个过滤是 AND");
  // 空串 = 不限
  assert.equal(store.query({ from: "", to: "", agent: "", model: "", provider: "", type: "" }).total, 4);

  store.close();
});

test("四种排序：tokens / uncached / hit / time，两个方向都对", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  store.rebuild({ sessions: SESSIONS });
  const order = (opts) => tags(store.query(opts).rows);

  assert.deepEqual(order({ sortKey: "time", order: "desc" }), ["sc1", "sb1", "sa2", "sa1"]);
  assert.deepEqual(order({ sortKey: "time", order: "asc" }), ["sa1", "sa2", "sb1", "sc1"]);
  assert.deepEqual(order({ sortKey: "tokens", order: "desc" }), ["sb1", "sa2", "sc1", "sa1"]);
  assert.deepEqual(order({ sortKey: "tokens", order: "asc" }), ["sa1", "sc1", "sa2", "sb1"]);
  // uncached = input - cache_read（不是 total）；c1 没有口径，按输入全算未命中
  assert.deepEqual(order({ sortKey: "uncached", order: "desc" }), ["sa2", "sc1", "sb1", "sa1"]);
  assert.deepEqual(order({ sortKey: "uncached", order: "asc" }), ["sa1", "sb1", "sc1", "sa2"]);
  // hit = cache_read / input；没有口径的行两个方向都排最后
  assert.deepEqual(order({ sortKey: "hit", order: "desc" }), ["sa1", "sa2", "sb1", "sc1"]);
  assert.deepEqual(order({ sortKey: "hit", order: "asc" }), ["sb1", "sa2", "sa1", "sc1"]);

  store.close();
});

test("minTokens 是「大于等于」，且与排序可叠加", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  store.rebuild({ sessions: SESSIONS });

  const r = store.query({ minTokens: 5000000, sortKey: "tokens", order: "desc" });
  assert.deepEqual(tags(r.rows), ["sb1", "sa2"], "500 万那条（等于门槛）要留下");
  assert.equal(r.total, 2);
  assert.equal(r.sumTokens, 11000000);
  assert.equal(store.query({ minTokens: 0 }).total, 4, "0 = 不限");

  store.close();
});

test("分页：limit/offset 只切行，total/sumTokens 始终是全量", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  store.rebuild({ sessions: SESSIONS });

  const p1 = store.query({ sortKey: "tokens", order: "desc", limit: 2, offset: 0 });
  assert.deepEqual(tags(p1.rows), ["sb1", "sa2"]);
  assert.equal(p1.total, 4, "total 不受 limit 影响");
  assert.equal(p1.sumTokens, 15000000, "sumTokens 是过滤后全量合计");

  const p2 = store.query({ sortKey: "tokens", order: "desc", limit: 2, offset: 2 });
  assert.deepEqual(tags(p2.rows), ["sc1", "sa1"]);
  assert.equal(p2.total, 4);
  assert.equal(p2.sumTokens, 15000000);

  // 拼接两页 = 全集，不漏不重
  assert.deepEqual([...tags(p1.rows), ...tags(p2.rows)], ["sb1", "sa2", "sc1", "sa1"]);

  store.close();
});

test("空库与脏参数都不抛", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  assert.deepEqual(store.query({}), { rows: [], total: 0, sumTokens: 0 }, "空表给空结果");
  assert.deepEqual(queryTurns(store, { sortKey: "tokens" }), { rows: [], total: 0, sumTokens: 0 });
  assert.deepEqual(queryTurns(null, {}), { rows: [], total: 0, sumTokens: 0 }, "store 缺失时退化成空");

  store.rebuild({ sessions: SESSIONS });
  const dirty = store.query({ sortKey: "nonsense", order: "sideways", limit: 0, offset: -5 });
  assert.deepEqual(tags(dirty.rows), ["sc1", "sb1", "sa2", "sa1"], "乱的 sortKey/order 退回默认：时间倒序");
  assert.equal(dirty.total, 4);
  assert.equal(store.query({ limit: -3 }).rows.length, 4, "limit 为负退回默认（这里 4 条全出）");
  assert.deepEqual(queryTurns(store, undefined), queryTurns(store, {}));

  store.close();
});

// ───────────────────────────── 对拍（本期最重要的验收点）─────────────────────────────

test("对拍：queryTurns 的结果必须逐项等于「遍历 record.conversations 直接算」", { skip: !DatabaseSync }, () => {
  const store = tempStore();
  store.rebuild({ sessions: SESSIONS });

  const cases = [
    {},
    { sortKey: "time", order: "asc" },
    { sortKey: "tokens", order: "desc" },
    { sortKey: "tokens", order: "asc" },
    { sortKey: "uncached", order: "desc" },
    { sortKey: "uncached", order: "asc" },
    { sortKey: "hit", order: "desc" },
    { sortKey: "hit", order: "asc" },
    { from: "2026-09-29", to: "2026-09-30", sortKey: "tokens", order: "desc" },
    { agent: "hanako", model: "m1" },
    { provider: "p1", sortKey: "uncached", order: "asc" },
    { minTokens: 3000000, sortKey: "tokens", order: "desc" },
    { sortKey: "tokens", order: "desc", limit: 2, offset: 1 },
    { sortKey: "hit", order: "asc", limit: 3, offset: 2 },
    { sortKey: "nonsense", limit: 0, offset: -1 },
  ];

  for (const opts of cases) {
    const got = store.query(opts);
    const want = brute(SESSIONS, opts);
    assert.deepEqual(got.rows, want.rows, "rows 对不上：" + JSON.stringify(opts));
    assert.equal(got.total, want.total, "total 对不上：" + JSON.stringify(opts));
    assert.equal(got.sumTokens, want.sumTokens, "sumTokens 对不上：" + JSON.stringify(opts));
  }

  store.close();
});

// ───────────────────────────── 端到端：真扫一份 jsonl ─────────────────────────────

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-turns-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-turns-data-"));
process.env.HANA_HOME = home;

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

async function bootEngine() {
  const engine = new Engine();
  const disposers = [];
  engine.ctx = {
    dataDir,
    config: { get: () => undefined },
    log,
    bus: { async request() { return { agents: [] }; }, subscribe: () => () => {}, handle: () => () => {}, emit() {} },
  };
  engine.register = (fn) => disposers.push(fn);
  await engine.onload();
  const shared = engine.ctx._tokenCache;
  await shared.scan(false);      // 首次（version 不匹配）即全量
  shared.persist.flushNow("test"); // 逼一次落盘，让 turns 表真的被写
  return { engine, shared, dispose: () => { for (const fn of disposers.reverse()) { try { fn(); } catch {} } } };
}

test("扫描落盘后：turns 表按会话拆出每轮，字段与 record.conversations 一致", { skip: !DatabaseSync }, async () => {
  const { shared, dispose } = await bootEngine();
  try {
    const read = createSqliteTurnsStore({ DatabaseSync, file: path.join(dataDir, "cache.sqlite"), log });
    try {
      assert.equal(read.count(), 2, "两轮 → 两行");

      const got = queryTurns(read, { sortKey: "time", order: "asc" });
      assert.equal(got.total, 2);
      assert.deepEqual(got.sumTokens, 18800, "15800 + 3000");

      const [t1, t2] = got.rows;
      assert.deepEqual(
        { key: t1.sessionKey, seq: t1.seq, at: t1.at, day: t1.day, agent: t1.agent, type: t1.type, provider: t1.provider, model: t1.model, total: t1.total, input: t1.input, output: t1.output, cacheRead: t1.cacheRead, calls: t1.calls },
        { key: SESSION_KEY, seq: 1, at: "2026-09-30T12:00:00.000Z", day: "2026-09-30", agent: "hanako", type: "desktop", provider: "deepseek", model: "deepseek-flash", total: 15800, input: 15500, output: 300, cacheRead: 14000, calls: 2 }
      );
      assert.equal(t2.seq, 2);
      assert.equal(t2.total, 3000);
      assert.equal(t2.cacheRead, 2000);
      assert.equal(t2.calls, 1);

      // 对拍：拿内存里的 record.conversations 直接算，跟表里读出来的逐项比
      const sess = shared.data.sessions[SESSION_KEY];
      const want = brute({ [SESSION_KEY]: sess }, { sortKey: "time", order: "asc" });
      assert.deepEqual(got.rows, want.rows, "turns 表必须等于从 conversations 直接算出来的");
      assert.equal(got.total, want.total);
      assert.equal(got.sumTokens, want.sumTokens);
    } finally {
      read.close();
    }

    // 同一会话重扫（force 全量）不产生重复行
    await shared.scan(true);
    shared.persist.flushNow("test-rescan");
    const again = createSqliteTurnsStore({ DatabaseSync, file: path.join(dataDir, "cache.sqlite"), log });
    try { assert.equal(again.count(), 2, "重扫不翻倍"); } finally { again.close(); }

    // 会话被移除那条路径：表现在由扫描维护（谁维护表只有一个答案），
    // 所以这里直接调 scanAll 用的那个入口 —— 把会话从内存里去掉，表就该跟着清。
    delete shared.data.sessions[SESSION_KEY];
    shared.turnsStore.apply(shared.data, { keys: [SESSION_KEY] });
    const after = createSqliteTurnsStore({ DatabaseSync, file: path.join(dataDir, "cache.sqlite"), log });
    try {
      assert.equal(after.count(), 0, "会话没了，它的轮次行也要清掉");
      assert.equal(after.query({ agent: "hanako" }).total, 0);
    } finally { after.close(); }
  } finally {
    dispose();
  }
});
