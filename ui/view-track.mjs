// 视图手势（真滑轨的第二半）：拖拽换页 + 图表就地平移。
// 这里只做两件事：① 判定这一摊手势属于谁（gestureMode 及其配套纯函数）；
//               ② 算位移与落点（dragOffset / settleTarget）。
// 真正的换页交给宿主调 selectView：页签高亮、inert、aria-hidden、懒加载只有那一条路。
//
// 手势归属（从按下点往上走，就近优先）：
//   data-tt-pan    图表里“按住可拖”的区域 → 平移它所在的可滚容器（不换页、不抢选字）
//   data-tt-select 图表里的文字区 → 什么都不做，把选中、双击这些交回浏览器
//   data-tt-view   明确声明“这里就是换页拖拽面”（即使它本身/祖先是个横滚容器也照拖）
//   表单控件 / 面板分割条 / 可编辑区 / 别的真能横滚的容器 → 什么都不做
//   其余（面板空白处、KPI 块…）→ 拖拽换页
// 面板那一层（轨道的直接子节点）不算“横滚容器”：它本身就是换页手势的落脚面，
// 把它当成要谦让的滚动区，整个看板就都拖不动了。
//
// 为什么用声明式属性而不是“看它能不能滚”去猜：能不能滚取决于内容宽度，
// 同一个图在不同时间范围下时能滚时不能滚，手势归属就会时好时坏。
// data-tt-view 就是给这种“内容宽度会变、但用途固定”的地方留的明确出口。

export const DRAG_START_PX = 8;     // 超过这个位移才判方向；低于它一律当点击
export const AXIS_RATIO = 1.2;      // 换页时横向位移要明显大于纵向才算横拖
export const SNAP_RATIO = 0.25;     // 位移超过 1/4 步长就翻页
export const SNAP_VELOCITY = 0.5;   // px/ms；甩得够快也翻页
export const RUBBER = 0.35;         // 换页时两端的阻尼系数：拖得动，但拖不远
// 松手后那段吸附过渡：基准时长、下限上限，以及“手多快算快”（px/ms）。
export const SETTLE_BASE_MS = 280;
export const SETTLE_MIN_MS = 110;
export const SETTLE_MAX_MS = 320;
export const SETTLE_REF_SPEED = 0.6;
// 快速用得更“陡”的曲线：缓入段几乎为零，接得上松手那一下的速度。
export const FLICK_EASING = "cubic-bezier(.08,.72,.12,1)";
const WALK_LIMIT = 24;              // 往上最多查这么多层

// 拖拽跟手时的平滑：画面不去死跟指针，而是追一个略微滞后的目标。
// 指针速度天然不平滑（人手抖、鼠标采样跳变），1:1 跟手等于把这些抖动原样传给画面；
// 这里让它以 50ms 的时常数收敛，并允许最多落后 12px（约一屏的 1.6%）
// —— 手指的抖动被抹平，匀速部分的速度依旧保留，只是整体晚一点。
export const SMOOTH_TAU_MS = 50;
export const SMOOTH_MAX_LAG = 12;

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
    if (hasMarker(node, "view")) return GESTURE.view;
    const reason = blockingReason(node);
    if (reason) return GESTURE.blocked;
    if (node.parentElement !== panelRoot && scrollableX(node)) return GESTURE.blocked;
    node = node.parentElement;
  }
  return GESTURE.view;
}

// 换页时拖动中的实际位移：越出首/尾之后按阻尼衰减，松手时再回弹。
// 注意 step 是“一屏 + 面板间距”，不是屏宽：两者不等的时候（有间距）用错就会整体偏移。
// from 是“眼睛看到的位置”（轨道当前的 translateX）。默认按 -index*step 算；
// 传 from 是因为上一次切页的过渡可能还在跑，从目标值算起会让第一帧跳一下。
export function dragOffset({ index, count, step, dx, rubber = RUBBER, from = -index * step }) {
  const min = -(count - 1) * step;
  const wanted = from + dx;
  if (wanted > 0) return wanted * rubber;
  if (wanted < min) return min + (wanted - min) * rubber;
  return wanted;
}

