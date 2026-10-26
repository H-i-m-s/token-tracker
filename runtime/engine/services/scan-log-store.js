// 扫描耗时的自述账本：每轮扫描一行，回答「这一轮到底花了多久、多少 CPU、动了几个文件」。
//
// 背景：增量扫描已经收窄到「只扫事件涉及的那一个会话」，但没有任何手段证明它真的变快了。
// 没有数字，下一轮就只能在「感觉快了点」和「好像还是卡」之间反复猜。这里只做一件事：
// 把每次扫描的墙钟耗时、进程 CPU 时间、涉及的文件数与字节数落成行，攒够了一起写。
//
// 三条设计约束，都是刻意的：
//   1) 采样本身必须便宜 —— 调用方只贡献 process.cpuUsage() 与 Date.now() 各两次，本模块只做
//      一次 Set 遍历（算 bytes/changed），绝不为了记账去遍历全量会话。所以「默认只记慢扫描」
//      不只是为了省空间：日常增量扫描几乎不产生行，这个表长期是空的，查询成本接近零。
//   2) 落盘攒批 —— 一个事务插完一批，绝不逐条 autocommit。SQLite 每次提交都要 fsync，
//      逐条写在慢盘上能把「记账」本身变成被记账的对象。
//   3) 只删不整理 —— 见 SCAN_LOG_RETAIN_DAYS 处的注释，不要加 VACUUM。
import fs from "node:fs";
import path from "node:path";
import { loadSqliteDriver } from "./cache-store.js";

// 慢扫描门槛：只有墙钟耗时 ≥ 这个值的扫描才入库。
// 200ms 的取法：一次全量重扫实测约 8 秒，一次单会话扫描通常 1~20ms，中间的 200ms 恰好是
// 「一眼能感觉到卡」的位置。低于它记下来只会把表塞满噪声，把真正的慢扫描淹掉。
export const SLOW_SCAN_MS = 200;

// 保留 7 天。选 7 天的理由：这个表的用途是「回答被追问的那一两个问题」——
// 「刚才那下卡了多久」「升级前后有没有变慢」，看的是最近几小时到最近几天；
// 再看更远的历史，会话文件本身也不是同一批了，比较失去意义。
// 7 天足够覆盖一个「周一到周五出问题、周一回来查」的周期。
export const SCAN_LOG_RETAIN_DAYS = 7;

// 攒批触发：条数或时间，任一满足即落盘。
export const SCAN_LOG_FLUSH_ROWS = 200;
export const SCAN_LOG_FLUSH_MS = 5 * 60 * 1000;

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 500;
export const MAX_QUERY_DAYS = 30;

