// DeepSeek 官网用量的落盘缓存。
//
// 介质选 SQLite 的原因只有一个：**按行增量写**。整块重写一个文件时，几百字节的更新会被
// 放大成整文件写；一天下来就是几十 GB 的擦写。按行 upsert 之后，写入量只跟「这一轮真的
// 变过的行」成正比。
//
// 四张表：
//   ds_point       一个时间桶一行（桶长由 bucket 区分：86400 天 / 3600 小时）；
//   ds_meta        覆盖范围、探测边界这类状态，以及诊断槽；
//   ds_token_hint  上次在哪找到 token（只有路径和时间，绝不含 token 本身）。
import fs from "node:fs";
import path from "node:path";
import { loadSqliteDriver } from "./cache-store.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ds_point (
     t INTEGER NOT NULL,
     bucket INTEGER NOT NULL,
     kind TEXT NOT NULL,
     model TEXT NOT NULL,
     type TEXT NOT NULL,
     amount REAL NOT NULL,
     PRIMARY KEY (t, bucket, kind, model, type)
   )`,
  `CREATE INDEX IF NOT EXISTS ds_point_by_t ON ds_point (bucket, kind, t)`,
  `CREATE TABLE IF NOT EXISTS ds_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS ds_token_hint (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     partition TEXT,
     file TEXT,
     mtime REAL,
     updated_at INTEGER
   )`,
];

export function createDsUsageStore({ DatabaseSync, file, log = () => {} }) {
  let db = null;

  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA synchronous = NORMAL");
    for (const sql of SCHEMA) d.exec(sql);
    db = d;
    return db;
  }

  // 写入一批点：一个事务，按 (t,bucket,kind,model,type) upsert。
  // 覆盖式更新（同键改值）由 ON CONFLICT 处理；不删旧行，历史因此只增不减。
  function savePoints(kind, bucket, points) {
    const d = open();
    const ins = d.prepare(
      "INSERT INTO ds_point (t, bucket, kind, model, type, amount) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(t,bucket,kind,model,type) DO UPDATE SET amount=excluded.amount"
    );
    let n = 0;
    d.exec("BEGIN");
    try {
      for (const p of points || []) {
        for (const [model, byType] of Object.entries(p.byModel || {})) {
          for (const [type, amount] of Object.entries(byType)) {
            ins.run(Number(p.t), Number(bucket), kind, model, type, Number(amount) || 0);
            n += 1;
          }
        }
      }
      d.exec("COMMIT");
      if (n > 200) {
        try { d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { log.warn("[token-tracker] ds 库 WAL 回收失败（下次检查点会处理）：", e.message); }
      }
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
    return n;
  }

  // 读某粒度 / 某口径下 [fromT, toT) 的行。
  function rangePoints(kind, bucket, fromT, toT) {
    return open().prepare(
      "SELECT t, model, type, amount FROM ds_point WHERE kind = ? AND bucket = ? AND t >= ? AND t < ? ORDER BY t"
    ).all(kind, bucket, Math.floor(fromT), Math.floor(toT));
  }

  // [fromT, toT) 内实际存在的桶时间戳（用于判断缺口）。
  function bucketTimes(bucket, fromT, toT) {
    return open().prepare(
      "SELECT DISTINCT t FROM ds_point WHERE bucket = ? AND t >= ? AND t < ? ORDER BY t"
    ).all(bucket, Math.floor(fromT), Math.floor(toT)).map(r => r.t);
  }

  // 某粒度下的全局范围：最早/最晚桶。
  function extent(bucket) {
    const row = open().prepare("SELECT MIN(t) AS lo, MAX(t) AS hi, COUNT(*) AS n FROM ds_point WHERE bucket = ?").get(bucket);
    return { lo: row?.lo ?? null, hi: row?.hi ?? null, rows: row?.n ?? 0 };
  }

  function totalRows() {
    const row = open().prepare("SELECT COUNT(*) AS n FROM ds_point").get();
    return row?.n ?? 0;
  }

  // ── meta：覆盖范围 / 探测边界 / 诊断槽 ──
  function setMeta(key, value) {
    try {
      open().prepare("INSERT INTO ds_meta (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
        .run(key, JSON.stringify(value ?? null), Date.now());
    } catch (e) { log.warn("[token-tracker] ds meta 写入失败：", key, e.message); }
  }

  function getMeta(key) {
    try {
      const row = open().prepare("SELECT value, updated_at FROM ds_meta WHERE key = ?").get(key);
      if (!row) return null;
      let value; try { value = JSON.parse(row.value); } catch { value = row.value; }
      return { value, updatedAt: row.updated_at };
    } catch { return null; }
  }

  // ── token 线索：只有「哪个文件、什么时候改的」，token 本身永远不进这里 ──
  function readHint() {
    try {
      const row = open().prepare("SELECT partition, file, mtime FROM ds_token_hint WHERE id = 1").get();
      return row && row.file ? { partition: row.partition, file: row.file, mtime: row.mtime } : null;
    } catch { return null; }
  }

  function writeHint(source) {
    try {
      if (!source?.file) return;
      open().prepare("INSERT INTO ds_token_hint (id, partition, file, mtime, updated_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET partition=excluded.partition, file=excluded.file, mtime=excluded.mtime, updated_at=excluded.updated_at")
        .run(source.partition || null, source.file, Number(source.mtime) || 0, Date.now());
    } catch (e) {
      log.warn("[token-tracker] 写 token 线索失败：", e.message);
    }
  }

  function close() {
    try { db?.close(); } catch {}
    db = null;
  }

  return { savePoints, rangePoints, bucketTimes, extent, totalRows, setMeta, getMeta, readHint, writeHint, close };
}

// 驱动拿不到时返回 null，调用方退化到「不缓存、每次现拉」，功能不受影响。
export function openDsUsageStore({ file, log = () => {} } = {}) {
  const DatabaseSync = loadSqliteDriver();
  if (!DatabaseSync) return null;
  try {
    return createDsUsageStore({ DatabaseSync, file, log });
  } catch (e) {
    log.warn("[token-tracker] ds 用量库打开失败：", e.message);
    return null;
  }
}

export default { createDsUsageStore, openDsUsageStore };