// 拖拽跟手的平滑一步：在 dt 毫秒里朝着 target 收敛，但落后不超过 maxLag。
// dt 很大（比如停了一会儿）就自然追上；dt≤0 不推进，但也不允许越出上限。
function clampLag(shown, target, maxLag) {
  const lag = shown - target;
  if (lag > maxLag) return target + maxLag;
  if (lag < -maxLag) return target - maxLag;
  return shown;
}

export function smoothStep({ shown = 0, target = 0, dt = 0, tau = SMOOTH_TAU_MS, maxLag = SMOOTH_MAX_LAG } = {}) {
  if (!(dt > 0)) return clampLag(shown, target, maxLag);
  const alpha = 1 - Math.exp(-dt / tau);
  return clampLag(shown + (target - shown) * alpha, target, maxLag);
}

// 松手后这段过渡走多久。为什么不是固定 280ms：固定时长等于“手一松就刹住、再重播一段动画”，
// 手感上就是被接管了一下。这里让手越快、要走的距离越短，这段就越短。
// distance 是抬手后还要走的距离（px）；step 是一屏加间距。
export function settleDuration({
  velocity = 0, distance = 0, step = 1,
  base = SETTLE_BASE_MS, min = SETTLE_MIN_MS, max = SETTLE_MAX_MS, refSpeed = SETTLE_REF_SPEED,
} = {}) {
  const speed = Math.abs(velocity);
  const speedFactor = speed > refSpeed ? refSpeed / speed : 1;              // 甩得快→更短
  const ratio = step > 0 ? Math.abs(distance) / step : 1;
  const distFactor = Math.min(1, Math.max(0.35, ratio));                    // 只差一点点→更短
  return Math.round(Math.min(max, Math.max(min, base * speedFactor * distFactor)));
}

// 松手落到第几块。一次最多一块：甩得再狠也只翻一格，宁可稳一点也不要不听话。
export function settleTarget({ index, count, dx, velocity = 0, step, snapRatio = SNAP_RATIO, snapVelocity = SNAP_VELOCITY }) {
  const flick = Math.abs(velocity) > snapVelocity || Math.abs(dx) > step * snapRatio;
  const stepDelta = flick ? (dx < 0 ? 1 : -1) : 0;
  return Math.min(count - 1, Math.max(0, index + stepDelta));
}

// 顶部控件区里的控件（页签、胶囊、下拉触发器、日期字段…）不当拖拽面：
// 在它们身上按住拖动应该没反应，而不是把整块看板拖走。
// 只对“滑轨区之外”用这条：滑轨区里的按钮自己会用 data-tt-pan / data-tt-select 声明。
const CONTROL_SELECTOR = "button, a[href], summary, label, [role='button'], input, select, textarea";
export function isControl(el) {
  return !!(el && typeof el.closest === "function" && el.closest(CONTROL_SELECTOR));
}

