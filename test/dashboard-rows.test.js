import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js 在模块顶层就要求这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-row-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-row-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;
const { rowOf } = await import("../runtime/engine/routes/dashboard.js");

test("明细行：缓存拆分与调用次数要带上", () => {
  const row = rowOf(
    { agent: "hanako" },
    { time: "2026-09-30T01:00:00Z", provider: "deepseek", model: "deepseek-flash", totalTokens: 15800,
      inTokens: 15500, outTokens: 300, cacheRead: 14000, cacheWrite: 800, reasoning: 70, msgCount: 2 },
    { hanako: "Hanako" },
  );
  assert.deepEqual(row, {
    time: "2026-09-30T01:00:00Z", agent: "hanako", agentName: "Hanako",
    provider: "deepseek", model: "deepseek-flash", totalTokens: 15800,
    inputTokens: 15500, outputTokens: 300, cacheRead: 14000, calls: 2,
  });
});

test("明细行：没有口径的老记录给 null，不给 0", () => {
  const row = rowOf({ agent: "hanako" }, { time: "2026-09-30T01:00:00Z", model: "m" }, {});
  assert.equal(row.cacheRead, null);
  assert.equal(row.calls, null);
  assert.equal(row.totalTokens, 0, "缺字段按 0 计的是总量");
  assert.equal(row.agentName, "hanako", "名册里没有时退回 agent id");
  assert.equal(row.provider, "", "provider 缺了给空串，不是 null");
});
