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
//   1) 位数变化不做逐位复用，整组重建 + 一次轻弹。
//      复用会错位：「个位忽然变成十位」看起来像数据错了，而不像动画。
//   2) 首屏不做入场。一进页面所有数字一起滚，会把「这里有变化」这个信号稀释掉。
//   3) 不用 FLIP 去补位移，行内布局由浏览器自己连续推动。
//
// ── 与原件不同之处，都是因为这里显示的不是「+12」这种纯整数 ────────────
//   · 有前置 $、后置 %、空格加单位（27.45 B）、比例（192:1）
//     → 拆成 prefix / core / suffix，只有 core 参与滚动，其余是静态字符
//   · 单位会跨量级变（B↔M）→ 单位单独一层，变了淡入淡出，不跟着数字滚
//   · 字号从 9px 到 78px 不等，格高不能像原版那样写死 14px
//     → 全程用 em，格高恒等于一个字号，字号被 fit 改动时格子与位移同步缩放
//
// 位移用 em 而不是 px 还有一层原因：字号是 kpi-fit.mjs 反解出来的，
// 每帧都可能微调。写成 px 就得在字号变化后把所有带子的位移重算一遍（还要防过渡抖动），
// 写成 em 则两者天然等比，不需要任何同步动作。

/** 滚动时长（ms）。与 token-tracker.css 里 .tt-strip 的 transition 保持一致。 */
export const ROLL_MS = 340;

/** 单位淡入淡出时长（ms）。 */
export const UNIT_MS = 220;

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

// ── DOM 层 ──────────────────────────────────────────────────────────────

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

/** 数字段：位数不变逐位滚；位数变了（或位型变了）整组重建 + 轻弹。 */
function setCore(box, core, animate) {
  const str = String(core ?? '');
  if (box.dataset.ttCore === str) return;
  const hadPrev = box.dataset.ttCore !== undefined;
  box.dataset.ttCore = str;

  const tokens = tokenize(str);
  const sameLength = box.children.length === tokens.length;
  // 长度一样还不够：某一位可能从数字变成标点（或反过来），
  // 那时节点类型不对，逐位复用会把带子塞进标点格里。
  const sameShape = sameLength && tokens.every((t, i) =>
    t.digit === box.children[i].classList.contains('tt-digit'));

  if (!sameLength || !sameShape) {
    box.textContent = '';
    for (const t of tokens) {
      if (!t.digit) {
        const s = span('tt-static');
        s.textContent = t.ch;
        box.append(s);
        continue;
      }
      box.append(makeDigit(t.ch));
    }
    if (animate && hadPrev) {
      box.classList.remove('tt-pop');
      void box.offsetWidth;
      box.classList.add('tt-pop');
    }
    return;
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const el = box.children[i];
    if (t.digit) { setDigit(el, t.ch, animate); continue; }
    if (el.textContent !== t.ch) el.textContent = t.ch;
  }
}

/**
 * 单位段：变了就叠一层做 crossfade。
 *
 * 为什么不用「先清空再写新字」：那样中间有一帧是空的，单位会闪一下；
 * 而宽度也会先塌到 0 再撑开，把旁边的数字推来推去。
 * 两层叠在同一个 grid 格里（.tt-unit 是 inline-grid，两层都是 grid-area:1/1），
 * 容器宽度取两者最大，所以换字过程里数字一个像素都不会动。
 */
function setUnit(box, text, animate) {
  const str = String(text ?? '');
  if (box.dataset.ttUnit === str) return;
  const hadPrev = box.dataset.ttUnit !== undefined;
  box.dataset.ttUnit = str;

  // 上一轮淡出还没走完就来了新值：先把已经标了 ttOut 的旧层收掉。
  // 不收的话每来一次就多叠一层 —— 实测连着切两次拿到 3 层 [" B"," M"," B"]，
  // 同一格里堆着好几个单位。
  if (box._ttUnitTimer) { clearTimeout(box._ttUnitTimer); box._ttUnitTimer = 0; }
  for (const o of [...box.children]) {
    if (o.dataset.ttOut === '1') o.remove();
  }

  if (!animate || !hadPrev) {
    box.textContent = '';
    if (str) {
      const only = span('tt-unit-layer');
      only.textContent = str;
      box.append(only);
    }
    return;
  }

  const outgoing = [...box.children];
  const incoming = span('tt-unit-layer');
  incoming.textContent = str;
  incoming.style.opacity = '0';
  box.append(incoming);
  // 逼一次布局，让 opacity:0 这一帧真的落地 —— 否则下一句改成 1 时
  // 起点和终点在同一帧里，浏览器认为没有变化，淡入不会发生。
  void box.offsetWidth;
  incoming.style.opacity = '1';
  for (const o of outgoing) {
    o.dataset.ttOut = '1';
    o.style.opacity = '0';
  }

  box._ttUnitTimer = setTimeout(() => {
    for (const o of [...box.children]) {
      if (o.dataset.ttOut === '1') o.remove();
    }
    incoming.style.opacity = '';
    box._ttUnitTimer = 0;
  }, UNIT_MS + 40);
}

/**
 * 更新一个 KPI 数值节点。
 *
 * 预期结构（首次调用时自动建立）：
 *   <strong data-tt-value="27.45 B">
 *     <span class="tt-num">…位…</span>
 *     <span class="tt-unit">B</span>
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
  // prefix（$ 之类）当静态字符塞进 num，它不滚，但跟着一起排版。
  setCore(num, prefix + core, canAnimate);
  setUnit(unit, suffix, canAnimate);

  // 空段不占位：否则 flex 的 gap 会在「—」这种没有数字的值上留一道空。
  num.hidden = num.childElementCount === 0;
  unit.hidden = unit.childElementCount === 0;
}

/** 取逻辑值（给 kpi-fit.mjs 量字用）。没有 data-tt-value 的老节点退回 textContent。 */
export function valueText(el) {
  if (!el) return '';
  const v = el.dataset?.ttValue;
  return v !== undefined ? v : (el.textContent || '');
}
