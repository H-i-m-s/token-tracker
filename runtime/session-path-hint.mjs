// 「真实会话文件路径」的备忘：按 agentId 记住最近一次见到的 .jsonl 绝对路径。
//
// 为什么需要这个模块：宿主的 attribution.sessionId 长这样
//   sess_0mvo0foho_f4954a9d2c8325bf97d0
// 而磁盘上的会话文件名长这样
//   2026-10-23T15-29-18-705Z_01a16961-7b71-78fb-ab9e-e2d9ea4948cf.jsonl
// 两者毫无交集，引擎拿 sessionId 去反查文件永远落空，于是每一轮扫描都退回增量全扫
// （真库实测：75 条 scan_log 记录全是 incr，session 一次都没有）。
//
// 但真实路径是拿得到的：context 事件的 payload.sessionPath 就是宿主给的绝对路径。
// 把它按 agentId 存下来，紧随其后的 token_usage 就能带着它去做单会话扫描。
//
// 放在独立模块而不是 service.mjs 里，是为了能直接 import 来做单元测试：
// service.mjs 顶层会读 process.argv[2] 解析运行配置、启动 HTTP 服务，import 即副作用。
//
// 三件刻意不做的事：
//   1) 不许塞假值。历史上 service.mjs 曾经用 path.join(homeDir,'agents',id,'sessions',session)
//      拼出一个 sessions/sess_xxx 的路径，磁盘上根本没有那个文件，引擎拿它去 stat 必然失败。
//      没有真路径就是 null，比一个看起来像路径的垃圾诚实。
//   2) 不清理、不按时间过期。冷启动第一条用量事件退回全扫是可接受的代价，
//      而多做一层过期策略只会制造「有时命中有时不命中」这种更难查的行为。
//   3) 不跨 agent 复用。用户切 agent 之后，上一个 agent 的路径绝不能拿去扫新的那份。

/**
 * 把「这个 agent 正在写的会话文件」记下来。
 * @param {Map<string,string>} map agentId -> 绝对路径
 * @param {string|null} agentId 从路径里反查出来的 agent id
 * @param {unknown} sessionPath 宿主给的路径（可能缺失、可能不是字符串）
 * @returns {string|null} 真的记下来了就返回那个路径，否则 null
 */
export function noteSessionPath(map, agentId, sessionPath) {
  if (!map || typeof map.set !== "function") return null;
  if (!agentId || typeof agentId !== "string") return null;
  if (typeof sessionPath !== "string" || !sessionPath) return null;
  // 只认会话文件。别的后缀（.json、.sqlite、目录）记下来也扫不了，还会把 Map 撑脏。
  if (!sessionPath.endsWith(".jsonl")) return null;
  // .repair.jsonl 是修复过程的中间产物，scanDir 也跳过它，不能拿去当会话扫描目标
  if (sessionPath.includes(".repair.jsonl")) return null;
  map.set(agentId, sessionPath);
  return sessionPath;
}

/**
 * 取某个 agent 最近一次的会话路径。没有就是 null（不是 undefined、不是空串）。
 */
export function recallSessionPath(map, agentId) {
  if (!map || typeof map.get !== "function" || !agentId) return null;
  const v = map.get(agentId);
  return typeof v === "string" && v ? v : null;
}

/**
 * 从路径里反查 agentId。与 index.js 里 agentFromPath 用同一个正则：
 *   agents/<id>/...
 * Windows 与 POSIX 的分隔符都认。
 */
export function agentFromSessionPath(sp) {
  if (typeof sp !== "string" || !sp) return null;
  const m = sp.match(/agents[\\\/]([^\\\/]+)[\\\/]/);
  return m ? m[1] : null;
}

export default { noteSessionPath, recallSessionPath, agentFromSessionPath };
