// 「点得开」：从明细里的一行还原出这一轮的会话文件与逐次调用。
//
// 数据源是会话文件本身（权威），不是 turns 表、也不是内存里的 conversations：
// 后两者都是扫描时的派生物，只有文件能回答「这一轮有几次调用、每次多少、哪一次失败了」。
//
// 拆轮规则必须与 runtime/engine/index.js 的 scanDir 逐字一致：两边口径一旦漂移，
// 同一轮在「明细行」与「详情」之间就会互相打脸。下面的实现是 scanDir 那份规则的镜像，
// 只照抄，不「顺手优化」。改了那边就必须回头改这边。
import fs from "node:fs";
import { readTextFile } from "./platform.js";

const CALL_LIMIT = 400;

// 与 index.js 顶部的 tokVal 同口径：数字原样、对象取 .totalTokens、其余 0。
// 不导出，但必须与 scanDir 保持一致——这是拆轮口径的一部分。
function tokVal(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object") return v.totalTokens || 0;
  return 0;
}

// 间隔 = 本条消息时间 − 上一条 message 记录时间（任何 role）。
// 它含排队与工具往返，只是「间隔」，别当「耗时」用。区间与 scanDir 的 tok/s 采样一致：
// >= 100ms 且 < 600000ms 才给数字，其余（含算不出来）一律 null。
function gapMsOf(evTs, prevEvTs) {
  if (!Number.isFinite(evTs) || !Number.isFinite(prevEvTs)) return null;
  const d = evTs - prevEvTs;
  return d >= 100 && d < 600000 ? d : null;
}

// 逐行拆轮，返回每一轮的原始汇总（含 callList）。规则镜像 scanDir：
//   - model_change + provider → 记下当前供应商（本函数里不影响轮次边界，只认 message）
//   - 非 message / 无 message / custom / toolResult → 跳过
//   - user：收掉上一轮、开新轮（新轮 time = 这条记录的 ts）
//   - assistant 且已有当前轮 → 归属当前轮；失败的不计有效统计，但进 callList
//   - 文件末尾未收尾的一轮补上
function splitTurns(text) {
  const turns = [];
  let current = null;      // 当前轮
  let prevMsgTs = NaN;     // 上一条 message 记录的时间（任何 role），用于算间隔
  for (const line of text.split("\n").filter(Boolean)) {
    let p;
    try { p = JSON.parse(line); } catch { continue; }   // 解析失败的行跳过（scanDir 亦然）
    if (p.type === "model_change" && p.provider) continue;
    if (p.type !== "message" || !p.message) continue;    // custom / toolResult 等一律不参与拆轮
    const m = p.message;
    const ts = p.timestamp || m.timestamp || "";
    const evTs = ts ? new Date(ts).getTime() : NaN;
    if (m.role === "user") {
      if (current) turns.push(current);
      current = {
        time: ts, model: null, provider: null,
        totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        calls: 0, failedCalls: 0,
        firstTs: evTs, lastTs: evTs,
        callList: [],
      };
    }
    if (m.role === "assistant" && current) {
      const u = m.usage || null;
      // 失败判定与 scanDir 一致：stopReason=error / isError / errorMessage。
      const failed = m.stopReason === "error" || m.isError === true || !!m.errorMessage;
      if (!failed) {
        current.calls++;
        // 与 scanDir 的 `if (!conv.model)` 一致：首个「有 model」的有效调用同时定下 model 与 provider。
        if (!current.model) { current.model = m.model; current.provider = m.provider; }
        if (u) {
          const cIn = tokVal(u.input), cOut = tokVal(u.output);
          const cCr = u.cacheRead || 0, cCw = u.cacheWrite || 0, cRsn = tokVal(u.reasoning);
          current.totalTokens += u.totalTokens ?? (cIn + cOut);
          // 合计的 input 含命中：未命中 + 命中缓存（与 conversations[i].inTokens 同口径）。
          current.input += cIn + cCr;
          current.output += cOut;
          current.cacheRead += cCr;
          current.cacheWrite += cCw;
          current.reasoning += cRsn;
        }
      } else {
        current.failedCalls++;
      }
      // 每条调用都进 callList（失败也进，标 failed:true）；单条 input 是「未命中」。
      current.callList.push({
        time: ts,
        model: m.model ?? null,
        provider: m.provider ?? null,
        input: u ? tokVal(u.input) : 0,
        output: u ? tokVal(u.output) : 0,
        cacheRead: u ? (u.cacheRead || 0) : 0,
        cacheWrite: u ? (u.cacheWrite || 0) : 0,
        reasoning: u ? tokVal(u.reasoning) : 0,
        totalTokens: u ? (u.totalTokens ?? (tokVal(u.input) + tokVal(u.output))) : 0,
        failed: !!failed,
        gapMs: gapMsOf(evTs, prevMsgTs),
      });
    }
    if (current) current.lastTs = evTs;   // 这一轮最后一条 message 记录的时间
    prevMsgTs = evTs;
  }
  if (current) turns.push(current);       // 末尾未收尾的一轮补上（scanDir 就是这么做的）
  return turns;
}

