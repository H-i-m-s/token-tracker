// 官网用量的组合层：找 token → 拉官网 → 落盘 → 按区间交出去。
//
// 三条策略：
//   1. 粒度跟着区间走。官网按区间长度自己决定给「天」还是「小时」，我们不猜、不换算，
//      只把 bucket 如实透给上层：区间窄到一天就近小时，宽到月就按天。
//   2. 历史按天落盘且只增不减；再次进来只补「上次覆盖点之后」的缺口，这就是增量。
//   3. token 失效自动重扫一次；还不行就如实报错，不静默沿用旧数、不假装成功。
import { findUserToken } from "./ds-token-source.js";
import { fetchWindowPair, localTzOffsetSeconds } from "./ds-usage.js";

export const DAY = 86400;
export const HOUR = 3600;
const COVER_KEY = "history-cover";     // 已覆盖的时间范围（天粒度）
const MAX_SPAN_DAYS = 30;              // 官网单次查询上限：实测 30 天可行、31 天 INVALID_PARAM
const FIRST_LOOKBACK_DAYS = 1095;      // 首次回看窗口（3 年）
const OVERLAP_DAYS = 3;                // 每次重拉的重叠天数：近期数据仍在长
const SHORT_MAX_DAYS = 3;              // ≤ 这个天数就用小时粒度（逐日拉再拼，因为服务器对 3 天只给天）
const SHORT_TTL_MS = 60 * 1000;        // 短区间结果的内存存活期

