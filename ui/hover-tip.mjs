// 悬停提示：自绘的小浮层，替代浏览器原生 title。
//
// 为什么不用 title：那套提示框是系统配色，深色卡片上会突然浮出一块
// 完全不属于这套界面的东西，而且各家平台长得都不一样。
//
// 为什么挂到 body 而不是用 ::after：
//   触发元素常常带 overflow: hidden（模型名要截断长名字），
//   ::after 会被那个 overflow 一起裁掉。挂 body 才不会被任何祖先容器剪。
//
// 样式在 ui/hover-tip.css 的 .tts-hovertip 一节。同一时刻最多一个浮层。
import { h } from "./components.mjs";

let tipEl = null;
let showTimer = null;
let owner = null;
// 正等着浮现的那一个。计时器是全局共用的，解绑时得先确认「等的是不是自己」，
// 否则清掉的是别人的计时（B 还在等浮现，A 被回收顺手把 B 的 timer 抹了）。
let pendingTarget = null;

// 绑在这个属性上的解绑函数，用来保证「一个元素只有一条绑定」。
const BINDING = Symbol("ttHoverTip");

// 所有还活着的绑定，每条是 { target, cleanup }。
//
// 为什么是一张表、一个 window 监听，而不是每个元素各挂一个：
//   色带图一天 24 格、热力格一天 24 格，多天下来就是几百个元素，每个都往 window 上
//   挂一个捕获阶段的 scroll 监听，滚动一次就要跑几百个回调，明显掉帧。
//   现在整页只有下面 onScroll 这一个，滚动的代价与提示数量无关。
const instances = new Set();
let scrollBound = false;

// 回收定时器：见 onScroll 里的说明。
const SWEEP_DELAY = 240;
let sweepTimer = null;

function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
}

function ensureTip() {
  if (!tipEl || !tipEl.isConnected) {
    tipEl = h("div", { className: "tts-hovertip", role: "tooltip" });
    document.body.append(tipEl);
  }
  return tipEl;
}

/** 放在触发元素下方居中；下方放不下就翻到上面；左右夹在视口内。 */
function place(target, tip) {
  const r = target.getBoundingClientRect();
  const gap = 8;
  // 先隐藏量一次尺寸，避免在错误位置闪一下。
  tip.style.left = "0px";
  tip.style.top = "0px";
  tip.style.visibility = "hidden";
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  // 默认在下方：一行行排着的时候，上方那块通常还压着上一行的内容，
  // 浮层弹上去会盖住别人；下方就是这一行自己的延伸方向，看着顺。
  let top = r.bottom + gap;
  if (top + hgt > window.innerHeight - 6) top = r.top - hgt - gap;
  const maxLeft = Math.max(6, window.innerWidth - w - 6);
  left = Math.min(Math.max(6, left), maxLeft);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.visibility = "";
}

function hide() {
  clearTimers();
  owner = null;
  pendingTarget = null;
  if (!tipEl) return;
  const node = tipEl;
  tipEl = null;
  node.classList.remove("is-in");
  // 等淡出再摘，避免「啪」地消失。
  // 这个计时器不归 clearTimers 管：淡出中的节点已经在退场，下一次悬停若把计时
  // 一并取消，它就永远留在 DOM 里了（原来那段代码有这一手，只是提示少不明显）。
  setTimeout(() => node.remove(), 120);
}

/**
 * 把触发元素已经掉出文档的那几条解绑。
 *
 * 为什么还要这一步：原先每个绑定自己带一个 window scroll 监听，元素被换掉之后
 * 那个监听永远活着、闭包里又攥着废弃节点，滑过几屏就能积出一堆死监听 —— 所以当时
 * 是「一发现元素掉出文档就地解绑」，顺手把浮层收掉。
 *
 * 监听已经收成一个共享的，越积越多的那条理由不存在了；剩下的只是这张表本身会把
 * 废弃元素留在内存里（重画一次就换一批新节点）。所以回收保留，但降级成「成批扫一次」，
 * 不再跟着每一次滚动跑。
 */
function sweep() {
  for (const record of instances) {
    if (record.target.isConnected) { record.seen = true; record.misses = 0; continue; }
    // 曾经在树上、现在不在了 = 确实被换掉了，就地解绑。
    if (record.seen) { record.cleanup(); continue; }
    // 从没进过文档的不当废弃：调用方可能先建好、下一拍才挂上去（筛选条、价格卡的整块）。
    // 但不能无限留着，扫过 20 轮还没进过树，就当它确实不会来了。
    if (++record.misses > 20) record.cleanup();
  }
}

function scheduleSweep() {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => { sweepTimer = null; sweep(); }, SWEEP_DELAY);
}

// 整个页面唯一的 scroll 监听。
//
// 滚动、按下鼠标都收起浮层：它是 fixed，跟着滚会脱位。
// 这里只做一件事 —— 收掉当前显示的那个（O(1)），然后把回收排到滚动停稳之后。
// 不在这一帧里扫全表：滚动一秒能触发上百次，每次扫几百条等于把「几百个监听」
// 原样换个地方，等于没改。
function onScroll() {
  // 连「还差几十毫秒就浮现」的那个也一起撤：滚过之后触发元素已经挪了位置，
  // 这时候再弹出来就贴在旧坐标上了。
  if (owner || pendingTarget) hide();
  if (instances.size) scheduleSweep();
}

