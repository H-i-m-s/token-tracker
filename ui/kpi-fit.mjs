// KPI 卡的字号一律算出来，样式里不出现任何一个写死的 px 字号。
//
// 原来的写法是 clamp(40px, 33cqi, 110px)：33cqi 是比例，但前后两个数是硬上下限。
// 卡片一旦越过上限，字就不再跟着长 —— 收起侧边栏后左列被分到一大片宽度，
// 数字停在 110px 不动，多出来的宽度只能变成右侧那片空白。
// cqi 能表达「和宽度成比例」，表达不了「这段文字刚好装进这个框」。
//
// 这里的做法：把这段文字按 100px 量一次真实宽度与墨迹高度，两者都随字号线性变化，
// 按可用框反解一次就是答案 —— 不二分、不试探、一次成型。
//
// 两种约束方向（卡片上的 --tt-fit-mode）：
//
//   both    宽高取小。尺寸由栅格 / aspect-ratio 定死的格子都用这个。
//
//   ratio   数字 = 标签 × 比例。用于扁长条（三级）：条子太矮，
//           按框反解会把数字撑到比标签大三倍，三级的层级就没了。
//
// 主数卡也用 both。早期曾让它“宽度跟字走”（auto 列），那在数学上是个环：
//   宽 → 字 → 高 → 右列宽 → 主卡宽，四个环节首尾相接，字会一路长到溢出或塔成零。
// 实测就是这样塔的：主卡夹成 22px、字号 0。让它跟格子卡一样两头都由外部定，环就断了。
//
// 一排里几张卡还要对齐：同一行内取它们各自算出的最小值统一写回，否则同一层级里
// 数字大一个小一个（短文本“1.2 K”会比“32.0%”大一圈），看着就不是一套字。
//
// 标签字号不跟数字走，否则「标签高 → 数字框高 → 数字字号 → 标签字号」会自己转起来。
// 而标签只按卡宽取比例（--tt-label-w）：卡的宽度永远由栅格/容器决定，
// 不会被字反推回去 —— 这条路是单行道，不存在振荡。
// （早期版本让主数卡与长条按卡高取，但卡片视图里高度是内容撑的，
//   于是“高定字、字定高”又成环，所以统一改成宽度制。）
//
// 所有「占多少」都是比例（--tt-label-w / --tt-fit-w / --tt-fit-h / --tt-fit-floor），不是字号。

const PROBE_PX = 100;
// 改动小于这个值就不写回：回调里反复改样式会把自己再叫起来。
const EPSILON = 0.15;

let probe = null;

function num(style, name) {
  const n = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(n) ? n : 0;
}

function ratio(style, name, fallback) {
  const n = num(style, name);
  return n > 0 ? n : fallback;
}

// 用真的元素量，不用 canvas。
// canvas 的 measureText 与浏览器排版有两处对不上：字距的累加方式、子像素舍入，
// 实测相差能到 8%（448px 的框里算出 325px 的字宽）——
// 字就被算大，然后再超出去。探针元素走的就是真正那套排版，没有这个差。
function probeEl() {
  if (probe && probe.isConnected) return probe;
  probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  // pre 而不是 nowrap：nowrap 仍会折叠连续空格，pre 量的才是真实排版宽度。
  probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;white-space:pre;display:inline-block;line-height:1;margin:0;padding:0;border:0;';
  document.body.append(probe);
  return probe;
}

// 按 100px 排一次，返回宽度与行盒高度。
// 字距是 em 单位，换算回 100px 再量，结果才能等比放大到任意字号。
function metrics(text, style) {
  if (!text) return null;
  const el = probeEl();
  const size = parseFloat(style.fontSize) || 16;
  const tracking = num(style, 'letter-spacing');
  const trackingEm = size > 0 ? tracking / size : 0;

  el.style.fontFamily = style.fontFamily || 'sans-serif';
  el.style.fontWeight = style.fontWeight || '400';
  el.style.fontStyle = style.fontStyle || 'normal';
  el.style.fontStretch = style.fontStretch || 'normal';
  el.style.letterSpacing = `${(trackingEm * PROBE_PX).toFixed(3)}px`;
  el.style.fontSize = `${PROBE_PX}px`;
  el.textContent = text;

  const rect = el.getBoundingClientRect();
  // 字宽为 0（未挂载、字体未就绪）时返回 null，让调用方跳过这一轮而不是写个 0 进去。
  if (!(rect.width > 0)) return null;
  return { width: rect.width, inkHeight: rect.height || PROBE_PX * 0.72, lineHeight: rect.height || PROBE_PX };
}

