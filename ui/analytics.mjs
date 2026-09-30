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

// ── 用量总览（色带图）──
// 全页唯一一张真正按顶部时间范围铺满的图：窗口长就按天，只剩一天就按小时。
// 默认按「来源」叠（对话 / 子代理 / 频道 / 后台 / 账本），可切成按 Agent。
const KIND_LABELS = { desktop: '对话', sub: '子代理', bridge: '频道', background: '后台任务', ledger: '账本', channel: '其他' };
const KIND_ORDER = ['desktop', 'sub', 'bridge', 'background', 'ledger', 'channel'];
// 按模型/供应商筛选时后端不给来源与 Agent 拆分，图退化成这一层总量，不空着。
const TOTAL_LAYER = '__total';
let flowDimension = 'kind'; // 模块级：重绘后仍记得用户上次选的是哪个维度
let flowScale = 'abs';      // 'abs' 绝对量 | 'pct' 每列归一成占比（小层才看得见）
let flowFocus = '';         // 非空时只显示这一层，纵轴按这层重新缩放；再点图例恢复

// 中点插值的平滑曲线段（不含起笔的 M）。上下边界用同一套算法，层与层之间才不露缝。
function curve(pts) {
  let d = '';
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i], [px, py] = pts[i - 1], mx = (x + px) / 2;
    d += ` C${mx},${py} ${mx},${y} ${x},${y}`;
  }
  return d;
}

const axisX = (i, count, width) => (count <= 1 ? width / 2 : (i * width) / (count - 1));

// 求平滑曲线在某个浮点索引处的值。用的是与绘制完全相同的中点贝塞尔：
// x 控制点落在两段中点，x(t) 单调，二分反解 t；y 控制点就是两端点，直接可算。
// 这样鼠标停在两点之间时，读数对得上曲线上那一点，而不是生硬地卡到整列。
function bezierYAt(i0, y0, i1, y1, target) {
  const mx = (i0 + i1) / 2;
  let lo = 0, hi = 1;
  for (let k = 0; k < 20; k++) {
    const t = (lo + hi) / 2;
    const x = i0 * (1 - t) ** 3 + 3 * mx * (1 - t) ** 2 * t + 3 * mx * (1 - t) * t ** 2 + i1 * t ** 3;
    if (x < target) lo = t; else hi = t;
  }
  const t = (lo + hi) / 2;
  return y0 * (1 - t) ** 2 * (1 + 2 * t) + y1 * t ** 2 * (3 - 2 * t);
}

// 叠加：每条曲线各自从基线画起，互相重叠。
// 这是「0–24 时分布」那张图的形状：填充很淡，重叠层数越多颜色越深，描边始终清楚。
function overlayPaths(layers, count, width, height, max) {
  const Y = (v) => height - (v / max) * (height - 6);
  return layers.map((layer) => {
    if (!count) return '';
    const pts = layer.values.map((v, i) => [axisX(i, count, width), Y(v)]);
    return `M${pts[0][0]},${pts[0][1]}` + curve(pts)
      + ` L${axisX(count - 1, count, width)},${height} L${axisX(0, count, width)},${height} Z`;
  });
}

// 堆叠：各层首尾相接，叠满即为总量。上下边界用同一套插值，层与层之间才不露缝。
function stackedAreaPaths(layers, count, width, height, max) {
  const X = (i) => axisX(i, count, width);
  const Y = (v) => height - (v / max) * (height - 6);
  const tops = [], bots = [];
  let acc = new Array(count).fill(0);
  for (const layer of layers) {
    bots.push(acc.slice());
    acc = acc.map((v, i) => v + layer.values[i]);
    tops.push(acc.slice());
  }
  return layers.map((layer, li) => {
    if (!count) return '';
    const topPts = tops[li].map((v, i) => [X(i), Y(v)]);
    const botPts = bots[li].map((v, i) => [X(i), Y(v)]).reverse();
    return `M${topPts[0][0]},${topPts[0][1]}` + curve(topPts) + ` L${botPts[0][0]},${botPts[0][1]}` + curve(botPts) + ' Z';
  });
}

