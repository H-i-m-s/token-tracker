import { splitRow } from './board-layout.mjs';
import { h, fmtCost, fmtPct } from './components.mjs';
import { asList, pickValues, modsOf } from './selection.mjs';
import { splineCurve, splineValueAt } from './curve.mjs';

const COLORS = ['#d1b477', '#7ea3cf', '#81b4a1', '#c68487', '#aa97c8', '#a7b779', '#bd987b', '#8897aa'];

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
  // 带图表的卡片整体算“读物”，不参与换页拖拽：里面任何地方按住都能选字。
  // 卡里真正要拖的区域（工作空间活跃分布的整张表、热力图）自己再标 data-tt-pan，更近的那个赢。
  const el = h('section', { className: `tt-board-panel ${className}`, 'data-tt-select': '' },
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
  const sel = asList(selected);
  return h('div', { className: `tt-board-legend${totals ? ' tt-legend-totals' : ''}` }, ...models.map(id => h('button', {
    type: 'button', title: id, className: sel.includes(id) ? 'selected' : '',
    'aria-pressed': String(sel.includes(id)), onClick: (event) => onSelect(id, event),
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
let flowFocus = [];         // 选中的层 id（可多层）：非空时只显示这几层，纵轴按它们重新缩放；全取消即恢复
// 多选的锚点：Shift 点的时候从这里到目标项之间整段加选。
// 它只关系到本次会话的点选手感，不是用户的筛选状态，所以不进 state、不落盘。
const anchors = { model: null, agent: null, focus: null };

// 中点插值的平滑曲线段（不含起笔的 M）。上下边界用同一套算法，层与层之间才不露缝。
const axisX = (i, count, width) => (count <= 1 ? width / 2 : (i * width) / (count - 1));

// 叠加：每条曲线各自从基线画起，互相重叠。
// 这是「0–24 时分布」那张图的形状：填充很淡，重叠层数越多颜色越深，描边始终清楚。
function overlayPaths(layers, count, width, height, max) {
  const Y = (v) => height - (v / max) * (height - 6);
  return layers.map((layer) => {
    if (!count) return '';
    const pts = layer.values.map((v, i) => [axisX(i, count, width), Y(v)]);
    return `M${pts[0][0]},${pts[0][1]}` + splineCurve(pts)
      + ` L${axisX(count - 1, count, width)},${height} L${axisX(0, count, width)},${height} Z`;
  });
}

// 堆叠图的其他用处（日模型占比柱）走各自的构造，这里不再需要 stackedAreaPaths：
// 河流图的占比改成了“各层独立成线”，与绝对量共用同一套几何，两个模式之间才能逐点插值。

// ── 时间刻度 ──
// 顶部时间选项是唯一的尺子：跨度 ≤7 天按小时，其余按天。看板上所有时间序列图都走这里，
// 不再各画各的刻度。
const SCALE_HOUR_MAX_DAYS = 7;
function scaleFor(days) {
  return days.length >= 1 && days.length <= SCALE_HOUR_MAX_DAYS ? 'hour' : 'day';
}
// 把范围摊成等距的时间格。小时档按「天 × 24」补齐成连续网格：后端的 heatmap 只含有数据的
// 那几个小时（实测没有任何一天是满 24 小时），直接当序列铺开会把时间轴压扁。
function timeSlots(days, scale) {
  if (scale !== 'hour') return days.map((date) => ({ date, hour: null, key: date, label: date.slice(5) }));
  const out = [];
  for (const date of days) {
    for (let hour = 0; hour < 24; hour++) {
      out.push({ date, hour, key: `${date}/${hour}`, label: `${date.slice(5)} ${String(hour).padStart(2, '0')}:00` });
    }
  }
  return out;
}
// 轴刻度文字：天档每 N 天一个；小时档只在 00:00 写日期，免得同一天重复标注。
function slotLabel(slot, index, count, scale) {
  if (scale === 'hour') return slot.hour === 0 ? slot.date.slice(5) : '';
  return index % Math.max(1, Math.ceil(count / 12)) === 0 ? slot.date.slice(5) : '';
}
function hourCells(heatmap, days) {
  const byKey = new Map(heatmap.map((c) => [`${c.date}/${c.hour}`, c]));
  return timeSlots(days, 'hour').map((s) => byKey.get(s.key)
    || { date: s.date, hour: s.hour, totalTokens: 0, models: {}, kinds: {}, agents: {}, calls: 0 });
}
// 面板骨架只建一次，之后只更新内容。
// 以前每次 draw() 都 replaceChildren 重建：元素全是新的，任何过渡都无从谈起（没有“从哪儿来”）。
// 现在曲线沿同一批 path 变过去，颜色跟着过渡，纵轴变化也能滑过去。
function createFlowPanel() {
  // 跨重画要活着的状态：数据、当前画出来的那几层、悬停用的几何参数
  let useHour = false, days = [], cells = [], canSplitKind = false, hasModels = false;
  let DIMS = [['kind', '按来源'], ['agent', '按 Agent']];
  let agentNames = {};
  let shown = [], dots = [], vline = null, span = 1, stepX = 0, max = 1;
  let valueAt = () => 0, fmtValue = () => '';
  const pathEls = new Map();        // 层 id -> { el, columns, values, max }
  const FLOW_MS = 260;              // 与 CSS 那条 S 形过渡同长，用来安排“降完再淡”
  const W = 1000, H = 300, PAD_L = 90, PAD_B = 40, PAD_T = 8;
  const cw = W - PAD_L - 10, ch = H - PAD_B - PAD_T;
  const chart = svg(W, H, '用量总览：各来源消耗随时间的变化');
  // 曲线与悬停标记跟网格共用一个坐标系（都平移 (PAD_L, PAD_T)），
  // path 从 viewBox 的 (0,0) 起算会整体偏上 8 个单位、偏左 90 个单位。
  const pathsLayer = node('g', { transform: `translate(${PAD_L},${PAD_T})` });
  const hoverLayer = node('g', { transform: `translate(${PAD_L},${PAD_T})` });
  chart.append(pathsLayer, hoverLayer);   // 顺序不能乱：曲线在下、悬停在上
  const hud = h('div', { className: 'tt-flow-hud' });
  const axesBox = h('div', { className: 'tt-flow-axes' });
  // 三条横向网格线做成 HTML，而不是 SVG 的 line：纵轴重算时它要跟旁边的刻度一起滑。
  // 画在 SVG 里时它没有过渡，纵轴一变就瞬跳到新刻度，而标签还在滑、曲线还在变，
  // 看上去就是整张图“突变”（多选相加改纵轴时最容易撞上）。
  const gridRows = ['', '', ''].map(() => {
    const row = h('div', { className: 'tt-flow-gridline' });
    row.style.left = ((PAD_L / W) * 100).toFixed(3) + '%';
    row.style.width = ((cw / W) * 100).toFixed(3) + '%';
    return row;
  });
  // y 轴三个标签常驻：纵轴重算时靠过渡滑过去，而不是硬跳（文本换了、位置过渡）
  const yLabelSpans = ['', '', ''].map(() => h('span', {}));
  for (let i = 0; i < 3; i++) axesBox.append(gridRows[i], yLabelSpans[i]);
  const plot = h('div', { className: 'tt-flow-plot', 'data-tt-select': '' }, chart, axesBox, hud);
  const legendBox = h('div', { className: 'tt-board-legend tt-legend-totals' });
  const emptyBox = h('div', { className: 'tt-board-empty' }, '所选范围暂无用量');
  const sw = h('div', { className: 'tt-flow-switch' });
  const body = h('div', { className: 'tt-board-body' });
  const canvas = h('div', { className: 'tt-flow-canvas' });
  const foot = h('footer', {}, '');
  canvas.append(plot, legendBox, emptyBox);
  body.append(canvas, foot);
  const el = h('section', { className: 'tt-board-panel tt-flow-panel', 'data-tt-select': '' },
    h('header', {}, h('h2', {}, '用量总览'), sw), body);

  // Agent 一律显它的中文名（缓存里带 agentNames 映射）；回落到 id 只是兜底。
  const nameOf = (id) => {
    if (id === TOTAL_LAYER) return '总量';
    if (flowDimension === 'kind') return KIND_LABELS[id] || id;
    if (flowDimension === 'agent') return agentNames[id] || id;
    return id;
  };
  const cellLabel = (c) => (useHour ? `${c.date} ${String(c.hour).padStart(2, '0')}:00` : c.date);

  // 把「旧形状按新列数重采样」钉成当前形态：两串 d 段数一样，浏览器才能插值。
  const pin = (el, d) => {
    if (!d) return;
    el.style.transition = 'none';
    el.setAttribute('d', d);
    void el.getBoundingClientRect();
    el.style.transition = '';
  };
  const resample = (rec, count) => {
    const from = Math.max(1, rec.values.length - 1);
    return new Array(count).fill(0).map((_, k) => splineValueAt(rec.values, (k / Math.max(1, count - 1)) * from));
  };
  const buildOne = (values, count, m) => overlayPaths([{ values }], count, cw, ch, m)[0] || '';
  const makePath = (layer, d) => node('path', {
    class: 'tt-flow-line tt-flow-line-vis',
    d,
    fill: COLORS[layer.colorIndex % COLORS.length],
    stroke: COLORS[layer.colorIndex % COLORS.length],
    'fill-opacity': .15,
    'stroke-width': 1.4,
  }, [title(`${nameOf(layer.id)} · ${compact(layer.total)} Token`)]);

  // 悬停用的一套值每次都换，但监听器只挂一次（元素现在是常驻的，重挂会越堆越多）。
  const clearHover = () => {
    if (vline) vline.setAttribute('opacity', '0');
    for (const dot of dots) dot.setAttribute('opacity', '0');
    hud.className = 'tt-flow-hud';
  };
  let hoverMove = null, hoverLeave = null;

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
    // 只清网格与悬停层。曲线层千万不能在这里清：一清，节点就被摘下来了，
    // 之后即使把同一批 path 塞回去，浏览器也当它是新插入的元素——“之前的样子”没了，
    // d 的过渡根本不会建立，看上去就是突然跳变。
    // 只清悬停层（网格线现在是 HTML，见上面 gridRows）
    hoverLayer.replaceChildren();
    const hasData = cells.length > 0 && (splittable || cellsTotal > 0);
    emptyBox.hidden = hasData;
    plot.hidden = !hasData;
    legendBox.hidden = !hasData;
    if (!hasData) {
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
    // 聚焦：点图例只留选中的几层（可多层）。纵轴按这几层自己的量算，否则小层被大层一并压平看不见。
    shown = flowFocus.length ? layers.filter((l) => flowFocus.includes(l.id)) : layers;
    if (flowFocus.length && !shown.length) { flowFocus = []; shown = layers; }
    const solo = shown.length === 1 && flowFocus.length ? shown[0] : null;

    // 纵轴上限 = 画面上真实存在的最高点，只算画出来的这几层。
    // 以前绝对量取的是「各层叠起来的日总量」，于是聚焦选谁都不影响纵轴：只选小层时轴还挂在
    // 全体叠起来的高度上（本机数据 23.52 亿，由 08-13 一天撑着），小层就被压成一条线。
    // 占比模式仍旧固定 1（每列归一才有意义），单选仍是它自己的尺度。
    const shownMax = Math.max(0.01, ...shown.flatMap((l) => l.values));
    max = flowScale === 'pct'
      ? (solo ? Math.max(...solo.values, 0.01) : 1)
      : Math.max(1, shownMax);
    // 两个模式共用同一套几何：占比只是把每层的值换成了“占当列的比例”（见上面 values 那段），
    // 纵轴从 Token 绝对量变成 0–100%。同一批节点、同一套命令结构，切换时就能逐点插值，
    // 是真正的形状变换，而不是两套图叠着淡入淡出。
    const paths = overlayPaths(shown, cells.length, cw, ch, max);
    // 轴标签不画进 SVG。SVG 随容器等比缩放，字会一起变大变小；
    // 改成叠一层 HTML，位置用百分比跟着图走，字号是普通 CSS px，永远不变。
    const yTicks = [], xTicks = [];
    for (let i = 0; i <= 2; i++) {
      const v = (max * i) / 2, y = ch - (v / max) * (ch - 6);
      // 网格线与刻度用同一个 top、同一条过渡，任何时刻都对得上
      if (gridRows[i]) gridRows[i].style.top = (((PAD_T + y) / H) * 100).toFixed(3) + '%';
      yTicks.push({ y: PAD_T + y, text: flowScale === 'pct' ? Math.round(v * 1000) / 10 + '%' : compact(v) });
    }
    // ── 曲线 ──
    // 按层 id 复用同一批 path：重画只换 d 与颜色，浏览器就能插值过渡。
    {
      // 配对：先按层 id 认领上一帧的元素（筛选、聚焦时 id 不变，形状就地变化）。
      // id 认不到的再按次序两两补位——典型是从「按来源」切到「按 Agent」，id 全换了，
      // 但同一种颜色的那条河流应当直接流到目标形状，而不是先降成 0 再升回来。
      const keep = new Set(shown.map((l) => l.id));
      const slots = shown.map((layer) => ({ layer, rec: pathEls.get(layer.id) || null }));
      const idle = [...pathEls].filter(([id]) => !keep.has(id)).map(([id, rec]) => ({ id, rec, adopted: false }));
      const free = slots.filter((s) => !s.rec);
      free.forEach((s, k) => { if (idle[k]) { s.rec = idle[k].rec; idle[k].adopted = true; } });
      // ① 真的不再画的层：先缓降到 0（保持自己的颜色），降完再淡掉、移除
      for (const { rec, adopted } of idle) {
        if (adopted) continue;                                  // 这具元素已被认领，别送走
        if (rec.columns !== cells.length) pin(rec.el, rec.values.length ? buildOne(resample(rec, cells.length), cells.length, rec.max) : null);
        rec.el.setAttribute('d', buildOne(new Array(cells.length).fill(0), cells.length, max));
        rec.timer = setTimeout(() => {
          rec.el.setAttribute('opacity', '0');   // 淡出交给样式表，不写内联
          rec.timer2 = setTimeout(() => {
            rec.el.remove();
            for (const [k2, v2] of pathEls) if (v2 === rec) pathEls.delete(k2);   // 被认领过的元素换了 key
          }, 200);
        }, FLOW_MS);
      }
      // ② 这次要画的层：形态对齐 → 换新 d。列数没变就能直接插值；变了先把旧形状重采样钉住。
      pathEls.clear();                                          // 下面按这一帧的 id 重新记账
      shown.forEach((layer, i) => {
        const color = COLORS[layer.colorIndex % COLORS.length];
        let rec = slots[i].rec;
        const fresh = !rec;
        if (fresh) {
          rec = { el: makePath(layer, ''), columns: cells.length, values: [], max: 1 };
        } else {
          // 刚从占比切回来：这具节点是被寄存的。先接回文档，再把旧形状钉住，
          // 顺序不能反——元素不在文档里时逼布局是没用的。
          if (!rec.el.isConnected) {
            pathsLayer.append(rec.el);
            pin(rec.el, rec.held || buildOne(new Array(cells.length).fill(0), cells.length, max));
          }
          if (rec.columns !== cells.length) pin(rec.el, rec.values.length ? buildOne(resample(rec, cells.length), cells.length, rec.max) : null);
        }
        // 次序：不动。同一帧里把节点摘下来重插（不管 append 还是 insertBefore），
        // 浏览器就把它当成新插入的元素，d 的过渡不会建立。而且叠放先后本来就不该每帧变。
        // 所以只追加（新层落在最后），已有节点永远留在原位——描边/填充谁压谁也随之稳定了。
        if (fresh) pathsLayer.append(rec.el);
        // 上一层刚被判“不画了”、正在降或正在淡，又被选回来了：先撤掉那两个定时器，
        // 否则几百毫秒后它会当着你的面消失。顺手清掉内联 transition（防御）：
        // 它会把样式表里那条 d 过渡整个顶掉。
        if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
        if (rec.timer2) { clearTimeout(rec.timer2); rec.timer2 = 0; }
        if (rec.el.style.transition) rec.el.style.transition = '';
        rec.el.style.opacity = '';
        // 新出现的层先从 0 起：这一帧必须在它挂进文档之后写，并逼一次布局，
        // 否则浏览器没有“之前的样子”，下面那行新 d 会直接落地 = 突然出现。
        if (fresh) {
          rec.el.setAttribute('d', buildOne(new Array(cells.length).fill(0), cells.length, max));
          void rec.el.getBoundingClientRect();
        }
        rec.el.setAttribute('d', paths[i]);
        rec.el.setAttribute('fill', color);
        rec.el.setAttribute('stroke', color);
        rec.el.setAttribute('fill-opacity', '.15');
        rec.el.setAttribute('stroke-width', '1.4');
        rec.el.setAttribute('opacity', '1');
        const tip = rec.el.querySelector('title');
        if (tip) tip.textContent = `${nameOf(layer.id)} · ${compact(layer.total)} Token`;   // 换了身份的要改名
        rec.columns = cells.length;
        rec.values = layer.values;
        rec.max = max;
        pathEls.set(layer.id, rec);
      });
    }
    // x 轴刻度按列中心摆（而不是数据点位置）：首尾两个刻度才不会把一半压在框外。
    const colW = cw / Math.max(1, cells.length);
    const step = Math.max(1, Math.ceil(cells.length / 9));
    // 跨天的小时轴：00:00 那格写日期（它就是上下两天的分界），其余写整点，
    // 否则「00:00」会在轴上连着出现好几次，看不出是第几天。
    // 步长按「总刻度数不超过 ~12」自己选：2–3 天每 6 小时一格，4 天每 12 小时，
    // 7 天就到 24 小时（一天一个日期，具体小时看悬停读数）。
    const multiDayHour = useHour && days.length > 1;
    const hourStep = multiDayHour
      ? ([6, 12, 24].find((s) => (24 / s) * days.length <= 12) || 24)
      : step;
    cells.forEach((c, i) => {
      if (useHour) {
        if (c.hour % hourStep) return;
        const text = multiDayHour && c.hour === 0 ? c.date.slice(5) : String(c.hour).padStart(2, '0') + ':00';
        xTicks.push({ x: PAD_L + i * colW + colW / 2, y: PAD_T + ch + 26, text });
        return;
      }
      if (i % step) return;
      xTicks.push({ x: PAD_L + i * colW + colW / 2, y: PAD_T + ch + 26, text: c.date.slice(5) });
    });

    // ── 悬停：竖直虚线 + 各层标记点 + 读数浮层 ──
    // 虚线跟着指针的 x 走，取值走插值，所以停在哪都能读出那个位置的值。
    span = Math.max(1, cells.length - 1);
    stepX = cw / span;
    // 悬停取值走同一套三次样条（见 ui/curve.mjs），所以读数和曲线永远对得上：
    // 停在两列之间时读的是曲线上那一点，而不是卡到整列。
    valueAt = (layer, fx) => splineValueAt(layer.values, fx);
    fmtValue = (v) => (flowScale === 'pct' ? (v * 100).toFixed(1) + '%' : compact(v));
    const hover = node('g', { class: 'tt-flow-hover' });
    vline = node('line', { y1: 0, y2: ch, stroke: 'var(--tt-t2)', 'stroke-width': 1, 'stroke-dasharray': '3 3', 'shape-rendering': 'crispEdges', opacity: 0 });
    hover.append(vline);
    dots = shown.map((layer) => node('circle', {
      r: 2.6, cx: 0, cy: 0,
      fill: COLORS[layer.colorIndex % COLORS.length], stroke: 'var(--tt-card)', 'stroke-width': 1, opacity: 0,
    }));
    for (const dot of dots) hover.append(dot);
    hoverLayer.append(hover);

    let lastPx = null, hudSide = 'right'; // 记住指针上一次的位置，用来判断滑向哪边
    hoverMove = (event) => {
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
    };
    if (hoverMove) chart.removeEventListener('mousemove', hoverMove);
    if (hoverLeave) chart.removeEventListener('mouseleave', hoverLeave);
    chart.addEventListener('mousemove', hoverMove);
    hoverLeave = clearHover;
    chart.addEventListener('mouseleave', hoverLeave);

    // 轴标签层：绝对定位盖在图上。viewBox 坐标换算成百分比，位置跟着图走。
    // 只换内容：y 轴三个标签复用常驻节点（位置过渡），x 轴日期每次重建（列数会变）。
    yTicks.forEach((t, i) => {
      const s = yLabelSpans[i];
      if (!s) return;
      s.textContent = t.text;
      s.style.left = ((PAD_L / W) * 100).toFixed(3) + '%';
      s.style.top = ((t.y / H) * 100).toFixed(3) + '%';
      s.style.transform = 'translate(calc(-100% - 8px),-50%)';
    });
    for (const s of axesBox.querySelectorAll('.tt-flow-xlab')) s.remove();
    for (const t of xTicks) {
      axesBox.append(h('span', {
        className: 'tt-flow-xlab',
        style: `left:${((t.x / W) * 100).toFixed(3)}%;top:${((t.y / H) * 100).toFixed(3)}%;transform:translate(-50%,-50%)`,
      }, t.text));
    }    const grand = (splittable ? [...totals.values()].reduce((s, v) => s + v, 0) : cellsTotal) || 1;
    legendBox.replaceChildren(
      ...ids.map((id, i) => h('button', {
        type: 'button',
        // 不用原生 title：它长得跟这套深色玻璃不搭，改用自带样式的说明（见 .tt-legend-tip）
        'aria-pressed': String(flowFocus.includes(id)),
        onClick: (event) => {
          flowFocus = pickValues(flowFocus, id, ids, modsOf(event), anchors.focus);
          anchors.focus = id;
          draw();
        },
      },
        h('span', { className: 'tt-legend-name' },
          h('i', { style: `background:${COLORS[i % COLORS.length]}` }),
          h('span', {}, nameOf(id))),
        h('b', {}, compact(totalOf(id))),
        h('span', { className: 'tt-legend-tip' },
          h('span', { className: 'tt-tip-head' },
            h('b', {}, nameOf(id)),
            splittable
              ? h('small', {}, `占总量 ${((totalOf(id) / grand) * 100).toFixed(1)}%`)
              : h('small', {}, '只有总量')),
          splittable ? h('small', {}, '点一下只看这一层 · Shift / Ctrl 点可多看几层 · 再点取消') : null))));
    // 叠加模式下各层独立成线，叠满不等于总量，页脚不能再那么写。
    const scaleNote = !splittable
      ? '按模型或供应商筛选时只显示总量'
      : solo
        ? `只看「${nameOf(solo.id)}」，纵轴已按这层重新缩放`
        : flowDimension === 'model' && ids.length === 1
          ? '只看所选模型自己的用量'
          : (flowScale === 'pct'
            ? '每条线是这一层占当列的比例，纵轴 0–100%'
            : (flowFocus.length > 1
              ? `各层独立成线，纵轴按所选的 ${flowFocus.length} 层里最高的一条缩放`
              : '各层独立成线，重叠处自然加深'));
    const lastCell = cells[cells.length - 1];
    foot.textContent = useHour
      ? `按小时 · ${cells[0].date}${lastCell.date === cells[0].date ? '' : ' → ' + lastCell.date} · 共 ${cells.length} 小时 · ${scaleNote}`
      : `${cells[0].date} → ${lastCell.date} · 共 ${cells.length} 天 · ${scaleNote}`;
  }

  function buildSwitch() {
    sw.replaceChildren();
    for (const [dim, label] of DIMS) {
      sw.append(h('button', { type: 'button', dataset: { dim }, 'aria-pressed': String(flowDimension === dim),
        onClick: () => { flowDimension = dim; flowFocus = ''; draw(); } }, label));
    }
    sw.append(h('span', { className: 'tt-flow-sep' }));
    for (const [sc, label] of [['abs', '绝对量'], ['pct', '占比']]) {
      sw.append(h('button', { type: 'button', dataset: { scale: sc }, 'aria-pressed': String(flowScale === sc),
        onClick: () => { flowScale = sc; draw(); } }, label));
    }
  }

  // 面板不再每次重建，改成外面拿到实例后调 update。
  function update(next, dayList, names) {
    agentNames = names || {};
    days = dayList || [];
    useHour = scaleFor(days) === 'hour' && next.heatmap.length > 0;
    cells = useHour ? hourCells(next.heatmap, days) : next.daily;
    // 有来源 / Agent 拆分就用它们；后端因为模型、供应商筛选把这两项撤掉时，改按模型看：
    // 供应商筛选下每格 models 仍然齐全（已按筛选过滤），所以各家模型自己的线加起来就是总量。
    canSplitKind = cells.some((c) => Object.keys(c.kinds || {}).length || Object.keys(c.agents || {}).length);
    hasModels = cells.some((c) => Object.keys(c.models || {}).length);
    DIMS = canSplitKind || !hasModels ? [['kind', '按来源'], ['agent', '按 Agent']] : [['model', '按模型']];
    buildSwitch();
    draw();
  }

  return { root: el, update };
}

const flowPanels = new WeakMap();   // container -> 常驻面板实例。换范围不能重建它，否则没有“从哪儿来”

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
  // KPI 块（合计 Token、日均…）也属于“读数”：里面要能选字，所以一块一块标上，
  // 块与块之间的缝不标 —— 那点缝是看板上剩下不多的拖拽落脚点。
  container.append(h('div', { className: 'tt-board-kpis' }, ...tiles.map(([label, value, hint]) =>
    h('div', { title: hint, 'data-tt-select': '' }, h('span', {}, label), h('strong', {}, value)))));
  if (!a) { empty(container, '小时分布尚未就绪，请稍后刷新。'); return; }
  // 全宽色带图：紧随 KPI，位于下面的细分图之前。它是唯一一张完整响应顶部时间范围的图。
  let flowPanel = flowPanels.get(container);
  if (!flowPanel) { flowPanel = createFlowPanel(); flowPanels.set(container, flowPanel); }
  // 顺序很重要：先把面板挂回容器，再更新内容。
  // 上面那句 replaceChildren 会把它整块摘下文档，而 update 里要改曲线的 d——
  // 元素不在文档里时写 d，浏览器就没有“之前的样子”，过渡不会建立（换日期看着就是硬跳）。
  // pin() 里那次逼布局同理，脱着文档时等于没逼。
  container.append(flowPanel.root);
  flowPanel.update(a, days, dashboard.agentNames || {});
  const totals = new Map();
  for (const day of a.daily) for (const [id, n] of Object.entries(day.models)) totals.set(id, (totals.get(id) || 0) + n);
  const allModels = [...totals].sort((x,y) => y[1]-x[1]).map(([id]) => id);
  const color = id => COLORS[Math.max(0, allModels.indexOf(id)) % COLORS.length];
  const selectModel = (id, event, ordered = allModels) => {
    const picked = pickValues(state.model, id, ordered, modsOf(event), anchors.model);
    anchors.model = id;
    patch({ model: picked });
  };
  const grid = h('div', { className: 'tt-board-grid' }); container.append(grid);
  const scale = scaleFor(days);
  const agent = panel('工作空间活跃分布', '当前按 Agent 归属 · 点击筛选', 'tt-agent-panel');
  const topRow = splitRow('boardTopSplit', '调整上方面板宽度', state, patch);
  const bottomRow = splitRow('boardBottomSplit', '调整下方面板宽度', state, patch);
  grid.append(topRow.row, bottomRow.row);
  if (!a.agents.length) empty(agent.body, '所选范围暂无 Agent 用量');
  // Agent 的小时拆分只有后端 canSplit 时才有（按模型 / 供应商筛选会整块撤掉），拿不到就退回按天。
  const agentHours = new Map();
  for (const c of a.heatmap) for (const [id, v] of Object.entries(c.agents || {})) {
    const key = `${id}/${c.date}/${c.hour}`;
    agentHours.set(key, (agentHours.get(key) || 0) + v);
  }
  const agentScale = scale === 'hour' && agentHours.size ? 'hour' : 'day';
  const agentSlots = timeSlots(days, agentScale);
  const agentValue = (item, s) => (agentScale === 'hour'
    ? (agentHours.get(`${item.id}/${s.key}`) || 0)
    : (item.days[s.date] || 0));
  const activityPeak = a.agents.reduce((peak, item) => agentSlots.reduce((max, s) => Math.max(max, agentValue(item, s)), peak), 0);
  const agentIds = a.agents.map((x) => x.id);   // Shift 整段加选的顺序：按这张表里从上到下的排列
  const intensityLabels = ['无用量', '低：低于峰值 1%', '较低：峰值 1%–5%', '中：峰值 5%–20%', '较高：峰值 20%–50%', '高：峰值 50% 及以上'];
  const unit = agentScale === 'hour' ? '小时' : '日';
  agent.body.append(h('div', { className: 'tt-agent-intensity-key', 'aria-label': `每${unit}用量强度图例：无用量和五档蓝色，同屏统一标尺` },
    h('span', {}, `${unit}用量`), h('span', {}, '无'),
    ...intensityLabels.map((label, level) => h('i', { 'data-intensity': level, title: `${label}；同屏最高${unit}用量 ${compact(activityPeak)} Token`, style: `background:var(--tt-activity-${level})` })), h('span', {}, '高'),
    h('span', { className: 'tt-agent-scale-note' }, '同屏统一标尺')));
  // 整张表按“块”标成可拖：手的落点大多不在那一条条小色块上，标细了就会“拖不动”。
  // 真正要选字的几列（名称/Token/占比）在下面单独标 data-tt-select，更近的那个赢。
  const agentList = h('div', { className: 'tt-agent-list', 'data-tt-pan': '', style: `--timeline-columns:${Math.max(1, agentSlots.length)}` }); agent.body.append(agentList);
  agentList.append(h('div', { className: 'tt-agent-axis' }, h('span', {}, '名称'), h('span', {}, 'Token'), h('span', {}, '占比'),
    h('span', { className: 'tt-agent-axis-dates', 'data-tt-pan': '' }, ...agentSlots.map((s, i) => h('small', { title: s.label }, slotLabel(s, i, agentSlots.length, agentScale))))));
  for (const item of a.agents) {
    const name = dashboard.agents.find(x => x.id === item.id)?.name || item.id;
    const cells = h('span', { className: 'tt-agent-cells', 'data-tt-pan': '', style: `grid-template-columns:repeat(${Math.max(1, agentSlots.length)},minmax(2px,1fr))` },
      ...agentSlots.map(s => {
        const value = agentValue(item, s), level = activityLevel(value, activityPeak);
        return h('i', { 'data-intensity': level, title: `${s.label} · ${compact(value)} Token · ${intensityLabels[level]}`, style: `background:var(--tt-activity-${level})` });
      }));
    agentList.append(h('button', { className: 'tt-agent-row', type: 'button', title: name, 'data-tt-pan': '',
      'aria-label': `筛选 Agent ${name}`, 'aria-pressed': String(asList(state.agent).includes(item.id)),
      onClick: (event) => {
        const picked = pickValues(state.agent, item.id, agentIds, modsOf(event), anchors.agent);
        anchors.agent = item.id;
        patch({ agent: picked });
      } },
      h('span', { className: 'tt-agent-name', 'data-tt-select': '' }, name), h('b', { 'data-tt-select': '' }, compact(item.totalTokens)),
      h('small', { 'data-tt-select': '' }, `${(item.totalTokens / Math.max(1,total) * 100).toFixed(1)}%`), cells));
  }
  agent.body.append(h('footer', {}, !days.length ? '暂无记录'
    : `${days[0]} — ${days.at(-1)} · ${agentScale === 'hour' ? '每小时一条' : '每日一条'}${scale === 'hour' && agentScale === 'day' ? ' · 该筛选下无小时级 Agent 拆分' : ''}`));

  const heat = panel('日活分布', '24 小时 × 日期', 'tt-heat-panel'); topRow.append(agent.el, heat.el);
  heat.el.querySelector('header').append(h('div', { className: 'tt-heat-legend', 'aria-label': '热力图图例：由少到多' },
    h('span', {}, '少'), ...[.12,.3,.5,.7,1].map(opacity => h('i', { style: `opacity:${opacity}` })), h('span', {}, '多')));
  const periods = [0,0,0,0]; for (const cell of a.heatmap) periods[Math.floor(cell.hour/6)] += cell.totalTokens;
  heat.body.append(h('div', { className: 'tt-time-bands' }, ...periods.map((n,i) => h('div', {},
    h('span', {}, ['凌晨 0–6','上午 6–12','下午 12–18','晚间 18–24'][i]), h('b', {}, fmtPct(n / Math.max(1,a.hourlyTotal) * 100,1))))));
  if (!a.heatmap.length || !days.length) empty(heat.body, '所选范围没有小时级记录');
  else {
    // 横轴 24 小时、纵轴日期，最新一天排在最上面（要翻更早的自己往下滚）。格子按可用宽度做成
    // 方块：这个面板是横长的，格子一旦被拉成细长条，深浅就看不出差别了。
    const byCell = new Map(a.heatmap.map(c => [`${c.date}/${c.hour}`, c.totalTokens]));
    const max = Math.max(1, ...a.heatmap.map(c => c.totalTokens));
    const grid = h('div', { className: 'tt-heat-grid', 'data-tt-pan': '' }, h('span', { className: 'tt-heat-corner' }),
      ...Array.from({ length: 24 }, (_, hour) => h('span', { className: 'tt-heat-hour' }, hour % 3 === 0 ? String(hour).padStart(2, '0') : '')));
    for (const date of [...days].reverse()) {
      grid.append(h('span', { className: 'tt-heat-day' }, date.slice(5)));
      for (let hour = 0; hour < 24; hour++) {
        const n = byCell.get(`${date}/${hour}`) || 0;
        const alpha = n ? .15 + .85 * Math.log1p(n) / Math.log1p(max) : .06;
        grid.append(h('i', { className: 'tt-heat-cell',
          style: `background:color-mix(in srgb, var(--tt-heat) ${(alpha * 100).toFixed(1)}%, transparent)`,
          title: `${date} ${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00 · ${compact(n)} Token` }));
      }
    }
    heat.body.append(h('div', { className: 'tt-heat-scroll', 'data-tt-pan': '' }, grid));
  }
  heat.body.append(h('footer', {}, `小时记录覆盖 ${fmtPct(a.hourlyTotal / Math.max(1,a.dailyTotal) * 100,1)} · ${a.timeZone || '日志本地时间'} · ${days.length} 天 · 最新在上`));

  const dist = panel('单轮请求大小分布', `会话轮次口径 · ${(a?.turnSize?.turnCount || 0).toLocaleString()} 轮`, 'tt-dist-panel');
  // 摘要是引擎侧算好的（次数 / P50 / P90 / 32 桶），前端不再搬明细自己算。
  const samples = a?.turnSize?.models || [];
  if (!samples.length) empty(dist.body, '该范围没有轮次明细');
  else {
    dist.body.append(h('div',{className:'tt-dist-head'},h('span',{},'模型 / 轮次'),h('span',{},'P50'),h('span',{},'P90'),h('span',{},'分布 · 横轴为 Token 对数')));
    const list = h('div', { className: 'tt-dist-list' }); dist.body.append(list);
    const shownSamples = samples.slice(0, 8);
    const shownIds = shownSamples.map((s) => s.id);   // Shift 整段加选的顺序：按这张表里从上到下的排列
    for (const sample of shownSamples) {
      const chart=svg(240,38,`${sample.id} 会话轮次分布`), d=pathFor(sample.bins,240,34,false,true);
      chart.append(node('path',{d:`${d} L240,38 L0,38 Z`,fill:color(sample.id),'fill-opacity':.23,stroke:color(sample.id),'stroke-width':1},[title(`${sample.count} 轮 · P50 ${compact(sample.p50)} · P90 ${compact(sample.p90)}`)]));
      list.append(h('button',{type:'button',className:'tt-dist-row',title:sample.id,
        'aria-pressed': String(asList(state.model).includes(sample.id)),
        onClick:(event)=>selectModel(sample.id,event,shownIds)},
        h('span',{},h('b',{},sample.id),h('small',{},`${sample.count.toLocaleString()} 轮`)),h('b',{},compact(sample.p50)),h('b',{},compact(sample.p90)),chart));
    }
  }
  dist.body.append(h('footer',{},'按一轮对话累计用量统计（含该轮的全部工具调用），不是单次 API 请求。'));

  const right=h('div',{className:'tt-board-right'});bottomRow.append(dist.el, right);
  const ridge=panel('0–24 时分布 · 按模型','每条曲线独立缩放 · 平滑显示');right.append(ridge.el);
  const hourModels=a.modelHours.slice(0,7);
  if (!hourModels.length) empty(ridge.body,'该范围暂无小时模型数据');
  else {
    const chart=svg(500,114,'各模型小时用量曲线');
    for (let i=0;i<=4;i++) { const x=12+i*118; chart.append(node('line',{x1:x,x2:x,y1:4,y2:90,stroke:'var(--tt-b2)','stroke-dasharray':'2 4'}));chart.append(node('text',{x,y:109,class:'tt-axis'},[String(i*6)])); }
    const ridgeIds = hourModels.map(m => m.id);   // Shift 整段加选的顺序：按曲线上画的顺序
    for (const model of hourModels) {
      const on = asList(state.model).includes(model.id);   // 选中的曲线加粗加重，多选后一眼看得出选了哪几条
      const path=node('path',{d:`${pathFor(model.hours,472,84,false,true)} L472,88 L0,88 Z`,transform:'translate(12,2)',fill:color(model.id),'fill-opacity':on?.3:.15,stroke:color(model.id),'stroke-width':on?2.2:1.4,tabindex:0,role:'button','aria-label':`筛选模型 ${model.id}`},[title(`${model.id} · ${compact(model.totalTokens)} Token`)]);
      path.addEventListener('click',(e)=>selectModel(model.id,e,ridgeIds));path.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectModel(model.id,e,ridgeIds);}});chart.append(path);
    }
    ridge.body.append(chart,legend(hourModels.map(m=>m.id),color,state.model,selectModel));
  }
  const daily=panel(scale === 'hour' ? '每小时模型用量比例' : '每日模型用量比例','柱高为总量 · 分段为模型占比');right.append(daily.el);
  const barSlots = timeSlots(days, scale);
  if (!barSlots.length) empty(daily.body, `所选范围暂无${scale === 'hour' ? '小时级' : '日'}汇总`);
  else {
    // 小时档的每格模型量取 heatmap（后端一直给 models）；天档取日汇总。
    const byHourModels = new Map(a.heatmap.map(c => [`${c.date}/${c.hour}`, c.models || {}]));
    const byDay = new Map(a.daily.map(d => [d.date, d]));
    const modelsAt = (s) => (scale === 'hour' ? (byHourModels.get(s.key) || {}) : (byDay.get(s.date)?.models || {}));
    const slotTotal = (s) => { const m = modelsAt(s); let n = 0; for (const id of Object.keys(m)) n += m[id] || 0; return n; };
    const max = Math.max(1, ...barSlots.map(slotTotal)), step = 480 / barSlots.length;
    const chart = svg(500, 118, '模型 Token 堆叠柱状图');
    barSlots.forEach((s, i) => {
      const models = modelsAt(s); let y = 90;
      for (const id of allModels) {
        const n = models[id] || 0; if (!n) continue;
        const height = n / max * 82; y -= height;
        const bar = node('rect', { x: 10 + i * step + 1, y, width: Math.max(1, step - 3), height, fill: color(id), rx: .8 }, [title(`${s.label} · ${id} · ${compact(n)} Token`)]);
        bar.addEventListener('click', () => patch({ range: 'all', from: s.date, to: s.date }));
        chart.append(bar);
      }
      const label = slotLabel(s, i, barSlots.length, scale);
      if (label) chart.append(node('text', { x: 10 + i * step + step / 2, y: 109, class: 'tt-axis', 'text-anchor': 'middle' }, [label]));
    });
    daily.body.append(chart,legend(allModels,color,state.model,selectModel,totals));
  }
  container.append(h('p',{className:'tt-board-note'},'数据来自 HanaAgent 本地日志汇总；图表沿用日志日期。模型颜色仅用于区分数据序列。'));
}
