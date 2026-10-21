// ui/digit-roll.mjs — KPI 数字的滚动层。
//
// 机制取自 git-save-load 的变更列表（apps/git-save-load/ui/assets/git/list-anim.mjs）：
// 每位数字是一个开窗的格子（width:1ch、height:1em、overflow:hidden），
// 里面一条竖排 9…0 的带子，靠 translateY 停在目标刻度。
//
// 它不是计数器，也不是字符替换 —— 数字是真的从 9 滚到 8 再到 7，
// 滚过去的每一帧都是合法数字，所以中间态没有假值。
//
// ── 原样保留的三条决策（都是那边踩过坑才写下来的） ──────────────────────
//   1) 位数变化不做逐位复用（「个位忽然变成十位」看起来像数据错了，而不像动画）。
//      但也不整块重建：现在是「换一层」—— 新层进流，旧层退出布局后留在原地
//      向上滚着淡出（见 setCore）。早年那版「重建 + 轻弹」被观感否掉了。
//   2) 首屏不做入场。一进页面所有数字一起滚，会把「这里有变化」这个信号稀释掉。
//   3) 不用 FLIP 去补位移，行内布局由浏览器自己连续推动。
//
// ── 与原件不同之处，都是因为这里显示的不是「+12」这种纯整数 ────────────
//   · 有前置 $、后置 %、空格加单位（27.45 B）、比例（192:1）
//     → 拆成 prefix / core / suffix，只有 core 参与滚动，其余是静态字符
//   · 单位会跨量级变（B↔M）→ 单位也是同一根滚轮：窗口只开一格，
//     里面竖排整张档位表，换档就滚过去（见 setUnit）
//   · 字号从 9px 到 78px 不等，格高不能像原版那样写死 14px
//     → 全程用 em，格高恒等于一个字号，字号被 fit 改动时格子与位移同步缩放
//
// 位移用 em 而不是 px 还有一层原因：字号是 kpi-fit.mjs 反解出来的，
// 每帧都可能微调。写成 px 就得在字号变化后把所有带子的位移重算一遍（还要防过渡抖动），
// 写成 em 则两者天然等比，不需要任何同步动作。

import { getUnitSystem, stepsOf } from './units.mjs';

/** 滚动时长（ms）。与 token-tracker.css 里 .tt-strip / .tt-unit-belt 的 transition 保持一致。 */
export const ROLL_MS = 340;

/** 滚轮的曲线，与 CSS 里那两条 transition 同一条。 */
export const ROLL_EASING = 'cubic-bezier(.22,.61,.36,1)';

// 位数变化：整串像滚轮过一格。
//
// 旧串滚出一整行，新串同时从另一侧补上同一行 —— 两者永远差一整行，
// 中途不会叠在同一个位置上，所以不需要淡入淡出：看到的就是一次转动，
// 而不是两串字在一个地方互相透（那看着就是“凭空丢出来”）。
// 方向跟显示值的增减走（变大往上、变小往下），与单位带子同一套语言。
const SWAP_LINES = 1;        // 转动行程，单位是一行（em）
const SWAP_MS = ROLL_MS;

function prefersReduced() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ── 纯逻辑（无 DOM；探针与测试直接覆盖这一层） ──────────────────────────

/**
 * 把一段显示文本拆成 prefix / core / suffix。
 * 只有 core（首字符数字到末字符数字之间的部分）参与滚动；
 * prefix（如 $）是静态字符，suffix（如 % / " B"）是单位，走淡入淡出。
 *
 * @returns {{prefix:string, core:string, suffix:string, plain:boolean}}
 *   plain=true 表示整串没有数字（例如取不到值时的「—」），只能用静态文本。
 */
export function splitValue(text) {
  const s = String(text ?? '');
  const first = s.search(/[0-9]/);
  if (first < 0) return { prefix: '', core: '', suffix: s, plain: true };
  let last = s.length - 1;
  while (last >= 0 && !/[0-9]/.test(s[last])) last--;
  return {
    prefix: s.slice(0, first),
    core: s.slice(first, last + 1),
    suffix: s.slice(last + 1),
    plain: false,
  };
}

/**
 * core 切成位：数字位可滚，标点（小数点和比例冒号）是不动的桩。
 * @returns {Array<{digit:boolean, ch:string}>}
 */
export function tokenize(core) {
  return [...String(core ?? '')].map((ch) => ({ digit: /[0-9]/.test(ch), ch }));
}

/**
 * 数字 d 对应的带子位移（em）。带子自上而下排成 9,8,…,0，所以数字越大越靠上。
 * d=9 → 0em；d=0 → -9em。
 */
export function digitOffset(d) {
  return (Number(d) - 9);
}

