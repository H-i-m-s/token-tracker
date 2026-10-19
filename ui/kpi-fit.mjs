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

// 数值节点的「逻辑文字」。
// 一旦接上 digit-roll.mjs，strong 里就不再是一段文本，而是若干开窗格 + 带子：
// textContent 会变成 “9876543210…” 拼成的串，拿它反解字号会把 10 个字符当显示宽度，
// 字直接被塔到地板。逻辑值一律从 data-tt-value 读。
function valueTextOf(el) {
  if (!el) return '';
  const v = el.dataset?.ttValue;
  return v !== undefined ? v : (el.textContent || '');
}

// 数值的字距一律按 0 量。
// .tt-num 上的 letter-spacing 被写作 0（负字距会把字从 1ch 的小窗里挤出去、
// 被 overflow:hidden 削掉半边），而 strong 自己还带着 -.03em / -.045em。
// 拿 strong 的算出来的宽比真实排版窄，按它反解出的字号会偏大，字就顶出框。
const NO_TRACKING = 0;

// 数值的「墨迹包围盒」。
// 不能用 Range.selectNodeContents：它不认 overflow:hidden，
// 会把整条 9…0 的带子算进去（那是 10 个字高），得到的是一条竖着的长条。
// 改成量可见的那几段（.tt-num / .tt-unit）的并集。
function valueInkRect(value) {
  const parts = [...value.children].filter((el) =>
    el.classList.contains('tt-num') || el.classList.contains('tt-unit'));
  if (!parts.length) {
    const r = document.createRange();
    r.selectNodeContents(value);
    return r.getBoundingClientRect();
  }
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const p of parts) {
    if (p.hidden) continue;
    const r = p.getBoundingClientRect();
    if (!(r.width > 0) && !(r.height > 0)) continue;
    left = Math.min(left, r.left); right = Math.max(right, r.right);
    top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
  }
  if (!Number.isFinite(left)) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

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
function metrics(text, style, trackingPx = null) {
  if (!text) return null;
  const el = probeEl();
  const size = parseFloat(style.fontSize) || 16;
  const tracking = trackingPx === null ? num(style, 'letter-spacing') : trackingPx;
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

// 标题与数字：共用一条左沿，整组再居中。
// 组宽取两者墨迹宽的大者：谁更宽就以谁为准，另一个跟过去。
// 用 translateX 而非 margin/padding 做位移：后者会挤掉元素自身的可用宽，
// 宽一变，字号与换行都跟着变，实测因为这一点差了 16~24px。
// scope 是尺寸基准（普通卡就是卡本身；主卡双列传列容器）——
// 按整卡宽算会把列内元素推出去。
function alignLabelToValue(card, label, value, scope) {
  if (!label || !value) return;
  const box = scope || card;
  const cardStyle = getComputedStyle(card);
  const ownStyle = box === card ? cardStyle : getComputedStyle(box);
  // 内容区宽度用 clientWidth（不含边框）；
  // 用 getBoundingClientRect 会把边框算进去，导致内容区左沿偏右 1px，
  // 再夹紧时就把数字框误判成“出界”（探针之前就是这么误报的）。
  const innerW = box.clientWidth - num(ownStyle, 'padding-left') - num(ownStyle, 'padding-right');
  if (!(innerW > 0)) return;
  const labelNode = label.firstChild;
  if (!labelNode || labelNode.nodeType !== 3) return;

  const vInk = valueInkRect(value);
  const rl = document.createRange();
  rl.selectNodeContents(label);

  // 先归一化：把上一次写的 translateX 清掉再量。
  // 不清就会拿“已位移的位置”再算偏移，且旧的 transform 会留在 DOM 里
  // 把元素推出可见区（实测“会话数”“预估费用”两格就残留了出界的位移）。
  if (label.style.transform) label.style.transform = '';
  if (value.style.transform) value.style.transform = '';

  const lInk = rl.getBoundingClientRect();
  // transform 只平移不缩放，所以墨迹宽度不受它影响，反复调用也稳定（幂等）。
  if (!(vInk.width > 0) || !(lInk.width > 0)) return;

  const groupW = Math.max(vInk.width, lInk.width);
  const groupLeft = (innerW - groupW) / 2;
  // 数字现在是居中摆的：居中时它的墨迹左沿在 (innerW - 数字宽)/2。
  // 要它落到组的左沿，差的这一段就是它该平移的量（下面会按能否位移重新赋值）。
  const vInkLeftNow = (innerW - vInk.width) / 2;
  const EDGE = 2;
  // 关键：translateX 作用在 strong 的“元素框”上，而它几乎撑满内容区。
  // 只要框比内容区窄不到 2*EDGE，任何位移都会把框推出边界 —— 墨迹没出界也没用，
  // overflow:hidden 是拿框去裁的。这种情况下不动数字，只把标签对到数字上。
  const vBoxW = value.getBoundingClientRect().width;
  const boxFills = vBoxW >= innerW - 2 * EDGE;
  let valueShift = 0;
  let labelShift = groupLeft;
  if (!boxFills) {
    const lo = EDGE - vInkLeftNow;
    const hi = innerW - vInk.width - vInkLeftNow - EDGE;
    valueShift = hi >= lo ? Math.min(hi, Math.max(lo, groupLeft - vInkLeftNow)) : 0;
    labelShift = vInkLeftNow + valueShift;   // 标签跟着数字的实际左沿走
  } else {
    // 框撑满时数字不能动，但标签仍要对到数字墨迹的左沿；
    // 写 groupLeft 会让标签居中到组中心，与数字错开（实测「合计 Token」比数字右缩了 100px）。
    labelShift = vInkLeftNow;
  }

  // 标签也必须夹紧：它同样在 overflow:hidden 的卡里，推出去就按框裁掉。
  // 以前只给数字算 lo/hi，标签是赤裸裸写的，于是窄卡上「预估费用 · USD」被削成
  // 「预估费用 · U」——实测 1430px 还好（不越界），到 960px 就超出 5px，720px 超出 16.8px。
  // 夹紧的目的是“标签完整可读”，它的优先度高过“标签与数字共左沿”：
  // 宁可标题偏一点，也不能把字截掉。
  // 注意这里比的是「相对内容区左沿的位移量」，而 lInk/ vInk 是视口坐标，
  // 所以上限直接用 innerW。EDGE 是留给抗锯齿的余量。
  const labelMax = innerW - lInk.width - EDGE;   // 标签不再位移时左沿为 0
  if (labelShift > labelMax) labelShift = Math.max(0, labelMax);

  const lt = `translateX(${labelShift.toFixed(2)}px)`;
  if (label.style.transform !== lt) label.style.transform = lt;
  const vt = Math.abs(valueShift) < 0.05 ? '' : `translateX(${valueShift.toFixed(2)}px)`;
  if (value.style.transform !== vt) value.style.transform = vt;
}

// 三级条的标签与数字横排在同一行，但“框对齐”不等于“看着对齐”：
// 中文占满 em 框（上下都有墨），数字只到 cap 高度（基本只在基在线），
// 行盒居中后两者墨迹中心就差了一截（实测 6~10px）。
// 这里按实测算墨迹中心，把数字纵向归位。
// 两个关键点：
//   1) 用 position:relative + top，不用 transform —— transform 是公用属性，
//      会和别处写的 translateX 互相覆盖（这是上一版失效的原因）。
//   2) 每次测量前先把 top 归零，测到的才是真正的布局位置；
//      否则拿“已偏移的位置”再算偏移，会越跑越偏。
function alignStripInk(label, value) {
  if (!label || !value) return;
  const ln = label.firstChild, vn = value.firstChild;
  if (!ln || ln.nodeType !== 3 || !vn) return;
  const ctx = canvasCtx();
  const measure = (el) => {
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    if (!(fs > 0)) return null;
    const lhRaw = cs.lineHeight;
    const lh = lhRaw === 'normal' ? fs * 1.2 : parseFloat(lhRaw);
    if (!(lh > 0)) return null;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
    const m = ctx.measureText(valueTextOf(el).trim());
    const A = m.fontBoundingBoxAscent, D = m.fontBoundingBoxDescent;
    if (!(A > 0) || !(D > 0)) return null;
    const box = el.getBoundingClientRect();
    // 两个元素都是 align-items:center 下的单行，行盒就贴在各自盒顶（盒高=行盒高）。
    const lineBoxTop = box.top + Math.max(0, (box.height - lh) / 2);
    const baseline = lineBoxTop + (lh - (A + D)) / 2 + A;
    return {
      mid: (baseline - m.actualBoundingBoxAscent + baseline + m.actualBoundingBoxDescent) / 2,
    };
  };

  // 归一化：先清掉上次的位移，再测基准位置。
  if (value.style.position !== 'relative') value.style.position = 'relative';
  const had = value.style.top;
  if (had && had !== '0px') value.style.top = '0px';

  const li = measure(label), vi = measure(value);
  if (!li || !vi) { if (had) value.style.top = had; return; }

  const shift = -(vi.mid - li.mid);
  value.style.top = Math.abs(shift) < 0.05 ? '0px' : `${shift.toFixed(2)}px`;
}

let _cctx = null;
function canvasCtx() {
  return _cctx || (_cctx = document.createElement('canvas').getContext('2d'));
}

function fitCard(card, blockW) {
  // 主卡现在是双列（合计 / 今日），两列各自是一组「标签 + 数字」。
  // 所以不能只看 card.children：那样拿到的是两个 div，里面一个 strong 都没有。
  // 这里先找出所有“直接包含 strong 的容器”，每容器当一组独立反解；
  // 普通卡就返回它自己，行为跟以前一致。
  const groups = [];
  const walk = (el) => {
    // data-tt-fit-box 是显式声明的“尺寸基准”：主卡的两列就是。
    // 为什么不能让它继续往下走到 group：group 是 max-content，
    // 宽度由字决定，而字号又要看宽度 —— 自引用，数字会被塔小。
    if (el.hasAttribute?.('data-tt-fit-box')) { groups.push(el); return; }
    const hasValue = [...el.children].some((c) => c.tagName === 'STRONG');
    if (hasValue) { groups.push(el); return; }
    for (const c of el.children) if (c.tagName === 'DIV') walk(c);
  };
  walk(card);
  if (!groups.length) return;
  for (const g of groups) fitGroup(card, g, blockW);
  // 每组各自对齐自己的标签与数字左沿。
  // 主卡两列各传自己的列容器当 scope：按整卡宽算会把列内元素推出去。
  // 横排条跳过：它走 alignStripInk，transform 是同一个属性，会互相覆盖。
  if (!card.classList.contains('tt-kpi-strip')) {
    for (const g of groups) {
      alignLabelToValue(card, g.querySelector('span'), g.querySelector('strong'), g);
    }
  }
}

function fitGroup(card, holder, blockW) {
  // 统一用 querySelector 而不是只看直接子元素：
  // 显式声明的尺寸基准（主卡的列）下面夹了一层分组，数字是孙子节点。
  const value = holder.querySelector('strong');
  const label = holder.querySelector('span');
  if (!value) return;

  const text = valueTextOf(value).trim();
  if (!text) return;

  // 尺寸基准用 holder：普通卡 holder 就是 card 本身，行为不变；
  // 双列主卡里 holder 是每一列，数字能用的宽高就是那一列的，不能再拿整张卡。
  const cardStyle = getComputedStyle(card);
  const ownStyle = holder === card ? cardStyle : getComputedStyle(holder);
  const cardW = holder.clientWidth;
  const cardH = holder.clientHeight;
  // 隐藏的模块（页签没选中）量到的都是 0：这时写 0px 会把字压没。
  // 等它重新显示，ResizeObserver 会再叫一次。
  if (cardW <= 0 || cardH <= 0) return;

  // 列容器（主卡的两列）可以自己写 --tt-fit-*：
  // 从 holder 读，变量不在 holder 上时再回落到整张卡。
  const dirOf = (name) => ownStyle.getPropertyValue(name).trim()
    || (holder === card ? '' : cardStyle.getPropertyValue(name).trim());

  // 宽度基准的两种情形：
  //   普通卡 / 主卡合计列 —— 由外部给定（栅格或 flex），不回喂，直接用数字框自己的宽。
  //   主卡今日列 —— 没有固定宽（按内容），同样用框自己的宽会被自引用拖动，
  //   所以下面 ratio 分支里用整卡内宽封顶。
  const fixedW = holder !== card
    ? card.clientWidth - num(cardStyle, 'padding-left') - num(cardStyle, 'padding-right')
    : 0;

  const mode = dirOf('--tt-fit-mode') || 'both';

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
      // 标签不许宽过容器内框：比例算得再大也得先装得下。
      //
      // 上限必须扣掉卡片自己的左右内边距。以前用的是 card.clientWidth —— 它是含 padding 的，
      // 于是窄卡上算出 86.8 而真实内容区只有 66.4，标签照样溢出、被 overflow:hidden 裁掉。
      // 这就是「预估费用 · USD」被削成「预估费用 · U」的第二层原因：
      // 第一层是位移没夹紧（已修），第二层是天生的字号就超了。
      //
      // 仍然用整卡宽（而不是列宽）作为基准：标签是全级同号的，
      // 改用列宽会让主卡的两个标签双双掉到 16px，而其它卡还是 22.4。
      const innerCardW = card.clientWidth
        - num(cardStyle, 'padding-left') - num(cardStyle, 'padding-right');
      if (lm && lm.width > 0 && innerCardW > 0) {
        labelSize = Math.min(labelSize, (innerCardW * 0.98 * PROBE_PX) / lm.width);
      }
    }
    // 行高 1.28：中文字形上下都伸到字框外，行高给到 1 会被裁掉顶和底（二级标题就是这么被遮的）。
    setFontSize(label, labelSize, '1.28');
  }

  // ② 扁长条：数字跟标签成比例，不去填满整条。
  if (mode === 'ratio') {
    // 比例优先读容器自己的（主卡右列的“注释档”就写在列上）。
    const vr = ratio(ownStyle, '--tt-value-ratio',
      holder === card ? 1.45 : ratio(cardStyle, '--tt-value-ratio', 1.45));
    let size = (labelSize || cardW * 0.06) * vr;
    // 比例是期望值，不是免死金牌：装不下就得收回。
    // 但“扣掉标签宽”只适用于横排的长条 —— 标签和数字抢同一行的宽度。
    // 主卡右列是上下排的，用横排那套公式会把标签宽白白扣掉一次，
    // 实测今日数字被压到 22（与标签同号）。这里按方向分开算。
    const rowLayout = card.classList.contains('tt-kpi-strip');
    const lm2 = metrics((label?.textContent || '').trim(), label ? getComputedStyle(label) : cardStyle);
    const labelW = rowLayout && lm2 && lm2.width > 0 ? (labelSize * lm2.width) / PROBE_PX : 0;
    // 可用宽度：主卡的两列用整卡内宽，绝不拿列自己的宽（列宽由字撑，自引用）；
    // 其他卡（横排长条）照旧用自己那条的宽。
    const baseW = fixedW > 0 ? fixedW : holder.clientWidth;
    const room = baseW - num(ownStyle, 'padding-left') - num(ownStyle, 'padding-right') - labelW - 10;
    const vm = metrics(text, getComputedStyle(value), NO_TRACKING);
    if (room > 0 && vm && vm.width > 0) size = Math.min(size, (room * WIDTH_SAFETY * PROBE_PX) / vm.width);
    setFontSize(value, size);
    // 墨迹中线归位只适用于“标签与数字在同一行”的横排条。
    // 主卡右列的注释档也是 ratio 模式，但它是上下排的，
    // 套用横排的纵向归位会把数字推到标签上（实测两者重叠）。
    if (rowLayout) alignStripInk(label, value);
    return;
  }

  // ③ 竖向块：写完标签再量数字框，否则拿到的是旧行高下的高度。
  // 宽度基准分两种：
  //   普通卡 —— 数字框自己（列宽由栅格给定，不随字变）。
  //   主卡的两列 —— 整卡内宽。那两列是 flex:0 0 auto（宽由内容定），
  //   拿自己的宽反解就是自引用（实测每帧缩一次，70 → 25 停不下来）。
  const boxH = value.clientHeight;
  // 主卡的列：宽度一律用整卡内宽（列自己的宽由内容定，不能拿来反解）。
  // 普通卡：用数字框自己的宽（由栅格给定，不回喂）。
  const boxW = fixedW > 0 ? fixedW : value.clientWidth;
  if (boxW <= 0 || boxH <= 0) return;

  const m = metrics(text, getComputedStyle(value), NO_TRACKING);
  if (!m || !(m.width > 0) || !(m.inkHeight > 0)) return;
  // fillW / fillH 也优先读列容器自己的（dirOf 已在上面定义）。
  const fillW = ratio(ownStyle, '--tt-fit-w', holder === card ? 1 : ratio(cardStyle, '--tt-fit-w', 1));
  const fillH = ratio(ownStyle, '--tt-fit-h', holder === card ? 0.94 : ratio(cardStyle, '--tt-fit-h', 0.94));
  // 宽与高两个方向各自反解，取小。
  // 高度：boxH 是行盒高，而字的高度只占行的 ~72%（上下还留了行距），
  //   所以拿 inkHeight 直接算会把字算得比框小而白白浪费高度 —— 这里用行高而非墨迹高。
  const byW = (boxW * WIDTH_SAFETY * PROBE_PX) / m.width;
  const byH = (boxH * fillH * PROBE_PX) / m.lineHeight;
  // 三种取法（--tt-fit-mode）：
  //   width  只看宽度。卡片视图里高被压得很矮，若看高度就会把主数压成和二级一样大。
  //   height 只看高度。
  //   both   取小（默认）。
  const mode2 = dirOf('--tt-fit-mode') || 'both';
  let size = mode2 === 'width' ? byW : mode2 === 'height' ? byH : Math.min(byW, byH);
  // fillW 只对“宽度参与决策”的模式生效；height 模式下压宽度上限会重新引入自引用。
  if (fillW < 1 && mode2 !== 'height') size = Math.min(size, (boxW * fillW * PROBE_PX) / m.width);

  // 防崩底线：字小到读不出来时按容器宽占一个比例兜住，不让它继续缩。
  const floor = cardW * ratio(ownStyle, '--tt-fit-floor', 0.05);
  setFontSize(value, Math.max(size, floor));
}

