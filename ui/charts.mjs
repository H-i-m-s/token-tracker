import { scaleText } from "./units.mjs";

export function drawSparkline(container, data, opts = {}) {
  if (!container) return null;
  const values = Array.isArray(data) ? data.filter((n) => Number.isFinite(n)) : [];
  if (!values.length) {
    container.innerHTML = "";
    return null;
  }

  const width = opts.width || 320;
  const height = opts.height || 40;
  const stroke = opts.stroke || "var(--tt-blue)";
  const strokeWidth = opts.strokeWidth || 1.5;
  const fill = opts.fill || "var(--tt-blue)";
  const fillOpacity = opts.fillOpacity ?? 0.10;
  const dot = opts.dot !== false;
  const padX = opts.padX ?? 2;
  const padY = opts.padY ?? 4;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values.map((v, i) => {
    const x = padX + (values.length <= 1 ? width / 2 : (i / (values.length - 1)) * (width - padX * 2));
    const y = height - padY - ((v - min) / span) * (height - padY * 2);
    return [x, y];
  });

  const polyline = points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const areaPath = `M${points[0][0]},${height} L${points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L")} L${points[points.length - 1][0]},${height} Z`;
  const last = points[points.length - 1];

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";

  const area = document.createElementNS(ns, "path");
  area.setAttribute("d", areaPath);
  area.setAttribute("fill", fill);
  area.setAttribute("fill-opacity", String(fillOpacity));
  svg.appendChild(area);

  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", polyline);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", String(strokeWidth));
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  if (dot && last) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(last[0].toFixed(1)));
    circle.setAttribute("cy", String(last[1].toFixed(1)));
    circle.setAttribute("r", String(opts.dotRadius || 2.5));
    circle.setAttribute("fill", opts.dotColor || "var(--tt-blue)");
    svg.appendChild(circle);
  }

  container.innerHTML = "";
  container.appendChild(svg);
  return svg;
}

// ── 区间趋势：面积 = 总 token（左轴），折线 = 缓存命中率（右轴 0~100%）──
// points: [{ t:unix秒, tokens:Number, hitRate:Number|null }]，按时间升序。
// opts.bucket 为官网给的粒度（86400 天 / 3600 小时），用来决定横轴标签的写法。
// 图表轴与卡片上的短数字，跟着设置里的数字单位走（中文「10亿」，英文「1B」）。
// trim：去掉多余的小数尾零，刻度上不留 1.00B 这种写法。
export const fmtTokensShort = (n) => scaleText(Number(n) || 0, { trim: true, plain: (v) => String(Math.round(v)) });

// 把一串 [x,y] 连成平滑曲线（单调三次插值，Fritsch–Carlson，转成三次贝塞尔）。
// 用它的原因：普通样条在数据起伏时容易“过冲”，画出数据里没有的谷和峰，
// 甚至跌到零线以下。单调插值保证曲线不越过相邻两点的取值区间。
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return "";
  if (n === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    slope[i] = dx[i] === 0 ? 0 : (ys[i + 1] - ys[i]) / dx[i];
  }
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;                                   // 拐点处切线放平，反而不出过冲
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = xs[i] + dx[i] / 3, c1y = ys[i] + (m[i] * dx[i]) / 3;
    const c2x = xs[i + 1] - dx[i] / 3, c2y = ys[i + 1] - (m[i + 1] * dx[i]) / 3;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}

