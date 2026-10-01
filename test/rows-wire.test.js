import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard.js 在模块顶层就要求这两个环境变量，必须先设好再 import。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-wire-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-wire-data-"));
process.env.HANA_HOME = home;
process.env.TOKEN_TRACKER_DATA_DIR = dataDir;
const { ROW_COLS, encodeRows, rowOf } = await import("../runtime/engine/routes/dashboard.js");
const { ROW_COLS: UI_COLS, decodeRows } = await import("../ui/details-view.mjs");

// 引擎产出的对象行现在带 sessionKey / seq（供「点得开」用），基准对象也要跟上，
// 否则「压缩编码→解码，字段一个不少」会把新列当成多出来的东西。
const objRow = (i) => {
  const r = rowOf(
    { agent: "hanako" },
    { time: `2026-09-30T12:${String(i).padStart(2, "0")}:00.000Z`, provider: "deepseek", model: "deepseek-flash",
      totalTokens: 15800, inTokens: 15500, outTokens: 300, cacheRead: 14000, msgCount: 2 },
    { hanako: "Hanako" },
  );
  r.sessionKey = `hanako::desktop::::2026-09-30T12-${String(i).padStart(2, "0")}-00-000Z_x.jsonl`;
  r.seq = i + 1;
  return r;
};

test("两边列名同序（任何一边加了字段而另一边没跟上，行会整体错位）", () => {
  assert.deepEqual(UI_COLS, ROW_COLS);
});

test("压缩编码 → 前端解码：字段一个不少", () => {
  const objs = [objRow(1), objRow(2)];
  const wire = { rows: encodeRows(objs), rowCols: ROW_COLS, summary: { totalTokens: 31600 } };
  assert.ok(Array.isArray(wire.rows[0]), "上线的是数组行");
  const back = decodeRows(wire);
  assert.deepEqual(back.rows, objs);
  assert.equal(back.summary.totalTokens, 31600, "其它字段不能被解码弄丢");
});

test("引擎没给列名时用前端兜底列名，空位给 null 而不是 undefined", () => {
  const back = decodeRows({ rows: [[null, "hanako", "Hanako", "", "m", 0, null, null, null, null]] });
  assert.equal(back.rows[0].time, null);
  assert.equal(back.rows[0].cacheRead, null);
  assert.equal(back.rows[0].calls, null);
  assert.equal(back.rows[0].totalTokens, 0);
});

test("对象行（mock 数据）原样通过，空载荷不抛", () => {
  const mock = { rows: [{ time: "t", totalTokens: 1, cost: 0.01 }] };
  assert.deepEqual(decodeRows(mock).rows, mock.rows);
  assert.deepEqual(decodeRows({}).rows, []);
  assert.deepEqual(decodeRows(null).rows, []);
});

test("压缩确实省字节：键名不再逐行重复", () => {
  const objs = Array.from({ length: 200 }, (_, i) => objRow(i % 60));
  const before = JSON.stringify(objs).length;
  const after = JSON.stringify(encodeRows(objs)).length;
  assert.ok(after < before * 0.6, `压缩后应显著更小：${after} vs ${before}`);
});
