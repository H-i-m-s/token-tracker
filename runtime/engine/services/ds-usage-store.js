// DeepSeek 官网用量的落盘缓存。
//
// 介质选 SQLite 的原因只有一个：**按行增量写**。整块重写一个文件时，几百字节的更新会被
// 放大成整文件写；一天下来就是几十 GB 的擦写。按行 upsert 之后，写入量只跟「这一轮真的
// 变过的行」成正比。
//
// 三张表：
//   ds_daily       按 天×模型×口径×类型 存一行用量或金额；
//   ds_month       每个月的新鲜度（当月会变，历史月冻结）与币种；
//   ds_token_hint  上次在哪找到 token（只有路径和时间，绝不含 token 本身）。
import fs from "node:fs";
import path from "node:path";
import { loadSqliteDriver } from "./cache-store.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ds_daily (
     date TEXT NOT NULL,
     model TEXT NOT NULL,
     kind TEXT NOT NULL,
     type TEXT NOT NULL,
     amount REAL NOT NULL,
     PRIMARY KEY (date, model, kind, type)
   )`,
  `CREATE TABLE IF NOT EXISTS ds_month (
     ym TEXT PRIMARY KEY,
     fetched_at INTEGER NOT NULL,
     amount_ok INTEGER NOT NULL DEFAULT 0,
     cost_ok INTEGER NOT NULL DEFAULT 0,
     currency TEXT
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

  // 一个月的数据一次性覆盖式写入：先删该月旧行，再插入新行，同一个事务里完成。
  // 官网的当月数据会持续变动，与其逐行比对，不如把「这个月的 1800 行」整体换掉——
  // 量级很小，且只在真去拉取时发生。
  function saveMonth(ym, { usageRows = [], costRows = [], currency = null, amountOk = true, costOk = true } = {}) {
    const d = open();
    d.exec("BEGIN");
    try {
      d.prepare("DELETE FROM ds_daily WHERE substr(date,1,7) = ?").run(ym);
      const ins = d.prepare("INSERT INTO ds_daily (date, model, kind, type, amount) VALUES (?,?,?,?,?) ON CONFLICT(date,model,kind,type) DO UPDATE SET amount=excluded.amount");
      let n = 0;
      for (const r of usageRows) { ins.run(r.date, r.model, "usage", r.type, Number(r.amount) || 0); n += 1; }
      for (const r of costRows) { ins.run(r.date, r.model, "cost", r.type, Number(r.amount) || 0); n += 1; }
      d.prepare("INSERT INTO ds_month (ym, fetched_at, amount_ok, cost_ok, currency) VALUES (?,?,?,?,?) ON CONFLICT(ym) DO UPDATE SET fetched_at=excluded.fetched_at, amount_ok=excluded.amount_ok, cost_ok=excluded.cost_ok, currency=excluded.currency")
        .run(ym, Date.now(), amountOk ? 1 : 0, costOk ? 1 : 0, currency);
      d.exec("COMMIT");
      // 每次整月替换都是约 1800 行，WAL 会跟着长；写得多就回收一次，别让它无限堆积。
      if (n > 200) {
        try { d.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { log.warn("[token-tracker] ds 库 WAL 回收失败（下次检查点会处理）：", e.message); }
      }
      return n;
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }

  function getMonth(ym) {
    const d = open();
    const meta = d.prepare("SELECT ym, fetched_at, amount_ok, cost_ok, currency FROM ds_month WHERE ym = ?").get(ym);
    if (!meta) return null;
    const rows = d.prepare("SELECT date, model, kind, type, amount FROM ds_daily WHERE substr(date,1,7) = ? ORDER BY date").all(ym);
    return {
      ym,
      fetchedAt: meta.fetched_at,
      amountOk: !!meta.amount_ok,
      costOk: !!meta.cost_ok,
      currency: meta.currency,
      usageRows: rows.filter(r => r.kind === "usage"),
      costRows: rows.filter(r => r.kind === "cost"),
    };
  }

  function listMonths() {
    const d = open();
    return d.prepare("SELECT ym, fetched_at, amount_ok, cost_ok, currency FROM ds_month ORDER BY ym DESC").all();
  }

  // ── token 线索：只有「哪个文件、什么时候改的」，token 本身永远不进这里 ──
  function readHint() {
    try {
      const row = open().prepare("SELECT partition, file, mtime FROM ds_token_hint WHERE id = 1").get();
      return row && row.file ? { partition: row.partition, file: row.file, mtime: row.mtime } : null;
    } catch {
      return null;
    }
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

  return { saveMonth, getMonth, listMonths, readHint, writeHint, close };
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
