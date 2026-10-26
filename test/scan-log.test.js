import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSqliteScanLogStore, percentile,
  SLOW_SCAN_MS, SCAN_LOG_RETAIN_DAYS, SCAN_LOG_FLUSH_ROWS,
} from "../runtime/engine/services/scan-log-store.js";
import { loadSqliteDriver } from "../runtime/engine/services/cache-store.js";

const DatabaseSync = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };
const DAY = 86400 * 1000;

function freshFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-scanlog-")), "cache.sqlite");
}

// 每测一个场景都要一个可控的「现在」：滚动删除与窗口筛选都以它为基准。
// 默认就用真实时间 —— 否则写进去的行会因为「早于 7 天前」而在 flush 时被顺带滚掉。
function makeStore(opts = {}) {
  const file = opts.file || freshFile();
  let clock = opts.now ?? Date.now();
  const store = createSqliteScanLogStore({
    DatabaseSync, file, log,
    now: () => clock,
    flushRows: opts.flushRows,
    flushMs: opts.flushMs,
  });
  return { store, file, setNow: (t) => { clock = t; }, now: () => clock };
}

const row = (ms, extra = {}) => ({
  at: extra.at ?? Date.now(),
  kind: extra.kind || "incr",
  ms,
  cpuUser: extra.cpuUser ?? 1000,
  cpuSys: extra.cpuSys ?? 200,
  files: extra.files ?? 3,
  bytes: extra.bytes ?? 4096,
  changed: extra.changed ?? 1,
});

// ─────────────────────────────────────────────────────────────────────────────
// 建表
// ─────────────────────────────────────────────────────────────────────────────
test("建表幂等：同一个文件连续打开两次都不报错，表结构是工单里那八列", { skip: !DatabaseSync }, () => {
  const file = freshFile();
  const a = createSqliteScanLogStore({ DatabaseSync, file, log });
  a.open();
  a.close();
  const b = createSqliteScanLogStore({ DatabaseSync, file, log });
  b.open(); // 第二次打开：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 都不该抛

  const cols = b.open().prepare("PRAGMA table_info(scan_log)").all().map((c) => c.name);
  assert.deepEqual(cols, ["at", "kind", "ms", "cpu_user", "cpu_sys", "files", "bytes", "changed"]);
  // 索引也建上了：查「最近 N 天」靠它
  const idx = b.open().prepare("PRAGMA index_list(scan_log)").all().map((i) => i.name);
  assert.ok(idx.includes("scan_log_at"), "应有 scan_log_at 索引，实际：" + idx.join(","));
  assert.equal(b.count(), 0);
  b.close();
});

