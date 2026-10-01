// 拖拽手势的纯函数单测：轴判定、拦截判定、位移与吸附。
// 这些函数不碰 DOM（拦截判定用鸭子类型的假节点喂），所以能在 node 里穷举边界。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideAxis, blockingReason, scrollableX, scrollableAny, nearestScroller, gestureMode, isControl,
  dragOffset, settleTarget, settleDuration, FLICK_EASING, SETTLE_BASE_MS,
  DRAG_START_PX,
} from "../ui/view-track.mjs";

test("decideAxis：没到门槛一律不判方向（留给点击）", () => {
  assert.equal(decideAxis(0, 0), "none");
  assert.equal(decideAxis(DRAG_START_PX - 1, 0), "none");
  assert.equal(decideAxis(0, DRAG_START_PX - 1), "none");
  assert.equal(decideAxis(5, 5), "none");
});

test("decideAxis：横向明显占优才算横拖", () => {
  assert.equal(decideAxis(40, 0), "x");
  assert.equal(decideAxis(-40, 0), "x");
  assert.equal(decideAxis(0, 40), "y");
  assert.equal(decideAxis(30, 30), "y");        // 对角线：不算横拖
  assert.equal(decideAxis(100, 90), "y");       // 1.11 倍还不够 1.2
  assert.equal(decideAxis(120, 90), "x");       // 1.33 倍够了
});

test("blockingReason：表单控件、分割条、可编辑区不接", () => {
  assert.equal(blockingReason({ tagName: "INPUT", getAttribute: () => null }), "control");
  assert.equal(blockingReason({ tagName: "select", getAttribute: () => null }), "control");
  assert.equal(blockingReason({ tagName: "TEXTAREA", getAttribute: () => null }), "control");
  assert.equal(blockingReason({ tagName: "DIV", getAttribute: (k) => (k === "role" ? "separator" : null) }), "separator");
  assert.equal(blockingReason({ tagName: "DIV", getAttribute: () => null, isContentEditable: true }), "editable");
  assert.equal(blockingReason({ tagName: "BUTTON", getAttribute: () => null }), "");
  assert.equal(blockingReason(null), "");
});

test("scrollableX：只有真能横滚、且 overflow-x 是 auto/scroll 才算", () => {
  const node = (scrollWidth, clientWidth, overflowX) => ({
    scrollWidth, clientWidth,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ overflowX }) } },
  });
  assert.equal(scrollableX(node(900, 700, "auto")), true);
  assert.equal(scrollableX(node(900, 700, "scroll")), true);
  assert.equal(scrollableX(node(700, 700, "auto")), false);   // 装得下就不算
  assert.equal(scrollableX(node(900, 700, "visible")), false);
  assert.equal(scrollableX(node(900, 700, "hidden")), false);
  assert.equal(scrollableX(null), false);
});

test("gestureMode：普通区域算换页，控件与横滚容器不接", () => {
  const cs = (o) => ({ defaultView: { getComputedStyle: () => o } });
  const el = (tag, parent, extra = {}) => ({ nodeType: 1, tagName: tag, getAttribute: () => null, hasAttribute: () => false, parentElement: parent, scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, ownerDocument: null, ...extra });
  const root = el("MAIN", null);
  const middle = el("DIV", root);
  assert.equal(gestureMode(el("BUTTON", middle), root), "view");      // button 不拦（否则整块看板都拖不动）
  assert.equal(gestureMode(el("INPUT", middle), root), "blocked");
  const scroller = el("DIV", root, { scrollWidth: 900, clientWidth: 700, ownerDocument: cs({ overflowX: "auto", overflowY: "auto" }) });
  assert.equal(gestureMode(el("SPAN", scroller), root), "blocked");   // 祖先在横滚，就不归我们管
  assert.equal(gestureMode(root, root), "view");                      // 走到根就停，当普通区域
});

