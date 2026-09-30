import test from "node:test";
import assert from "node:assert/strict";
import { buildDetailsCSV } from "../ui/csv-export.mjs";

test("明细 CSV：表头含缓存命中率与调用次数两列", () => {
  const csv = buildDetailsCSV([]).replace("\uFEFF", "");
  assert.equal(csv, '"时间","Agent","Provider","模型","输入Token","输出Token","缓存命中率","调用次数","总Token","成本"');
});

test("明细 CSV：命中率按命中/输入算一位小数，没有口径就留空", () => {
  const csv = buildDetailsCSV([
    { time: "2026-09-30T01:00:00.000Z", agent: "hanako", provider: "deepseek", model: "deepseek-flash",
      inputTokens: 15500, outputTokens: 300, totalTokens: 15800, cacheRead: 14000, calls: 2 },
    { time: "2026-09-30T02:00:00.000Z", agent: "hanako", inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
  ]).replace("\uFEFF", "").split("\r\n");
  assert.match(csv[1], /"90\.3%","2","15800",""$/, "14000/15500 = 90.3%，金额列留空");
  assert.match(csv[2], /"","","1010",""$/, "没有缓存口径与调用次数的记录留空，不写 0% 冒充");
});