/**
 * 单位滚轮的档位：从「没有单位」一路排到最大档。
 * 英文 ['', ' K', ' M', ' B', ' T']，中文 ['', ' 万', ' 亿', ' 万亿']。
 *
 * 顺序就是带子的上下顺序（越靠后越大、也越靠下），换档时往哪边滚由它决定，
 * 所以这张表必须与 units.mjs 的档位一致 —— 不另写一份，直接用那边生成。
 */
export function unitRollStops(system = getUnitSystem()) {
  return ['', ...stepsOf(system).slice().reverse().map((step) => ` ${step.suffix}`)];
}

// ── DOM 层 ──────────────────────────────────────────────────────────────

/**
 * 位数变化时轮子往哪边转：显示值变大往上（+1），变小往下（-1）。
 * 只看显示出来的那个数（「18.8」而不是乘完单位的总量），
 * 因为人看到的就是这个数在变大变小。
 */
export function rollDirection(prev, next) {
  const num = v => Number.parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  const a = num(prev), b = num(next);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return 1;
  return b > a ? 1 : -1;
}

function span(className) {
  const el = document.createElement('span');
  el.className = className;
  return el;
}

/** 一个数字格：内含 9…0 竖排的一条带子。 */
function makeDigit(ch) {
  const slot = span('tt-digit');
  const strip = span('tt-strip');
  strip.setAttribute('aria-hidden', 'true');
  for (let d = 9; d >= 0; d--) {
    const g = span('tt-digit-g');
    g.textContent = String(d);
    strip.append(g);
  }
  slot.append(strip);
  setDigit(slot, ch, false);
  return slot;
}

/** 把某个数字格放到新刻度。animate=false 时瞬移（首屏 / 新增位 / 位数重建）。 */
function setDigit(slot, ch, animate) {
  const strip = slot.firstElementChild;
  if (!strip) return;
  const d = Number(ch);
  if (!Number.isFinite(d)) return;
  if (slot.dataset.d === String(d)) return;
  const first = slot.dataset.d === undefined;
  slot.dataset.d = String(d);
  const y = `translateY(${digitOffset(d)}em)`;
  if (!animate || first) {
    // 先摘掉过渡、瞬移到目标、逼一次布局让这一帧落地，再把过渡交还给 CSS。
    // 不逼布局的话，浏览器可能把「摘过渡 → 改值 → 恢复过渡」合并成一帧，
    // 结果就是带着过渡从旧刻度滑过去 —— 首屏所有数字会一起滚一遍。
    strip.style.transition = 'none';
    strip.style.transform = y;
    void strip.offsetWidth;
    strip.style.transition = '';
    return;
  }
  strip.style.transform = y;
}

// ── 数字段：一层一层的 ────────────────────────────────────────────────
//
// 一层 = 一整串格子。位数不变时在层内逐位滚；位数（或位型）变了就换一层：
// 新层进流（宽度当帧定下来，外面量两端位置的动画才拿到真终点），
// 旧层退出布局、留在原地向上滚着淡出。
//
// 为什么旧层要绝对定位 + 居中（CSS 里 [data-tt-out] 那两条）：整排数字是整组居中的，
// 只有最后一位改宽度时，它的中心本来就不动，变的只是两条边。所以旧层不必平移，
// 只要把它钉在同一个中心上淡出，就不会有“字忽然往旁边跳一下”的观感。

/** 取在流里的那一层（退场中的不算）。 */
function liveRow(box) {
  let live = null;
  for (const el of box.children) {
    if (el.classList.contains('tt-num-row') && el.dataset.ttOut !== '1') live = el;
  }
  return live;
}

/** 退场层还挂着就来了下一次换人：先收掉，免得多层叠在同一个中心上。 */
function clearRetired(box) {
  for (const el of [...box.children]) {
    if (el.dataset.ttOut === '1') el.remove();
  }
}

/** 把一串 core 铺成格子。新层出生时用：每格直接落位，不逐位滚。 */
function fillRow(row, tokens) {
  row.textContent = '';
  for (const t of tokens) {
    if (!t.digit) {
      const s = span('tt-static');
      s.textContent = t.ch;
      row.append(s);
      continue;
    }
    row.append(makeDigit(t.ch));
  }
}

/** 旧层退场：向上（或向下）滚出一整行，然后从 DOM 里摘掉。 */
function retireRow(row, dir) {
  row.dataset.ttOut = '1';
  const anim = row.animate([
    { transform: 'translateY(0)' },
    { transform: `translateY(${-SWAP_LINES * dir}em)` },
  ], { duration: SWAP_MS, easing: ROLL_EASING, fill: 'forwards' });
  const drop = () => { if (row.isConnected) row.remove(); };
  anim.addEventListener('finish', drop);
  // finish 在后台页签里不一定发（合成器可能不推），用定时器兼底。
  setTimeout(drop, SWAP_MS + 80);
}