// 同一行里的块状卡（二级）字号要一致：取这排算出的最小值统一写回。
// 不统一的话，「1.2 K」这种短文本会比「32.0%」大一圈，同一层级看着就是两套字。
// 只处理块状卡：长条走 ratio、主数卡独占一行，都没有这个问题。
function unifyRow(row) {
  if (!row) return;
  const cards = [...row.children].filter((card) => card.classList.contains('tt-kpi') && !card.classList.contains('tt-kpi-strip'));
  const values = cards.map((card) => card.querySelector('strong')).filter(Boolean);
  if (values.length < 2) return;
  const sizes = values.map((el) => parseFloat(el.style.fontSize)).filter((n) => Number.isFinite(n) && n > 0);
  if (sizes.length < 2) return;
  const min = Math.min(...sizes);
  for (const el of values) setFontSize(el, min);
  // 字号被统一改过，标签的位移得重算：位移量取决于数字墨迹宽，而宽随字号变。
  for (const card of cards) {
    alignLabelToValue(card, card.querySelector('span'), card.querySelector('strong'));
  }
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
  unifyLabels(scope);
  // 标签字号被 unifyLabels 改过之后，之前算的位移全部陈旧了（位移量取决于墨迹宽，而宽随字号变）。
  // 不重算就会出现“标题与数字左沿错开 20~30px” —— 这在 1430px 下非常明显。
  realignAll(scope);
  // 主卡是特例：两列都是 flex:0 0 auto（宽由内容撑），而字号基准用的是整卡内宽。
  // 兩边各自按同一个基准反解，加起来必然超 —— 实测 280.16 + 187.73 + 16 = 484.89，
  // 而内容区只有 463.45，溢出 21.44（恰好等于小数点那个静态格的宽）。
  // 超出的部分会被 .tt-kpi 的 overflow:hidden 直接削掉，右侧今日用量的单位就不见了。
  // 所以最后一律校一次。
  for (const card of scope.querySelectorAll('.tt-kpi-primary')) shrinkPrimaryToFit(card);
  settleTodayTransition(scope);
}

