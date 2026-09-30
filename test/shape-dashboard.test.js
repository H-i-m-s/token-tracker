import test from "node:test";
import assert from "node:assert/strict";
import { shapeDashboard } from "../lib/snapshot-service.mjs";

// 引擎发上来的行是「列名 + 数组」，插件这一层不能展开（展开会让载荷在两跳里都胖回去），
// 但列名必须跟着一起过桥 —— 丢了列名，前端就只剩一堆数，没有名字。
test("看板载荷过桥：数组行与列名原样带过去", () => {
  const out = shapeDashboard({
    rows: [["2026-09-30T01:00:00.000Z", "hanako", "Hanako", "deepseek", "deepseek-flash", 15800, 15500, 300, 14000, 2]],
    rowCols: ["time", "agent", "agentName", "provider", "model", "totalTokens", "inputTokens", "outputTokens", "cacheRead", "calls"],
    summary: { totalTokens: 15800 },
    agentNames: { hanako: "Hanako" },
  });
  assert.equal(out.rows.length, 1);
  assert.ok(Array.isArray(out.rows[0]), "这一层不展开");
  assert.deepEqual(out.rowCols, ["time", "agent", "agentName", "provider", "model", "totalTokens", "inputTokens", "outputTokens", "cacheRead", "calls"]);
  assert.equal(out.summary.totalTokens, 15800);
  assert.equal(out.rowCount, 1);
});

test("看板载荷过桥：mock 的对象行也不动", () => {
  const mock = [{ time: "t", model: "m", totalTokens: 5, cost: 0.01 }];
  const out = shapeDashboard({ rows: mock, models: ["m"], providers: ["p"] });
  assert.deepEqual(out.rows, mock);
  assert.equal(out.rowCols, null);
  assert.deepEqual(out.models, ["m"]);
});

test("看板载荷过桥：没有行时不给假数字", () => {
  const out = shapeDashboard({});
  assert.deepEqual(out.rows, []);
  assert.equal(out.summary.totalTokens, 0);
  assert.equal(out.rowCount, 0);
});