test("gestureMode：面板那一层不算横滚容器；data-tt-pan / data-tt-select 就近优先", () => {
  const cs = (o) => ({ defaultView: { getComputedStyle: () => o } });
  const wide = { scrollWidth: 900, clientWidth: 700, scrollHeight: 500, clientHeight: 300, ownerDocument: cs({ overflowX: "auto", overflowY: "auto" }) };
  const el = (tag, parent, extra = {}) => ({ nodeType: 1, tagName: tag, getAttribute: () => null, hasAttribute: () => false, parentElement: parent, scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, ownerDocument: null, ...extra });
  const root = el("MAIN", null);
  const track = el("DIV", root);
  const panel = el("SECTION", track, { ...wide });                     // 面板自己 overflow:auto 且内容偏宽
  assert.equal(gestureMode(el("DIV", panel), root, { panelRoot: track }), "view");        // 得能拖（实测踩到的那个 bug）
  assert.equal(gestureMode(panel, root, { panelRoot: track }), "view");                    // 直接按在面板上也算
  const innerScroller = el("DIV", panel, { ...wide });
  assert.equal(gestureMode(el("SPAN", innerScroller), root, { panelRoot: track }), "blocked");   // 面板里面真能横滚的照旧拦

  // 标记：图表可拖区 / 图表文字区，就近优先（深的赢）
  const marked = (parent, names) => el("DIV", parent, { hasAttribute: (name) => names.includes(name) });
  const textZone = marked(panel, ["data-tt-select"]);
  assert.equal(gestureMode(textZone, root, { panelRoot: track }), "select");
  const barsInText = marked(textZone, ["data-tt-pan"]);               // 文字区里嵌着可拖条带
  assert.equal(gestureMode(el("I", barsInText), root, { panelRoot: track }), "pan");    // 近的那个赢
  assert.equal(gestureMode(el("I", textZone), root, { panelRoot: track }), "select");   // 文字列上则归选字
  const panZone = marked(panel, ["data-tt-pan"]);
  assert.equal(gestureMode(el("I", panZone), root, { panelRoot: track }), "pan");

  // data-tt-view：明确声明“这里就是换页拖拽面”，即使它自己是横滚容器也照拖。
  // 用在内容宽度会变、但用途固定的地方（筛选排那片：胶囊多了它会变成横滚容器）。
  const viewScroller = el("DIV", panel, { ...wide, hasAttribute: (name) => name === "data-tt-view" });
  assert.equal(gestureMode(viewScroller, root, { panelRoot: track }), "view");
  assert.equal(gestureMode(el("SPAN", viewScroller), root, { panelRoot: track }), "view");
  const plainScroller = el("DIV", panel, { ...wide });               // 同样的盒子，没标记
  assert.equal(gestureMode(el("SPAN", plainScroller), root, { panelRoot: track }), "blocked");
  // 里面标了 select 的更近，仍然赢（声明式标记依旧是就就近优先）
  const selectInView = el("DIV", viewScroller, { hasAttribute: (name) => name === "data-tt-select" });
  assert.equal(gestureMode(el("SPAN", selectInView), root, { panelRoot: track }), "select");
});

test("isControl：顶部控件区里的控件不当拖拽面，普通块算", () => {
  const fake = (hit) => ({ closest: () => hit });
  assert.equal(isControl(fake({ tagName: "BUTTON" })), true);
  assert.equal(isControl(fake(null)), false);
  assert.equal(isControl(null), false);
  assert.equal(isControl({}), false);
});

test("settleDuration：手越快、要走的距离越短，这段过渡就越短（不再固定 280ms）", () => {
  const base = { step: 700, distance: 700 };
  const slow = settleDuration({ ...base, velocity: 0 });
  const fast = settleDuration({ ...base, velocity: 2 });
  assert.equal(slow, SETTLE_BASE_MS);                     // 慢慢挪：照旧
  assert.ok(fast < slow && fast >= 110, `甩得快应当更短且有下限（${fast} < ${slow}）`);
  const short = settleDuration({ step: 700, distance: 40, velocity: 0 });
  assert.ok(short < slow && short >= 110, `只差一点点就到位时更短（${short}）`);
  const tiny = settleDuration({ step: 700, distance: 700, velocity: 400 });
  assert.ok(tiny >= 110 && tiny <= 320, `极端值不越界（${tiny}）`);
  assert.ok(FLICK_EASING.startsWith("cubic-bezier"), "快甩用一条单独的陡曲线");
});

