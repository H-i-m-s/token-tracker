import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js 在模块顶层就读这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rd-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rd-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;

fs.writeFileSync(path.join(home, "provider-catalog.json"), JSON.stringify({
  catalogVersion: 2,
  providers: { p1: { models: [{ id: "m1" }] } },
}), "utf8");
fs.writeFileSync(path.join(dataDir, "price-table.json"), JSON.stringify({
  _comment: ["probe"],
  "p1/m1": { input: 1.5, cacheRead: 0.15, cacheWrite: 0, output: 6 },
}), "utf8");

const registerDashboard = (await import("../runtime/engine/routes/dashboard.js")).default;

// 造一份能真的算出钱的最小数据集：
// dailyBreakdown 必须有（聚合从它取），里面的 models 也必须有（算钱与模型列表从它取）。
function makeData() {
  const dailyBreakdown = {};
  const day = "2026-09-20";
  const d = dailyBreakdown[day] = {
    input: 0, output: 0, cacheRead: 0, totalTokens: 0, assistantCount: 0,
    desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0,
    providerTotals: {}, models: {},
  };
  for (let c = 0; c < 4; c++) {
    const inTokens = 1000, outTokens = 50, total = 1050;
    d.input += inTokens; d.output += outTokens; d.totalTokens += total; d.assistantCount += 1;
    d.desktop += total;
    const pt = d.providerTotals["p1/m1"] || (d.providerTotals["p1/m1"] = { provider: "p1", model: "m1", input: 0, output: 0, cacheRead: 0, totalTokens: 0, assistantCount: 0 });
    pt.input += inTokens; pt.output += outTokens; pt.totalTokens += total; pt.assistantCount += 1;
    const dm = d.models["m1"] || (d.models["m1"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, assistantCount: 0 });
    dm.input += inTokens; dm.output += outTokens; dm.totalTokens += total; dm.assistantCount += 1;
  }
  return {
    sessions: {
      "hanako::desktop::::s0.jsonl": {
        agent: "hanako", type: "desktop",
        conversations: [{ time: `${day}T12:00:00.000Z`, model: "m1", provider: "p1", msgCount: 1, inTokens: 4000, outTokens: 200, totalTokens: 4200, cacheRead: 0, cacheWrite: 0 }],
        dailyBreakdown,
        models: { m1: { totalTokens: 4200 } },
        providers: { "p1/m1": { provider: "p1", model: "m1", totalTokens: 0, count: 1 } },
        firstSeen: `${day}T12:00:00.000Z`, lastSeen: `${day}T12:00:00.000Z`,
      },
    },
    agentNames: { hanako: "Hanako" },
  };
}

function makeCtx() {
  const ctx = {
    _tokenCache: { data: makeData(), dataDir, turnsStore: null },
    bus: { async request() { return { agents: [{ id: "hanako", name: "Hanako" }] }; } },
  };
  registerDashboard({ get() {}, post() {} }, ctx);
  return ctx;
}

// 数「读价格文件」的次数：给 fs.existsSync 与 fs.readFileSync 套一层计数。
// readUserPrices 每次调用都会先 existsSync 再 readFileSync 同一个文件，
// 所以数其中任意一个都能反映读了几遍。
function countPriceReads(run) {
  const target = path.join(dataDir, "price-table.json");
  const origExists = fs.existsSync;
  const origRead = fs.readFileSync;
  let hits = 0;
  fs.existsSync = function (p) { if (p === target) hits++; return origExists.call(fs, p); };
  fs.readFileSync = function (p, ...rest) { if (p === target) hits++; return origRead.call(fs, p, ...rest); };
  return Promise.resolve(run()).finally(() => {
    fs.existsSync = origExists;
    fs.readFileSync = origRead;
    return hits;
  });
}

test("一次看板请求只读一遍价格表", async () => {
  const ctx = makeCtx();
  let hits = 0;
  const origExists = fs.existsSync;
  const origRead = fs.readFileSync;
  const target = path.join(dataDir, "price-table.json");
  fs.existsSync = function (p) { if (p === target) hits++; return origExists.call(fs, p); };
  fs.readFileSync = function (p, ...rest) { if (p === target) hits++; return origRead.call(fs, p, ...rest); };
  try {
    await ctx._buildDashboardData({ range: "all" }, { fxRate: 7.1 });
  } finally {
    fs.existsSync = origExists;
    fs.readFileSync = origRead;
  }
  // 一次读 = existsSync + readFileSync 各一次 = 2 次命中。
  // 曾经这里是四处各读一遍（8 次命中），这个断言就是为了钉住那次收敛。
  assert.equal(hits, 2, `价格表被读了 ${hits / 2} 遍，应当只有 1 遍`);
});

test("价格表只读一遍，但算出来的钱是对的", async () => {
  const ctx = makeCtx();
  const dash = await ctx._buildDashboardData({ range: "all" }, { fxRate: 7.1 });
  // m1 输入 4000 tokens × 1.5/1e6 = 0.006
  // m1 输出  200 tokens × 6/1e6   = 0.0012
  // 合计 0.0072（没有 cacheRead，cacheWrite 为 0）
  //
  // 以前这里查的是 _modelCosts 里那条模型行，那份数组已删（没任何界面读它）。
  // 改为直接断总计：它就是页面上那一个金额，验的就是同一件事。
  const total = dash.summary?.estimatedCost;
  assert.ok(Number.isFinite(total), "应当算出总估算成本");
  assert.ok(Math.abs(total - 0.0072) < 1e-9, `成本应为 0.0072，实际 ${total}`);
});

test("价格表里的供应商会补进 providers 列表", async () => {
  const ctx = makeCtx();
  const dash = await ctx._buildDashboardData({ range: "all" }, { fxRate: 7.1 });
  assert.ok((dash.providers || []).some((p) => p.provider === "p1"), "providers 里应当有 p1");
});
