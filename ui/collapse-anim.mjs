// 元素「从零展开 / 收成零」的过渡层。
//
// 参考实现是 git-save-load 主卡片里的变更文件列表（ui/assets/git/list-anim.mjs）。
// 那边把一套很有意思的取舍跑通了，这里照搬结论，并把理由留在代码里：
//
//   1. **不用 FLIP 自己补位移。**
//      这些都是普通流元素，展开 / 收起时浏览器会连续推动下方内容。
//      自己再算一遍「旧位置 → 新位置」的位移，等于和浏览器比着改 transform，
//      结果就是推挤一顿一卡。让布局自己动，只负责把高度过渡好。
//
//   2. **高度之外还要带上 padding / margin / opacity。**
//      只动 height 的话，元素那几像素的内外边距会在动画首尾各跳一下 ——
//      肉眼看就是「顿两下」，比不做动画还糟。
//
//   3. **起点要「提交」一帧再改目标值。**
//      同一个任务里先写 height:0 再写 height:auto，浏览器会把两次变更合并，
//      只算最终值，过渡根本不会播。中间必须强制读一次布局。
//
//   4. **收成零之后再摘，别中途 display:none。**
//      中途隐藏会直接把过渡掐掉，看起来是「唰」一下消失而不是「缩回去」。
//
// 与参考实现的差异：那边用 CSS transition，这里也用 transition（不是 WAAPI）。
// 原因是 WAAPI 要自己管 fill 的前后态，上一轮刚在 `fill:"forwards"` 上栽过一次；
// transition 播完就是播完了，不留尾巴。

/** 一起过渡的属性。少一个都会在首尾跳一下。
 *
 *  边框与内边距也必须算进来：把 height 收到 0 之后，
 *  `padding: 10px 12px` 加 1px 边框仍然会留下一条 22px 高的空框。
 *  参考实现只带了 padding / margin，因为它的行本来没有边框；
 *  我们这个批量栏有边框，所以 border-*-width 也得跟。
 */
export const MORPH_PROPS = [
  "height",
  "padding-top",
  "padding-bottom",
  "margin-top",
  "margin-bottom",
  "border-top-width",
  "border-bottom-width",
  "opacity",
];

/** 展开 / 收起各自的时长（ms）。收比开略快：收起是「让路」，不该比出现更拖沓。 */
export const EXPAND_MS = 300;
export const COLLAPSE_MS = 240;

/** 力保 transitionend 一定被收尾的兜底余量（ms）。 */
const TAIL_MS = 140;

