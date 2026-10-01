// 视图手势（真滑轨的第二半）：拖拽换页 + 图表就地平移。
// 这里只做两件事：① 判定这一摊手势属于谁（gestureMode 及其配套纯函数）；
//               ② 算位移与落点（dragOffset / settleTarget）。
// 真正的换页交给宿主调 selectView：页签高亮、inert、aria-hidden、懒加载只有那一条路。
//
// 手势归属（从按下点往上走，就近优先）：
//   data-tt-pan    图表里“按住可拖”的区域 → 平移它所在的可滚容器（不换页、不抢选字）
//   data-tt-select 图表里的文字区 → 什么都不做，把选中、双击这些交回浏览器
//   表单控件 / 面板分割条 / 可编辑区 / 别的真能横滚的容器 → 什么都不做
//   其余（面板空白处、KPI 块…）→ 拖拽换页
// 面板那一层（轨道的直接子节点）不算“横滚容器”：它本身就是换页手势的落脚面，
// 把它当成要谦让的滚动区，整个看板就都拖不动了。
//
// 为什么用声明式属性而不是“看它能不能滚”去猜：能不能滚取决于内容宽度，
// 同一个图在不同时间范围下时能滚时不能滚，手势归属就会时好时坏。

export const DRAG_START_PX = 8;     // 超过这个位移才判方向；低于它一律当点击
export const AXIS_RATIO = 1.2;      // 换页时横向位移要明显大于纵向才算横拖
export const SNAP_RATIO = 0.25;     // 位移超过 1/4 步长就翻页
export const SNAP_VELOCITY = 0.5;   // px/ms；甩得够快也翻页
export const RUBBER = 0.35;         // 换页时两端的阻尼系数：拖得动，但拖不远
const WALK_LIMIT = 24;              // 往上最多查这么多层

export const GESTURE = { view: "view", pan: "pan", select: "select", blocked: "blocked" };

export function decideAxis(dx, dy, { startPx = DRAG_START_PX, ratio = AXIS_RATIO } = {}) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < startPx) return "none";
  return ax > ay * ratio ? "x" : "y";
}

// 这个元素本身就“不该由我们接管手势”的理由；空串表示可以接管。
export function blockingReason(el) {
  if (!el || typeof el.getAttribute !== "function") return "";
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return "control";
  if (el.getAttribute("role") === "separator") return "separator";
  if (el.isContentEditable) return "editable";
  return "";
}

export function overflowPair(node) {
  const view = node && node.ownerDocument && node.ownerDocument.defaultView;
  const cs = view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(node) : null;
  return { x: cs ? cs.overflowX : "", y: cs ? cs.overflowY : "" };
}

// 真能在横轴上滚：内容比容器宽，且 overflow-x 是 auto/scroll。
export function scrollableX(node) {
  if (!node || !(node.scrollWidth > node.clientWidth + 1)) return false;
  const ox = overflowPair(node).x;
  return ox === "auto" || ox === "scroll";
}

// 任一轴真能滚（图表平移要连带管纵向）。
export function scrollableAny(node) {
  if (!node) return false;
  const { x, y } = overflowPair(node);
  const canX = (x === "auto" || x === "scroll") && node.scrollWidth > node.clientWidth + 1;
  const canY = (y === "auto" || y === "scroll") && node.scrollHeight > node.clientHeight + 1;
  return canX || canY;
}

// 从某个节点往上找最近的可滚容器（图表平移的实际落点）。
export function nearestScroller(node, root, { limit = WALK_LIMIT } = {}) {
  let n = node && node.nodeType === 1 ? node : null;
  for (let i = 0; n && n !== root && i < limit; i++) {
    if (scrollableAny(n)) return n;
    n = n.parentElement;
  }
  return null;
}

function hasMarker(node, name) {
  return typeof node.hasAttribute === "function" && node.hasAttribute(`data-tt-${name}`);
}

export function gestureMode(target, root, { panelRoot = null, limit = WALK_LIMIT } = {}) {
  let node = target && target.nodeType === 1 ? target : null;
  for (let i = 0; node && node !== root && i < limit; i++) {
    if (hasMarker(node, "pan")) return GESTURE.pan;
    if (hasMarker(node, "select")) return GESTURE.select;
    const reason = blockingReason(node);
    if (reason) return GESTURE.blocked;
    if (node.parentElement !== panelRoot && scrollableX(node)) return GESTURE.blocked;
    node = node.parentElement;
  }
  return GESTURE.view;
}

// 换页时拖动中的实际位移：越出首/尾之后按阻尼衰减，松手时再回弹。
// 注意 step 是“一屏 + 面板间距”，不是屏宽：两者不等的时候（有间距）用错就会整体偏移。
export function dragOffset({ index, count, step, dx, rubber = RUBBER }) {
  const min = -(count - 1) * step;
  const wanted = -index * step + dx;
  if (wanted > 0) return wanted * rubber;
  if (wanted < min) return min + (wanted - min) * rubber;
  return wanted;
}

