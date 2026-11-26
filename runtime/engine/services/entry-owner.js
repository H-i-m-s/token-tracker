// 跨会话文件的「同一条消息只统计一次」。
//
// ── 为什么需要这一层 ──
// Hana 的会话分叉（第一行 session 的 parentSession 指向父会话）会把父会话的整个历史
// 逐行复制进新的 .jsonl。实测两个相邻的 fork 文件：4727 行里有 4708 行的 id 与内容完全相同。
// 扫描器按文件独立累加，同一批消息于是被算十几遍：2026-11-25 显示 6.24 B，
// 而宿主账本（按 requestId 去重）与逐行去重的结果都落在 5.76 亿，差 10.8 倍。
//
// ── 判定用什么 ──
// 会话文件里每一个 entry 行都有一个全局唯一的 id（复制的行原样带着它）。
// 同一个 id 只让第一个遇到的文件认领，后面的文件跳过整行——不只是跳过 usage，
// 连 msgCount / firstTime 也不重复记。
//
// ── 为什么内存里不存 id 原文 ──
// 全量语料约 58 万个 entry，UUID 原文在 V8 里每个要一百来字节，加上 Map 条目就是五六十 MB
// 常驻。折成 53 位指纹（JS number 精确无损的整数上限是 2^53）后约 4～6 MB。
// 58 万条落在这个空间里的期望碰撞数是 0.018 次，远小于其他统计噪声。
// 落库仍然存原文：按 owner 清理、以及将来人工核查都要能读。

const TABLE = "entry_owner";
const SCHEMA =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
  "id TEXT PRIMARY KEY, " +
  "owner TEXT NOT NULL" +
  ") WITHOUT ROWID";

/** id → 53 位指纹。两个独立的 32 位散列拼起来，取高 53 位。 */
export function hashEntryId(id) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  // h1 最大 4294967295，乘以 2^21 得 9.007e15，仍小于 2^53 = 9.0072e15，整数不丢精度。
  return h1 * 0x200000 + (h2 & 0x1fffff);
}

/**
 * @param {{DatabaseSync: Function, file: string, log?: Function}} deps
 */
export function createEntryOwnerStore({ DatabaseSync, file, log = () => {} }) {
  let db = null;
  let ids = new Set(); // 指纹集合：当前生效的归属
  let pendingId = []; // 待落库的原文（与 pendingOwner 平行）
  let pendingOwner = [];
  let loaded = false;
  let rebuilding = false;

  function open() {
    if (db) return db;
    const d = new DatabaseSync(file);
    // 与 cache-store / turns-store 共用同一个库文件，各自独立连接。
    try { d.exec("PRAGMA busy_timeout = 5000"); } catch {}
    try { d.exec("PRAGMA journal_mode = WAL"); } catch {}
    try { d.exec("PRAGMA synchronous = NORMAL"); } catch {}
    d.exec(SCHEMA);
    db = d;
    return db;
  }

  /** 全量重建之前先把已有的归属读进内存；增量扫描走的就是这条。 */
  function ensureLoaded() {
    if (loaded || rebuilding) return;
    loaded = true;
    try {
      const d = open();
      for (const row of d.prepare(`SELECT id FROM ${TABLE}`).iterate()) ids.add(hashEntryId(row.id));
    } catch (e) {
      // 读不出来就当没有：会重复统计一次，但不会把已有的统计打坏。
      log.warn("[token-tracker] entry_owner 读取失败：", e?.code || "", e?.message || e);
    }
  }

  /**
   * 全量重建开始：内存换成空集合，暂不动库里的表。
   * 扫描期间新集合只认领这一轮读到的东西，扫完再一次性替换，
   * 中途被打断时库里仍是上一轮的完整归属，不会留下半张表。
   */
  function beginRebuild() {
    rebuilding = true;
    loaded = true;
    ids = new Set();
    pendingId = [];
    pendingOwner = [];
  }

  /** 全量重建结束：一个事务里把整表换成这一轮的结果。 */
  function commitRebuild() {
    const d = open();
    d.exec("BEGIN");
    try {
      d.exec(`DELETE FROM ${TABLE}`);
      const ins = d.prepare(`INSERT OR IGNORE INTO ${TABLE} (id, owner) VALUES (?, ?)`);
      for (let i = 0; i < pendingId.length; i += 1) ins.run(pendingId[i], pendingOwner[i]);
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      log.warn("[token-tracker] entry_owner 重建落库失败：", e?.code || "", e?.message || e);
    }
    const n = pendingId.length;
    pendingId = [];
    pendingOwner = [];
    rebuilding = false;
    return n;
  }

  /**
   * 认领一条 entry。
   * @returns {boolean} true = 这条归本次扫描的文件，照常统计；false = 别的文件已经算过，整行跳过。
   */
  function claim(id, owner) {
    if (!id) return true; // 没有 id 的行无法判定，宁可重复也不能丢
    const h = hashEntryId(id);
    if (ids.has(h)) return false;
    ids.add(h);
    // 总是记 pending：重建期间 commitRebuild 要重写整表，增量期间 flushDelta 只写新增。
    pendingId.push(id);
    pendingOwner.push(owner);
    return true;
  }

  /**
   * 把一个文件上次认领的 entry 全部退回。
   * 重新解析一个文件之前必须调：否则它自己的历史行会因为「这个 id 已被认领」而整行跳过，
   * 文件越长重扫后算得越少（真实现场：父会话追加一轮后总量反而从 600 变 700）。
   */
  function releaseOwner(owner) {
    if (rebuilding || !owner) return 0;
    try {
      const d = open();
      const rows = d.prepare(`SELECT id FROM ${TABLE} WHERE owner = ?`).all(owner);
      if (!rows.length) return 0;
      d.prepare(`DELETE FROM ${TABLE} WHERE owner = ?`).run(owner);
      for (const r of rows) ids.delete(hashEntryId(r.id));
      return rows.length;
    } catch (e) {
      log.warn("[token-tracker] entry_owner 释放失败：", e?.code || "", e?.message || e);
      return 0;
    }
  }

  /** 增量扫描结束：只把本次新增的行写进库。 */
  function flushDelta() {
    if (rebuilding || !pendingId.length) return 0;
    const n = pendingId.length;
    try {
      const d = open();
      d.exec("BEGIN");
      const ins = d.prepare(`INSERT OR IGNORE INTO ${TABLE} (id, owner) VALUES (?, ?)`);
      for (let i = 0; i < n; i += 1) ins.run(pendingId[i], pendingOwner[i]);
      d.exec("COMMIT");
    } catch (e) {
      log.warn("[token-tracker] entry_owner 落库失败：", e?.code || "", e?.message || e);
      pendingId = [];
      pendingOwner = [];
      return 0;
    }
    pendingId = [];
    pendingOwner = [];
    return n;
  }

  function count() {
    try { return open().prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n; } catch { return 0; }
  }

  /** 上一轮全量重建是不是没跑到 commitRebuild（中途抛错 / 进程被杀）。 */
  function isRebuilding() {
    return rebuilding;
  }

  function close() {
    try { db?.close(); } catch {}
    db = null;
  }

  return { open, ensureLoaded, beginRebuild, commitRebuild, claim, releaseOwner, flushDelta, count, isRebuilding, close };
}
