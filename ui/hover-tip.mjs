// 悬停提示：自绘的小浮层，替代浏览器原生 title。
//
// 为什么不用 title：那套提示框是系统配色，深色卡片上会突然浮出一块
// 完全不属于这套界面的东西，而且各家平台长得都不一样。
//
// 为什么挂到 body 而不是用 ::after：
//   触发元素常常带 overflow: hidden（模型名要截断长名字），
//   ::after 会被那个 overflow 一起裁掉。挂 body 才不会被任何祖先容器剪。
//
// 样式在 settings.css 的 .tts-hovertip 一节。同一时刻最多一个浮层。
import { h } from "./components.mjs";

let tipEl = null;
let showTimer = null;
let hideTimer = null;
let owner = null;

function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
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
  if (!tipEl) return;
  const node = tipEl;
  tipEl = null;
  node.classList.remove("is-in");
  // 等淡出再摘，避免「啪」地消失。
  hideTimer = setTimeout(() => { node.remove(); hideTimer = null; }, 120);
}

/**
 * 给元素挂一个悬停提示。
 *
 * render() 返回节点或字符串，延迟 delay 毫秒后浮现。
 * 返回一个解绑函数；元素被移除时浮层也会自己收掉（每次显示前查一次 isConnected）。
 */
export function attachHoverTip(target, render, { delay = 420 } = {}) {
  const onEnter = () => {
    clearTimers();
    showTimer = setTimeout(() => {
      showTimer = null;
      if (!target.isConnected) return;
      hide();               // 换人时先收上一个，同一时刻只留一个
      const tip = ensureTip();
      tip.replaceChildren();
      const content = typeof render === "function" ? render() : render;
      if (Array.isArray(content)) tip.append(...content);
      else if (content != null) tip.append(content);
      place(target, tip);
      // 下一帧再上类，否则元素刚插入就带 opacity 终值，过渡不成立。
      requestAnimationFrame(() => tip.classList.add("is-in"));
      owner = target;
    }, delay);
  };
  const onLeave = () => { if (owner === target || showTimer) hide(); };

  // 滚动、按下鼠标都收起：浮层是 fixed，跟着滚会脱位。
  //
  // 这个监听器还兼任回收：卡片每次重画，触发元素是新节点，
  // mouseleave 永远不会再发，而 window 上的 scroll 监听会一直活着，
  // 闭包里又攥着已经废弃的节点。所以一旦发现元素掉出文档，
  // 就地解绑并收掉浮层 —— 否则滑过几个价格卡就能积出一堆死监听。
  function onScroll() {
    if (!target.isConnected) { cleanup(); return; }
    if (owner === target) hide();
  }

  function cleanup() {
    if (owner === target) hide();
    target.removeEventListener("mouseenter", onEnter);
    target.removeEventListener("mouseleave", onLeave);
    target.removeEventListener("mousedown", onLeave);
    window.removeEventListener("scroll", onScroll, true);
  }

  target.addEventListener("mouseenter", onEnter);
  target.addEventListener("mouseleave", onLeave);
  target.addEventListener("mousedown", onLeave);
  window.addEventListener("scroll", onScroll, true);

  return cleanup;
}

/** 页面整体收掉（比如设置页整块重建前）。 */
export function closeHoverTip() {
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
    if (!text) continue;
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
