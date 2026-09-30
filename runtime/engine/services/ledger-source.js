// 宿主账本的来源。
//
// 背景：宿主在 2026-09-09 把账本从 usage-ledger.json 迁到了 usage-ledger.sqlite，
// json 那份从此冻结（最后一笔停在 09-09 22:55）。App 之前一直读 json，于是
// memory / utility 这两类没有 JSONL 的调用从 9 月 10 日起就不再进入统计
// （按天图里「账本」那一层停止增长）。
//
// 两个来源的条目形状是同一份：sqlite 的 entry_json 存的就是原来那个条目对象，
// 所以换来源之后上层代码一行都不用改。
//
// 指纹：WAL 模式下主库文件的 mtime 只在检查点才动，所以把 -wal 的大小与时间也算进去，
// 否则「刚写进去、还没检查点」的那段时间会被当成没变化。

import fs from "node:fs";
import path from "node:path";
import { loadSqliteDriver } from "./cache-store.js";

const EMPTY = (sourcePath, key) => ({ entries: [], sourcePath, key });

// 同一份账本只解析一次：20000 条 entry_json 全量读+解析约 150 ms，
// 看板每次请求都会问到它（OpenCode Go 的几处估算），不能每次都重来。
let memo = { key: "", value: null };

export function loadLedger(homeDir, log = () => {}) {
  const sqlitePath = path.join(homeDir, "usage-ledger.sqlite");
  const jsonPath = path.join(homeDir, "usage-ledger.json");

  const Driver = loadSqliteDriver();
  if (Driver && fs.existsSync(sqlitePath)) {
    try {
      const st = fs.statSync(sqlitePath);
      let wal = "";
      try { const w = fs.statSync(sqlitePath + "-wal"); wal = `:${w.mtimeMs}:${w.size}`; } catch {}
      const key = `sqlite:${st.mtimeMs}:${st.size}${wal}`;
      if (memo.key === key) return memo.value;
      const db = new Driver(sqlitePath, { readOnly: true });
      let entries = [];
      try {
        entries = db.prepare("SELECT entry_json FROM usage_entries ORDER BY entry_order").all()
          .map((row) => { try { return JSON.parse(row.entry_json); } catch { return null; } })
          .filter(Boolean);
      } finally { try { db.close(); } catch {} }
      memo = { key, value: { entries, sourcePath: sqlitePath, key } };
      return memo.value;
    } catch (e) {
      log.warn("[token-tracker] 账本 sqlite 读取失败，退回 json：", e.code || "", e.message);
    }
  }

  // 退回 json（老版本宿主，或 sqlite 驱动不可用）
  try {
    if (!fs.existsSync(jsonPath)) return EMPTY(jsonPath, "json:missing");
    const st = fs.statSync(jsonPath);
    const key = `json:${st.mtimeMs}:${st.size}`;
    if (memo.key === key) return memo.value;
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    memo = { key, value: { entries, sourcePath: jsonPath, key } };
    return memo.value;
  } catch (e) {
    log.warn("[token-tracker] 账本 json 读取失败：", e.code || "", e.message);
    return EMPTY(jsonPath, "json:error");
  }
}
