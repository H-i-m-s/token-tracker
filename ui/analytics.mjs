import { splitRow } from './board-layout.mjs';
import { h, fmtCost, fmtPct } from './components.mjs';

const COLORS = ['#d1b477', '#7ea3cf', '#81b4a1', '#c68487', '#aa97c8', '#a7b779', '#bd987b', '#8897aa'];
export const BOARD_RANGES = [
  { key: 'today', label: '1天' }, { key: 'last3', label: '3天' },
  { key: 'last7', label: '近7天' }, { key: 'last30', label: '近30天' },
];
// Use one scale for every visible row: equal daily usage gets equal intensity.
export function activityLevel(value, peak) {
  if (!(value > 0) || !(peak > 0)) return 0;
  const ratio = value / peak;
  return ratio < .01 ? 1 : ratio < .05 ? 2 : ratio < .2 ? 3 : ratio < .5 ? 4 : 5;
}

export function compact(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return Math.round(n).toLocaleString('zh-CN');
}
export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b), pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function distribution(rows) {
  const models = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.totalTokens) || r.totalTokens <= 0) continue;
    if (!models.has(r.model)) models.set(r.model, []);
    models.get(r.model).push(r.totalTokens);
  }
  let max = 1;
  for (const values of models.values()) for (const n of values) max = Math.max(max, n);
  return [...models].map(([id, values]) => {
    const bins = Array(32).fill(0);
    for (const n of values) bins[Math.min(31, Math.floor(Math.log1p(n) / Math.log1p(max) * 32))]++;
    return { id, count: values.length, p50: quantile(values, .5), p90: quantile(values, .9), bins };
  }).sort((a,b) => b.count-a.count);
}
function node(tag, attrs = {}, children = []) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const child of children) el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return el;
}
function svg(width, height, label) {
  return node('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, class: 'tt-board-svg' });
}
const title = text => node('title', {}, [text]);
function panel(label, caption, className = '') {
  const body = h('div', { className: 'tt-board-body' });
  const el = h('section', { className: `tt-board-panel ${className}` },
    h('header', {}, h('h2', {}, label), h('span', {}, caption)), body);
  return { el, body };
}
function empty(body, message) { body.append(h('div', { className: 'tt-board-empty' }, message)); }
function pathFor(values, width, height, logarithmic = false, smooth = false) {
  const scaled = values.map(v => logarithmic ? Math.log1p(v) : v);
  const max = Math.max(1, ...scaled);
  const points = scaled.map((v,i) => [i * width / Math.max(1, values.length - 1), height - v / max * (height - 4)]);
  let path = `M${points[0]?.[0] || 0},${points[0]?.[1] || height}`;
  for (let i = 1; i < points.length; i++) {
    const [x,y] = points[i], [px,py] = points[i-1], mid = (x+px)/2;
    path += smooth ? ` C${mid},${py} ${mid},${y} ${x},${y}` : ` L${x},${y}`;
  }
  return path;
}
export function calendarDays(analytics, state) {
  const dates = analytics.daily.map(d => d.date);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  let end = state.to || dates.at(-1);
  let start = state.from || dates[0];
  const preset = /^last(3|7|30)$/.exec(state.range);
  if (preset && !state.from) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - Number(preset[1]) + 1);
    start = d.toISOString().slice(0,10);
    return enumerate(start, today);
  }
  if (!state.from) {
    if (state.range === 'today') start = end = today;
    if (state.range === 'month') { start = today.slice(0,7) + '-01'; end = today; }
    if (state.range === 'year') { start = today.slice(0,4) + '-01-01'; end = today; }
    if (state.range === 'week') { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()+6)%7)); start = d.toISOString().slice(0,10); end = today; }
  }
  return enumerate(start, end);
}
function enumerate(start, end) {
  const out = [], a = new Date(start + 'T12:00:00Z'), b = new Date(end + 'T12:00:00Z');
  if (!Number.isFinite(+a) || !Number.isFinite(+b)) return out;
  for (let t = +a; t <= +b && out.length < 4000; t += 86400000) out.push(new Date(t).toISOString().slice(0,10));
  return out;
}
function legend(models, color, selected, onSelect, totals) {
  return h('div', { className: `tt-board-legend${totals ? ' tt-legend-totals' : ''}` }, ...models.map(id => h('button', {
    type: 'button', title: id, className: selected === id ? 'selected' : '',
    'aria-pressed': String(selected === id), onClick: () => onSelect(id),
  }, h('i', { style: `background:${color(id)}` }), h('span', {}, id), totals ? h('b', {}, compact(totals.get(id) || 0)) : null)));
}

