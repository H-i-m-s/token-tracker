import path from "node:path";

// 「文件已经不在了」的会话要从缓存里摘掉。
//
// 只写不删的后果不是少一条记录：它的用量会永久留在总量、日图、模型榜和 turns 表里
//（turns-store.apply 只会删 touched 里的键），于是「清掉旧会话让统计干净」永远不生效。
//
// 归属判断用 filePath，不用缓存键前缀：sessions/ 与 sessions/archived/ 会撞同一个键
//（agent::desktop::::文件名），按前缀删会误删另一个目录里的会话。
//
// 性能：这条路径每轮扫描都要跑，会话可能有几万条，而绝大多数条目都是「还在」。
// 所以先用 Set 命中即走（便宜），只有真的不在集合里才去算 dirname（那个调用很贵）。

/** 把一个目录本轮看到的文件名变成绝对路径集合 */
export function presentFiles(dir, names) {
  const out = new Set();
  for (const n of names || []) out.add(path.join(dir, n));
  return out;
}

/**
 * @param {{sessions: Record<string, any>}} cache 缓存（就地删）
 * @param {Set<string>|null} touched 本轮动过的键（turns 表按它增量同步）
 * @param {Array<{dir: string, present: Set<string>}>} scanDirs 本轮扫过的目录与文件
 * @returns {boolean} 有没有删掉东西
 */
export function sweepVanished(cache, touched, scanDirs) {
  if (!Array.isArray(scanDirs) || !scanDirs.length) return false;
  const sessions = cache?.sessions;
  if (!sessions) return false;
  const present = new Set();
  for (const d of scanDirs) for (const fp of d.present) present.add(fp);
  const scanned = new Set(scanDirs.map((d) => d.dir));
  let changed = false;
  for (const k of Object.keys(sessions)) {
    const fp = sessions[k]?.filePath;
    // 没有 filePath 的不是文件型会话（账本条目就是这种），一律不动
    if (!fp || present.has(fp)) continue;
    // 不是本轮扫过的目录，不动：那个目录可能整个不存在（比如已移除的 agent）
    if (!scanned.has(path.dirname(fp))) continue;
    delete sessions[k];
    touched?.add(k);
    changed = true;
  }
  return changed;
}