/** 新层进场：从同一行的另一侧补上来，与旧层卡在同一个节奏上。 */
function enterRow(row, dir) {
  row.animate([
    { transform: `translateY(${SWAP_LINES * dir}em)` },
    { transform: 'translateY(0)' },
  ], { duration: SWAP_MS, easing: ROLL_EASING, fill: 'backwards' });
}

/** 数字段：位数不变逐位滚；位数变了就换一层（旧层上滚淡出，新层落进来）。 */
function setCore(box, core, animate) {
  const str = String(core ?? '');
  let row = liveRow(box);
  if (row && row.dataset.ttCore === str) return;
  const tokens = tokenize(str);

  if (!row) {
    row = span('tt-num-row');
    row.dataset.ttCore = str;
    fillRow(row, tokens);
    box.append(row);
    return;
  }

  const slots = [...row.children];
  // 长度一样还不够：某一位可能从数字变成标点（或反过来），
  // 那时节点类型不对，逐位复用会把带子塞进标点格里。
  const sameShape = slots.length === tokens.length
    && tokens.every((t, i) => t.digit === slots[i].classList.contains('tt-digit'));

  if (sameShape) {
    row.dataset.ttCore = str;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const el = slots[i];
      if (t.digit) { setDigit(el, t.ch, animate); continue; }
      if (el.textContent !== t.ch) el.textContent = t.ch;
    }
    return;
  }

  // 方向先量好：row.dataset.ttCore 就是上一次显示的那串。
  const dir = rollDirection(row.dataset.ttCore, str);
  clearRetired(box);
  const next = span('tt-num-row');
  next.dataset.ttCore = str;
  fillRow(next, tokens);
  box.append(next);
  if (!animate) { row.remove(); return; }
  retireRow(row, dir);
  enterRow(next, dir);
}

// ── 单位段：第二根滚轮 ────────────────────────────────────────────────
//
// 单位以前是淡入淡出：两行字叠在同一格里互相显隐。数字在纵向滚、单位在横向淡，
// 两套语言并排放着，换量级时会觉得整块被重绘过。
//
// 现在单位也是一根带子：窗口只开一格，里面竖排整张档位表
//（空 / K / M / B / T，中文是 空 / 万 / 亿 / 万亿），换档就滚过去，
// 方向和数字一致（往大档走＝带子往上，字从下面进来）。
// 空档也是表里的一档，所以「单位消失」是滚出去，不是淡掉。
//
// 窗口的宽度由 sizer 定：它在流里、不可见，内容永远是目标档。
// 宽度本身不在这里管 —— 换值时 kpi-fit 会把窗口宽度从旧档补间到新档，
// 整组（标题 / 数字）跟着布局连续移动；这里只管纵向滚。
// 元素刚从不显示变成显示时那一帧要逼一次布局，否则过渡不会建立
//（见 placeBelt、syncUnitVisibility）。

function ensureUnitDom(box) {
  if (box._ttSizer && box._ttBelt) return;
  box.textContent = '';
  const sizer = span('tt-unit-sizer');
  sizer.setAttribute('aria-hidden', 'true');
  const belt = span('tt-unit-belt');
  belt.setAttribute('aria-hidden', 'true');
  box.append(sizer, belt);
  box._ttSizer = sizer;
  box._ttBelt = belt;
  box._ttStops = null;
}

/** 把档位表铺成格子。带子重建只在「首次」或「档位表变了」时发生。 */
function renderBelt(box, stops) {
  const belt = box._ttBelt;
  belt.textContent = '';
  for (const stop of stops) {
    const cell = span('tt-unit-cell');
    cell.textContent = stop;
    belt.append(cell);
  }
  box._ttStops = stops.slice();
}

/** 把带子停在某一档。animate=false 时瞬移（首屏 / 重建后的对位）。 */
function placeBelt(box, index, animate) {
  const belt = box._ttBelt;
  const y = `translateY(${-index}em)`;
  if (!animate) {
    // 与 setDigit 同一套手法：摘过渡、落位、逼一次布局，再把过渡交还。
    belt.style.transition = 'none';
    belt.style.transform = y;
    void belt.offsetWidth;
    belt.style.transition = '';
    return;
  }
  // 先把「已经显示出来 + 停在旧档」这一帧逼落地，再写新值 ——
  // 元素刚从不显示变成显示时，若直接写目标，浏览器没有“前一个渲染帧”，过渡不会建立。
  void belt.offsetWidth;
  belt.style.transform = y;
}

