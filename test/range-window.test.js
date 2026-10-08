import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceApp } from "../ui/workspace.mjs";

// 账单图那份时间窗。直接拿方法本体来测：它只吃这两个参数，不碰 this。
// 钉住「现在」是必须的 —— 否则断言只能是同义反复（用同一个 Date.now() 算出的期望值）。
const win = (state, nowSec) => WorkspaceApp.prototype.dsWindowFromState.call({}, state, nowSec);

// 2026-10-08 12:00 东八区 == 2026-10-08 04:00Z
const NOW = Date.UTC(2026, 9, 8, 4, 0, 0) / 1000;
// 东八区某天零点对应的 epoch 秒
const CN = (y, m, d) => Date.UTC(y, m - 1, d) / 1000 - 8 * 3600;

test("本月 = 本月 1 号 00:00 起，不是近 30 天（用户看出来的那个 bug）", () => {
  assert.deepEqual(win({ range: "month" }, NOW), { from: CN(2026, 10, 1), to: CN(2026, 10, 9) });
  const month = win({ range: "month" }, NOW);
  const last30 = win({ range: "last30" }, NOW);
  assert.notDeepEqual(month, last30, "本月与近30天不能再是同一个窗口");
  // 同日成立：本月 1 号 = 10-01，近30天起点 = 09-09，差 22 天
  assert.equal(month.from - last30.from, 22 * 86400);
});

test("跨年：1 月的本月从 1 月 1 号算起", () => {
  const jan3 = Date.UTC(2027, 0, 3, 4, 0, 0) / 1000;
  assert.deepEqual(win({ range: "month" }, jan3), { from: CN(2027, 1, 1), to: CN(2027, 1, 4) });
});

test("其余各档：与引擎同一口径，端点含今天整天", () => {
  assert.deepEqual(win({ range: "today" }, NOW), { from: CN(2026, 10, 8), to: CN(2026, 10, 9) });
  assert.deepEqual(win({ range: "last3" }, NOW), { from: CN(2026, 10, 6), to: CN(2026, 10, 9) });
  assert.deepEqual(win({ range: "last7" }, NOW), { from: CN(2026, 10, 2), to: CN(2026, 10, 9) });
  assert.deepEqual(win({ range: "last30" }, NOW), { from: CN(2026, 9, 9), to: CN(2026, 10, 9) });
  assert.deepEqual(win({ range: "all" }, NOW), { from: 0, to: CN(2026, 10, 9) });
});

test("「今天」按东八区算：UTC 还在 10-07 时，东八区已经是 10-08", () => {
  const t = Date.UTC(2026, 9, 7, 17, 0, 0) / 1000; // 东八区 10-08 01:00
  assert.deepEqual(win({ range: "today" }, t), { from: CN(2026, 10, 8), to: CN(2026, 10, 9) });
  assert.deepEqual(win({ range: "month" }, t), { from: CN(2026, 10, 1), to: CN(2026, 10, 9) });
});

test("自定义日期：按东八区的天，含当天整天；坏日期退回全部历史", () => {
  assert.deepEqual(
    win({ range: "all", from: "2026-10-01", to: "2026-10-03" }, NOW),
    { from: CN(2026, 10, 1), to: CN(2026, 10, 4) },
  );
  // 反过来的日期不能给出空窗口或反向窗口
  assert.deepEqual(win({ range: "all", from: "2026-10-03", to: "2026-10-01" }, NOW), { from: 0, to: CN(2026, 10, 9) });
  assert.deepEqual(win({ range: "all", from: "不是日期", to: "2026-10-01" }, NOW), { from: 0, to: CN(2026, 10, 9) });
});