function finalizeTurn(t) {
  const elapsedMs = (Number.isFinite(t.firstTs) && Number.isFinite(t.lastTs)) ? (t.lastTs - t.firstTs) : null;
  const truncated = t.callList.length > CALL_LIMIT;
  return {
    ok: true,
    seq: null,
    kind: "session",
    time: t.time,
    model: t.model ?? null,
    provider: t.provider ?? null,
    filePath: null,
    fileExists: true,
    totalTokens: t.totalTokens, input: t.input, output: t.output,
    cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, reasoning: t.reasoning,
    calls: t.calls, failedCalls: t.failedCalls,
    elapsedMs,
    truncated,
    callList: truncated ? t.callList.slice(0, CALL_LIMIT) : t.callList,
  };
}

// 空壳（缺文件 / 账本行）：形状齐全，数字归零，不抛。
function emptyShell(seq, kind, filePath, fileExists) {
  return {
    ok: true,
    seq,
    kind,
    time: null,
    model: null,
    provider: null,
    filePath: filePath ?? null,
    fileExists: !!fileExists,
    totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    calls: 0, failedCalls: 0,
    elapsedMs: null,
    truncated: false,
    callList: [],
  };
}

// 读一轮的逐次调用。session 必须是缓存里的会话对象（含 type / filePath）；
// seq 从 1 起，与 conversations[i] 的 i+1 一致。
// 读失败不抛：返回 { ok:false, code, message } 并留痕。
export function readTurnCalls({ session, seq, log = () => {} } = {}) {
  try {
    // 账本聚合行没有会话文件（filePath 指向 usage-ledger.sqlite），别按拆轮规则去读它。
    if (session && session.type === "ledger") {
      return emptyShell(seq, "ledger", session.filePath, false);
    }
    if (!session) {
      return { ok: false, code: "NO_SESSION_FILE", message: "会话不存在" };
    }
    const fp = session.filePath || null;
    if (!fp || !fs.existsSync(fp)) {
      return emptyShell(seq, "session", fp, false);
    }

    const turns = splitTurns(readTextFile(fp));
    if (!Number.isFinite(seq) || seq < 1 || seq > turns.length) {
      return { ok: false, code: "TURN_NOT_FOUND", message: `该会话没有第 ${seq} 轮（共 ${turns.length} 轮）` };
    }
    const out = finalizeTurn(turns[seq - 1]);
    out.seq = seq;
    out.filePath = fp;
    return out;
  } catch (e) {
    try { log.warn("[token-tracker] readTurnCalls 读取失败：", e.code || "", e.message); } catch {}
    return { ok: false, code: "READ_FAILED", message: e.message };
  }
}

export default { readTurnCalls };
