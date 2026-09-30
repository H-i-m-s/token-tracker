// Read existing daily/hourly cache only. No inferred request times or cache migration.
const value = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;
function modelsFor(bucket, { model, provider }) {
  const result = new Map();
  const add = (id, row) => {
    if (model && id !== model) return;
    const old = result.get(id) || { totalTokens: 0, count: 0 };
    old.totalTokens += value(row.totalTokens); old.count += value(row.assistantCount);
    result.set(id, old);
  };
  if (provider) {
    for (const [key, row] of Object.entries(bucket.providerTotals || {})) {
      const sep = key.indexOf('/');
      if (key.slice(0, sep) === provider) add(key.slice(sep + 1), row);
    }
  } else {
    for (const [id, row] of Object.entries(bucket.models || {})) add(id, row);
    if (!model) {
      const gap = value(bucket.totalTokens) - [...result.values()].reduce((sum, row) => sum + row.totalTokens, 0);
      if (gap > 0) result.set('未归属', { totalTokens: gap, count: 0 });
    }
  }
  return result;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// 单轮请求大小分布：把调用方已经筛好的轮次按模型汇成摘要（次数 / P50 / P90 / 32 桶）。
//
// 口径与前端旧实现完全一致：桶位 = floor(log1p(n) / log1p(跨模型最大值) * 32)，
// 对数轴只用一条（模型之间可比），分位数线性插值，排序按轮次数降序。
// 为什么放在引擎侧：轮次明细现在覆盖全部历史（上万条），而分布只是个摘要，
// 没必要把明细搬进每次请求再让前端自己算。传进来的 rows 就是消费明细那批（同一套筛选），
// 所以分布与明细看到的是同一个集合。
export function summarizeTurns(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const n = r?.totalTokens;
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = r.model || '';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(n);
  }
  let max = 1;
  for (const values of groups.values()) for (const n of values) if (n > max) max = n;
  const scale = Math.log1p(max);
  const models = [...groups].map(([id, values]) => {
    const bins = Array(32).fill(0);
    for (const n of values) bins[Math.min(31, Math.floor(Math.log1p(n) / scale * 32))]++;
    return {
      id, count: values.length, totalTokens: values.reduce((sum, n) => sum + n, 0),
      p50: quantile(values, .5), p90: quantile(values, .9), bins,
    };
  }).sort((a, b) => b.count - a.count);
  return { turnCount: rows.length, models };
}

export function buildVisualAnalytics(sessions, dateFilter, filters = {}, rows = []) {
  const days = new Map(), agents = new Map(), hours = new Map();
  let sessionCount = 0;
  // 按「来源」拆分（对话 / 子代理 / 频道 / 后台 / 账本）只在没有模型、供应商筛选时成立：
  // dailyBreakdown 里这几个分项是不分模型的，一旦按模型筛选，各分项之和就不再等于
  // 筛选后的总量，硬画出来是假的。这种情况就退回单层总量。
  const canSplit = !filters.model && !filters.provider;
  const kindsOf = (b) => canSplit ? {
    desktop: value(b.desktop), sub: value(b.sub), bridge: value(b.bridge),
    background: value(b.background), ledger: value(b.ledger), channel: value(b.channel),
  } : null;
  for (const session of sessions) {
    if (filters.agent && session.agent !== filters.agent) continue;
    if (filters.type && session.type !== filters.type) continue;
    let active = false;
    for (const [date, bucket] of Object.entries(session.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(date)) continue;
      const models = modelsFor(bucket, filters);
      let total = 0, calls = 0;
      for (const m of models.values()) { total += m.totalTokens; calls += m.count; }
      if (!total) continue;
      active = true;
      if (!days.has(date)) days.set(date, { date, totalTokens: 0, models: {}, kinds: {}, agents: {}, calls: 0 });
      const day = days.get(date); day.totalTokens += total; day.calls += calls;
      for (const [id, data] of models) day.models[id] = (day.models[id] || 0) + data.totalTokens;
      const kb = kindsOf(bucket);
      if (kb) for (const [k, v] of Object.entries(kb)) if (v) day.kinds[k] = (day.kinds[k] || 0) + v;
      if (canSplit) day.agents[session.agent] = (day.agents[session.agent] || 0) + total;
      if (!agents.has(session.agent)) agents.set(session.agent, { id: session.agent, totalTokens: 0, days: {} });
      const agent = agents.get(session.agent); agent.totalTokens += total;
      agent.days[date] = (agent.days[date] || 0) + total;
    }
    if (active) sessionCount++;
    for (const [date, buckets] of Object.entries(session.hourlyBreakdown || {})) {
      if (dateFilter && !dateFilter(date)) continue;
      for (const [hour, bucket] of Object.entries(buckets)) {
        const h = Number(hour); if (!Number.isInteger(h) || h < 0 || h > 23) continue;
        const key = `${date}/${h}`;
        if (!hours.has(key)) hours.set(key, { date, hour: h, totalTokens: 0, models: {}, kinds: {}, agents: {}, calls: 0 });
        const cell = hours.get(key);
        let cellTotal = 0;
        for (const [id, data] of modelsFor(bucket, filters)) {
          cell.totalTokens += data.totalTokens;
          cell.models[id] = (cell.models[id] || 0) + data.totalTokens;
          cellTotal += data.totalTokens;
          cell.calls += value(data.count);
        }
        const hb = kindsOf(bucket);
        if (hb) for (const [k, v] of Object.entries(hb)) if (v) cell.kinds[k] = (cell.kinds[k] || 0) + v;
        if (canSplit && cellTotal) cell.agents[session.agent] = (cell.agents[session.agent] || 0) + cellTotal;
      }
    }
  }
  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const heatmap = [...hours.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
  const modelHours = new Map();
  for (const cell of heatmap) for (const [id, total] of Object.entries(cell.models)) {
    if (!modelHours.has(id)) modelHours.set(id, { id, totalTokens: 0, hours: Array(24).fill(0) });
    const model = modelHours.get(id); model.hours[cell.hour] += total; model.totalTokens += total;
  }
  return {
    granularity: 'hour', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionCount, daily, heatmap, canSplit,
    agents: [...agents.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    modelHours: [...modelHours.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    hourlyTotal: heatmap.reduce((sum, row) => sum + row.totalTokens, 0),
    dailyTotal: daily.reduce((sum, row) => sum + row.totalTokens, 0),
    turnSize: summarizeTurns(rows),
  };
}