function bindShared() {
  if (scrollBound) return;
  scrollBound = true;
  window.addEventListener("scroll", onScroll, true);
}

// 一条绑定都不剩时把监听也摘掉：页面重建 / 整页关掉之后不留悬空回调。
function unbindShared() {
  if (!scrollBound) return;
  scrollBound = false;
  window.removeEventListener("scroll", onScroll, true);
}

/**
 * 给元素挂一个悬停提示。
 *
 * render() 返回节点或字符串，延迟 delay 毫秒后浮现。
 * 返回一个解绑函数；元素被移除时浮层也会自己收掉（显示前查一次 isConnected）。
 */
export function attachHoverTip(target, render, { delay = 420 } = {}) {
  // 同一个元素只留一条绑定。upgradeTitles 本身是幂等的，但有的地方文案会被重画后
  // 再赋一次 title（analytics 里那两颗「为什么点不了」的按钮），再扫一遍就会给同一
  // 个元素挂上第二条，悬停时叠出两个浮层。旧绑定先解掉，新文案顶替它。
  const prev = target[BINDING];
  if (typeof prev === "function") prev();

  const onEnter = () => {
    clearTimers();
    pendingTarget = target;
    showTimer = setTimeout(() => {
      showTimer = null;
      pendingTarget = null;
      if (!target.isConnected) return;
      hide();               // 换人时先收上一个，同一时刻只留一个
      const content = typeof render === "function" ? render() : render;
      const parts = Array.isArray(content) ? content.filter((x) => x != null) : (content == null ? [] : [content]);
      // 没话可说就不弹（analytics 里那两个按钮“可点”时文案是空串）：
      // 否则会在触发元素旁边跳出一个空的小方块。
      if (!parts.length) return;
      const tip = ensureTip();
      tip.replaceChildren(...parts);
      place(target, tip);
      // 下一帧再上类，否则元素刚插入就带 opacity 终值，过渡不成立。
      requestAnimationFrame(() => tip.classList.add("is-in"));
      owner = target;
    }, delay);
  };
  const onLeave = () => { if (owner === target || pendingTarget === target) hide(); };

  function cleanup() {
    // 只收回属于自己的那一份：别人正在显示 / 正在等浮现，不该被这条解绑牵连。
    if (owner === target || pendingTarget === target) hide();
    target.removeEventListener("mouseenter", onEnter);
    target.removeEventListener("mouseleave", onLeave);
    target.removeEventListener("mousedown", onLeave);
    instances.delete(record);
    if (target[BINDING] === cleanup) target[BINDING] = null;
    if (!instances.size) unbindShared();
  }

  const record = { target, cleanup, seen: target.isConnected, misses: 0 };

  target.addEventListener("mouseenter", onEnter);
  target.addEventListener("mouseleave", onLeave);
  target.addEventListener("mousedown", onLeave);
  bindShared();
  instances.add(record);
  target[BINDING] = cleanup;
  // 这一批挂完顺手排一次回收：重画产生的是新节点，上一批已经掉出文档，
  // 扫一次就把它们清掉，免得表跟着每次重画一直长。
  scheduleSweep();

  return cleanup;
}

/** 页面整体收掉（比如设置页整块重建前）。
 *
 * 传了 root 就只收「正悬停在那块子树里」的那一个：看板里实时监控每 5 秒重画、
 * 体检块也会单独重画，不该把读者正在别处看的那一条一起抹掉。 */
export function closeHoverTip(root = null) {
  if (!root || typeof root.contains !== "function") { hide(); return; }
  const live = owner || pendingTarget;
  if (live && !root.contains(live)) return;
  hide();
}

/**
 * 把一棵子树里的原生 title 统一升级成自绘浮层。
 *
 * 做法是「把 title 当数据源，读完就摘掉」：调用方不用逐处改成 data-tip，
 * 原先写 title 的地方保持原样，将来新加的也自动生效。
 *
 * 为什么不能提前摘：有些元素每次重画都是新节点，也会带 title；
 * 而这个函数幂等 —— 已经摘过的元素扫不到 title，不会重复挂监听。
 *
 * 多行 title 按行拆开，每行一个 div。
 */
export function upgradeTitles(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const el of root.querySelectorAll("[title]")) {
    const text = String(el.getAttribute("title") || "").trim();
    el.removeAttribute("title");
    if (!text) {
      // 空串 = 这个元素不需要提示了（色带图那四颗开关可点时会把文案清空）。
      // 得把上一条绑定撤掉：不撤的话，悬停还会弹出上一帧那句“为什么点不了”。
      if (typeof el[BINDING] === "function") el[BINDING]();
      continue;
    }
    // 摘掉 title 会把读屏用户的可及名一起摘掉（输入框尤甚：四格长得一模一样，
    // 没有名字就分不出谁是「输入」谁是「输出」）。这里补一个 aria-label ——
    // 只补没有的，不覆盖调用方已经写好的。
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
      el.setAttribute("aria-label", text.replace(/\n+/g, "，"));
    }
    const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    attachHoverTip(el, () => lines.map((line) => h("div", { className: "tts-hovertip__line" }, line)));
  }
}