/** 用户要求减弱动效时不播动画。 */
export function prefersReducedMotion(win) {
  try {
    const w = win || (typeof window !== "undefined" ? window : null);
    return !!w && typeof w.matchMedia === "function"
      && w.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * 把一组属性的过渡声明拼出来。
 * 单独一个函数是为了让时长与缓动只有一处出处，测试也能直接对比字符串。
 */
export function morphTransition(ms, easing = "cubic-bezier(0.22, 0.61, 0.36, 1)") {
  return MORPH_PROPS.map((p) => `${p} ${ms}ms ${easing}`).join(", ");
}

/** 清掉本模块写过的内联值，把元素交回 CSS。 */
export function clearMorph(node) {
  if (!node || !node.style) return;
  const s = node.style;
  s.transition = "";
  s.height = "";
  s.overflow = "";
  s.boxSizing = "";
  s.opacity = "";
  s.paddingTop = "";
  s.paddingBottom = "";
  s.marginTop = "";
  s.marginBottom = "";
  s.borderTopWidth = "";
  s.borderBottomWidth = "";
}

/** 强制读一次布局，让刚写入的起始值落地。 */
function commit(node) {
  // 读一个会触发重排的属性即可；取值本身没用，作用是把样式刷下去。
  void node.offsetHeight;
}

/**
 * 量元素的**自然高度**，即「不受本模块写的那几个内联值影响时的真实高度」。
 *
 * 为什么不能直接 getBoundingClientRect：元素可能正带着上一次收起留下的
 * `height:0 / overflow:hidden`。此时直接量，得到的是那个被压扁的值（实测 22px,
 * 只有边框加内边距）—— 于是动画就从 0 补到 22，看着像「卡了一下才跳开」。
 *
 * 所以临时摘掉这几个内联值、量完再原样放回去。摘/放都发生在同一个任务里，
 * 中间没有让浏览器绘帧，用户看不到闪。
 */
export function measureNaturalHeight(node) {
  if (!node || !node.style) return 0;
  const s = node.style;
  const saved = {
    height: s.height,
    overflow: s.overflow,
    opacity: s.opacity,
    paddingTop: s.paddingTop,
    paddingBottom: s.paddingBottom,
    marginTop: s.marginTop,
    marginBottom: s.marginBottom,
    borderTopWidth: s.borderTopWidth,
    borderBottomWidth: s.borderBottomWidth,
  };
  s.height = "";
  s.overflow = "";
  s.opacity = "";
  s.paddingTop = "";
  s.paddingBottom = "";
  s.marginTop = "";
  s.marginBottom = "";
  s.borderTopWidth = "";
  s.borderBottomWidth = "";
  commit(node);
  const h = node.getBoundingClientRect().height;
  // 原样放回（包括放回那些原本就是空串的）
  for (const [k, v] of Object.entries(saved)) s[k] = v;
  commit(node);
  return h;
}

/**
 * 收尾只干一次。
 *
 * 为什么要双保险：transitionend 在某些情况下不会来 ——
 * 元素中途被 display:none、属性在动画期间被改写、或者浏览器判定没有实际位移。
 * 只等事件就会留下一个「永远停在半高、再也收不回去」的残骸。
 */
function onceEnd(node, ms, done) {
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    node.removeEventListener?.("transitionend", onEnd);
    done();
  };
  const onEnd = (e) => {
    // 只认 height 的那一条：padding / margin / opacity 各会各发一次事件，
    // 谁先到都算结束的话清理就跑早了，剩下的属性动画到一半被掐断。
    if (e && e.propertyName && e.propertyName !== "height") return;
    finish();
  };
  node.addEventListener?.("transitionend", onEnd);
  const w = typeof window !== "undefined" ? window : globalThis;
  w.setTimeout(finish, Math.max(0, ms) + TAIL_MS);
  return finish;
}

/**
 * 从零展开到自然高度。
 *
 * 调用前元素必须处于**自然态**（没有内联 height 压着）。
 * 这一条不是接口洁癖：元素若还带着 height:0，量到的高度就是 0，
 * 于是这里会以为「没什么可播的」直接落地 —— 看上去就是「悄悄出现、没有过渡」。
 * 如果调用方刚改过内联值（比如刚把 height:"" 抹掉），必须先强制一次布局，
 * 否则这里读到的是旧值。直接读 getBoundingClientRect 实测会拿到那个 22px ——
 * 只有边框和内边距，内容完全没算进去。下面先 void offsetHeight 再量，就是为了这个。
 *
 * @returns {boolean} 是否真的播了动画（false 表示即时切换）
 */
export function expandFromZero(node, { ms = EXPAND_MS, easing, reduced } = {}) {
  if (!node || !node.style) return false;
  const skip = reduced !== undefined ? reduced : prefersReducedMotion();

  const h = measureNaturalHeight(node);
  if (skip || !h) {
    clearMorph(node);
    return false;
  }

  node.style.boxSizing = "border-box";
  node.style.overflow = "hidden";
  node.style.height = "0px";
  node.style.paddingTop = "0px";
  node.style.paddingBottom = "0px";
  node.style.marginTop = "0px";
  node.style.marginBottom = "0px";
  node.style.borderTopWidth = "0px";
  node.style.borderBottomWidth = "0px";
  node.style.opacity = "0";
  commit(node);

  node.style.transition = morphTransition(ms, easing);
  node.style.height = `${h}px`;
  // 置空即回到 CSS 里的自然值，由过渡补间过去。
  node.style.paddingTop = "";
  node.style.paddingBottom = "";
  node.style.marginTop = "";
  node.style.marginBottom = "";
  node.style.borderTopWidth = "";
  node.style.borderBottomWidth = "";
  node.style.opacity = "";

  onceEnd(node, ms, () => clearMorph(node));
  return true;
}

/**
 * 收成零。结束后执行 onGone（用来把元素真正藏起来 / 摘掉）。
 *
 * 注意 onGone 是**动画结束后**才调的：中途隐藏会把过渡直接掐掉。
 *
 * @returns {boolean} 是否真的播了动画
 */
export function collapseToZero(node, { ms = COLLAPSE_MS, easing, reduced, onGone } = {}) {
  if (!node || !node.style) return false;
  const skip = reduced !== undefined ? reduced : prefersReducedMotion();

  const h = measureNaturalHeight(node);
  const done = () => {
    clearMorph(node);
    if (typeof onGone === "function") onGone();
  };
  if (skip || !h) {
    done();
    return false;
  }

  node.style.boxSizing = "border-box";
  node.style.overflow = "hidden";
  node.style.height = `${h}px`;
  commit(node);

  node.style.transition = morphTransition(ms, easing);
  node.style.height = "0px";
  node.style.paddingTop = "0px";
  node.style.paddingBottom = "0px";
  node.style.marginTop = "0px";
  node.style.marginBottom = "0px";
  node.style.borderTopWidth = "0px";
  node.style.borderBottomWidth = "0px";
  node.style.opacity = "0";

  onceEnd(node, ms, done);
  return true;
}
