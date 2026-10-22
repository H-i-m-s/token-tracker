import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 开合动画的收尾纪律。
//
// 这一条是给一个真实 bug 钉的钉子：expand 后勾选，部分行被顶出卡片。
// 成因：onfinish 里先把 this.anim 置空、再调 paintCollapse，
// 而 paintCollapse 判定「要不要 cancel」看的就是 this.anim —— 条件永不成立，
// fill:"forwards" 的动画从未被取消，body 高度永久铉在动画结束那一瞬的值上。
//
// 这类 bug 靠人眼看很难发现（要看的那一瞬正好是「内容变高」），
// 但它有一个很好认的结构特征：**cancel 的依据不能是被清空过的字段**。
// 所以这里用源码断言把它钉住，而不是去模拟一次 DOM 动画。

const SRC = fs.readFileSync(
  path.join(import.meta.dirname, "..", "ui", "price-card.mjs"),
  "utf8",
);

test("onfinish 收尾时，要把当次动画实例显式交给 paintCollapse", () => {
  const m = SRC.match(/anim\.onfinish\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\};/);
  assert.ok(m, "应当存在 anim.onfinish 收尾");
  const body = m[1];
  assert.match(body, /paintCollapse\(\s*next\s*,\s*anim\s*\)/,
    "必须把局部 anim 传进去：光靠 this.anim 已经靠不住了");
  assert.doesNotMatch(body, /this\.anim\s*=\s*null\s*;[\s\S]*paintCollapse\(next\)\s*;/,
    "不能先清字段再交给只认字段的 paintCollapse —— 那正是当初的 bug");
});

test("paintCollapse 会 cancel 传进来的那个动画，再清内联高度", () => {
  const m = SRC.match(/paintCollapse\(collapsed,\s*extra\s*=\s*null\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(m, "paintCollapse 应当接受 extra 参数");
  const body = m[1];
  const cancelAt = body.indexOf("cancel()");
  const clearAt = body.indexOf('body.style.height = ""');
  assert.ok(cancelAt >= 0, "必须 cancel");
  assert.ok(clearAt >= 0, "必须清内联高度");
  assert.ok(cancelAt < clearAt, "先 cancel 再清高度：反了的话动画还在，高度清不掉");
  assert.match(body, /extra/, "要处理传进来的 extra");
});

test("内容会变的两个入口都先释放高度锁", () => {
  // paint() 重建整块内容；syncBatchBar() 显隐批量栏。两处都会改高度。
  const paintM = SRC.match(/\n  paint\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(paintM, "应当有 paint()");
  assert.match(paintM[1], /releaseHeightLock\(\)/,
    "paint 会 replaceChildren 重建内容，必须先拆掉遗留的高度锁");

  const batchM = SRC.match(/\n  syncBatchBar\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(batchM, "应当有 syncBatchBar()");
  const b = batchM[1];
  const releaseAt = b.indexOf("releaseHeightLock()");
  const hiddenAt = b.indexOf("batchEl.hidden =");
  assert.ok(releaseAt >= 0, "syncBatchBar 要释放高度锁");
  assert.ok(hiddenAt > releaseAt, "释放必须在改显隐之前，顺序反了这一天就白改");
});

test("releaseHeightLock 只拆自己留下的东西，不动别的内联样式", () => {
  const m = SRC.match(/\n  releaseHeightLock\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(m, "应当有 releaseHeightLock()");
  const body = m[1];
  assert.match(body, /getAnimations/, "要按元素上真实存在的动画去 cancel，而不是靠一个可能已经失配的字段");
  assert.match(body, /body\.style\.height/, "要清掉遗留的内联高度");
  // 只清 overflow:hidden 那种由动画留下的值，别把用户/别处设置的 overflow 一并抹了。
  assert.match(body, /style\.overflow === "hidden"/,
    "只清动画留下的 hidden，不要无条件抹掉 overflow");
});
