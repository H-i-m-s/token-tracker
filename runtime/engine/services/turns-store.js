// 「消费明细」的存储层：把每一轮对话从会话 JSON blob 里抽出来，落成真正的行。
//
// 背景：sessions 表一行一个会话，record 是整块 JSON，里面 conversations 数组才是「消费明细」
// 真正要看的东西。想按时间/用量/未命中排序、按天/agent/model 过滤、翻页，就得把 JSON 反序列化
// 全量再在内存里排 —— 数据一多每次都把整库搬一遍。
//
// 这里只做存储与查询：一张 turns 表 + 一个参数白名单的查询函数。
// record.conversations 本期照旧保留、照旧写（路由与载荷形状的改造是后续工单）。
//
// 写入按「先删后插、同一事务」进行：一个会话的所有轮次当成一个原子单位。
// 全量重扫整表重建，增量落盘只动真的变过/被移除的那几个会话，绝不放任上万行逐条 autocommit。
import fs from "node:fs";
import path from "node:path";
import { loadSqliteDriver } from "./cache-store.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS turns (
     session_key TEXT NOT NULL, seq INTEGER NOT NULL,
     at TEXT NOT NULL, day TEXT NOT NULL,
     agent TEXT NOT NULL, type TEXT NOT NULL,
     provider TEXT NOT NULL, model TEXT NOT NULL,
     total INTEGER NOT NULL, input INTEGER, output INTEGER,
     cache_read INTEGER, calls INTEGER,
     PRIMARY KEY (session_key, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS turns_at ON turns(at)`,
  `CREATE INDEX IF NOT EXISTS turns_day ON turns(day)`,
];

const INSERT_SQL =
  "INSERT INTO turns (session_key, seq, at, day, agent, type, provider, model, total, input, output, cache_read, calls) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
const DELETE_SESSION_SQL = "DELETE FROM turns WHERE session_key = ?";

// 排序键白名单：键 → SQL 表达式。表达式只来自这里，绝不拼接调用方字符串。
//   time     按轮次时间
//   tokens   按总量
//   uncached 按「未命中输入」= input - cache_read（与 ui/details-view.mjs 的 uncachedInput 同口径，负数夹到 0）
//   hit      按命中率 = cache_read / input，input 为空或 ≤ 0 的行给 NULL
const SORT_EXPR = {
  time: "at",
  tokens: "total",
  uncached: "MAX(COALESCE(input, 0) - COALESCE(cache_read, 0), 0)",
  hit: "CASE WHEN input IS NOT NULL AND input > 0 THEN CAST(cache_read AS REAL) / input ELSE NULL END",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const BACKFILL_CHUNK = 200;

// 筛选列匹配：非空数组 → col IN (?,?,…)（字段内 OR，多值）；单值字符串仍走 col = ?（原路径不变）。
// 空数组 / 空串 / null / undefined / 其它类型都不产生条件，与「不筛」同义（不是「筛成空」）。
function pushEq(where, params, col, v) {
  if (Array.isArray(v)) {
    if (!v.length) return;
    where.push(col + " IN (" + v.map(() => "?").join(",") + ")");
    for (const x of v) params.push(x);
    return;
  }
  if (typeof v === "string" && v !== "") { where.push(col + " = ?"); params.push(v); }
}

// 本地时区取日，写法与 scanDir/scanLedger 里的那行一模一样（避免 UTC 日期错位）。
// 时间戳缺失或非法时归到 "unknown"（day 是 NOT NULL，而且要给筛选一个可用的桶）。
function localDay(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d.getTime())) return "unknown";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// 可空列：老记录没有口径时给 NULL，不要用 0 冒充（0 是「真的用了 0」，NULL 是「不知道」）。
function numOrNull(v) {
  return v == null ? null : num(v);
}

// 一个会话的 record → 该会话所有轮次的参数元组。seq 从 1 起（第几轮），与 conversations 顺序一一对应。
export function turnRowsFor(key, session) {
  const convs = Array.isArray(session?.conversations) ? session.conversations : [];
  if (!convs.length) return [];
  const agent = session?.agent == null ? "" : String(session.agent);
  const type = session?.type == null ? "" : String(session.type);
  const out = [];
  for (let i = 0; i < convs.length; i++) {
    const c = convs[i] || {};
    const at = c.time == null ? "" : String(c.time);
    out.push([
      key, i + 1, at, localDay(at),
      agent, type,
      c.provider == null ? "" : String(c.provider),
      c.model == null ? "" : String(c.model),
      num(c.totalTokens), numOrNull(c.inTokens), numOrNull(c.outTokens),
      numOrNull(c.cacheRead), numOrNull(c.msgCount),
    ]);
  }
  return out;
}

export function createSqliteTurnsStore({ DatabaseSync, file, log = () => {} }) {
  let db = null;

  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    // 与 cache-store 共用同一个库文件，用独立的连接。写操作总是串行发生（JS 单线程、写完即提交），
    // busy_timeout 只是给「另一个连接恰好持锁」留一点重试余量，不让偶发的 SQLITE_BUSY 冒到调用方。
    try { d.exec("PRAGMA busy_timeout = 5000"); } catch {}
    try { d.exec("PRAGMA journal_mode = WAL"); } catch {}
    try { d.exec("PRAGMA synchronous = NORMAL"); } catch {}
    for (const sql of SCHEMA) d.exec(sql);
    db = d;
    return db;
  }

  function insertStatement(d) {
    return d.prepare(INSERT_SQL);
  }

  // 单会话：先删后插，同一事务。会话没有 conversations 时等于只删。
  function replaceSession(key, session) {
    const d = open();
    d.exec("BEGIN");
    try {
      replaceSessionNoTx(d, key, session);
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }

  function replaceSessionNoTx(d, key, session, ins = null) {
    d.prepare(DELETE_SESSION_SQL).run(key);
    const stmt = ins || insertStatement(d);
    for (const r of turnRowsFor(key, session)) stmt.run(...r);
  }

  function removeSession(key) {
    open().prepare(DELETE_SESSION_SQL).run(key);
  }

  // 全量重扫：整表重建（一个事务，删光再插光），别逐行 autocommit。
  function rebuild(data) {
    const d = open();
    const sessions = data?.sessions || {};
    let inserted = 0;
    d.exec("BEGIN");
    try {
      d.exec("DELETE FROM turns");
      const ins = insertStatement(d);
      for (const key of Object.keys(sessions)) {
        for (const r of turnRowsFor(key, sessions[key])) { ins.run(...r); inserted += 1; }
      }
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
    if (inserted > 200) {
      try { d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { log.warn("[token-tracker] turns 库 WAL 回收失败（下次检查点会处理）：", e.message); }
    }
    return inserted;
  }

  // 增量落盘：changed.key 是这一轮真的动过的会话（与 cache-store 的 touched 同源）。
  // 键还在 sessions 里 → 重建该会话的行；已经不在 → 删掉它的行。整批一个事务。
  function apply(data, changed) {
    const sessions = data?.sessions || {};
    if (changed?.all) return rebuild(data);
    const keys = Array.isArray(changed?.keys) ? changed.keys : [];
    if (!keys.length) return 0;
    const d = open();
    let n = 0;
    d.exec("BEGIN");
    try {
      const ins = insertStatement(d);
      for (const key of keys) {
        const s = sessions[key];
        if (s) { replaceSessionNoTx(d, key, s, ins); n += 1; }
        else { d.prepare(DELETE_SESSION_SQL).run(key); n += 1; }
      }
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
    return n;
  }

  function count() {
    const row = open().prepare("SELECT COUNT(*) AS n FROM turns").get();
    return Number(row?.n) || 0;
  }

  // 迁移回填：turns 为空而 sessions 里还有 conversations 时，把历史一次性铺进表。
  // 分批提交并在批间让出一拍，别把事件循环按死。
  async function backfill(data) {
    const d = open();
    const sessions = data?.sessions || {};
    const keys = Object.keys(sessions);
    let inserted = 0;
    for (let i = 0; i < keys.length; i += BACKFILL_CHUNK) {
      d.exec("BEGIN");
      try {
        const ins = insertStatement(d);
        const end = Math.min(i + BACKFILL_CHUNK, keys.length);
        for (let j = i; j < end; j++) {
          for (const r of turnRowsFor(keys[j], sessions[keys[j]])) { ins.run(...r); inserted += 1; }
        }
        d.exec("COMMIT");
      } catch (e) {
        try { d.exec("ROLLBACK"); } catch {}
        throw e;
      }
      await new Promise((r) => setImmediate(r));
    }
    return inserted;
  }

  // 参数白名单 + 全参数化：过滤列名与排序表达式都取自固定表，值一律走占位符，没有字符串拼 SQL 的注入口。
  function query(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const d = open();
    const where = [];
    const params = [];
    const eq = (col, v) => pushEq(where, params, col, v);
    if (typeof o.from === "string" && o.from !== "") { where.push("day >= ?"); params.push(o.from); }
    if (typeof o.to === "string" && o.to !== "") { where.push("day <= ?"); params.push(o.to); }
    eq("agent", o.agent);
    eq("model", o.model);
    eq("provider", o.provider);
    eq("type", o.type);
    const min = Number(o.minTokens);
    if (Number.isFinite(min) && min > 0) { where.push("total >= ?"); params.push(min); }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";

    const agg = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS s FROM turns" + clause).get(...params);
    const total = Number(agg?.n) || 0;
    const sumTokens = Number(agg?.s) || 0;
    if (!total) return { rows: [], total: 0, sumTokens: 0 };

    const sortKey = Object.prototype.hasOwnProperty.call(SORT_EXPR, o.sortKey) ? o.sortKey : "time";
    const expr = SORT_EXPR[sortKey];
    const dir = o.order === "asc" ? "ASC" : "DESC";
    // 空值（hit 对没有口径的行）一律排最后；同值一律用 at DESC 兜底，末了再用主键钉住，
    // 保证分页顺序稳定 —— 否则同一条记录可能在两页里各出现一次。
    const orderBy = `(${expr} IS NULL) ASC, ${expr} ${dir}, at DESC, session_key ASC, seq ASC`;

    const lim = Number(o.limit);
    const limit = Number.isFinite(lim) && lim > 0 ? Math.min(Math.floor(lim), MAX_LIMIT) : DEFAULT_LIMIT;
    const offRaw = Number(o.offset);
    const offset = Number.isFinite(offRaw) && offRaw > 0 ? Math.floor(offRaw) : 0;

    const select = "SELECT session_key AS sessionKey, seq, at, day, agent, type, provider, model, total, input, output, cache_read AS cacheRead, calls " +
      "FROM turns" + clause + " ORDER BY " + orderBy;
    // all=true：不分页（导出要的就是「当前筛选下的全部行」，而不是某一页）。
    const rows = o.all === true
      ? d.prepare(select).all(...params)
      : d.prepare(select + " LIMIT ? OFFSET ?").all(...params, limit, offset);

    // node:sqlite 给的是 null 原型对象，展开成普通对象，别让调用方在 deepEqual / 原型链上踩坑。
    return { rows: rows.map((r) => ({ ...r })), total, sumTokens };
  }

  // 单轮大小的分布只吃 (model, total) 两列：上万行不必把整行搬出来。
  // 与 query 共用同一套筛选（date/agent/model/provider/type），但不设 minTokens、不排序、不分页 ——
  // 分布看的是「这批筛选下的全部轮次」，与门槛无关（与旧的「先把全量行喂给 summarizeTurns」同口径）。
  function queryTurnSizes(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const d = open();
    const where = [];
    const params = [];
    const eq = (col, v) => pushEq(where, params, col, v);
    if (typeof o.from === "string" && o.from !== "") { where.push("day >= ?"); params.push(o.from); }
    if (typeof o.to === "string" && o.to !== "") { where.push("day <= ?"); params.push(o.to); }
    eq("agent", o.agent);
    eq("model", o.model);
    eq("provider", o.provider);
    eq("type", o.type);
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    return d.prepare("SELECT model, total FROM turns" + clause).all(...params)
      .map((r) => ({ model: String(r.model ?? ""), totalTokens: Number(r.total) || 0 }));
  }

  function close() {
    try { db?.close(); } catch {}
    db = null;
  }

  return { open, replaceSession, removeSession, rebuild, apply, count, backfill, query, queryTurnSizes, close };
}

// 查询入口（工单约定的签名）。store 缺失时退化成空结果，调用方不必先判空。
export function queryTurns(store, opts) {
  if (!store || typeof store.query !== "function") return { rows: [], total: 0, sumTokens: 0 };
  return store.query(opts);
}

// (model, total) 对，喂给 visual-analytics 的 summarizeTurns。没 store 时给空数组。
export function queryTurnSizes(store, opts) {
  if (!store || typeof store.queryTurnSizes !== "function") return [];
  return store.queryTurnSizes(opts);
}

// 驱动拿不到时返回 null，调用方退化到「不落 turns 表」，功能不受影响。
export function openTurnsStore({ file, log = () => {} } = {}) {
  const DatabaseSync = loadSqliteDriver();
  if (!DatabaseSync) return null;
  try {
    return createSqliteTurnsStore({ DatabaseSync, file, log });
  } catch (e) {
    log.warn("[token-tracker] turns 库打开失败：", e.message);
    return null;
  }
}

export default { createSqliteTurnsStore, queryTurns, queryTurnSizes, openTurnsStore, turnRowsFor };
