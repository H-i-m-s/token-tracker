// 曲线的几何：三次样条（Fritsch–Carlson 单调样条）+ 一元三次 Hermite 取值。
//
// 为什么不用「每个点切线拉平」的中点贝塞尔：那种曲线不过冲，但每个峰都塌成圆顶，
// 点一密就像一串珠子。改成切线由相邻点决定之后，形状连续得多，峰谷处仍然停住。
// 限制切线大小的那一步（Fritsch–Carlson）是必须的：普通三次样条会在尖峰旁边
// 冲过头，把曲线压到基线以下，或者造出数据里根本没有的峰。
//
// 控制点一律放在 x 的 1/3、2/3 处，于是 x(t) 严格线性，
// 反解某个 x 处的值只要一步除法（绘制和悬停读数因此共用同一套几何）。

// 等距采样下，各点的切线（单位：y 每单位 x）。dx 可以为负（堆叠图的下边界从右往左画）。
export function splineTangents(ys, dx = 1) {
  const n = ys.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const s = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) s[i] = (ys[i + 1] - ys[i]) / dx;
  if (n === 2) {
    m[0] = m[1] = s[0];
    return m;
  }
  for (let i = 1; i < n - 1; i++) {
    // 极值点、平段、符号翻转：切线拉平，曲线在峰谷处停住而不是冲过去
    if (s[i - 1] === 0 || s[i] === 0 || Math.sign(s[i - 1]) !== Math.sign(s[i])) {
      m[i] = 0;
      continue;
    }
    m[i] = 2 / (1 / s[i - 1] + 1 / s[i]);      // 等距时是两侧斜率的加权调和平均
  }
  const end = (near, far) => {
    let v = (3 * near - far) / 2;              // 三点单侧差分
    if (Math.sign(v) !== Math.sign(near)) v = 0;
    else if (Math.sign(near) !== Math.sign(far) && Math.abs(v) > 3 * Math.abs(near)) v = 3 * near;
    return v;
  };
  m[0] = end(s[0], s[1]);
  m[n - 1] = end(s[n - 2], s[n - 3]);
  return m;
}

// 一元三次 Hermite（t ∈ [0,1]）：两端点的值与切线决定这一段。
export function hermiteAt(v0, v1, m0, m1, t) {
  const h = 1 - t;
  return h * h * h * v0 + 3 * h * h * t * (v0 + m0 / 3) + 3 * h * t * t * (v1 - m1 / 3) + t * t * t * v1;
}

// 把一串点连成「M 起点 + 每段一个 C」——命令结构与段数一一对应，
// 列数不变时浏览器可以直接在两串 d 之间做过渡。
export function splineCurve(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const dx = pts[1][0] - pts[0][0];
  const m = splineTangents(pts.map((p) => p[1]), dx);
  let d = '';
  for (let i = 1; i < n; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], c = dx / 3;
    d += ` C${x0 + c},${y0 + m[i - 1] * c} ${x1 - c},${y1 - m[i] * c} ${x1},${y1}`;
  }
  return d;
}

// 某个浮点位置（x 以「列」为单位、可带小数）上的值。与 splineCurve 同一套几何。
export function splineValueAt(values, fx) {
  const n = values.length;
  if (!n) return 0;
  const a = Math.max(0, Math.min(n - 1, Math.floor(fx)));
  const b = Math.min(n - 1, a + 1);
  if (a === b) return values[a];
  const m = splineTangents(values, 1);
  return hermiteAt(values[a], values[b], m[a], m[b], Math.max(0, Math.min(1, fx - a)));
}
