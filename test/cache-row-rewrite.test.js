import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSqliteDriver, createSqliteCacheStore } from "../runtime/engine/services/cache-store.js";

const DatabaseSync = loadSqliteDriver();
const log = { info() {}, warn() {}, error() {} };

// 按行落盘的前提是「文件 mtime/size 没变，就等于这一行的内容没变」。全量重扫打破了这个前提：
// 记录是重新解析出来的，文件却一个都没动。引擎在全量重扫时改走 markAllDirty → save(all=true)，
// 这条契约由下面三个断言钉住：增量跳过、全量必须重写。
test("同一 mtime/size 的行：增量落盘跳过，全量落盘必须重写", { skip: !DatabaseSync }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-row-"));
  const store = createSqliteCacheStore({ DatabaseSync, file: path.join(dir, "cache.sqlite"), log });
  const key = "hanako::desktop::::x.jsonl";
  const row = (v) => ({ [key]: { mtime: 111, size: 222, v } });

  store.save({ sessions: row("旧格式") }, [], false); // 空库 → 首次必然全量
  assert.equal(store.load().sessions[key].v, "旧格式");

  // 内容变了、mtime/size 一字不差 → 增量落盘按「这一行没变」跳过
  store.save({ sessions: row("新格式") }, [], false);
  assert.equal(store.load().sessions[key].v, "旧格式", "增量落盘不该重写未变化的行");

  // 全量落盘（版本变更 / 强制重扫）必须把这一行写回新格式
  store.save({ sessions: row("新格式") }, [], true);
  assert.equal(store.load().sessions[key].v, "新格式", "全量落盘必须重写未变化的行");

  // 已经不在缓存里的行要删掉
  store.save({ sessions: {} }, [], true);
  assert.equal(store.load(), null, "整库清空后 load 应视为无缓存");

  store.close();
});
