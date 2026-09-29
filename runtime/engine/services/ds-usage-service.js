// 官网用量的组合层：把「找 token」「拉接口」「落盘缓存」串成一条线，并对上层只暴露一个
// 「给我某几个月的用量」的入口。
//
// 两条关键策略：
//   1. 缓存分新鲜度：历史月拉一次就冻结；当月有存活期，过期才重拉。
//   2. token 失效自动重扫一次：官网拒了就用最新的线索重新全盘找 token 重试，还不行则如实报错，
//      不静默沿用旧数据、不假装成功。
import { findUserToken } from "./ds-token-source.js";
import { fetchUsageMonth } from "./ds-usage.js";

const CURRENT_MONTH_TTL_MS = 10 * 60 * 1000; // 当月数据的存活期

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// 从某个起点往前推 n 个月，得到 ["2026-09", "2026-08", ...]
export function recentMonths(count, from = new Date()) {
  const out = [];
  const y = from.getFullYear();
  const m = from.getMonth();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(y, m - i, 1);
    out.push(monthKey(d));
  }
  return out;
}

export function createDsUsageService({ store = null, partitionsDir, log = () => {}, now = () => Date.now() } = {}) {
  let lastSource = null; // 内存里的 token 来源（含 token 吗？不含——token 单独存）

  function resolveToken() {
    const hint = store?.readHint?.() || null;
    const found = findUserToken({ partitionsDir, hint });
    if (found?.source && found.token) {
      store?.writeHint?.(found.source);
      lastSource = found.source;
    }
    return found;
  }

  function isFresh(meta, ym) {
    if (!meta) return false;
    const age = now() - (meta.fetchedAt || 0);
    if (ym === monthKey(new Date(now()))) return age < CURRENT_MONTH_TTL_MS;
    // 历史月一旦成功取过就冻结，不再重拉（数据不会再变）
    if (meta.amountOk && meta.costOk) return true;
    return age < CURRENT_MONTH_TTL_MS;
  }

  // 拉一个月并落盘。token 失效则重扫一次再试。
  async function fetchAndStore(ym, token) {
    const [year, month] = ym.split("-").map(Number);
    let result = await fetchUsageMonth(token, { month, year });
    if (result.amountError === "DS_TOKEN_INVALID" || result.costError === "DS_TOKEN_INVALID") {
      const again = resolveToken();
      if (again?.token && again.token !== token) {
        result = await fetchUsageMonth(again.token, { month, year });
      }
    }
    const amountOk = !!result.amount;
    const costOk = !!result.cost;
    if (amountOk || costOk) {
      store?.saveMonth?.(ym, {
        usageRows: result.amount?.days || [],
        costRows: result.cost?.days || [],
        currency: result.cost?.currency || result.amount?.currency || null,
        amountOk,
        costOk,
      });
    }
    return result;
  }

  // 对外主入口。
  // opts.months 缺省取最近 1 个月；opts.force 强制忽略缓存。
  // 返回 { months: [{ ym, fromCache, usageRows, costRows, currency, error }], source }
  async function getUsage({ months, force = false } = {}) {
    const list = Array.isArray(months) && months.length ? months : [monthKey(new Date(now()))];
    const found = resolveToken();
    const token = found?.token || null;
    const out = [];
    let tokenError = null;

    for (const ym of list) {
      const cached = store?.getMonth?.(ym) || null;
      if (!force && isFresh(cached, ym)) {
        out.push({ ym, fromCache: true, usageRows: cached.usageRows, costRows: cached.costRows, currency: cached.currency, error: null });
        continue;
      }
      if (!token) {
        // 没 token 但有缓存，先把缓存交出去，同时如实标注取不到最新
        if (cached) {
          out.push({ ym, fromCache: true, usageRows: cached.usageRows, costRows: cached.costRows, currency: cached.currency, error: "DS_NO_TOKEN" });
        } else {
          out.push({ ym, fromCache: false, usageRows: [], costRows: [], currency: null, error: "DS_NO_TOKEN" });
        }
        tokenError = tokenError || "DS_NO_TOKEN";
        continue;
      }
      try {
        const r = await fetchAndStore(ym, token);
        const after = store?.getMonth?.(ym) || null;
        out.push({
          ym,
          fromCache: false,
          usageRows: after?.usageRows || r.amount?.days || [],
          costRows: after?.costRows || r.cost?.days || [],
          currency: after?.currency || r.cost?.currency || null,
          error: r.amount || r.cost ? null : (r.amountError || r.costError || "DS_EMPTY"),
        });
        if (!r.amount && !r.cost) tokenError = tokenError || r.amountError || r.costError;
      } catch (e) {
        out.push({ ym, fromCache: false, usageRows: cached?.usageRows || [], costRows: cached?.costRows || [], currency: cached?.currency || null, error: e?.code || e?.message || "DS_FAILED" });
      }
    }

    return {
      months: out,
      source: found?.source ? { partition: found.source.partition, file: found.source.file, mtime: found.source.mtime } : null,
      hasToken: !!token,
      tokenError,
      updatedAt: now(),
    };
  }

  return { getUsage, resolveToken };
}

export default { createDsUsageService, recentMonths, monthKey };