// 反解出来的字宽与实测字宽有 1~2px 的系统偏差（子像素舍入、字距累积）。
// 留这一点余量，避免贴着框边的情况被判成溢出。
const WIDTH_SAFETY = 0.985;

function setFontSize(el, size, lineHeight = '1') {
  if (!Number.isFinite(size) || size <= 0) return;
  const changed = Math.abs((parseFloat(el.style.fontSize) || 0) - size) > EPSILON;
  if (changed) el.style.fontSize = `${size.toFixed(2)}px`;
  // 行高必须单独给：标签是中文，字形上下都顶到字框外，
  // line-height:1 会把字的顶部和底部裁掉一截（二级卡标题就是这么被遮的）。
  if (changed || el.style.lineHeight !== lineHeight) el.style.lineHeight = lineHeight;
}

function fitCard(card, blockW) {
  const kids = [...card.children];
  const value = kids.find((el) => el.tagName === 'STRONG');
  const label = kids.find((el) => el.tagName === 'SPAN');
  if (!value) return;

  const text = (value.textContent || '').trim();
  if (!text) return;

  const cardStyle = getComputedStyle(card);
  const cardW = card.clientWidth;
  const cardH = card.clientHeight;
  // 隐藏的模块（页签没选中）量到的都是 0：这时写 0px 会把字压没。
  // 等它重新显示，ResizeObserver 会再叫一次。
  if (cardW <= 0 || cardH <= 0) return;

  const mode = cardStyle.getPropertyValue('--tt-fit-mode').trim() || 'both';

  // ① 标签：整块 KPI 共用一个基准（--tt-label-base × 整块宽），不是每张卡自己算。
  //    为什么要上提到整块：以前每张卡乘自己的卡宽比例，于是同一个层级里
  //    二级与三级差 1px（三级卡更宽但比例低），同一排的字看着就不是一套。
  //    标签是“说明”，不参与自适应；只有数值随卡片尺寸走。
  let labelSize = 0;
  if (label) {
    const base = num(cardStyle, '--tt-label-base');
    if (base > 0 && blockW > 0) {
      labelSize = blockW * base;
    } else {
      // 兜底：没拿到整块宽时退回按本卡宽算（--tt-label-h 优先，横排长条用它）。
      const byH = num(cardStyle, '--tt-label-h');
      labelSize = byH > 0 ? cardH * byH : cardW * ratio(cardStyle, '--tt-label-w', 0.09);
    }
    const labelText = (label.textContent || '').trim();
    if (labelText) {
      const lm = metrics(labelText, getComputedStyle(label));
      // 标签不许宽过卡内框：比例算得再大也得先装得下。
      if (lm && lm.width > 0) labelSize = Math.min(labelSize, (cardW * 0.92 * PROBE_PX) / lm.width);
    }
    // 行高 1.28：中文字形上下都伸到字框外，行高给到 1 会被裁掉顶和底（二级标题就是这么被遮的）。
    setFontSize(label, labelSize, '1.28');
  }

  // ② 扁长条：数字跟标签成比例，不去填满整条。
  if (mode === 'ratio') {
    const vr = ratio(cardStyle, '--tt-value-ratio', 1.45);
    let size = (labelSize || cardW * 0.06) * vr;
    // 比例是期望值，不是免死金牌：标签很长（“平均每轮”）时，数字可能被挤出去。
    // 这里再用剩下那点宽度封一次顶 —— 数字先不被切，标签才去省略。
    const lm2 = metrics((label?.textContent || '').trim(), label ? getComputedStyle(label) : cardStyle);
    const labelW = lm2 && lm2.width > 0 ? (labelSize * lm2.width) / PROBE_PX : 0;
    const room = cardW - num(cardStyle, 'padding-left') - num(cardStyle, 'padding-right') - labelW - 10;
    const vm = metrics(text, getComputedStyle(value));
    if (room > 0 && vm && vm.width > 0) size = Math.min(size, (room * WIDTH_SAFETY * PROBE_PX) / vm.width);
    setFontSize(value, size);
    return;
  }

  // ③ 竖向块：写完标签再量数字框，否则拿到的是旧行高下的高度。
  const boxW = value.clientWidth;
  const boxH = value.clientHeight;
  if (boxW <= 0 || boxH <= 0) return;

  const m = metrics(text, getComputedStyle(value));
  if (!m || !(m.width > 0) || !(m.inkHeight > 0)) return;

  const fillW = ratio(cardStyle, '--tt-fit-w', 1);
  const fillH = ratio(cardStyle, '--tt-fit-h', 0.94);
  // 宽与高两个方向各自反解，取小。
  // 宽度：boxW 已经是数字框的可用宽（flex 子项，已扣掉隔壁元素与 gap）。
  // 高度：boxH 是行盒高，而字的高度只占行的 ~72%（上下还留了行距），
  //   所以拿 inkHeight 直接算会把字算得比框小而白白浪费高度 —— 这里用行高而非墨迹高。
  const byW = (boxW * WIDTH_SAFETY * PROBE_PX) / m.width;
  const byH = (boxH * fillH * PROBE_PX) / m.lineHeight;
  // 三种取法（--tt-fit-mode）：
  //   width  只看宽度。卡片视图里高被压得很矮，若看高度就会把主数压成和二级一样大。
  //   height 只看高度。
  //   both   取小（默认）。
  const mode2 = cardStyle.getPropertyValue('--tt-fit-mode').trim() || 'both';
  let size = mode2 === 'width' ? byW : mode2 === 'height' ? byH : Math.min(byW, byH);
  if (fillW < 1) size = Math.min(size, (boxW * fillW * PROBE_PX) / m.width);

  // 防崩底线：字小到读不出来时按卡宽占一个比例兜住，不让它继续缩。
  const floor = cardW * ratio(cardStyle, '--tt-fit-floor', 0.05);
  setFontSize(value, Math.max(size, floor));
}

