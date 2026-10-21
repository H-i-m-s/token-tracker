import test from "node:test";
import assert from "node:assert/strict";
import {
  splitValue, tokenize, digitOffset, unitRollStops, ROLL_MS, ROLL_EASING,
} from "../ui/digit-roll.mjs";

// KPI 数字滚动的纯逻辑层。DOM 层要靠浏览器实测（见仓库里的探针做法），
// 但「拆值 / 切位 / 刻度」这三件决定数字停在哪一格，错一位就是显示错数，
// 必须在这里钉死。

test("splitValue：拆出 prefix / core / suffix", () => {
  const cases = [
    // 输入,        prefix, core,    suffix
    ["27.45 B",    "",     "27.45", " B"],
    ["43.3%",      "",     "43.3",  "%"],
    ["$0.00",      "$",    "0.00",  ""],
    ["$1.2345",    "$",    "1.2345",""],
    ["192:1",      "",     "192:1", ""],
    ["1.2 K",      "",     "1.2",   " K"],
    ["11",         "",     "11",    ""],
    ["452.0 K",    "",     "452.0", " K"],
  ];
  for (const [input, prefix, core, suffix] of cases) {
    const r = splitValue(input);
    assert.equal(r.plain, false, `${input} 不该判成 plain`);
    // prefix 一定在 core 前面：$ 这种符号要跟着数字排，不能当单位淡出
    const piped = r.prefix + r.core;
    assert.equal(piped, prefix + core, `${input} 的 prefix+core`);
    assert.equal(r.suffix, suffix, `${input} 的 suffix`);
  }
});

test("splitValue：拼回去必须与原串逐字相同", () => {
  // 任何一个字符丢掉，数字就会显示错值，而且很难一眼看出来。
  for (const t of ["27.45 B", "43.3%", "$0.00", "192:1", "1.2 K", "11",
                   "$1.2345", "0", "9.9 B", "1,234", "—", ""]) {
    const r = splitValue(t);
    assert.equal(r.prefix + r.core + r.suffix, t, `拼回原串：${t}`);
  }
});

test("splitValue：没有数字的值走 plain，整串当静态文字", () => {
  for (const t of ["—", "", "n/a"]) {
    const r = splitValue(t);
    assert.equal(r.plain, true, `${t} 应判为 plain`);
    assert.equal(r.core, "", `${t} 不该有可滚的 core`);
    assert.equal(r.prefix + r.core + r.suffix, t, `${t} 拼回原串`);
  }
});

test("tokenize：数字是滚动的位，标点是不动的桩", () => {
  assert.deepEqual(tokenize("27.45").map((t) => t.digit), [true, true, false, true, true]);
  assert.deepEqual(tokenize("192:1").map((t) => t.ch), ["1", "9", "2", ":", "1"]);
  assert.deepEqual(tokenize("192:1").filter((t) => !t.digit).map((t) => t.ch), [":"]);
  assert.deepEqual(tokenize("").map((t) => t.ch), []);
});

test("digitOffset：9 在顶上（位移 0），0 在最下（位移 -9）", () => {
  // 带子自上而下排成 9,8,…,0，所以数字越大越靠上、位移越大（越接近 0）。
  assert.equal(digitOffset(9), 0);
  assert.equal(digitOffset(0), -9);
  for (let d = 1; d <= 9; d++) {
    assert.equal(digitOffset(d), d - 9, `d=${d}`);
    assert.ok(digitOffset(d) > digitOffset(d - 1), `d=${d} 应比 d=${d - 1} 更靠上`);
  }
});

test("时长与曲线常量与 CSS 里的过渡保持一致", () => {
  // .tt-strip（数字带子）与 .tt-unit-belt（单位带子）写的是同一个 340ms / 同一条贝塞尔。
  // 两边对不上时数字会「还没滚到位就被下一帧改写」，看着是卡在半路。
  assert.equal(ROLL_MS, 340);
  assert.equal(ROLL_EASING, "cubic-bezier(.22,.61,.36,1)");
});

test("unitRollStops：单位带子的档位由键，小档在上、大档在下", () => {
  // 带子顺序就是滚动的方向：往大档走＝往下滚一格。
  // 中文与英文档数不同（4 / 5），所以这张表只能由 units.mjs 生成，不能写死。
  assert.deepEqual(unitRollStops("en"), ["", " K", " M", " B", " T"]);
  assert.deepEqual(unitRollStops("zh"), ["", " 万", " 亿", " 万亿"]);
  // 第一档必须是没有单位：不足最小量级的数（“7”）就停在这一档。
  for (const system of ["en", "zh"]) assert.equal(unitRollStops(system)[0], "", system);
});