export function dayStart(ts) {
  const d = new Date(ts * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
}

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// 把 amount 与 cost 两组桶按时间对齐成同一串点。
function mergePair(pair) {
  const byT = new Map();
  const touch = (t) => { if (!byT.has(t)) byT.set(t, { t, tokens: 0, hit: 0, miss: 0, response: 0, request: 0, prompt: 0, cost: 0 }); return byT.get(t); };
  for (const p of pair.amount?.points || []) {
    const rec = touch(p.t);
    for (const [type, a] of Object.entries(p.byType || {})) {
      if (type === "PROMPT_TOKEN") rec.prompt += a;
      else if (type === "PROMPT_CACHE_HIT_TOKEN") rec.hit += a;
      else if (type === "PROMPT_CACHE_MISS_TOKEN") rec.miss += a;
      else if (type === "RESPONSE_TOKEN") rec.response += a;
      else if (type === "REQUEST") rec.request += a;
    }
  }
  for (const p of pair.cost?.points || []) {
    const rec = touch(p.t);
    for (const a of Object.values(p.byType || {})) rec.cost += a;
  }
  const points = [...byT.values()].sort((a, b) => a.t - b.t);
  for (const r of points) {
    const prompt = r.prompt > 0 ? r.prompt : r.hit + r.miss;
    r.tokens = prompt + r.response;
    const denom = r.hit + r.miss;
    r.hitRate = denom > 0 ? (r.hit / denom) * 100 : null;
  }
  return points;
}

function sumPoints(points) {
  const acc = { tokens: 0, hit: 0, miss: 0, response: 0, request: 0, prompt: 0, cost: 0 };
  for (const p of points) for (const k of Object.keys(acc)) acc[k] += p[k] || 0;
  const denom = acc.hit + acc.miss;
  return { ...acc, hitRate: denom > 0 ? (acc.hit / denom) * 100 : null, points: points.length };
}

export function createDsUsageService({ store = null, partitionsDir, log = () => {}, now = () => Date.now() } = {}) {
  let shortCache = { key: "", at: 0, value: null };

  function resolveToken() {
    const hint = store?.readHint?.() || null;
    const found = findUserToken({ partitionsDir, hint });
    if (found?.source && found.token) store?.writeHint?.(found.source);
    return found;
  }

  // 拉一个区间（可能天、可能小时），失败时把错误如实带出来。
  async function pull(from, to, token) {
    const pair = await fetchWindowPair(token, { start: from, end: to, tz: localTzOffsetSeconds() });
    if (pair.amountError === "DS_TOKEN_INVALID" || pair.costError === "DS_TOKEN_INVALID") {
      const again = resolveToken();
      if (again?.token && again.token !== token) {
        return { ...(await fetchWindowPair(again.token, { start: from, end: to, tz: localTzOffsetSeconds() })), retried: true };
      }
    }
    return pair;
  }

  // 确保「天」粒度的历史覆盖到当下。返回 { ok, cover, fetched, segments, saved }。
  // 官网单次最多查 30 天，所以历史是分段拉的；从最新往旧走，连续两段都空就当作到头了。
  async function ensureHistory({ force = false } = {}) {
    const nowT = Math.floor(now() / 1000);
    const today = dayStart(nowT);
    const cover = store?.getMeta?.(COVER_KEY)?.value || null;
    const found = resolveToken();
    const token = found?.token || null;
    if (!token) return { ok: false, error: "DS_NO_TOKEN", cover };

    // 已覆盖到当下附近、且刚拉过：不必再打官网
    if (!force && cover?.to && today - cover.to < DAY && nowT - (cover.at || 0) < 3600) {
      return { ok: true, cover, fetched: false, segments: 0, saved: 0 };
    }

    const SEG = MAX_SPAN_DAYS * DAY;
    const top = today + DAY;                                   // 覆盖到今天结束
    const floor = cover?.from ?? (today - FIRST_LOOKBACK_DAYS * DAY);
    const startAt = cover?.to && !force
      ? Math.min(today - OVERLAP_DAYS * DAY, cover.to)          // 从上次覆盖点（含少量重叠）继续
      : Math.max(floor, today - FIRST_LOOKBACK_DAYS * DAY);

    // 切段：从最新往旧排，便于“连续两段空”尽早收工
    const segments = [];
    for (let end = top; end > startAt; end -= SEG) {
      const begin = Math.max(end - SEG, floor, startAt);
      if (end - begin <= 0) break;
      segments.push([begin, end]);
    }

    let saved = 0, okAny = false, lastErr = null, emptyStreak = 0, earliest = cover?.from ?? null, done = 0, tokenInvalid = false;
    // 严格从新到旧串行："连续两段全空即到头"这个判据只有在有序时才成立。
    // 并发会打乱顺序，把中间某个没用量的月份误当终点，所以这里不用并发。
    for (const [a, b] of segments) {
      let pair;
      try {
        pair = await pull(a, b, token);
      } catch (e) {
        lastErr = e?.code || e?.message || "DS_FAILED";
        emptyStreak += 1;
        done += 1;
        if (emptyStreak >= 2) break;
        continue;
      }
      // 官网明确拒了这枚 token：后面每一段都会一样被拒，停手，把原因如实带出去。
      // 这里必须显式判：fetchWindowPair 用 allSettled，失效是当成 amountError/costError 返回的，
      // 不走 catch，光收 catch 里的错误会把 DS_TOKEN_INVALID 整个吞掉、最后报成含糊的 DS_EMPTY。
      if (pair.amountError === "DS_TOKEN_INVALID" || pair.costError === "DS_TOKEN_INVALID") {
        tokenInvalid = true;
        lastErr = "DS_TOKEN_INVALID";
        done += 1;
        break;
      }
      const aOk = !!pair.amount, cOk = !!pair.cost;
      const hasData = (pair.amount?.points?.length || 0) > 0 || (pair.cost?.points?.length || 0) > 0;
      if (aOk) saved += store?.savePoints?.("usage", DAY, pair.amount.points) || 0;
      if (cOk) saved += store?.savePoints?.("cost", DAY, pair.cost.points) || 0;
      if (hasData) {
        okAny = true;
        if (earliest == null || a < earliest) earliest = a;
        emptyStreak = 0;
      } else {
        emptyStreak += 1;
        if (emptyStreak >= 2) { done += 1; break; }   // 连续两段全空：认为账号账本到这里为止
      }
      done += 1;
    }

    const nextCover = {
      from: earliest ?? floor,
      to: okAny ? today : (cover?.to ?? null),
      at: now(),
    };
    if (okAny) store?.setMeta?.(COVER_KEY, nextCover);

    return {
      ok: okAny,
      cover: nextCover,
      fetched: true,
      segments: done,
      saved,
      tokenInvalid,
      // token 失效优先于「有没有拉到数据」：它是需要人去处理的状态，不能被 okAny 盖掉，
      // 否则界面会把一份停止更新的旧数据当成正常结果摆出来。
      error: tokenInvalid ? "DS_TOKEN_INVALID" : (okAny ? null : (lastErr || "DS_EMPTY")),
    };
  }

  function readDayRange(from, to) {
    const rows = store?.rangePoints?.("usage", DAY, from, to) || [];
    const costRows = store?.rangePoints?.("cost", DAY, from, to) || [];
    const byT = new Map();
    const touch = (t) => { if (!byT.has(t)) byT.set(t, { t, tokens: 0, hit: 0, miss: 0, response: 0, request: 0, prompt: 0, cost: 0 }); return byT.get(t); };
    for (const r of rows) {
      const rec = touch(r.t);
      const a = Number(r.amount) || 0;
      if (r.type === "PROMPT_TOKEN") rec.prompt += a;
      else if (r.type === "PROMPT_CACHE_HIT_TOKEN") rec.hit += a;
      else if (r.type === "PROMPT_CACHE_MISS_TOKEN") rec.miss += a;
      else if (r.type === "RESPONSE_TOKEN") rec.response += a;
      else if (r.type === "REQUEST") rec.request += a;
    }
    for (const r of costRows) touch(r.t).cost += Number(r.amount) || 0;
    const points = [...byT.values()].sort((a, b) => a.t - b.t);
    for (const r of points) {
      const prompt = r.prompt > 0 ? r.prompt : r.hit + r.miss;
      r.tokens = prompt + r.response;
      const denom = r.hit + r.miss;
      r.hitRate = denom > 0 ? (r.hit / denom) * 100 : null;
    }
    return points;
  }

  // 主入口：给一个时间区间，交回该区间的点。
  // from=0（或省略）表示不设下限，“全部历史”就靠这个；区间窄则问官网拿更细的桶。
  async function getRange({ from, to, force = false } = {}) {
    const nowT = Math.floor(now() / 1000);
    const toT = to == null ? nowT : Math.floor(to);
    const fromT = from == null ? toT - 30 * DAY : Math.floor(from);
    const span = toT - fromT;

    // 区间短到几天以内：官网会按小时给，这是看“今天/这几天”的路径。
    // from=0 时 span 是天文数字，自然不会误入这里。
    if (span > 0 && span <= SHORT_MAX_DAYS * DAY) {
      const key = `${fromT}:${toT}`;
      if (!force && shortCache.key === key && now() - shortCache.at < SHORT_TTL_MS) return shortCache.value;
      const found = resolveToken();
      let diagnostics = null;
      if (!found?.token) {
        const { diagnosePartitions } = await import("./ds-token-source.js");
        diagnostics = diagnosePartitions({ partitionsDir });
        store?.setMeta?.("diagnosis", { ...diagnostics, at: new Date().toISOString() });
        const value = { bucket: 0, from: fromT, to: toT, points: [], totals: sumPoints([]), hasToken: false, tokenError: "DS_NO_TOKEN", diagnostics, source: null };
        return value;
      }
      // 逐日拉：单日请求服务器才给小时桶，多日会退回天。拼接后按时间排序。
      let bucket = HOUR, err = null, ok = false;
      const coll = new Map();
      try {
        for (let s = fromT; s < toT; s += DAY) {
          const e = Math.min(s + DAY, toT);
          const pair = await pull(s, e, found.token);
          // 短窗口同样要认这个码，否则会白打每一天，最后只报个 DS_EMPTY。
          if (pair.amountError === "DS_TOKEN_INVALID" || pair.costError === "DS_TOKEN_INVALID") { err = "DS_TOKEN_INVALID"; break; }
          if (pair.amount?.bucket) bucket = pair.amount.bucket;
          else if (pair.cost?.bucket) bucket = pair.cost.bucket;
          if (pair.amount || pair.cost) ok = true;
          else err = err || pair.amountError || pair.costError || "DS_EMPTY";
          for (const p of mergePair(pair)) coll.set(p.t, p);
        }
      } catch (e) {
        err = e?.code || e?.message || "DS_FAILED";
      }
      const points = [...coll.values()].sort((a, b) => a.t - b.t);
      const value = {
        bucket,
        from: fromT,
        to: toT,
        points,
        totals: sumPoints(points),
        hasToken: true,
        tokenError: ok ? null : err,
        diagnostics: null,
        source: found.source,
        live: true,
      };
      shortCache = { key, at: now(), value };
      return value;
    }

    const hist = await ensureHistory({ force });
    const points = readDayRange(fromT, toT);
    const value = {
      bucket: DAY,
      from: fromT,
      to: toT,
      points,
      totals: sumPoints(points),
      hasToken: hist.ok || !!resolveToken()?.token,
      tokenError: hist.ok ? null : (hist.error || "DS_EMPTY"),
      diagnostics: null,
      source: resolveToken()?.source || null,
      live: false,
      coverage: hist.cover || null,
    };
    return value;
  }

  return { getRange, ensureHistory, resolveToken };
}

export default { createDsUsageService, dayStart, monthKey, DAY, HOUR };