// 主卡总宽校核：两列加起来超过内容区就按比例收字号。
//
// 为什么不用「给两列钉一个固定宽」来避免自引用：那会回到当初被废弃的做法 ——
// 列宽被均分会把长数字压小，而短数字旁边留一大块空白。现在列宽仍由内容定，
// 只在总量越界时等比收，收完再重算标签对齐。
//
// 宽度对字号是线性的，所以一轮就该收敛；给两轮是防子像素舍入导致差 0.5px 反复。
function shrinkPrimaryToFit(card) {
  if (!card) return;
  const cols = [...card.children].filter((c) =>
    c.classList.contains('tt-kpi-main') || c.classList.contains('tt-kpi-today'));
  if (cols.length < 2) return;
  const cs = getComputedStyle(card);
  const innerW = card.clientWidth - num(cs, 'padding-left') - num(cs, 'padding-right');
  if (!(innerW > 0)) return;
  const gap = num(cs, 'column-gap') || num(cs, 'gap') || 0;

  for (let iter = 0; iter < 2; iter++) {
    const widths = cols.map((c) => c.getBoundingClientRect().width);
    // 竖线是 today 列的 border-left，已经在它的宽里，不另加。
    const total = widths.reduce((a, b) => a + b, 0) + gap;
    if (total <= innerW - 0.5) break;
    const factor = (innerW - gap - 0.5) / (total - gap);
    if (!(factor > 0) || factor >= 1) break;
    for (const c of cols) {
      const strong = c.querySelector('strong');
      const cur = parseFloat(strong?.style.fontSize) || 0;
      if (!(cur > 1)) continue;
      // 不低于 6px：再小就不是“排版”，是糊成一片。宁可用省略也不能出现读不出的字。
      strong.style.fontSize = Math.max(6, cur * factor).toFixed(2) + 'px';
    }
    card.getBoundingClientRect();   // 逼重排，下一轮量到的是新几何
  }
  // 字号变了，标签与数字的左沿关系也跟着变，重算一次。
  for (const c of cols) {
    alignLabelToValue(card, c.querySelector('span'), c.querySelector('strong'), c);
  }
}