// 同一行里的块状卡（二级）字号要一致：取这排算出的最小值统一写回。
// 不统一的话，「1.2 K」这种短文本会比「32.0%」大一圈，同一层级看着就是两套字。
// 只处理块状卡：长条走 ratio、主数卡独占一行，都没有这个问题。
function unifyRow(row) {
  if (!row) return;
  const values = [...row.children]
    .filter((card) => card.classList.contains('tt-kpi') && !card.classList.contains('tt-kpi-strip'))
    .map((card) => card.querySelector('strong'))
    .filter(Boolean);
  if (values.length < 2) return;
  const sizes = values.map((el) => parseFloat(el.style.fontSize)).filter((n) => Number.isFinite(n) && n > 0);
  if (sizes.length < 2) return;
  const min = Math.min(...sizes);
  for (const el of values) setFontSize(el, min);
}

export function fitKpiCards(root) {
  if (!root?.querySelectorAll) return;
  // 整块宽度：所有标签共用一个基准，所以要先把块宽量好再分工算。
  // root 自己可能就是 .tt-board-kpis（调用方直接传块进来），而 querySelector
  // 只搜后代、不搜自身 —— 上一版漏了这一条，基准恒为 0，标签退回逐卡算，
  // 于是同一排里 43 / 20 / 27 各不相同。这里用 matches 兼容“传的就是块”。
  const block = root.matches?.('.tt-board-kpis') ? root : root.querySelector('.tt-board-kpis');
  const blockW = block ? block.clientWidth : 0;
  const scope = block || root;
  for (const card of scope.querySelectorAll('.tt-kpi')) fitCard(card, blockW);
  // 单张算完再拉平：拉平只改字号，字号不参与卡尺寸，不会再反过来。
  for (const row of scope.querySelectorAll('.tt-kpi-row-secondary')) unifyRow(row);
}

// 一块看板里的 KPI 卡共用一个观察器：卡尺寸变了就重算。
// 卡尺寸全部来自栅格，改字号不会反过来改卡尺寸，不会自激。
const observers = new WeakMap();

export function installKpiFit(root) {
  if (!root) return;
  // 卡片视图会把 .tt-board-kpis 从看板里摸出来、移进标题那一行，
  // 所以不能只看 root 的直接层，要跨层找；一块里面只有一个 KPI 区。
  const block = root.querySelector('.tt-board-kpis');
  if (!block) return;

  let pending = 0;
  const run = () => {
    pending = 0;
    fitKpiCards(block);
  };
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(run);
  };

  observers.get(root)?.disconnect();
  const observer = new ResizeObserver(schedule);
  observer.observe(block);
  for (const card of block.querySelectorAll('.tt-kpi')) observer.observe(card);
  observers.set(root, observer);

  // 首帧先算一次：ResizeObserver 第一次回调是异步的，不等它，
  // 数字会先按样式里的兜底比例闪一下再跳到正确大小。
  run();
  // 字体没就绪时量出来的宽度偏窄（回退字体的度量不一样），
  // 等字备好再算一次，避免数字偏大一点点。
  document.fonts?.ready?.then(schedule);
}