test("nearestScroller：往上找最近的可滚容器（图表平移的落点）", () => {
  const cs = (o) => ({ defaultView: { getComputedStyle: () => o } });
  const el = (tag, parent, extra = {}) => ({ nodeType: 1, tagName: tag, parentElement: parent, scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, ownerDocument: null, ...extra });
  const root = el("MAIN", null);
  const list = el("DIV", root, { scrollWidth: 1200, clientWidth: 700, ownerDocument: cs({ overflowX: "auto", overflowY: "auto" }) });
  const row = el("BUTTON", list);
  assert.equal(nearestScroller(el("SPAN", row), root), list);
  assert.equal(nearestScroller(root, root), null);
  const plain = el("DIV", root, { scrollWidth: 1200, clientWidth: 700, ownerDocument: cs({ overflowX: "visible", overflowY: "visible" }) });
  assert.equal(nearestScroller(el("B", plain), root), null);          // 内容宽但 overflow 是 visible：不是滚动容器
  assert.equal(scrollableAny(list), true);
  assert.equal(scrollableAny(plain), false);
});

test("dragOffset：正常区间原样跟手", () => {
  const args = { index: 1, count: 4, step: 700 };
  assert.equal(dragOffset({ ...args, dx: 0 }), -700);
  assert.equal(dragOffset({ ...args, dx: 120 }), -580);
  assert.equal(dragOffset({ ...args, dx: -120 }), -820);
});

test("dragOffset：from 给了就从“眼睛看到的位置”接着算（接上一次没跑完的过渡）", () => {
  const args = { index: 1, count: 4, step: 700 };
  // 上一次切页的过渡还在半路（比如视觉位置在 -500），这时接着拖 120px
  assert.equal(dragOffset({ ...args, dx: 120, from: -500 }), -380);
  assert.equal(dragOffset({ ...args, dx: 0, from: -500 }), -500);
  // 阻尼两端也按 from 来（首块再往右拖）
  assert.equal(dragOffset({ index: 0, count: 4, step: 700, dx: 120, from: 0 }), 42);
  // 不传 from 时与以前完全一致（默认 -index*step）
  assert.equal(dragOffset({ ...args, dx: 120 }), dragOffset({ ...args, dx: 120, from: -700 }));
});

test("dragOffset：两端有阻尼，拖得动但拖不远", () => {
  // 在第 0 块还往右拖：位移按 0.35 折
  assert.equal(dragOffset({ index: 0, count: 4, step: 700, dx: 100 }), 35);
  // 在最后一块往左拖
  const last = dragOffset({ index: 3, count: 4, step: 700, dx: -100 });
  assert.equal(last, -2100 - 35);
});

test("settleTarget：不动就回原位", () => {
  assert.equal(settleTarget({ index: 1, count: 4, dx: 0, velocity: 0, step: 700 }), 1);
  assert.equal(settleTarget({ index: 1, count: 4, dx: -100, velocity: 0, step: 700 }), 1);   // 100 < 700*0.25
});

test("settleTarget：位移过 1/4 屏就翻一格，方向跟着位移", () => {
  // dx 为正 = 往右拖 = 看上一块；为负 = 往左拖 = 看下一块。
  assert.equal(settleTarget({ index: 1, count: 4, dx: -200, velocity: 0, step: 700 }), 2);
  assert.equal(settleTarget({ index: 1, count: 4, dx: 200, velocity: 0, step: 700 }), 0);
  assert.equal(settleTarget({ index: 1, count: 4, dx: -176, velocity: 0, step: 700 }), 2);    // 刚好超过
  assert.equal(settleTarget({ index: 1, count: 4, dx: -175, velocity: 0, step: 700 }), 1);    // 刚好不到
});

test("settleTarget：甩得快也算翻页（位移很小）", () => {
  assert.equal(settleTarget({ index: 2, count: 4, dx: -40, velocity: -1.2, step: 700 }), 3);
  assert.equal(settleTarget({ index: 2, count: 4, dx: 0, velocity: 2, step: 700 }), 1);
});

test("settleTarget：一次最多一块，且两端夹住", () => {
  assert.equal(settleTarget({ index: 0, count: 4, dx: -5000, velocity: -9, step: 700 }), 1);   // 甩穿也只走一格
  assert.equal(settleTarget({ index: 0, count: 4, dx: 500, velocity: 9, step: 700 }), 0);      // 已经在头：回弹
  assert.equal(settleTarget({ index: 3, count: 4, dx: -500, velocity: -9, step: 700 }), 3);    // 已经在尾：回弹
  assert.equal(settleTarget({ index: 3, count: 4, dx: 500, velocity: 9, step: 700 }), 2);
});