export function renderAnalytics(container, dashboard, state, patch) {
  container.replaceChildren(); container.className = 'tt-board';
  if (!dashboard) { empty(container, '正在读取用量统计…'); return; }
  const a = dashboard.analytics, summary = dashboard.summary;
  const days = a ? calendarDays(a, state) : [];
  const total = summary.totalTokens || 0;
  const input = (summary.inputTokens || 0) + (summary.cacheRead || 0);
  const tiles = [
    ['合计 Token', compact(total), '所选范围的累计用量'],
    ['日均 Token', days.length ? compact(total / days.length) : '—', `按 ${days.length} 个自然日计算（含无记录日）`],
    ['会话数', compact(a?.sessionCount), '有记录用量的日志会话数量'],
    ['轮次', compact(summary.assistantCount), '有 usage 记录的 assistant 消息数量'],
    ['输入/输出比', summary.outputTokens > 0 ? `${Math.round(input / summary.outputTokens)}:1` : '—', '输入含缓存读取；不含缓存写入'],
    ['缓存命中率', fmtPct(summary.cacheHitRate, 1), '缓存读取 Token / 总 Token，沿用插件统计口径'],
    ['预估费用 · USD', total > 0 && !summary.estimatedCost ? '未完整定价' : fmtCost(summary.estimatedCost), '按已配置价格估算；不是供应商结算账单'],
  ];
  container.append(h('div', { className: 'tt-board-kpis' }, ...tiles.map(([label, value, hint]) =>
    h('div', { title: hint }, h('span', {}, label), h('strong', {}, value)))));
  if (!a) { empty(container, '小时分布尚未就绪，请稍后刷新。'); return; }
  const totals = new Map();
  for (const day of a.daily) for (const [id, n] of Object.entries(day.models)) totals.set(id, (totals.get(id) || 0) + n);
  const allModels = [...totals].sort((x,y) => y[1]-x[1]).map(([id]) => id);
  const color = id => COLORS[Math.max(0, allModels.indexOf(id)) % COLORS.length];
  const selectModel = id => patch({ model: state.model === id ? '' : id });
  const grid = h('div', { className: 'tt-board-grid' }); container.append(grid);
  const shownDays = days.slice(-31);
  const agent = panel('工作空间活跃分布', '当前按 Agent 归属 · 点击筛选', 'tt-agent-panel');
  const topRow = splitRow('boardTopSplit', '调整上方面板宽度', state, patch);
  const bottomRow = splitRow('boardBottomSplit', '调整下方面板宽度', state, patch);
  grid.append(topRow.row, bottomRow.row);
  if (!a.agents.length) empty(agent.body, '所选范围暂无 Agent 用量');
  const activityPeak = a.agents.reduce((peak, item) => shownDays.reduce((max, day) => Math.max(max, item.days[day] || 0), peak), 0);
  const intensityLabels = ['无用量', '低：低于峰值 1%', '较低：峰值 1%–5%', '中：峰值 5%–20%', '较高：峰值 20%–50%', '高：峰值 50% 及以上'];
  agent.body.append(h('div', { className: 'tt-agent-intensity-key', 'aria-label': '每日用量强度图例：无用量和五档蓝色，同屏统一标尺' },
    h('span', {}, '日用量'), h('span', {}, '无'),
    ...intensityLabels.map((label, level) => h('i', { 'data-intensity': level, title: `${label}；同屏最高日用量 ${compact(activityPeak)} Token`, style: `background:var(--tt-activity-${level})` })), h('span', {}, '高'),
    h('span', { className: 'tt-agent-scale-note' }, '同屏统一标尺')));
  const agentList = h('div', { className: 'tt-agent-list', style: `--timeline-columns:${Math.max(1, shownDays.length)}` }); agent.body.append(agentList);
  agentList.append(h('div', { className: 'tt-agent-axis' }, h('span', {}, '名称'), h('span', {}, 'Token'), h('span', {}, '占比'),
    h('span', { className: 'tt-agent-axis-dates' }, ...shownDays.map((day,i) => h('small', { title: day }, i % 6 === 0 ? day.slice(5) : '')))));
  for (const item of a.agents) {
    const name = dashboard.agents.find(x => x.id === item.id)?.name || item.id;
    const cells = h('span', { className: 'tt-agent-cells', style: `grid-template-columns:repeat(${Math.max(1, shownDays.length)},minmax(2px,1fr))` },
      ...shownDays.map(day => {
        const value = item.days[day] || 0, level = activityLevel(value, activityPeak);
        return h('i', { 'data-intensity': level, title: `${day} · ${compact(value)} Token · ${intensityLabels[level]}`, style: `background:var(--tt-activity-${level})` });
      }));
    agentList.append(h('button', { className: 'tt-agent-row', type: 'button', title: name,
      'aria-label': `筛选 Agent ${name}`, 'aria-pressed': String(state.agent === item.id),
      onClick: () => patch({ agent: state.agent === item.id ? '' : item.id }) },
      h('span', { className: 'tt-agent-name' }, name), h('b', {}, compact(item.totalTokens)),
      h('small', {}, `${(item.totalTokens / Math.max(1,total) * 100).toFixed(1)}%`), cells));
  }
  agent.body.append(h('footer', {}, shownDays.length ? `${shownDays[0]} — ${shownDays.at(-1)} · 每日一条 · 最多最近 31 天` : '暂无记录'));

  const heat = panel('日活分布', '1 小时粒度', 'tt-heat-panel'); topRow.append(agent.el, heat.el);
  heat.el.querySelector('header').append(h('div', { className: 'tt-heat-legend', 'aria-label': '热力图图例：由少到多' },
    h('span', {}, '少'), ...[.12,.3,.5,.7,1].map(opacity => h('i', { style: `opacity:${opacity}` })), h('span', {}, '多')));
  const periods = [0,0,0,0]; for (const cell of a.heatmap) periods[Math.floor(cell.hour/6)] += cell.totalTokens;
  heat.body.append(h('div', { className: 'tt-time-bands' }, ...periods.map((n,i) => h('div', {},
    h('span', {}, ['凌晨 0–6','上午 6–12','下午 12–18','晚间 18–24'][i]), h('b', {}, fmtPct(n / Math.max(1,a.hourlyTotal) * 100,1))))));
  if (!a.heatmap.length) empty(heat.body, '所选范围没有小时级记录');
  else {
    const byCell = new Map(a.heatmap.map(c => [`${c.date}/${c.hour}`, c.totalTokens]));
    const max = Math.max(1, ...a.heatmap.map(c => c.totalTokens));
    const height = Math.max(120, 24 + shownDays.length * 9), chart = svg(500,height,'每日每小时 Token 热力图');
    for (let i=0;i<24;i+=3) chart.append(node('text',{x:40+i*19,y:12,class:'tt-axis'},[String(i).padStart(2,'0')]));
    shownDays.forEach((date,i) => {
      chart.append(node('text',{x:0,y:27+i*9,class:'tt-axis'},[date.slice(5)]));
      for (let hour=0;hour<24;hour++) {
        const n=byCell.get(`${date}/${hour}`)||0;
        chart.append(node('rect',{x:40+hour*19,y:20+i*9,width:8,height:7,rx:1,fill:'var(--tt-heat)',opacity:n ? .15+.85*Math.log1p(n)/Math.log1p(max) : .06},[title(`${date} ${hour}:00–${hour+1}:00 · ${compact(n)} Token`)]));
      }
    });
    heat.body.append(chart);
  }
  heat.body.append(h('footer', {}, `小时记录覆盖 ${fmtPct(a.hourlyTotal / Math.max(1,a.dailyTotal) * 100,1)} · ${a.timeZone || '日志本地时间'} · 最多最近31天`));

  const dist = panel('单次请求大小分布', '当前为会话轮次口径 · 最近 5 天', 'tt-dist-panel');
  const samples = distribution(dashboard.rows);
  if (!samples.length) empty(dist.body, '该范围无保留的会话轮次明细；日汇总仍可查看');
  else {
    dist.body.append(h('div',{className:'tt-dist-head'},h('span',{},'模型 / 轮次'),h('span',{},'P50'),h('span',{},'P90'),h('span',{},'分布 · 横轴为 Token 对数')));
    const list = h('div', { className: 'tt-dist-list' }); dist.body.append(list);
    for (const sample of samples.slice(0,8)) {
      const chart=svg(240,38,`${sample.id} 会话轮次分布`), d=pathFor(sample.bins,240,34,false,true);
      chart.append(node('path',{d:`${d} L240,38 L0,38 Z`,fill:color(sample.id),'fill-opacity':.23,stroke:color(sample.id),'stroke-width':1},[title(`${sample.count} 轮 · P50 ${compact(sample.p50)} · P90 ${compact(sample.p90)}`)]));
      list.append(h('button',{type:'button',className:'tt-dist-row',title:sample.id,onClick:()=>selectModel(sample.id)},
        h('span',{},h('b',{},sample.id),h('small',{},`${sample.count.toLocaleString()} 轮`)),h('b',{},compact(sample.p50)),h('b',{},compact(sample.p90)),chart));
    }
  }
  dist.body.append(h('footer',{},'按一轮对话累计用量统计，不代表单次 API 请求；历史明细仅保留最近 5 天。'));

  const right=h('div',{className:'tt-board-right'});bottomRow.append(dist.el, right);
  const ridge=panel('0–24 时分布 · 按模型','每条曲线独立缩放 · 平滑显示');right.append(ridge.el);
  const hourModels=a.modelHours.slice(0,7);
  if (!hourModels.length) empty(ridge.body,'该范围暂无小时模型数据');
  else {
    const chart=svg(500,114,'各模型小时用量曲线');
    for (let i=0;i<=4;i++) { const x=12+i*118; chart.append(node('line',{x1:x,x2:x,y1:4,y2:90,stroke:'var(--tt-b2)','stroke-dasharray':'2 4'}));chart.append(node('text',{x,y:109,class:'tt-axis'},[String(i*6)])); }
    for (const model of hourModels) {
      const path=node('path',{d:`${pathFor(model.hours,472,84,false,true)} L472,88 L0,88 Z`,transform:'translate(12,2)',fill:color(model.id),'fill-opacity':.15,stroke:color(model.id),'stroke-width':1.4,tabindex:0,role:'button','aria-label':`筛选模型 ${model.id}`},[title(`${model.id} · ${compact(model.totalTokens)} Token`)]);
      path.addEventListener('click',()=>selectModel(model.id));path.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectModel(model.id);}});chart.append(path);
    }
    ridge.body.append(chart,legend(hourModels.map(m=>m.id),color,state.model,selectModel));
  }
  const daily=panel('每日模型用量比例','柱高为总量 · 分段为模型占比');right.append(daily.el);
  if (!shownDays.length) empty(daily.body,'所选范围暂无日汇总');
  else {
    const chart=svg(500,118,'每日模型 Token 堆叠柱状图'), map=new Map(a.daily.map(d=>[d.date,d]));
    const max=Math.max(1,...shownDays.map(day=>map.get(day)?.totalTokens||0)), step=480/shownDays.length;
    shownDays.forEach((date,i)=>{
      const day=map.get(date);let y=90;
      for(const id of allModels){ const n=day?.models[id]||0;if(!n)continue;const height=n/max*82;y-=height;
        const bar=node('rect',{x:10+i*step+1,y,width:Math.max(1,step-3),height,fill:color(id),rx:.8},[title(`${date} · ${id} · ${compact(n)} Token`)]);
        bar.addEventListener('click',()=>patch({range:'all',from:date,to:date}));chart.append(bar);
      }
      if(i%Math.max(1,Math.ceil(shownDays.length/7))===0)chart.append(node('text',{x:10+i*step,y:109,class:'tt-axis'},[date.slice(5)]));
    });
    daily.body.append(chart,legend(allModels,color,state.model,selectModel,totals));
  }
  container.append(h('p',{className:'tt-board-note'},'数据来自 HanaAgent 本地日志汇总；图表沿用日志日期，明细分布受最近 5 天保留期限制。模型颜色仅用于区分数据序列。'));
}