// 重算所有“组”的标签左沿对齐。
// “组”的判定与 fitCard 里的 walk 保持一致：直接含 strong 的容器。
// 主卡的两列（data-tt-fit-box）也是组，但它们的对齐基准是列自己。
function realignAll(scope) {
  for (const card of scope.querySelectorAll('.tt-kpi')) {
    if (card.classList.contains('tt-kpi-strip')) continue;   // 横排条走 alignStripInk
    const groups = [];
    const walk = (el) => {
      if (el.hasAttribute?.('data-tt-fit-box')) { groups.push(el); return; }
      if ([...el.children].some((c) => c.tagName === 'STRONG')) { groups.push(el); return; }
      for (const c of el.children) if (c.tagName === 'DIV') walk(c);
    };
    walk(card);
    for (const g of groups) {
      alignLabelToValue(card, g.querySelector('span'), g.querySelector('strong'), g);
    }
  }
}

// 标签是「说明」，全块同号。
//
// 为什么要这一步：窄卡上「预估费用 · USD」比别的标题长很多，单独给它压字号
// 会出现同一个层级 9.7 / 10.1 两种字 —— 挨着看就是乱了。
// 改成取全块最小的那个当准，全体跟着降：宁可整块小 0.3px，也不要同层两套字号。
//
// 只降不升：每个标签自己的上限是“装得下”，统一取最小就是所有人都装得下。
function unifyLabels(scope) {
  // 只取“块状卡”的标签：三级横排条的标签跟条高走（--tt-label-h），
  // 它不在同一套字号体系里，混进来会把整块拖到条子的大小。
  const labels = [];
  for (const card of scope.querySelectorAll('.tt-kpi')) {
    if (card.classList.contains('tt-kpi-strip')) continue;
    // 主卡里是两个“列”，每列各有一个标签；直接 querySelector 只能拿到第一个。
    const cols = [...card.children].filter(c => c.classList.contains('tt-kpi-main') || c.classList.contains('tt-kpi-today'));
    const hosts = cols.length ? cols : [card];
    for (const h of hosts) {
      const sp = h.querySelector('span');
      if (sp && sp.textContent.trim()) labels.push(sp);
    }
  }
  if (labels.length < 2) return;
  const sizes = labels.map(el => parseFloat(el.style.fontSize)).filter(n => Number.isFinite(n) && n > 0);
  if (sizes.length < 2) return;
  const min = Math.min(...sizes);
  for (const el of labels) {
    const cur = parseFloat(el.style.fontSize);
    if (!Number.isFinite(cur) || cur <= 0) continue;
    if (Math.abs(cur - min) < 0.05) continue;
    el.style.fontSize = min.toFixed(2) + 'px';
  }
}

