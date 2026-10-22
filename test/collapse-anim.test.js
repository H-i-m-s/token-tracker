import test from "node:test";
import assert from "node:assert/strict";
import {
  MORPH_PROPS, EXPAND_MS, COLLAPSE_MS, morphTransition, clearMorph,
  prefersReducedMotion, expandFromZero, collapseToZero,
} from "../ui/collapse-anim.mjs";

// 开合过渡层。参考 git-save-load 的变更文件列表（list-anim.mjs）。
//
// 这里能测的是「写进 style 的那串值对不对」「什么时候清理」「reduced-motion 走不走动画」，
// 测不了「看起来丝不丝滑」—— 那属于肉眼看的部分，不在这里假装能判定。
//
// 用一个最小 DOM 桩：只要 style、addEventListener、getBoundingClientRect、offsetHeight。
// 足够覆盖模块的真实分支，又不用装 jsdom。

function makeEl(height = 100) {
  const listeners = {};
  return {
    style: {},
    offsetHeight: height,
    _h: height,
    getBoundingClientRect() { return { height: this._h, width: 200, top: 0, left: 0 }; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn);
    },
    // 测试里手动触发 transitionend
    _fire(type, propertyName) {
      for (const fn of [...(listeners[type] || [])]) fn({ propertyName, type });
    },
    _listeners: listeners,
  };
}

test("过渡属性：必须带上 padding / margin / 边框，否则收到 0 会剩一条空框", () => {
  for (const p of ["height", "padding-top", "padding-bottom", "margin-top", "margin-bottom", "opacity"]) {
    assert.ok(MORPH_PROPS.includes(p), `MORPH_PROPS 要含 ${p}`);
  }
  // 批量栏有 1px 边框 + 10px 上下 padding。只收 height 的话，
  // 最后会剩下一条 22px 高、看得见的空框 —— 这一点参考实现没覆盖（它的行没边框）。
  assert.ok(MORPH_PROPS.includes("border-top-width"), "边框上边宽也要过渡");
  assert.ok(MORPH_PROPS.includes("border-bottom-width"), "边框下边宽也要过渡");
});

test("morphTransition：时长与缓动只有一个出处", () => {
  const s = morphTransition(250);
  for (const p of MORPH_PROPS) {
    assert.ok(s.includes(`${p} 250ms`), `${p} 要在过渡声明里`);
  }
  assert.ok(s.includes("cubic-bezier(0.22, 0.61, 0.36, 1)"), "默认缓动与卡片开合同一条曲线");
  // 每条属性一段。按「属性名 + 空格 + 时长」去数，不能按逗号切：
  // cubic-bezier 括号里自己就带逗号，切出来会把一段拆成四段。
  const segs = MORPH_PROPS.filter((p) => s.includes(`${p} 250ms`));
  assert.equal(segs.length, MORPH_PROPS.length, "每条属性都要在声明里，不重不漏");
});

test("展开：起点先压到 0 并提交一帧，再补到自然高度", () => {
  const el = makeEl(120);
  const played = expandFromZero(el, { reduced: false });
  assert.equal(played, true, "有高度且没要求减弱动效 → 应当播");
  // 终点是量到的自然高度
  assert.equal(el.style.height, "120px");
  // padding / margin / border 交还给 CSS（置空），由过渡补过去
  assert.equal(el.style.paddingTop, "");
  assert.equal(el.style.marginTop, "");
  assert.equal(el.style.borderTopWidth, "");
  assert.equal(el.style.opacity, "");
  assert.match(el.style.transition, /height 300ms/);
  assert.equal(el.style.overflow, "hidden", "动画期间要裁切");
});

test("展开结束后清掉内联值，把元素交回 CSS", () => {
  const el = makeEl(120);
  expandFromZero(el, { reduced: false });
  el._fire("transitionend", "height");
  assert.equal(el.style.height, "", "高度要清空，否则内容之后变高就长不动了");
  assert.equal(el.style.transition, "");
  assert.equal(el.style.overflow, "");
});

test("收尾只认 height 那一条 transitionend", () => {
  // padding / margin / opacity 各自也会发 transitionend，谁先到都算结束的话，
  // 清理会跑在动画中途，剩下的属性被硬掐断，看起来就是「顿一下」。
  const el = makeEl(120);
  expandFromZero(el, { reduced: false });
  el._fire("transitionend", "padding-top");
  assert.match(el.style.transition, /height/, "只收到 padding 的事件时不该清理");
  el._fire("transitionend", "height");
  assert.equal(el.style.transition, "", "收到 height 的事件后才清理");
});

test("收起：补到 0，动画结束才执行 onGone", () => {
  const el = makeEl(90);
  let gone = false;
  const played = collapseToZero(el, { reduced: false, onGone: () => { gone = true; } });
  assert.equal(played, true);
  assert.equal(el.style.height, "0px");
  assert.equal(el.style.paddingTop, "0px", "padding 同步归零，否则剩一条边");
  assert.equal(el.style.borderTopWidth, "0px");
  assert.equal(gone, false, "动画没结束前不能摘 —— 中途隐藏会把过渡直接掐掉");
  el._fire("transitionend", "height");
  assert.equal(gone, true, "结束后才通知调用方");
});

test("零高度元素不播动画，直接落地", () => {
  // 量不到高度就没法补间。这时必须立刻把活干完，不能留一个卡住的中间态。
  const el = makeEl(0);
  assert.equal(expandFromZero(el, { reduced: false }), false);
  let gone = false;
  assert.equal(collapseToZero(el, { reduced: false, onGone: () => { gone = true; } }), false);
  assert.equal(gone, true, "不播动画时 onGone 要立刻执行");
});

test("reduced-motion：不播动画，但状态照旧落地", () => {
  const el = makeEl(100);
  assert.equal(expandFromZero(el, { reduced: true }), false);
  assert.equal(el.style.height, "", "不播时直接回到自然高度");
  let gone = false;
  assert.equal(collapseToZero(el, { reduced: true, onGone: () => { gone = true; } }), false);
  assert.equal(gone, true);
});

test("prefersReducedMotion：拿不到 matchMedia 时当作不减弱", () => {
  assert.equal(prefersReducedMotion(null), false);
  assert.equal(prefersReducedMotion({}), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  // matchMedia 抛错也不能把开合卡死
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error("x"); } }), false);
});

test("clearMorph 只清自己写过的那几个属性", () => {
  const el = makeEl(50);
  el.style.color = "red";
  el.style.width = "30px";
  el.style.height = "12px";
  el.style.transition = "height 1s";
  clearMorph(el);
  assert.equal(el.style.height, "");
  assert.equal(el.style.transition, "");
  assert.equal(el.style.color, "red", "别的样式不许动");
  assert.equal(el.style.width, "30px");
});

test("时长：收起不比展开更拖沓", () => {
  assert.ok(COLLAPSE_MS <= EXPAND_MS, "让路的那一下不该比出现还慢");
});

test("兜底：transitionend 不来时，靠定时器也能收尾", async () => {
  // display 被换掉、属性中途被改写，都可能让 transitionend 永远不来。
  // 只等事件就会留下一个停在半高、再也收不回去的残骸。
  const el = makeEl(100);
  let gone = false;
  collapseToZero(el, { reduced: false, ms: 10, onGone: () => { gone = true; } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gone, true, "没等到 transitionend 也要收尾");
  assert.equal(el.style.transition, "", "兜底路径同样要清理干净");
});