const DAY_MS = 86400 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scan_log (
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     ms INTEGER NOT NULL,
     cpu_user INTEGER NOT NULL,
     cpu_sys INTEGER NOT NULL,
     files INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     changed INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS scan_log_at ON scan_log(at)`,
];

const INSERT_SQL =
  "INSERT INTO scan_log (at, kind, ms, cpu_user, cpu_sys, files, bytes, changed) VALUES (?,?,?,?,?,?,?,?)";
// 滚动删除与插入在同一个事务里：留一行垃圾等下一轮再删，只会让「保留 7 天」变成「大约 7 天」。
const DELETE_BEFORE_SQL = "DELETE FROM scan_log WHERE at < ?";
const SELECT_RECENT_SQL =
  "SELECT at, kind, ms, cpu_user AS cpuUser, cpu_sys AS cpuSys, files, bytes, changed " +
  "FROM scan_log WHERE at >= ? ORDER BY at DESC, rowid DESC LIMIT ?";
const SELECT_WINDOW_SQL = "SELECT at, kind, ms FROM scan_log WHERE at >= ?";

const KINDS = ["full", "incr", "session"];

function clampInt(v, fallback, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// 最近秩（nearest-rank）：把 n 个样本升序排好，取第 ceil(p*n) 个。
// 不插值、不平均，返回的永远是真实观测到的那个值 —— 诊断看的是「最坏的那一次有多坏」，
// 一个插值出来的 217.3ms 反而不如真实的 219ms 有说服力。
export function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx];
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function normalize(row, now) {
  if (!row || typeof row !== "object") return null;
  const atNum = Number(row.at);
  const msNum = Number(row.ms);
  const at = Number.isFinite(atNum) ? Math.round(atNum) : now();
  const ms = Number.isFinite(msNum) ? Math.max(Math.round(msNum), 0) : 0;
  const nonNeg = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(Math.round(n), 0) : 0;
  };
  return {
    at,
    kind: KINDS.includes(row.kind) ? row.kind : "incr",
    ms,
    cpuUser: nonNeg(row.cpuUser),
    cpuSys: nonNeg(row.cpuSys),
    files: nonNeg(row.files),
    bytes: nonNeg(row.bytes),
    changed: nonNeg(row.changed),
  };
}

export function createSqliteScanLogStore({
  DatabaseSync,
  file,
  log = () => {},
  now = Date.now,
  flushRows = SCAN_LOG_FLUSH_ROWS,
  flushMs = SCAN_LOG_FLUSH_MS,
} = {}) {
  let db = null;
  let buf = [];
  let timer = null;
  let closed = false;

  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    // 与 cache-store / turns-store 共用同一个库文件，但用独立连接。
    // 建表放在 open 里（惰性）而不是构造时：驱动缺失或库文件被锁死时，构造不该抛，
    // 调用方拿到的对象此后每次写入都会静默退化，App 其余功能不受影响。
    try { d.exec("PRAGMA busy_timeout = 5000"); } catch {}
    try { d.exec("PRAGMA journal_mode = WAL"); } catch {}
    try { d.exec("PRAGMA synchronous = NORMAL"); } catch {}
    for (const sql of SCHEMA) d.exec(sql);
    db = d;
    return db;
  }

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  function arm() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, flushMs);
    timer.unref?.();
  }

  // 一个事务：整批插入 + 顺手滚掉超期行。
  //
  // 这里没有 VACUUM，而且不要加：SQLite 删掉的行会进 freelist，后续 INSERT 直接复用那些页，
  // 库文件的稳定大小就等于「7 天里最多攒下多少行」，不会持续膨胀。VACUUM 是把整个库重写一遍
  // （临时文件 + 全量拷贝 + 重建索引），在几十万行的库上要几百毫秒到几秒，代价远超收益。
  // 如果将来嫌文件大，正确做法是调 RETAIN_DAYS 或 delete 之后靠 page_size 复用，不是 VACUUM。
  function flush() {
    clearTimer();
    if (!buf.length) return 0;
    const rows = buf;
    buf = [];
    let d;
    try {
      d = open();
    } catch (e) {
      // 库打不开：把行放回去（并设上限），下次再试。不能让记账把 App 拖死。
      buf = rows.concat(buf);
      log?.warn?.("[token-tracker] scan_log 库打不开，暂存 " + buf.length + " 行：", e?.message || e);
      return 0;
    }
    const t = now();
    const before = t - SCAN_LOG_RETAIN_DAYS * DAY_MS;
    try {
      d.exec("BEGIN");
      try {
        const ins = d.prepare(INSERT_SQL);
        for (const r of rows) {
          ins.run(r.at, r.kind, r.ms, r.cpuUser, r.cpuSys, r.files, r.bytes, r.changed);
        }
        d.prepare(DELETE_BEFORE_SQL).run(before);
        d.exec("COMMIT");
      } catch (e) {
        try { d.exec("ROLLBACK"); } catch {}
        throw e;
      }
    } catch (e) {
      // 回滚了，这批行一条都没进库：放回缓冲区下次重试，别悄悄丢掉唯一的诊断线索。
      buf = rows.concat(buf);
      if (buf.length > flushRows * 20) buf = buf.slice(buf.length - flushRows * 20);
      log?.warn?.("[token-tracker] scan_log 落盘失败（" + rows.length + " 行留待重试）：", e?.code || "", e?.message || e);
      return 0;
    }
    return rows.length;
  }

  /**
   * 记一轮扫描。门槛在入缓冲之前就判掉，所以「没入库」和「还没落盘」是两件不同的事：
   * 前者是策略（默认只记慢扫描），后者只是时间差。
   * @returns {boolean} 这一行有没有被接受进缓冲
   */
  function record(row, opts) {
    if (closed) return false;
    const r = normalize(row, now);
    if (!r) return false;
    // 默认只记慢扫描：详细到每一轮 5ms 的增量扫描没有诊断价值，只会把表塞成噪声。
    if (opts?.logAll !== true && r.ms < SLOW_SCAN_MS) return false;
    buf.push(r);
    if (buf.length >= flushRows) { flush(); return true; }
    arm();
    return true;
  }

  // 显式滚动：删掉 before 之前的行。严格小于，边界那一行留下（「7 天前这一毫秒」还在窗口里）。
  function prune(before) {
    const t = Number(before);
    if (!Number.isFinite(t)) return 0;
    const d = open();
    const r = d.prepare(DELETE_BEFORE_SQL).run(Math.round(t));
    return Number(r?.changes) || 0;
  }

  function count() {
    const row = open().prepare("SELECT COUNT(*) AS n FROM scan_log").get();
    return Number(row?.n) || 0;
  }

  function pendingCount() {
    return buf.length;
  }

  /**
   * 诊断查询：窗口内最近 limit 条 + 汇总。所有值走占位符，没有任何字符串拼 SQL。
   * summary 在 JS 里算：SQLite 没有 percentile，硬塞窗口函数只会把 20 行数据写成一屏看不清的 SQL。
   * 窗口内行数本来就被「只记慢扫描 + 7 天保留 + 攒批」压得很小，多搬一遍两列是几微秒的事。
   */
  function query(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const limit = clampInt(o.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const days = clampInt(o.days, SCAN_LOG_RETAIN_DAYS, MAX_QUERY_DAYS);
    const until = now();
    const since = until - days * DAY_MS;

    const empty = {
      recent: [],
      summary: {
        count: 0, avgMs: 0, p95Ms: 0, maxMs: 0,
        byKind: { full: { count: 0, avgMs: 0 }, incr: { count: 0, avgMs: 0 }, session: { count: 0, avgMs: 0 } },
      },
      window: { days, since, until },
      settings: { slowScanMs: SLOW_SCAN_MS, logAll: o.logAll === true, retainDays: SCAN_LOG_RETAIN_DAYS },
    };

    const d = open();
    const recent = d.prepare(SELECT_RECENT_SQL).all(since, limit).map((r) => ({
      at: Number(r.at), kind: String(r.kind), ms: Number(r.ms),
      cpuUser: Number(r.cpuUser), cpuSys: Number(r.cpuSys),
      files: Number(r.files), bytes: Number(r.bytes), changed: Number(r.changed),
    }));
    const window = d.prepare(SELECT_WINDOW_SQL).all(since);

    const msList = [];
    const byKind = {
      full: { count: 0, avgMs: 0 },
      incr: { count: 0, avgMs: 0 },
      session: { count: 0, avgMs: 0 },
    };
    const sums = { full: 0, incr: 0, session: 0 };
    let sum = 0;
    let max = 0;
    for (const r of window) {
      const ms = Number(r.ms) || 0;
      msList.push(ms);
      sum += ms;
      if (ms > max) max = ms;
      const kind = KINDS.includes(r.kind) ? r.kind : "incr";
      byKind[kind].count += 1;
      sums[kind] += ms;
    }
    const n = msList.length;
    for (const k of KINDS) {
      byKind[k].avgMs = byKind[k].count ? round1(sums[k] / byKind[k].count) : 0;
    }

    if (!n) return { ...empty, recent, window: { days, since, until } };

    return {
      recent,
      summary: {
        count: n,
        avgMs: round1(sum / n),
        p95Ms: percentile(msList, 0.95),
        maxMs: max,
        byKind,
      },
      window: { days, since, until },
      settings: { slowScanMs: SLOW_SCAN_MS, logAll: o.logAll === true, retainDays: SCAN_LOG_RETAIN_DAYS },
    };
  }

  // 卸载：先把缓冲区刷一次（丢一个攒批窗口的诊断数据不划算），再关连接。
  function close() {
    try { flush(); } catch {}
    closed = true;
    clearTimer();
    buf = [];
    try { db?.close(); } catch {}
    db = null;
  }

  return { open, record, flush, prune, query, count, pendingCount, close };
}

// 驱动拿不到时返回 null：记账是锦上添花，不能因为它挡住 App 启动。
export function openScanLogStore({ file, log = () => {}, DatabaseSync = null, now, flushRows, flushMs } = {}) {
  const Driver = DatabaseSync || loadSqliteDriver();
  if (!Driver) return null;
  try {
    return createSqliteScanLogStore({ DatabaseSync: Driver, file, log, now, flushRows, flushMs });
  } catch (e) {
    log?.warn?.("[token-tracker] scan_log 库打开失败：", e?.message || e);
    return null;
  }
}

export default {
  createSqliteScanLogStore, openScanLogStore, percentile,
  SLOW_SCAN_MS, SCAN_LOG_RETAIN_DAYS, SCAN_LOG_FLUSH_ROWS, SCAN_LOG_FLUSH_MS,
};