function renderFlowPanel(a, days, agentNames = {}) {
  const useHour = days.length <= 1 && a.heatmap.length > 0;
  const cells = useHour ? a.heatmap : a.daily;
  // 有来源 / Agent 拆分就用它们；后端因为模型、供应商筛选把这两项撤掉时，改按模型看：
  // 供应商筛选下每格 models 仍然齐全（已按筛选过滤），所以各家模型自己的线加起来就是总量。
  const canSplitKind = cells.some((c) => Object.keys(c.kinds || {}).length || Object.keys(c.agents || {}).length);
  const hasModels = cells.some((c) => Object.keys(c.models || {}).length);
  const DIMS = canSplitKind || !hasModels ? [['kind', '按来源'], ['agent', '按 Agent']] : [['model', '按模型']];
  const sw = h('div', { className: 'tt-flow-switch' });
  const body = h('div', { className: 'tt-board-body' });
  const canvas = h('div', { className: 'tt-flow-canvas' });
  const foot = h('footer', {}, '');
  body.append(canvas, foot);
  const el = h('section', { className: 'tt-board-panel tt-flow-panel' },
    h('header', {}, h('h2', {}, '用量总览'), sw), body);

  // Agent 一律显它的中文名（缓存里带 agentNames 映射）；回落到 id 只是兜底。
  const nameOf = (id) => {
    if (id === TOTAL_LAYER) return '总量';
    if (flowDimension === 'kind') return KIND_LABELS[id] || id;
    if (flowDimension === 'agent') return agentNames[id] || id;
    return id;
  };
  const cellLabel = (c) => (useHour ? `${c.date} ${String(c.hour).padStart(2, '0')}:00` : c.date);

  function draw() {
    // 拆分维度由数据决定：后端在按模型 / 供应商筛选时不发 kinds / agents（各分项之和会对不上
    // 筛选后的总量），这时改按模型看：每家自己的模型各一条线。
    if (!DIMS.some(([d]) => d === flowDimension)) flowDimension = DIMS[0][0];
    const field = flowDimension === 'kind' ? 'kinds' : flowDimension === 'agent' ? 'agents' : 'models';
    const totals = new Map();
    for (const c of cells) for (const [id, v] of Object.entries(c[field] || {})) totals.set(id, (totals.get(id) || 0) + v);
    const splittable = totals.size > 0 && cells.length > 0;
    const cellsTotal = cells.reduce((sum, c) => sum + Math.max(0, c.totalTokens || 0), 0);
    // 只有一层总量时「占比」恒为 100%，没有信息量，收回这个选项。
    if (!splittable && flowScale === 'pct') flowScale = 'abs';
    const noSplit = cells.length > 0 && !splittable;
    for (const btn of [...sw.children]) {
      if (btn.dataset.dim) {
        btn.setAttribute('aria-pressed', String(btn.dataset.dim === flowDimension));
        btn.disabled = noSplit;
        btn.title = noSplit ? '所选范围内没有可拆分的用量' : '';
      }
      if (btn.dataset.scale) {
        btn.setAttribute('aria-pressed', String(btn.dataset.scale === flowScale));
        btn.disabled = noSplit && btn.dataset.scale === 'pct';
        btn.title = btn.disabled ? '只有总量一层时，占比恒为 100%' : '';
      }
    }
    canvas.replaceChildren();
    if (!cells.length || (!splittable && cellsTotal <= 0)) {
      canvas.append(h('div', { className: 'tt-board-empty' }, '所选范围暂无用量'));
      foot.textContent = '';
      return;
    }

    const ids = splittable
      ? (flowDimension === 'kind'
          ? KIND_ORDER.filter((k) => totals.has(k))
          : [...totals.keys()].sort((x, y) => totals.get(y) - totals.get(x)))
      : [TOTAL_LAYER];
    const totalOf = (id) => (id === TOTAL_LAYER || !splittable ? cellsTotal : totals.get(id));
    const colTotals = cells.map((c) => Math.max(1, c.totalTokens));
    const layers = ids.map((id, i) => ({
      id, total: totalOf(id), colorIndex: i,
      values: cells.map((c, i2) => {
        const v = id === TOTAL_LAYER
          ? Math.max(0, c.totalTokens || 0)
          : (splittable ? ((c[field] || {})[id] || 0) : Math.max(0, c.totalTokens || 0));
        return flowScale === 'pct' ? v / colTotals[i2] : v;
      }),
    }));
    // 聚焦：点图例只留一层。纵轴改成按这层自己的量算，否则小层被大层一并压平看不见。
    let shown = flowFocus ? layers.filter((l) => l.id === flowFocus) : layers;
    if (flowFocus && !shown.length) { flowFocus = ''; shown = layers; }
    const solo = shown.length === 1 && flowFocus ? shown[0] : null;

    const W = 1000, H = 300, PAD_L = 90, PAD_B = 40, PAD_T = 8;
    const cw = W - PAD_L - 10, ch = H - PAD_B - PAD_T;
    const max = solo
      ? Math.max(...solo.values, 0.01)
      : (flowScale === 'pct' ? 1 : Math.max(1, ...cells.map((c) => c.totalTokens)));
    // 绝对量用叠加（复刻「0–24 时分布」的观感），占比用堆叠（归一到 100% 才有意义）。
    const overlaid = flowScale === 'abs';
    const paths = overlaid
      ? overlayPaths(shown, cells.length, cw, ch, max)
      : stackedAreaPaths(shown, cells.length, cw, ch, max);
    const chart = svg(W, H, '用量总览：各来源消耗随时间的变化');
    const g = node('g', { transform: `translate(${PAD_L},${PAD_T})` });
    // 轴标签不画进 SVG。SVG 随容器等比缩放，字会一起变大变小；
    // 改成叠一层 HTML，位置用百分比跟着图走，字号是普通 CSS px，永远不变。
    const yTicks = [], xTicks = [];
    for (let i = 0; i <= 2; i++) {
      const v = (max * i) / 2, y = ch - (v / max) * (ch - 6);
      g.append(node('line', { x1: 0, x2: cw, y1: y, y2: y, stroke: 'var(--tt-b3)', 'stroke-dasharray': '2 4' }));
      yTicks.push({ y: PAD_T + y, text: flowScale === 'pct' ? Math.round(v * 1000) / 10 + '%' : compact(v) });
    }
    shown.forEach((layer, i) => {
      const color = COLORS[layer.colorIndex % COLORS.length];
      // 叠加：照搬「0–24 时分布」的色彩逻辑——填充只给 15%，重叠层数越多颜色越深；
      // 描边一点都不透，所以叠得再深，轮廓也始终认得出来。
      // 占比：那是堆叠，层不重叠，重叠加深不成立，填充得实一些才能看出构成。
      const style = overlaid
        ? { 'fill-opacity': .15, stroke: color, 'stroke-width': 1.4 }
        : { 'fill-opacity': .55, stroke: color, 'stroke-width': .8, 'stroke-opacity': .85 };
      g.append(node('path', { d: paths[i], fill: color, ...style },
        [title(`${nameOf(layer.id)} · ${compact(layer.total)} Token`)]));
    });
    // x 轴刻度按列中心摆（而不是数据点位置）：首尾两个刻度才不会把一半压在框外。
    const colW = cw / Math.max(1, cells.length);
    const step = Math.max(1, Math.ceil(cells.length / 9));
    cells.forEach((c, i) => {
      if (i % step) return;
      const label = useHour ? String(c.hour).padStart(2, '0') + ':00' : c.date.slice(5);
      xTicks.push({ x: PAD_L + i * colW + colW / 2, y: PAD_T + ch + 26, text: label });
    });

    // ── 悬停：竖直虚线 + 各层标记点 + 读数浮层 ──
    // 虚线跟着指针的 x 走，取值走插值，所以停在哪都能读出那个位置的值。
    const span = Math.max(1, cells.length - 1);
    const stepX = cw / span;
    const valueAt = (layer, fx) => {
      const a = Math.max(0, Math.min(cells.length - 1, Math.floor(fx)));
      const b = Math.min(cells.length - 1, a + 1);
      return a === b ? layer.values[a] : bezierYAt(a, layer.values[a], b, layer.values[b], fx);
    };
    const fmtValue = (v) => (flowScale === 'pct' ? (v * 100).toFixed(1) + '%' : compact(v));
    const hover = node('g', { class: 'tt-flow-hover' });
    const vline = node('line', { y1: 0, y2: ch, stroke: 'var(--tt-t2)', 'stroke-width': 1, 'stroke-dasharray': '3 3', 'shape-rendering': 'crispEdges', opacity: 0 });
    hover.append(vline);
    const dots = shown.map((layer) => node('circle', {
      r: 2.6, cx: 0, cy: 0,
      fill: COLORS[layer.colorIndex % COLORS.length], stroke: 'var(--tt-card)', 'stroke-width': 1, opacity: 0,
    }));
    for (const dot of dots) hover.append(dot);
    g.append(hover);

    const hud = h('div', { className: 'tt-flow-hud' });
    let lastPx = null, hudSide = 'right'; // 记住指针上一次的位置，用来判断滑向哪边

    const clearHover = () => {
      vline.setAttribute('opacity', '0');
      for (const dot of dots) dot.setAttribute('opacity', '0');
      hud.className = 'tt-flow-hud';
    };
    chart.addEventListener('mousemove', (event) => {
      const box = chart.getBoundingClientRect ? chart.getBoundingClientRect() : null;
      if (!box || !box.width) return;
      const gx = ((event.clientX - box.left) / box.width) * W - PAD_L;
      const fx = Math.max(0, Math.min(span, gx / stepX));
      const vx = fx * stepX;
      vline.setAttribute('x1', vx); vline.setAttribute('x2', vx); vline.setAttribute('opacity', '1');
      shown.forEach((layer, li) => {
        const v = valueAt(layer, fx);
        dots[li].setAttribute('cx', vx);
        dots[li].setAttribute('cy', ch - (v / max) * (ch - 6));
        dots[li].setAttribute('opacity', '1');
      });
      // 日期取最近的一列（半天那种中间值写出来没意义），数值才是插值结果。
      const cell = cells[Math.round(fx)];
      hud.replaceChildren(
        h('b', {}, cellLabel(cell)),
        h('small', {}, `${(cell.calls || 0).toLocaleString()} 次调用`),
        ...shown.map((layer, li) => h('span', {},
          h('i', { style: `background:${COLORS[layer.colorIndex % COLORS.length]}` }),
          nameOf(layer.id),
          h('em', {}, fmtValue(valueAt(layer, fx))))),
      );
      hud.className = 'tt-flow-hud on';
      // 尺寸每次现测。display 刚从 none 切过来，缓存下来的值会差很多。
      const hudW = hud.offsetWidth || 160;
      const hudHt = hud.offsetHeight || 60;
      // 浮层贴在虚线旁边，放哪一侧看指针的移动方向：
      // 向右滑放左边，向左滑放右边，于是它不会挡在你正要去看的那一侧。
      const pxPos = ((PAD_L + vx) / W) * box.width;
      if (lastPx != null && Math.abs(pxPos - lastPx) > 2) hudSide = pxPos > lastPx ? 'left' : 'right';
      lastPx = pxPos;
      const hudGap = 14;
      let hudLeft = hudSide === 'right' ? pxPos + hudGap : pxPos - hudGap - hudW;
      if (hudLeft < 0) hudLeft = pxPos + hudGap;                          // 左边放不下就让到右边
      if (hudLeft + hudW > box.width) hudLeft = pxPos - hudGap - hudW;    // 右边放不下就让到左边
      hud.style.left = Math.max(0, Math.min(Math.max(0, box.width - hudW), hudLeft)) + 'px';
      const rectH = box.height || H;
      const py = event.clientY - box.top;
      // 指针落在浮层「从下往上 2/3」处，也就是距顶边 1/3、距底边 2/3。
      // 浮层顶边因此在指针上方 1/3 个浮层高度处。
      const top = py - hudHt * (1 / 3);
      hud.style.top = Math.max(4, Math.min(Math.max(4, rectH - hudHt - 4), top)) + 'px';
    });
    chart.addEventListener('mouseleave', clearHover);

    chart.append(g);
    // 轴标签层：绝对定位盖在图上。viewBox 坐标换算成百分比，位置跟着图走。
    const axes = h('div', { className: 'tt-flow-axes' },
      ...yTicks.map((t) => h('span', {
        style: `left:${((PAD_L / W) * 100).toFixed(3)}%;top:${((t.y / H) * 100).toFixed(3)}%;transform:translate(calc(-100% - 8px),-50%)`,
      }, t.text)),
      ...xTicks.map((t) => h('span', {
        style: `left:${((t.x / W) * 100).toFixed(3)}%;top:${((t.y / H) * 100).toFixed(3)}%;transform:translate(-50%,-50%)`,
      }, t.text)));
    // 轴标签层和浮层都塞进 plot。plot 只包 SVG，百分比才以图区为基准，
    // 否则按整块画布（还含图例）算，标签会落到底下的图例上。
    const plot = h('div', { className: 'tt-flow-plot' }, chart, axes, hud);
    canvas.append(plot);
    const grand = (splittable ? [...totals.values()].reduce((s, v) => s + v, 0) : cellsTotal) || 1;
    canvas.append(h('div', { className: 'tt-board-legend tt-legend-totals' },
      ...ids.map((id, i) => h('button', {
        type: 'button',
        title: `${nameOf(id)}${splittable ? ' · 点击只看这一层，再点恢复' : ''}`,
        'aria-pressed': String(flowFocus === id),
        onClick: () => { flowFocus = flowFocus === id ? '' : id; draw(); },
      },
        h('span', { className: 'tt-legend-name' },
          h('i', { style: `background:${COLORS[i % COLORS.length]}` }),
          h('span', {}, nameOf(id))),
        h('b', {}, `${compact(totalOf(id))} · ${((totalOf(id) / grand) * 100).toFixed(1)}%`)))));
    // 叠加模式下各层独立成线，叠满不等于总量，页脚不能再那么写。
    const scaleNote = !splittable
      ? '按模型或供应商筛选时只显示总量'
      : solo
        ? `只看「${nameOf(solo.id)}」，纵轴已按这层重新缩放`
        : flowDimension === 'model' && ids.length === 1
          ? '只看所选模型自己的用量'
          : (flowScale === 'pct' ? '每列归一到 100%，看构成' : '各层独立成线，重叠处自然加深');
    foot.textContent = useHour
      ? `按小时 · ${cells[0].date} · 共 ${cells.length} 小时 · ${scaleNote}`
      : `${cells[0].date} → ${cells[cells.length - 1].date} · 共 ${cells.length} 天 · ${scaleNote}`;
  }

  for (const [dim, label] of DIMS) {
    sw.append(h('button', { type: 'button', dataset: { dim }, 'aria-pressed': String(flowDimension === dim),
      onClick: () => { flowDimension = dim; flowFocus = ''; draw(); } }, label));
  }
  sw.append(h('span', { className: 'tt-flow-sep' }));
  for (const [sc, label] of [['abs', '绝对量'], ['pct', '占比']]) {
    sw.append(h('button', { type: 'button', dataset: { scale: sc }, 'aria-pressed': String(flowScale === sc),
      onClick: () => { flowScale = sc; draw(); } }, label));
  }
  draw();
  return el;
}

export function renderAnalytics(container, dashboard, state, patch) {
  container.replaceChildren(); container.className = 'tt-board';
  if (!dashboard) { empty(container, '正在读取用量统计…'); return; }
  const a = dashboard.analytics, summary = dashboard.summary;
  const days = a ? calendarDays(a, state) : [];
  const total = summary.totalTokens || 0;  const input = (summary.inputTokens || 0) + (summary.cacheRead || 0);
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
  // 全宽色带图：紧随 KPI，位于下面的细分图之前。它是唯一一张完整响应顶部时间范围的图。
  container.append(renderFlowPanel(a, days, dashboard.agentNames || {}));
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