/** 这一次要用的档位表：表内单位用整张表；表外的（以后新增、怪值）就地造两格滚一格。 */
function unitStopsFor(str, prev) {
  const ladder = unitRollStops();
  if (ladder.includes(str) && (prev === undefined || ladder.includes(prev))) return ladder;
  return [prev ?? '', str];
}

// 单位从「有」变成「没有」时不要当场 display:none —— 那样就没有滚出去的过程了。
// 让它先以 0 宽度留在文档里（窗口宽度由 kpi-fit 补间到 0），滚完再收起来。
const UNIT_HIDE_MS = ROLL_MS + 60;

function syncUnitVisibility(box, str, prev, animate) {
  if (box._ttHideTimer) { clearTimeout(box._ttHideTimer); box._ttHideTimer = 0; }
  if (str) { box.hidden = false; return; }
  const rolling = animate && !!prev;
  if (!rolling) { box.hidden = true; return; }
  box.hidden = false;
  box._ttHideTimer = setTimeout(() => {
    box._ttHideTimer = 0;
    if (!box.isConnected || box.dataset.ttUnit !== '') return;
    box.hidden = true;
  }, UNIT_HIDE_MS);
}

function setUnit(box, text, animate) {
  const str = String(text ?? '');
  const prev = box.dataset.ttUnit;
  // 显隐先处理：元素挂着 display:none 的话，那一帧不会被渲染，滚动过渡会被吞掉。
  syncUnitVisibility(box, str, prev, animate);
  if (prev === str) return;
  box.dataset.ttUnit = str;

  ensureUnitDom(box);
  box._ttSizer.textContent = str;   // 窗口宽度：当帧按目标档落定

  const stops = unitStopsFor(str, prev);
  const index = Math.max(0, stops.indexOf(str));
  const sameBelt = !!box._ttStops && box._ttStops.join('\u0001') === stops.join('\u0001');

  if (!animate || prev === undefined) {
    renderBelt(box, stops);
    placeBelt(box, index, false);
    return;
  }

  if (!sameBelt) {
    // 带子要重建（首次、或进/出了档位表）：先把旧档摆好，再从那里滚过去。
    // 不先落位就直接写目标，会从 0 往目标冲 —— 看起来像“从无单位滚到 M”，不是从 K 滚到 M。
    const from = Math.max(0, stops.indexOf(prev));
    renderBelt(box, stops);
    placeBelt(box, from, false);
    if (from === index) return;
  }
  placeBelt(box, index, true);
}

/**
 * 更新一个 KPI 数值节点。
 *
 * 预期结构（首次调用时自动建立）：
 *   <strong data-tt-value="27.45 B">
 *     <span class="tt-num"><span class="tt-num-row">…位…</span></span>
 *     <span class="tt-unit">
 *       <span class="tt-unit-sizer">B</span>
 *       <span class="tt-unit-belt">…档…</span>
 *     </span>
 *   </strong>
 *
 * data-tt-value 是「逻辑值」：DOM 里的文字已经被拆成带子，textContent 不再可读，
 * kpi-fit.mjs 必须读这个属性来量字宽、算字号。
 *
 * @param {HTMLElement} strong
 * @param {string} text        要显示的文字，原样（含 $ % 单位）
 * @param {{animate?:boolean}} [options]
 */
export function setValue(strong, text, options) {
  if (!strong) return;
  const str = String(text ?? '');
  const animate = options?.animate !== false && !prefersReduced();

  let num = strong.querySelector(':scope > .tt-num');
  let unit = strong.querySelector(':scope > .tt-unit');
  if (!num || !unit) {
    strong.textContent = '';
    num = span('tt-num');
    unit = span('tt-unit');
    strong.append(num, unit);
  }

  const prev = strong.dataset.ttValue;
  strong.dataset.ttValue = str;
  // 第一次写入不滚：首屏所有数字一起滚会把「变化」这个信号稀释掉。
  const canAnimate = animate && prev !== undefined;

  const { prefix, core, suffix } = splitValue(str);

  // 空段不占位：否则 flex 的 gap 会在「—」这种没有数字的值上留一道空。
  // 数字的显隐要先定（单位的那份交给 setUnit：它要留着旧单位滚出去）。
  num.hidden = !(prefix + core);

  // prefix（$ 之类）当静态字符塞进 num，它不滚，但跟着一起排版。
  setCore(num, prefix + core, canAnimate);
  setUnit(unit, suffix, canAnimate);
}

/** 取逻辑值（给 kpi-fit.mjs 量字用）。没有 data-tt-value 的老节点退回 textContent。 */
export function valueText(el) {
  if (!el) return '';
  const v = el.dataset?.ttValue;
  return v !== undefined ? v : (el.textContent || '');
}
