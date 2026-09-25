// 缓存落盘介质：按「每个会话一行」存进 SQLite，一次落盘只写变化的那几行。
//
// 背景：这份缓存是派生数据（权威在 agents/*/sessions/*.jsonl），唯一用途是让下次启动少扫一遍。
// 整块重写六十多 MiB 的 JSON，会把几千字节的变化放大成上万倍。换成按行存储后，
// 一次落盘的字节数跟「这一轮真的变过的那几个会话」成正比，而不是跟整个语料成正比。
//
// 「哪一行变了」不额外记账：直接用会话记录里本来就有的 mtime / size —— 增量扫描正是按这两个
// 字段决定要不要重解析文件，所以它们没变，就等于这一行的内容没变。另有两处会就地改动记录而
// 不动 mtime/size（5 天窗口裁剪、账本会话重建），由调用方通过 forced 显式补报。
//
// node:sqlite 自 Node 22.5 起可用，目前是实验模块。拿不到驱动时 loadSqliteDriver 返回 null，
// 调用方退回原来的 JSON 快照，功能不受影响。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const TABLE = "sessions";
const META_KEY = "state";
const require = createRequire(import.meta.url);

// 同步拿驱动（内置模块，require 即可），避免把异步传染给引擎的启动流程。
export function loadSqliteDriver() {
  try {
    const mod = require("node:sqlite");
    return typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

export function createSqliteCacheStore({ DatabaseSync, file, log = () => {} }) {
  let db = null;
  const rows = new Map(); // key -> { mtime, size }：上一次落盘时这一行的状态

  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    // WAL + synchronous=NORMAL：提交不 fsync，只有检查点才落盘，写入尽量小。
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA synchronous = NORMAL");
    d.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, mtime REAL, size REAL, record TEXT NOT NULL)`);
    d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db = d;
    return db;
  }

  function load() {
    try {
      const d = open();
      const sessions = {};
      for (const row of d.prepare(`SELECT key, mtime, size, record FROM ${TABLE}`).all()) {
        let record;
        try { record = JSON.parse(row.record); } catch { continue; }
        if (!record || typeof record !== "object") continue;
        sessions[row.key] = record;
        rows.set(row.key, { mtime: row.mtime, size: row.size });
      }
      if (!Object.keys(sessions).length) return null; // 空库：当作没有缓存，让调用方走全量
      let rest = {};
      const meta = d.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY);
      if (meta?.value) { try { rest = JSON.parse(meta.value); } catch {} }
      return { ...rest, sessions };
    } catch (e) {
      log.warn("[token-tracker] sqlite 缓存读取失败：", e.code || "", e.message);
      return null;
    }
  }

  // forced：调用方明确知道变了、但 mtime/size 看不出来的键。
  // all：整库重写（首次导入、全量重扫）。
  function save(data, forced, all) {
    const d = open();
    const sessions = data.sessions || {};
    const touched = new Set(forced || []);
    const writeAll = !!(all || rows.size === 0);
    const why = { forced: touched.size, stale: 0, gone: 0 };
    if (writeAll) {
      const before = touched.size;
      for (const key of Object.keys(sessions)) touched.add(key);
      why.stale = touched.size - before;
    } else {
      for (const key of Object.keys(sessions)) {
        const prev = rows.get(key);
        const cur = sessions[key];
        if (!prev || prev.mtime !== cur.mtime || prev.size !== cur.size) { touched.add(key); why.stale += 1; }
      }
    }
    // 已经不在缓存里的行要删掉（账本按天分键，旧的那天会被移除）
    for (const key of rows.keys()) if (!(key in sessions)) { touched.add(key); why.gone += 1; }

    const upsert = d.prepare(`INSERT INTO ${TABLE} (key, mtime, size, record) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, record=excluded.record`);
    const remove = d.prepare(`DELETE FROM ${TABLE} WHERE key = ?`);
    let count = 0;
    let bytes = 0;
    d.exec("BEGIN");
    try {
      for (const key of touched) {
        const record = sessions[key];
        if (!record) {
          remove.run(key);
          rows.delete(key);
          count += 1;
          continue;
        }
        const text = JSON.stringify(record);
        const mtime = Number(record.mtime) || 0;
        const size = Number(record.size) || 0;
        upsert.run(key, mtime, size, text);
        rows.set(key, { mtime, size });
        count += 1;
        bytes += Buffer.byteLength(text);
      }
      d.exec("COMMIT");
      // 批量写入（首次导入、全量重扫）会把 WAL 撑到和库一样大，主动回收一次；
      // 增量落盘只有几十 KB，交给 SQLite 自己按阈值处理。
      if (all || count > 200) {
        try { d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { log.warn("[token-tracker] WAL 回收失败（下次检查点会自己处理）：", e.message); }
      }
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
    return { rows: count, bytes, scope: writeAll ? "全量" : "增量", why };
  }

  // meta（除 sessions 以外的状态）单独写：调度器要先把这一轮的真实计数更新完再写它。
  function saveMeta(data) {
    const d = open();
    const rest = { ...data };
    delete rest.sessions;
    const text = JSON.stringify(rest);
    d.prepare("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(META_KEY, text);
    return Buffer.byteLength(text);
  }

  function close() {
    try { db?.close(); } catch {}
    db = null;
  }

  return { load, save, saveMeta, close, rowCount: () => rows.size };
}