test("打开两次用的是同一个库文件，不新开文件", { skip: !DatabaseSync }, () => {
  const file = freshFile();
  const a = createSqliteScanLogStore({ DatabaseSync, file, log });
  a.record(row(500));
  a.flush();
  const dir = path.dirname(file);
  const before = fs.readdirSync(dir).filter((n) => n.endsWith(".sqlite")).sort();
  a.close();
  const b = createSqliteScanLogStore({ DatabaseSync, file, log });
  assert.equal(b.count(), 1, "重新打开能读到上一次写的行");
  const after = fs.readdirSync(dir).filter((n) => n.endsWith(".sqlite")).sort();
  assert.deepEqual(after, before, "没有多出第二个 sqlite 文件");
  b.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 阈值过滤
// ─────────────────────────────────────────────────────────────────────────────
test("阈值：199ms 不入库，200ms 入库", { skip: !DatabaseSync }, () => {
  assert.equal(SLOW_SCAN_MS, 200, "门槛常量就是 200ms");
  const { store } = makeStore();
  assert.equal(store.record(row(199)), false, "199ms 被闸门挡掉");
  assert.equal(store.pendingCount(), 0, "被挡掉的连缓冲区都进不去");
  assert.equal(store.record(row(200)), true, "200ms 就是慢扫描的下界（>= 而非 >）");
  assert.equal(store.pendingCount(), 1);
  store.flush();
  assert.equal(store.count(), 1);
  store.close();
});

test("阈值：logAll 打开后 10ms 也入库", { skip: !DatabaseSync }, () => {
  const { store } = makeStore();
  assert.equal(store.record(row(10), { logAll: true }), true);
  assert.equal(store.record(row(10)), false, "同一个 store 换回默认口径就照样挡");
  store.flush();
  assert.equal(store.count(), 1, "只落进去 logAll 那一条");
  store.close();
});

test("阈值：挡掉的扫描不等于「还没落盘」——两者是不同的事", { skip: !DatabaseSync }, () => {
  const { store } = makeStore();
  store.record(row(5));            // 策略挡掉
  store.record(row(300));          // 进缓冲
  assert.equal(store.pendingCount(), 1, "缓冲区里只有被接受的那一条");
  assert.equal(store.count(), 0, "还没落盘，库里一条都没有");
  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 攒批
// ─────────────────────────────────────────────────────────────────────────────
test("攒批：不足 200 条不写库，够 200 条一次性写进去", { skip: !DatabaseSync }, () => {
  const { store } = makeStore();
  for (let i = 0; i < SCAN_LOG_FLUSH_ROWS - 1; i++) store.record(row(300));
  assert.equal(store.pendingCount(), SCAN_LOG_FLUSH_ROWS - 1);
  assert.equal(store.count(), 0, "199 条仍在缓冲区，库还是空的");

  store.record(row(300)); // 第 200 条触发落盘
  assert.equal(store.count(), SCAN_LOG_FLUSH_ROWS, "达到 200 条后一次事务全写进去");
  assert.equal(store.pendingCount(), 0, "缓冲区已清空");
  store.close();
});

test("攒批：自适应 flushRows，条数条件按配置生效", { skip: !DatabaseSync }, () => {
  const { store } = makeStore({ flushRows: 3 });
  store.record(row(300));
  store.record(row(301));
  assert.equal(store.count(), 0);
  store.record(row(302));
  assert.equal(store.count(), 3, "第 3 条达到自定义门槛即落盘");
  store.close();
});

test("攒批：unload 时把剩下的刷一次（close 内先 flush）", { skip: !DatabaseSync }, () => {
  const file = freshFile();
  const a = createSqliteScanLogStore({ DatabaseSync, file, log });
  a.record(row(300));
  a.record(row(301));
  assert.equal(a.pendingCount(), 2);
  a.close();

  const b = createSqliteScanLogStore({ DatabaseSync, file, log });
  assert.equal(b.count(), 2, "close 把缓冲区刷干净了，重开能读到");
  b.close();
});

test("攒批：一次落盘只开一个事务（不是逐条 autocommit）", { skip: !DatabaseSync }, () => {
  const { file } = makeStore({ flushRows: 50 });
  const store = createSqliteScanLogStore({ DatabaseSync, file, log, flushRows: 50 });
  // 数 BEGIN：把 exec 包一层，看落盘期间到底开了几次事务
  const d = store.open();
  const rawExec = d.exec.bind(d);
  let begins = 0;
  d.exec = (sql) => { if (String(sql).trim().toUpperCase() === "BEGIN") begins += 1; return rawExec(sql); };
  for (let i = 0; i < 50; i++) store.record(row(300));
  assert.equal(begins, 1, "50 行一个事务，实际开了 " + begins + " 次");
  assert.equal(store.count(), 50);
  store.close();
});

test("攒批：5 分钟到了就落盘，不必等够 200 条", { skip: !DatabaseSync }, () => {
  const { store } = makeStore({ flushMs: 30 });
  store.record(row(300));
  assert.equal(store.count(), 0, "刚记下来还没到时间");
  // 定时器用的是真时间（flushMs 可配成很小的值来测），等它跑
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assert.equal(store.count(), 1, "时间条件到了，一条也照样落盘");
        store.close();
        resolve();
      } catch (e) { store.close(); reject(e); }
    }, 120);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 滚动
// ─────────────────────────────────────────────────────────────────────────────
test("滚动：落盘顺手删掉 8 天前的，6 天前的三条留着", { skip: !DatabaseSync }, () => {
  const { store, setNow, now } = makeStore();
  const t0 = now();

  // 先塞一条「8 天前」，并立刻放它进库：要靠一次落盘才能触发滚动，所以得让它先在库里。
  setNow(t0 - 8 * DAY);
  store.record(row(400, { at: t0 - 8 * DAY }));
  store.flush();
  assert.equal(store.count(), 1, "8 天前的这条此刻在库里");

  // 再写三条 6 天前的，并把「现在」推到 t0，触发一次落盘
  setNow(t0 - 6 * DAY);
  store.record(row(300, { at: t0 - 6 * DAY }));
  store.record(row(301, { at: t0 - 6 * DAY + 1000 }));
  store.record(row(302, { at: t0 - 6 * DAY + 2000 }));
  setNow(t0);
  store.flush();

  const rows = store.query({ days: SCAN_LOG_RETAIN_DAYS, limit: 100 }).recent;
  assert.equal(store.count(), 3, "8 天前那条被滚掉了");
  assert.deepEqual(rows.map((r) => r.ms).sort(), [300, 301, 302], "6 天前的三条都在");
  assert.ok(rows.every((r) => r.at >= t0 - 7 * DAY), "留下的都在保留窗口内");
  store.close();
});

test("滚动：保留天数是 7，而且写成模块级常量", () => {
  assert.equal(SCAN_LOG_RETAIN_DAYS, 7);
});

test("prune 不误删边界内的行：严格小于，边界那一毫秒留着", { skip: !DatabaseSync }, () => {
  const { store, now } = makeStore();
  const t = now();
  store.record(row(300, { at: t - 1000 }));
  store.record(row(301, { at: t }));          // 正好在边界上
  store.record(row(302, { at: t + 1000 }));
  store.flush();
  assert.equal(store.count(), 3);

  const removed = store.prune(t);             // 删 at < t
  assert.equal(removed, 1, "只删掉边界之前那一条");
  assert.equal(store.count(), 2);
  const left = store.query({ days: 30, limit: 100 }).recent.map((r) => r.ms).sort();
  assert.deepEqual(left, [301, 302], "边界那一毫秒与之后的都还在");
  store.close();
});

test("prune：删除后库文件不会因为单纯的删多写少而无限增长", { skip: !DatabaseSync }, () => {
  const file = freshFile();
  const store = createSqliteScanLogStore({ DatabaseSync, file, log, flushRows: 1000 });
  const t = Date.now();
  // 先铺 500 行、全删掉，再铺 500 行：第二批应该复用 freelist 里的页，
  // 最终文件大小不会被第二批再撑大一大截（不 VACUUM 也该如此）。
  // 时间基用真实的「现在」：写太早的行会在 flush 时被滚动删掉，那就不是在测页面复用。
  for (let i = 0; i < 500; i++) store.record(row(300, { at: t - 100000 + i }));
  store.flush();
  assert.equal(store.count(), 500, "第一批进去了");
  store.prune(t);
  assert.equal(store.count(), 0, "全删光了");
  const afterFirst = fs.statSync(file).size;
  for (let i = 0; i < 500; i++) store.record(row(300, { at: t - 100000 + i }));
  store.flush();
  const afterSecond = fs.statSync(file).size;
  assert.equal(store.count(), 500);
  // 不要求字节完全不变（页分配有取整），只要没有翻倍级别的增长。
  assert.ok(afterSecond <= afterFirst * 1.5,
    "删掉的行应该被复用，库文件没理由翻倍：" + afterFirst + " → " + afterSecond);
  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 查询与汇总
// ─────────────────────────────────────────────────────────────────────────────
test("percentile：最近秩，返回真实观测值而不是插值", () => {
  // 1..100，p95 的秩 = ceil(0.95*100) = 95 → 第 95 个（值 95）
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 0.95), 95);
  // 20 个数：ceil(0.95*20) = 19 → 第 19 个（值 19）
  const v20 = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(v20, 0.95), 19);
  // 单值时 p95 就是它自己，空数组给 0
  assert.equal(percentile([42], 0.95), 42);
  assert.equal(percentile([], 0.95), 0);
  // 乱序输入输出一样（内部先排序）
  assert.deepEqual(percentile([5, 1, 9, 3], 0.5), 3);
});

test("查询：summary.p95Ms 在已知数据集上等于预期值", { skip: !DatabaseSync }, () => {
  const { store, now } = makeStore();
  const t = now();
  // 20 条已知值：200, 400, 600 … 4000（全部 ≥ 门槛，不会被闸门挡）
  for (let i = 0; i < 20; i++) store.record(row(200 * (i + 1), { at: t - i * 1000 }));
  store.flush();

  const out = store.query({ days: 7, limit: 50 });
  assert.equal(out.summary.count, 20);
  // 升序后第 ceil(0.95*20)=19 个 = 第 19 小 = 200*19 = 3800
  assert.equal(out.summary.p95Ms, 3800);
  assert.equal(out.summary.maxMs, 4000);
  // 平均 = 200*(1+…+20)/20 = 200*10.5 = 2100
  assert.equal(out.summary.avgMs, 2100);
  assert.equal(out.recent.length, 20, "默认 limit=50，20 条全给");
  store.close();
});

test("查询：recent 按 at 倒序，limit 生效且夹在上限内", { skip: !DatabaseSync }, () => {
  const { store, now } = makeStore({ flushRows: 1000 });
  const t = now();
  for (let i = 0; i < 10; i++) store.record(row(300 + i, { at: t - i * 1000, kind: "incr" }));
  store.flush();

  const out = store.query({ days: 7, limit: 3 });
  assert.deepEqual(out.recent.map((r) => r.at), [t, t - 1000, t - 2000], "最新的三条，严格倒序");
  assert.equal(out.summary.count, 10, "summary 覆盖整个窗口，不受 limit 影响");

  // limit 超过 500 一律夹到 500；非数字回默认 50
  assert.ok(store.query({ limit: 9999 }).recent.length <= 500);
  assert.equal(store.query({ limit: 0 }).recent.length, 10, "0 当没传，回默认值");

  // days 夹到 30
  assert.ok(store.query({ days: 999 }).window.days <= 30);
  assert.equal(store.query({ days: 999 }).window.days, 30);
  store.close();
});

test("查询：byKind 分桶，count 与 avgMs 各自算自己那一桶", { skip: !DatabaseSync }, () => {
  const { store, now } = makeStore({ flushRows: 1000 });
  const t = now();
  store.record(row(1000, { at: t, kind: "full" }));
  store.record(row(2000, { at: t - 1000, kind: "full" }));
  store.record(row(300, { at: t - 2000, kind: "incr" }));
  store.record(row(400, { at: t - 3000, kind: "incr" }));
  store.record(row(20, { at: t - 4000, kind: "session" }), { logAll: true });
  store.flush();

  const { summary } = store.query({ days: 7 });
  assert.equal(summary.byKind.full.count, 2);
  assert.equal(summary.byKind.full.avgMs, 1500);
  assert.equal(summary.byKind.incr.count, 2);
  assert.equal(summary.byKind.incr.avgMs, 350);
  assert.equal(summary.byKind.session.count, 1);
  assert.equal(summary.byKind.session.avgMs, 20);
  store.close();
});

test("查询：空库给零，不是 null 也不是空对象", { skip: !DatabaseSync }, () => {
  const { store } = makeStore();
  const out = store.query({});
  assert.deepEqual(out.recent, []);
  assert.equal(out.summary.count, 0);
  assert.equal(out.summary.p95Ms, 0);
  assert.equal(out.summary.byKind.full.count, 0);
  assert.equal(out.settings.slowScanMs, SLOW_SCAN_MS);
  assert.equal(out.settings.retainDays, SCAN_LOG_RETAIN_DAYS);
  assert.ok(out.window.days > 0 && out.window.since < out.window.until);
  store.close();
});

test("查询：window 与 settings 如实带出，days 影响 since", { skip: !DatabaseSync }, () => {
  const { store, now } = makeStore();
  const t = now();
  const out = store.query({ days: 3 });
  assert.equal(out.window.days, 3);
  assert.equal(out.window.until, t);
  assert.equal(out.window.since, t - 3 * DAY);
  assert.equal(out.settings.logAll, false, "传什么就如实回什么");
  assert.equal(store.query({ logAll: true }).settings.logAll, true);
  store.close();
});

test("查询：窗口外的老行不出现在 summary 里（窗口筛选真的生效）", { skip: !DatabaseSync }, () => {
  const { store, now } = makeStore();
  const t = now();
  store.record(row(300, { at: t - 1 * DAY }));
  store.flush();
  // 再绕过 record/flush 直接塞一条 20 天前的：这两道都会把它滚掉，而这条测的是「查询窗口」。
  store.open().prepare(
    "INSERT INTO scan_log (at, kind, ms, cpu_user, cpu_sys, files, bytes, changed) VALUES (?,?,?,?,?,?,?,?)",
  ).run(t - 20 * DAY, "full", 5000, 0, 0, 1, 1, 1);

  assert.equal(store.count(), 2, "两行都在库里");
  const out = store.query({ days: 7 });
  assert.equal(out.summary.count, 1, "20 天前那条不进窗口");
  assert.equal(out.summary.maxMs, 300, "也不是 maxMs");
  assert.equal(out.recent.length, 1);
  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 健壮性：坏行不炸
// ─────────────────────────────────────────────────────────────────────────────
test("record：kind 不认识的落成 incr，负数毫秒夹到 0，缺字段给 0", { skip: !DatabaseSync }, () => {
  const { store } = makeStore();
  // logAll 打开：夹到 0 之后自然过不了慢扫描闸门，不放行就看不到归一化结果。
  store.record({ at: Date.now(), kind: "weird", ms: -5, cpuUser: -1, files: "3" }, { logAll: true });
  store.flush();
  const r = store.query({ days: 7 }).recent[0];
  assert.equal(r.kind, "incr");
  assert.equal(r.ms, 0);
  assert.equal(r.cpuUser, 0);
  assert.equal(r.files, 3, "字符串数字能收就收");
  assert.equal(r.bytes, 0, "缺的字段给 0");
  store.close();
});

test("record：传 null / undefined 之类不抛，只是返回 false", { skip: !DatabaseSync }, () => {
  const { store } = makeStore();
  assert.equal(store.record(null), false);
  assert.equal(store.record(undefined), false);
  assert.equal(store.pendingCount(), 0);
  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 设置项 scanLogAll：布尔项不能进数值区间校验分支
// ─────────────────────────────────────────────────────────────────────────────
test("设置：scanLogAll 默认 false，写入后读回；非布尔值被拦下", async () => {
  const { createSettingsService } = await import("../runtime/engine/services/settings.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-scanlog-settings-"));
  const service = createSettingsService({ dataDir: dir });

  assert.equal(service.read().scanLogAll, false, "默认不记全部扫描");
  assert.equal(service.write({ scanLogAll: true }).scanLogAll, true);
  assert.equal(createSettingsService({ dataDir: dir }).read().scanLogAll, true, "落盘了");
  assert.equal(service.write({ scanLogAll: false }).scanLogAll, false);

  // 别把布尔项丢进数值区间循环：'false' / 0 / null 一律拒，而不是当成「假」默默收下
  assert.throws(() => service.write({ scanLogAll: "false" }), /布尔/);
  assert.throws(() => service.write({ scanLogAll: 0 }), /布尔/);
  assert.throws(() => service.write({ scanLogAll: null }), /布尔/);
  assert.equal(service.read().scanLogAll, false, "被拒的写入不改盘上那份");

  // 原有两项的区间校验没被碰松
  assert.throws(() => service.write({ scanInterval: 5 }), /超出范围/);
  assert.throws(() => service.write({ highUsageThreshold: -1 }), /超出范围/);
  assert.equal(service.write({ scanInterval: 120 }).scanInterval, 120);
});

// ─────────────────────────────────────────────────────────────────────────────
// 端到端：引擎真的在扫完之后记了一行下去（采集接通了，而不只是 store 能写）
// ─────────────────────────────────────────────────────────────────────────────
const engineLog = { info() {}, warn() {}, error() {} };
const engLine = (ts, message) => JSON.stringify({ type: "message", timestamp: ts, message });

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-scanlog-home-"));
  const sessDir = path.join(home, "agents", "hanako", "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, "2026-10-24T10-00-00-000Z_e2e.jsonl"), [
    engLine("2026-10-24T10:00:00.000Z", { role: "user", content: "问" }),
    engLine("2026-10-24T10:00:05.000Z", { role: "assistant", model: "m", provider: "p", usage: { input: 100, output: 20, totalTokens: 120 } }),
  ].join("\n") + "\n");
  return home;
}

// 引擎模块顶层就按 HANA_HOME 解析 agents 路径，所以每个场景都得先把环境变量改好再 import。
// 同一进程里只能 import 一次，因此两步共用同一个 home：先按默认设置跑，再改设置重新 onload。
test("端到端：默认不记快扫描，scanLogAll 打开后全量扫描落一行", { skip: !DatabaseSync }, async () => {
  const home = makeHome();
  process.env.HANA_HOME = home;
  const { default: Engine } = await import("../runtime/engine/index.js");

  async function boot(dataDir) {
    const disposers = [];
    const engine = new Engine();
    engine.ctx = {
      dataDir,
      config: { get: () => undefined },
      log: engineLog,
      bus: { async request() { return { agents: [] }; }, subscribe: () => () => {}, handle: () => () => {}, emit() {} },
    };
    engine.register = (fn) => disposers.push(fn);
    await engine.onload();
    return { engine, disposers };
  }

  // 一）默认：只记 ≥200ms 的扫描。这份语料只有一个会话文件，扫完是毫秒级，所以一行都不该有。
  const dataA = fs.mkdtempSync(path.join(os.tmpdir(), "tt-scanlog-data-a-"));
  const a = await boot(dataA);
  try {
    const cache = a.engine.ctx._tokenCache;
    await cache.scanPromise; // onload 已经排了一轮（版本不匹配→全扫），等它跑完
    const store = cache.scanLogStore;
    assert.ok(store, "usingSqlite 时应当开出了 scan_log 存储");
    await cache.scan(true);   // 再来一轮全量，这回只盯它
    store.flush();
    assert.equal(store.count(), 0, "毫秒级的全量扫描默认不入库");
  } finally {
    for (const fn of a.disposers.reverse()) { try { fn(); } catch {} }
  }

  // 二）scanLogAll=true：全部入库，并且记录里的 kind/files/bytes 都对得上。
  const dataB = fs.mkdtempSync(path.join(os.tmpdir(), "tt-scanlog-data-b-"));
  fs.mkdirSync(path.join(dataB, "engine"), { recursive: true });
  fs.writeFileSync(path.join(dataB, "engine", "app-settings.json"), JSON.stringify({ scanLogAll: true }));
  const b = await boot(path.join(dataB, "engine"));
  try {
    const cache = b.engine.ctx._tokenCache;
    await cache.scanPromise;
    const store = cache.scanLogStore;
    store.flush();
    const base = store.count();
    await cache.scan(true);
    store.flush();
    assert.equal(store.count(), base + 1, "一轮全量扫描 = 一行");
    const r = store.query({ days: 7, limit: 1 }).recent[0];
    assert.equal(r.kind, "full", "force=true 走的是 full");
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
    assert.ok(r.cpuUser >= 0 && r.cpuSys >= 0, "CPU 时间是微秒级的非负数");
    assert.ok(r.files >= 1, "至少动了那一个会话文件，实际：" + r.files);
    assert.ok(r.bytes > 0, "字节数是那个会话文件的大小之和，实际：" + r.bytes);
    assert.ok(r.changed >= 1);

    // 再跑一轮单会话扫描：kind 应该是 session（这条通路与全扫分开记）
    const key = Object.keys(cache.data.sessions)[0];
    const sessionId = path.basename(cache.data.sessions[key].filePath).replace(/^.*_/, "").replace(/\.jsonl$/, "");
    fs.appendFileSync(cache.data.sessions[key].filePath, engLine("2026-10-24T10:01:00.000Z", { role: "user", content: "再问" }) + "\n");
    const before = store.count();
    await cache.scanSession({ agentId: "hanako", sessionId });
    store.flush();
    assert.equal(store.count(), before + 1, "单会话那一轮也记了一行");
    const kinds = store.query({ days: 7 }).recent.map((x) => x.kind);
    assert.equal(kinds[0], "session", "最新一条是 session 而不是退回全扫的 incr")
  } finally {
    for (const fn of b.disposers.reverse()) { try { fn(); } catch {} }
  }
});
