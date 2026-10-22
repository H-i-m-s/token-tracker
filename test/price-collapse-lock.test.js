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
  // paint() 重建整块内容；syncBatchBar() 会带出批量栏的展开 / 收起。两处都会改高度。
  const paintM = SRC.match(/\n  paint\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(paintM, "应当有 paint()");
  assert.match(paintM[1], /releaseHeightLock\(\)/,
    "paint 会 replaceChildren 重建内容，必须先拆掉遗留的高度锁");

  // 批量栏的显隐现在走 setBatchVisible；两者都在 setBatchVisible 的同一条链上，
  // 所以断言 pini 到「syncBatchBar 确实驱了它」，而不是写死旧的内联 hidden。
  const batchM = SRC.match(/\n  syncBatchBar\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(batchM, "应当有 syncBatchBar()");
  assert.match(batchM[1], /setBatchVisible\(/,
    "syncBatchBar 要把显隐交给 setBatchVisible（那里统一做过渡）");
});

test("批量栏的开合走高度过渡，不再靠 hidden 开关", () => {
  // 取 applyBatchVisibility 的方法体：从它签名开始，到下一个「列首两空格的 方法名(」为止。
  // 不用平衡大括号的正则：函数体里有内层块，正则很容易在第一个 } 处就截断，
  // 那样断言会在一个被截短的片段上做判断，看着红/绿都是假信息。
  const start = SRC.indexOf("applyBatchVisibility(show,");
  assert.ok(start > -1, "应当有 applyBatchVisibility()");
  const rest = SRC.slice(start + 30);
  const nextMethod = rest.search(/\n  [a-zA-Z_$][\w$]*\([^)]*\)\s*\{/);
  const body = nextMethod > -1 ? rest.slice(0, nextMethod) : rest;
  assert.ok(body.length > 200, `取到的方法体太短（${body.length}），区间切错了`);

  assert.match(body, /expandFromZero\(/, "展开要用 expandFromZero：从 0 补间到自然高，下方内容被连续推下去");
  assert.match(body, /collapseToZero\(/, "收起要用 collapseToZero：缩回去而不是瞬时消失");
  assert.doesNotMatch(body, /\.hidden\s*=/, "不能再用 hidden 开合：那是个不可补间的开关");
  // 收着态由 applyCollapsedInline 统一写，不在两处各写一遍（漏一项就剩一条空框）。
  assert.match(body, /applyCollapsedInline\(/, "收着态要交给 applyCollapsedInline");
  assert.doesNotMatch(body, /display\s*=\s*"none"/, "不能用 display:none：元素就量不到高度了");
});

test("收着态必须把 padding 与边框一起归零", () => {
  // box-sizing:border-box 下，height:0 收不掉 padding:10px 与 border:1px，
  // 会留下一条 22px 高的空框 —— 实测过。
  const start = SRC.indexOf("function applyCollapsedInline(");
  assert.ok(start > -1, "应当有 applyCollapsedInline()");
  const body = SRC.slice(start, start + 700);
  assert.match(body, /height\s*=\s*"0px"/, "零高");
  assert.match(body, /overflow\s*=\s*"hidden"/, "裁切");
  assert.match(body, /paddingTop\s*=\s*"0px"/, "上内边距要归零");
  assert.match(body, /paddingBottom\s*=\s*"0px"/, "下内边距要归零");
  assert.match(body, /borderTopWidth\s*=\s*"0px"/, "上边框要归零");
  assert.match(body, /borderBottomWidth\s*=\s*"0px"/, "下边框要归零");
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