// 松手落到第几块。一次最多一块：甩得再狠也只翻一格，宁可稳一点也不要不听话。
export function settleTarget({ index, count, dx, velocity = 0, step, snapRatio = SNAP_RATIO, snapVelocity = SNAP_VELOCITY }) {
  const flick = Math.abs(velocity) > snapVelocity || Math.abs(dx) > step * snapRatio;
  const stepDelta = flick ? (dx < 0 ? 1 : -1) : 0;
  return Math.min(count - 1, Math.max(0, index + stepDelta));
}

// 接线部分：只做事件编排，判定全用上面的纯函数。
export function createViewGestures({ mainEl, trackEl, count, getIndex, onChange, onClaim } = {}) {
  if (!mainEl || !trackEl || typeof count !== "number" || count < 2) return { dispose() {} };
  const doc = mainEl.ownerDocument;
  const win = doc.defaultView || window;
  let drag = null;

  // 一屏 + 面板间距 = 位移的步长。间距定义在 CSS 变量上，这里读同一份，不另写一个数字。
  const gapOf = () => {
    const raw = win.getComputedStyle(trackEl).getPropertyValue("--tt-track-gap");
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const stepOf = () => (mainEl.clientWidth || 1) + gapOf();

  // 接管过的那次手势，松手后会补一个 click（鼠标立刻、触摸约 300ms 后）。
  // 那个 click 是“拖完手一松”，不该被当成点了落点上的东西，所以吃掉一次。
  function swallowNextClick() {
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    doc.addEventListener("click", swallow, { capture: true, once: true });
    win.setTimeout(() => doc.removeEventListener("click", swallow, true), 400);
  }

  function listen(on) {
    const fn = win[on ? "addEventListener" : "removeEventListener"].bind(win);
    fn("pointermove", onMove, true);
    fn("pointerup", onUp, true);
    fn("pointercancel", onUp, true);
  }

  function onDown(e) {
    if (drag) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const mode = gestureMode(e.target, mainEl, { panelRoot: trackEl });
    if (mode === GESTURE.blocked || mode === GESTURE.select) return;   // 这两类一律不接
    drag = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      lastX: e.clientX, lastT: e.timeStamp, velocity: 0,
      axis: "none", claimed: false, dx: 0, mode, startTarget: e.target,
      index: getIndex(), step: stepOf(), surface: null, left: 0, top: 0,
    };
    listen(true);
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;

    // 图表平移：两个轴都算，到门槛就接管，然后逐帧写 scrollLeft/scrollTop。
    if (drag.mode === GESTURE.pan) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_START_PX) return;
      if (!drag.claimed) {
        drag.surface = nearestScroller(drag.startTarget, mainEl);
        if (!drag.surface) { drag = null; listen(false); return; }   // 没得可拖：交回浏览器
        drag.left = drag.surface.scrollLeft;
        drag.top = drag.surface.scrollTop;
        drag.claimed = true;
        drag.surface.classList.add("tt-panning");
        try { mainEl.setPointerCapture(drag.id); } catch { /* 合成事件没有真实指针，忽略 */ }
      }
      e.preventDefault();
      drag.surface.scrollLeft = drag.left - dx;
      drag.surface.scrollTop = drag.top - dy;
      return;
    }

    // 换页：先判轴向，判成纵向就整个交还给面板自己滚。
    if (!drag.claimed) {
      drag.axis = decideAxis(dx, dy);
      if (drag.axis === "y") { drag = null; listen(false); return; }
      if (drag.axis !== "x") return;
      drag.claimed = true;
      drag.index = getIndex();
      drag.step = stepOf();
      trackEl.classList.add("tt-no-anim");   // 拖动期间关掉过渡，位移由我们逐帧写
      mainEl.classList.add("tt-dragging");
      onClaim?.();                            // 收掉还开着的浮层（文字选中由 CSS 管）
      try { mainEl.setPointerCapture(drag.id); } catch { /* 合成事件没有真实指针，忽略 */ }
    }
    e.preventDefault();
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.velocity = (e.clientX - drag.lastX) / dt;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    drag.dx = dx;
    trackEl.style.transform = `translateX(${Math.round(dragOffset({ index: drag.index, count, step: drag.step, dx }))}px)`;
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const current = drag;
    drag = null;
    listen(false);
    if (!current.claimed) return;         // 没接管：点击照旧
    swallowNextClick();                   // 拖完手一松补的那个 click 不算“点了落点上的东西”
    if (current.mode === GESTURE.pan) {
      current.surface?.classList.remove("tt-panning");
      return;                             // 平移不换页
    }
    mainEl.classList.remove("tt-dragging");
    trackEl.classList.remove("tt-no-anim");   // 交回过渡，下面这次的位移就是吸附动画
    onChange(settleTarget({ index: current.index, count, dx: current.dx, velocity: current.velocity, step: current.step }));
  }

  mainEl.addEventListener("pointerdown", onDown, true);
  return {
    dispose() {
      drag = null;
      listen(false);
      mainEl.removeEventListener("pointerdown", onDown, true);
    },
  };
}