// 接线部分：只做事件编排，判定全用上面的纯函数。
export function createViewGestures({ mainEl, trackEl, bindEl, count, getIndex, onChange, onClaim } = {}) {
  if (!mainEl || !trackEl || typeof count !== "number" || count < 2) return { dispose() {} };
  const doc = mainEl.ownerDocument;
  const win = doc.defaultView || window;
  // 监听挂在哪一层：默认只挂滑轨区，传 bindEl 可以扩到整个 App 容器。
  // 顶部控件区（范围胶囊、筛选排、页签）在滑轨区**外面**，只挂 mainEl 的话在那边按下根本收不到事件。
  const surfaceEl = bindEl || mainEl;
  let drag = null;

  // 轨道当前“眼睛看到”的位移（过渡跑到一半时就是中间值）。
  function currentTranslate(el) {
    let t = "";
    try { t = win.getComputedStyle(el).transform; } catch { /* 量不到就当 0 */ }
    if (!t || t === "none") return 0;
    const m = /matrix\(([^)]+)\)/.exec(t);
    if (m) { const p = m[1].split(","); return parseFloat(p[4]) || 0; }
    const m3 = /matrix3d\(([^)]+)\)/.exec(t);
    if (m3) { const p = m3[1].split(","); return parseFloat(p[12]) || 0; }
    return 0;
  }

  // 位置直接写，不做 rAF 合并。为什么：写 style.transform 本身很便宜，
  // 浏览器本来就按帧批量处理样式；而多一层延迟在后台标签页（rAF 被节流、甚至不回调）
  // 时会变成真问题。这里只做一件事：值没变就不写。
  function writeJob(job) {
    if (job.kind === "pan") {
      if (job.surface) { job.surface.scrollLeft = job.left; job.surface.scrollTop = job.top; }
    } else {
      trackEl.style.transform = `translateX(${job.x}px)`;
    }
  }

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
    const target = e.target;
    // 滑轨区之外的控件（顶部/筛选排里的按钮、下拉、日期字段）不接：按住拖动本来就没意义。
    if (!mainEl.contains(target) && isControl(target)) return;
    const mode = gestureMode(target, mainEl, { panelRoot: trackEl });
    if (mode === GESTURE.blocked || mode === GESTURE.select) return;   // 这两类一律不接
    drag = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      lastX: e.clientX, lastT: e.timeStamp, velocity: 0,
      axis: "none", claimed: false, dx: 0, mode, startTarget: target,
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
        // 认领这刻已经走掉的距离不再算进来：否则第一帧会把“门槛之前那段”一次性补上（弹一下）。
        drag.originX = dx;
        drag.originY = dy;
        drag.surface.classList.add("tt-panning");
        // 合成事件（验收台里造的）没有真实指针，setPointerCapture 会抛 NotFoundError；
        // 只有真指针才需要它，判 isTrusted 比吞异常干净。
        if (e.isTrusted) { try { mainEl.setPointerCapture(drag.id); } catch { /* 指针已消失 */ } }
      }
      e.preventDefault();
      const mx = dx - drag.originX, my = dy - drag.originY;
      const left = drag.left - mx, top = drag.top - my;
      if (drag.wroteLeft !== left || drag.wroteTop !== top) {
        drag.wroteLeft = left;
        drag.wroteTop = top;
        writeJob({ kind: "pan", surface: drag.surface, left, top });
      }
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
      // 从眼睛看到的位置接着拖：上次切页的过渡可能还在跑，从 -index*step 算起会跳一下。
      drag.from = currentTranslate(trackEl);
      // 同上：门槛之前那段不算位移，认领之后才从 0 开始跟手。
      drag.originX = dx;
      drag.originY = dy;
      drag.wrote = null;
      trackEl.classList.add("tt-no-anim");   // 拖动期间关掉过渡，位移由我们逐帧写
      mainEl.classList.add("tt-dragging");
      onClaim?.();                            // 收掉还开着的浮层（文字选中由 CSS 管）
      if (e.isTrusted) { try { mainEl.setPointerCapture(drag.id); } catch { /* 指针已消失 */ } }
    }
    e.preventDefault();
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.velocity = (e.clientX - drag.lastX) / dt;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    drag.dx = dx - drag.originX;
    const x = Math.round(dragOffset({ index: drag.index, count, step: drag.step, dx: drag.dx, from: drag.from }));
    if (drag.wrote !== x) {
      drag.wrote = x;
      writeJob({ kind: "view", x });
    }
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
    const target = settleTarget({ index: current.index, count, dx: current.dx, velocity: current.velocity, step: current.step });
    // 抬手后还要走多远：从“眼睛看到的位置”到吸附点。
    const distance = -target * current.step - (current.from + current.dx);
    const duration = settleDuration({ velocity: current.velocity, distance, step: current.step });
    const easing = Math.abs(current.velocity) > SNAP_VELOCITY ? FLICK_EASING : "";
    onChange(target, { duration, easing });
  }

  surfaceEl.addEventListener("pointerdown", onDown, true);
  return {
    dispose() {
      drag = null;
      listen(false);
      surfaceEl.removeEventListener("pointerdown", onDown, true);
    },
  };
}