// 横轴刻度文字。小时桶默认只写「时:00」；如果这串点跨了天（比如看了眼两天），
// 光写小时会出现 00:00 / 23:00 / 00:00 这种看不出先后的标签，这时把日期带上。
export function bucketLabel(t, bucket, opts = {}) {
  const d = new Date(t * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  if (bucket === 3600) {
    const hm = p2(d.getHours()) + ":00";
    return opts.withDate ? p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + hm : hm;
  }
  return p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

export function drawUsageChart(container, points, opts = {}) {
  if (!container) return null;
  const rows = Array.isArray(points) ? points.filter((d) => d && Number.isFinite(d.t)) : [];
  container.innerHTML = "";
  if (rows.length < 2) {
    container.appendChild(Object.assign(document.createElement("div"), { className: "tt-empty", textContent: "数据不足，至少需要两个点" }));
    return null;
  }
  const bucket = opts.bucket || 86400;
  // 小时桶跨天时必须带日期，否则刻度看不出前后
  const dayOf = (t) => { const d = new Date(t * 1000); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
  const withDate = bucket === 3600 && dayOf(rows[0].t) !== dayOf(rows[rows.length - 1].t);
  const lbl = (t) => (opts.labelFmt ? opts.labelFmt(t) : bucketLabel(t, bucket, { withDate }));

  // 图形照固定的「设计尺寸」画，靠 viewBox 铺满容器：界面变宽时图形横向铺开，
  // 竖向不动。所有文字都放在 HTML 层（见下面的 .tt-ds-axes），是普通 CSS px，
  // 既不缩放，也不需要“每变宽一帧就重画整张图”——那正是拖侧边栏时抽搐的来源。
  const width = opts.width || 680;
  const height = opts.height || 190;
  const padL = 46, padR = 46, padT = 14, padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const tokens = rows.map((d) => Number(d.tokens) || 0);
  const rawMax = Math.max(...tokens, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const niceMax = Math.ceil(rawMax / mag * 4) / 4 * mag;
  const xAt = (i) => padL + (i / (rows.length - 1)) * plotW;
  const yTok = (v) => padT + plotH - (v / niceMax) * plotH;
  const yHit = (p) => padT + plotH - (Math.max(0, Math.min(100, p)) / 100) * plotH;

  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", preserveAspectRatio: "none" });
  svg.style.width = "100%"; svg.style.height = "100%"; svg.style.display = "block";
  // 文字层：位置用百分比跟着 viewBox 走（同一套坐标，铺满后自然对齐），字号是 CSS px。
  const axes = document.createElement("div");
  axes.className = "tt-ds-axes";
  const put = (x, y, text, anchor = "end", color = "", kind = "y") => {
    const s = document.createElement("span");
    s.textContent = text;
    s.className = "tt-ds-" + kind + "lab";
    s.style.left = ((x / width) * 100).toFixed(3) + "%";
    s.style.top = ((y / height) * 100).toFixed(3) + "%";
    s.style.transform = anchor === "end" ? "translate(-100%,-50%)" : anchor === "middle" ? "translate(-50%,-50%)" : "translate(0,-50%)";
    if (color) s.style.color = color;
    axes.appendChild(s);
    return s;
  };

  // 横向网格 + 左轴 token 刻度
  for (let i = 0; i <= 3; i++) {
    const y = padT + (i / 3) * plotH;
    svg.appendChild(el("line", { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: "var(--tt-b3, #efede8)", "stroke-width": 1, "stroke-dasharray": i === 3 ? "0" : "2 4", "vector-effect": "non-scaling-stroke" }));
    put(padL - 6, y, fmtTokensShort(niceMax * (1 - i / 3)));
  }

  // 面积：平滑曲线封到底以后填充
  const line = smoothPath(rows.map((d, i) => [xAt(i), yTok(tokens[i])]));
  const areaD = `${line} L${xAt(rows.length - 1)},${padT + plotH} L${xAt(0)},${padT + plotH} Z`;
  svg.appendChild(el("path", { d: areaD, fill: opts.areaColor || "var(--tt-blue, #4a7fe0)", "fill-opacity": 0.16 }));
  svg.appendChild(el("path", { d: line, fill: "none", stroke: opts.areaColor || "var(--tt-blue, #4a7fe0)", "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));

  // 命中率折线（跳过 null）。同样平滑，用虚线跟总量的实线区分开。
  let seg = [];
  const flushSeg = () => {
    if (seg.length >= 2) svg.appendChild(el("path", { d: smoothPath(seg), fill: "none", stroke: opts.rateColor || "var(--tt-green, #35c07d)", "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": "4 3", "vector-effect": "non-scaling-stroke" }));
    seg = [];
  };
  rows.forEach((d, i) => {
    const p = d.hitRate;
    if (p == null || !Number.isFinite(p)) { flushSeg(); return; }
    seg.push([xAt(i), yHit(p)]);
  });
  flushSeg();

  // 右轴：命中率刻度
  for (const p of [0, 50, 100]) put(padL + plotW + 6, yHit(p), p + "%", "start", "var(--tt-green, #35c07d)", "y2");

  // X 轴：跨天的小时图把刻度落在每天的 0 点，天数一眼可见；其余情况均匀取 4 个位置。
  let marks;
  if (bucket === 3600 && withDate) {
    const dayStarts = [];
    rows.forEach((r, i) => { if (new Date(r.t * 1000).getHours() === 0) dayStarts.push(i); });
    if (dayStarts.length >= 2) {
      const c = Math.min(3, dayStarts.length);
      const pick = [];
      for (let j = 0; j < c; j++) pick.push(dayStarts[c === 1 ? 0 : Math.round(j * (dayStarts.length - 1) / (c - 1))]);
      marks = [...pick, rows.length - 1];
    }
  }
  if (!marks) marks = [0, Math.round((rows.length - 1) / 3), Math.round((rows.length - 1) * 2 / 3), rows.length - 1];
  const seen = new Set();
  const usedX = [];
  for (const i of marks) {
    if (seen.has(i)) continue;
    seen.add(i);
    // 标签太密就跳过，宁缺勿挤
    const x = xAt(i);
    if (usedX.length && x - usedX[usedX.length - 1] < 54) continue;
    usedX.push(x);
    put(x, height - 7, lbl(rows[i].t), i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle", "", "x");
  }

  container.appendChild(svg);
  container.appendChild(axes);
  return svg;
}

export function drawRing(container, opts = {}) {
  if (!container) return null;

  const size = opts.size || 44;
  const strokeWidth = opts.strokeWidth || 4;
  const percent = Math.max(0, Math.min(100, Number(opts.percent) || 0));
  const color = opts.color || "var(--tt-blue)";
  const bgColor = opts.bgColor || "var(--tt-empty)";
  const showText = opts.showText !== false;
  const text = opts.text !== undefined ? String(opts.text) : `${Math.round(percent)}%`;
  const textColor = opts.textColor || color;

  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const dash = (percent / 100) * c;
  const offset = c - dash;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";

  const bg = document.createElementNS(ns, "circle");
  bg.setAttribute("cx", String(size / 2));
  bg.setAttribute("cy", String(size / 2));
  bg.setAttribute("r", String(r));
  bg.setAttribute("fill", "none");
  bg.setAttribute("stroke", bgColor);
  bg.setAttribute("stroke-width", String(strokeWidth));
  svg.appendChild(bg);

  const fg = document.createElementNS(ns, "circle");
  fg.setAttribute("cx", String(size / 2));
  fg.setAttribute("cy", String(size / 2));
  fg.setAttribute("r", String(r));
  fg.setAttribute("fill", "none");
  fg.setAttribute("stroke", color);
  fg.setAttribute("stroke-width", String(strokeWidth));
  fg.setAttribute("stroke-linecap", "round");
  fg.setAttribute("stroke-dasharray", String(c));
  fg.setAttribute("stroke-dashoffset", String(offset));
  fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  svg.appendChild(fg);

  if (showText) {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", String(size / 2));
    t.setAttribute("y", String(size / 2));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "central");
    t.setAttribute("font-family", "var(--font-sans)");
    t.setAttribute("font-size", String(opts.fontSize || size * 0.28));
    t.setAttribute("font-weight", "700");
    t.setAttribute("fill", textColor);
    t.textContent = text;
    svg.appendChild(t);
  }

  container.innerHTML = "";
  container.appendChild(svg);
  return svg;
}