// 「今日用量」列的进/退场。
//
// 不用 CSS @keyframes：动画结束后要把“无约束”恢复回去，而 fill-mode:both 会把最后一帧按住，
// 靠移除属性去恢复的时机很难合对 —— 实测会出现入场停在宽度 0、或停在 109 而不是静止态的 167。
//
// 改成写普通内联样式驱动 transition，时机完全在我们手上：
//   退场：展开态 → 收起态 → transition 完 → 摘掉整列
//   进场：收起态 → （下一帧）展开态 → transition 完 → 清内联，回到 CSS 默认
//
// 两端都必须是具体像素值：max-width 从 none 到 0px 不可插值，
// 那样过渡等于直接跳 —— 实测退场第一帧宽度就是 15 而不是 167，“丝滑”是假的。
const TODAY_MS = 340;

function settleTodayTransition(scope) {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const card of scope.querySelectorAll('.tt-kpi-primary')) {
    const enter = card.hasAttribute('data-tt-enter');
    const leave = card.hasAttribute('data-tt-leave');
    if (!enter && !leave) continue;
    const col = card.querySelector('.tt-kpi-today');
    const cleanup = () => { card.removeAttribute('data-tt-enter'); card.removeAttribute('data-tt-leave'); };
    if (!col) { cleanup(); continue; }
    // 这列正在跑过渡：本次什么都不能做。
    // 为什么要这个闸：过渡期间列宽在变 → 卡尺寸变 → ResizeObserver 又叫一次 fit
    // → 又进到这里 → 重写起点→终点 → 过渡被反复重置。
    // 实测的表现就是“卡在起点不动，最后一刻直接跳到终点”。
    if (col.dataset.ttAnim === '1') { cleanup(); continue; }

    // 先清掉可能残留的内联样式，量出“展开态”的真实几何。
    col.style.width = ''; col.style.maxWidth = ''; col.style.paddingLeft = '';
    col.style.borderLeftWidth = ''; col.style.opacity = '';
    const cs = getComputedStyle(col);
    const fullW = col.getBoundingClientRect().width;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const bL = parseFloat(cs.borderLeftWidth) || 0;

    const apply = (w, pad, border, op) => {
      // 用固定 width 而不是 max-width：
      // max-width 在这里描不准 —— 列的宽度是内容撑出来的，从 167 收到 0 时
      // 浏览器算出的“间值”会被内容最小宽顶回去，实测宽度一直卡在 167 不动、到末了直接跳 0。
      // width 是显式尺寸，两端数值明确，过渡真的能插值。
      col.style.width = w === null ? '' : w + 'px';
      col.style.paddingLeft = pad === null ? '' : pad + 'px';
      col.style.borderLeftWidth = border === null ? '' : border + 'px';
      col.style.opacity = op === null ? '' : String(op);
    };

    if (reduced) {
      cleanup();
      if (leave) col.setAttribute('data-tt-gone', '');
      else apply(null, null, null, null);
      fitKpiCards(card.closest('.tt-board-kpis') || scope);
      continue;
    }

    // 起点写成显式像素，强制同步重排让它真的落下去，再写目标态 —— 两值之间才有可插值的差别。
    // 只写 void offsetWidth 不够：reader 可能命中缓存，实测起点仍是收起态。
    col.dataset.ttAnim = '1';
    if (leave) {
      // 退场：第一帧什么都不写（保持自然态 167），第二帧才写 0。
      // 不能在第一帧写 fullW —— 那等于“写回原值”，浏览器视为无变化，
      // 于是起点没建立，后面写 0 就是直接跳变（实测 167 一直停到 530ms 才归零）。
      // 进场没这个问题，因为它第一帧写的是 0，与自然态不同，起点天然成立。
      col.getBoundingClientRect();
      setTimeout(() => {
        if (!col.isConnected) return;
        apply(0, 0, 0, 0);
      }, 16);
    } else {
      apply(0, 0, 0, 0);
      col.getBoundingClientRect();
      setTimeout(() => {
        if (!col.isConnected) return;
        apply(fullW, padL, bL, 1);
      }, 16);
    }

    setTimeout(() => {
      // 已经不在文档里（换了一次区间、整块被重建）：别再动，免得摸到别人。
      if (!col.isConnected) return;
      cleanup();
      delete col.dataset.ttAnim;
      if (leave) col.setAttribute('data-tt-gone', '');
      // 清掉内联，回到 CSS 默认的“无约束”态：这样卡宽度再变，这列也不会被钉住。
      else apply(null, null, null, null);
      fitKpiCards(card.closest('.tt-board-kpis') || scope);
    }, TODAY_MS + 40);
  }
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
