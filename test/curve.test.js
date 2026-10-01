import test from "node:test";
import assert from "node:assert/strict";
import { splineTangents, hermiteAt, splineCurve, splineValueAt } from "../ui/curve.mjs";

const nearly = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test("splineTangents：直线的切线就是斜率，两端也一样", () => {
  const ys = [0, 3, 6, 9, 12];
  const m = splineTangents(ys, 1);
  for (const v of m) assert.ok(nearly(v, 3, 1e-12), `切线应为 3，实际 ${v}`);
});

test("splineTangents：峰顶拉平，不冲过数据点", () => {
  const ys = [0, 1, 5, 1, 0];
  const m = splineTangents(ys, 1);
  assert.equal(m[2], 0, "峰顶切线应为 0");
  assert.ok(m[0] >= 0 && m[4] <= 0, "端点切线方向要对");
});

test("三次样条不过冲：每一段都落在两端点之间（尖峰旁边不会被压到基线以下）", () => {
  const cases = [
    [0, 0, 0, 100, 0, 0, 0],           // 孤立尖峰
    [0, 1, 2, 1, 0, 1, 2, 1],          // 连续起伏
    [5, 4, 3, 2, 1, 0, 0, 0],          // 下降后拖平
    [0, 10, 0, 10, 0],
  ];
  for (const ys of cases) {
    const m = splineTangents(ys, 1);
    for (let i = 0; i < ys.length - 1; i++) {
      const lo = Math.min(ys[i], ys[i + 1]), hi = Math.max(ys[i], ys[i + 1]);
      for (let k = 0; k <= 20; k++) {
        const v = hermiteAt(ys[i], ys[i + 1], m[i], m[i + 1], k / 20);
        assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9,
          `第 ${i} 段 t=${k / 20} 取到 ${v.toFixed(4)}，越出 [${lo}, ${hi}]（数据 ${ys.join(",")}）`);
      }
    }
  }
});

test("splineCurve：只出 C 段（M 由调用方拼），段数与列数一一对应", () => {
  const pts = [0, 1, 2, 3, 4].map((i) => [i * 10, 100 - i * 7]);
  const d = splineCurve(pts);
  assert.ok(d.startsWith(" C"), d.slice(0, 12));
  assert.equal((d.match(/ C/g) || []).length, pts.length - 1, "每段一个 C");
  assert.equal((d.match(/M/g) || []).length, 0, "不自己拼 M");
});

test("splineCurve：下边界反向画（dx 为负）也不越界", () => {
  const ys = [10, 4, 9, 0];
  const pts = ys.map((v, i) => [(ys.length - 1 - i) * 8, v]);   // x 递减
  const d = splineCurve(pts);
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  for (let i = 0; i < nums.length; i += 2) {
    assert.ok(nums[i + 1] >= 0 && nums[i + 1] <= 10, `控制点 y=${nums[i + 1]} 越界`);
  }
});

test("splineValueAt：整数位置取到原值，两点之间与画出来的曲线完全一致", () => {
  const ys = [0, 2, 8, 3, 3, 7, 1];
  for (let i = 0; i < ys.length; i++) assert.equal(splineValueAt(ys, i), ys[i]);

  // 同一段：把 splineCurve 画出来的三次贝塞尔在参数 t 处取值，应当等于 splineValueAt(i+t)
  const pts = ys.map((v, i) => [i, v]);
  const d = splineCurve(pts);
  const seg = d.match(/ C(-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+)/g);
  for (let i = 0; i < seg.length; i++) {
    const [c1x, c1y, c2x, c2y, ex, ey] = seg[i].match(/(-?[\d.]+)/g).map(Number);
    const x0 = i, y0 = ys[i];
    for (const t of [0.15, 0.5, 0.85]) {
      // x(t) 线性（控制点在 1/3、2/3），所以 t 一步可得；这里顺便验一下确实线性
      const x = (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * c1x + 3 * (1 - t) * t ** 2 * c2x + t ** 3 * ex;
      assert.ok(nearly(x, x0 + t, 1e-9), `x(t) 应为线性，实际 ${x} vs ${x0 + t}`);
      const y = (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * c1y + 3 * (1 - t) * t ** 2 * c2y + t ** 3 * ey;
      assert.ok(nearly(y, splineValueAt(ys, i + t), 1e-9),
        `第 ${i} 段 t=${t}：画出来 ${y}，悬停读数 ${splineValueAt(ys, i + t)}`);
    }
  }
});

test("splineValueAt：单点与空数组不炸", () => {
  assert.equal(splineValueAt([], 3), 0);
  assert.equal(splineValueAt([42], 0), 42);
  assert.equal(splineValueAt([42], 9), 42);
});
