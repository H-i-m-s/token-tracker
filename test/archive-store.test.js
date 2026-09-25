import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openArchiveStore, journalPathForArchive } from "../runtime/engine/services/archive-store.js";
import { readJsonLines } from "../runtime/engine/services/jsonl-log.js";

const silent = () => {};
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "tt-archive-")); }

test("旧 usage-archive.json 一次性迁移为 JSONL 且旧文件留底", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  fs.writeFileSync(jsonPath, JSON.stringify({
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: { r1: { t: "a" }, r2: { t: "b" } },
  }));

  const store = openArchiveStore(jsonPath, silent);
  assert.equal(store.size(), 2);
  assert.equal(store.entries.r1.t, "a");
  assert.equal(store.updatedAt, "2026-01-01T00:00:00.000Z");

  const journal = journalPathForArchive(jsonPath);
  assert.ok(fs.existsSync(journal), "日志文件应生成");
  assert.ok(fs.existsSync(jsonPath + ".imported"), "旧文件应改名留底");
  assert.ok(!fs.existsSync(jsonPath), "旧文件不应原位保留");
});

test("新增只追加；重复 appendPending 与重新打开都不重复归档", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, entries: { r1: { t: "a" } } }));
  const journal = journalPathForArchive(jsonPath);

  const store = openArchiveStore(jsonPath, silent);
  store.entries.r2 = { t: "b" };
  store.updatedAt = "2026-02-02T00:00:00.000Z";
  const r = store.appendPending();
  assert.equal(r.rows, 1);
  const sizeAfter = fs.statSync(journal).size;
  // 没有新条目时是空操作，不写盘
  store.appendPending();
  assert.equal(fs.statSync(journal).size, sizeAfter);

  const reopened = openArchiveStore(jsonPath, silent);
  assert.deepEqual(Object.keys(reopened.entries).sort(), ["r1", "r2"]);
  assert.equal(reopened.updatedAt, "2026-02-02T00:00:00.000Z");
});

test("同 rid 后写覆盖先写；半截尾行被跳过且不污染后续追加", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  const journal = journalPathForArchive(jsonPath);
  // 手工构造：r9 两次（覆盖），末尾一行被截断
  fs.writeFileSync(journal, [
    JSON.stringify({ rid: "r9", v: { n: 1 } }),
    JSON.stringify({ rid: "r9", v: { n: 2 } }),
    '{"rid":"r10","v":{"n":3',
  ].join("\n")); // 注意：末尾无换行 = 半截行

  const store = openArchiveStore(jsonPath, silent);
  assert.deepEqual(store.entries.r9, { n: 2 });
  assert.equal(store.entries.r10, undefined);

  store.entries.r11 = { n: 4 };
  store.appendPending();

  const reopened = openArchiveStore(jsonPath, silent);
  assert.deepEqual(reopened.entries.r11, { n: 4 });
  assert.deepEqual(reopened.entries.r9, { n: 2 });
  assert.equal(reopened.entries.r10, undefined);
});

test("迁移被中断（日志与旧文件并存）时以日志为准并补完改名", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  const journal = journalPathForArchive(jsonPath);
  fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, entries: { r1: { t: "a" } } }));
  fs.writeFileSync(journal, JSON.stringify({ rid: "r1", v: { t: "a" } }) + "\n");

  const store = openArchiveStore(jsonPath, silent);
  assert.deepEqual(Object.keys(store.entries), ["r1"]);
  assert.ok(fs.existsSync(jsonPath + ".imported"));
  assert.ok(!fs.existsSync(jsonPath));
});

test("既有 .imported 留底在收尾改名时不被删除，本次旧文件改用带时间戳的备份名", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  const imported = jsonPath + ".imported";
  const journal = journalPathForArchive(jsonPath);
  fs.writeFileSync(imported, "OLD-BACKUP-KEEP");
  fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, entries: { r1: { t: "a" } } }));
  // 模拟「日志已生成、旧文件未改名」且已存在一份更早的留底
  fs.writeFileSync(journal, [
    JSON.stringify({ rid: "r1", v: { t: "a" } }),
    JSON.stringify({ rid: "r2", v: { t: "b" } }),
  ].join("\n") + "\n");

  const store = openArchiveStore(jsonPath, silent);
  assert.equal(fs.readFileSync(imported, "utf8"), "OLD-BACKUP-KEEP", "既有留底必须原样保留");
  const tsBackups = fs.readdirSync(dir).filter((n) => n.startsWith("usage-archive.json.imported-"));
  assert.equal(tsBackups.length, 1, "本次旧文件应改名到带时间戳的备份");
  const backed = JSON.parse(fs.readFileSync(path.join(dir, tsBackups[0]), "utf8"));
  assert.ok(backed.entries.r1, "时间戳备份应含旧文件内容");
  assert.deepEqual(Object.keys(store.entries).sort(), ["r1", "r2"]);
});

test("首次迁移时若已有 .imported，旧文件改名带时间戳且不删除既有留底", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  const imported = jsonPath + ".imported";
  fs.writeFileSync(imported, "PRE-EXISTING");
  fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", entries: { r1: { t: "a" } } }));

  const store = openArchiveStore(jsonPath, silent);
  assert.ok(fs.existsSync(journalPathForArchive(jsonPath)));
  assert.equal(fs.readFileSync(imported, "utf8"), "PRE-EXISTING", "既有留底必须原样保留");
  const tsBackups = fs.readdirSync(dir).filter((n) => n.startsWith("usage-archive.json.imported-"));
  assert.equal(tsBackups.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, tsBackups[0]), "utf8")).entries.r1);
  assert.deepEqual(Object.keys(store.entries), ["r1"]);
  assert.equal(store.updatedAt, "2026-01-01T00:00:00.000Z");
});

test("日志中 v=null 的 rid 不占槽位，内存补值后能真正追加且重启可读", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  const journal = journalPathForArchive(jsonPath);
  fs.writeFileSync(journal, [
    JSON.stringify({ rid: "r1", v: { n: 1 } }),
    JSON.stringify({ rid: "r1", v: null }), // 无效：不应抹掉 r1，也不应占槽
    JSON.stringify({ rid: "x", v: null }),  // 无效：x 不应被标记为已写
    JSON.stringify({ rid: "r2", v: { n: 2 } }),
  ].join("\n") + "\n");

  const store = openArchiveStore(jsonPath, silent);
  assert.deepEqual(store.entries.r1, { n: 1 }, "有效值不应被 null 抹掉");
  assert.equal(store.entries.x, undefined);

  store.entries.x = { n: 9 };
  const r = store.appendPending();
  assert.equal(r.rows, 1, "x 应能真正追加（未被 invalid 记录占槽）");

  const reopened = openArchiveStore(jsonPath, silent);
  assert.deepEqual(reopened.entries.x, { n: 9 });
  assert.deepEqual(reopened.entries.r1, { n: 1 });
});

test("日志已存在、旧 json 重新出现：只并入缺失条目，旧文件保留为新备份", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  const journal = journalPathForArchive(jsonPath);
  // 日志已含 r1（模拟降级运行旧版本后日志仍在）
  fs.writeFileSync(journal, JSON.stringify({ rid: "r1", v: { t: "a" } }) + "\n");
  // 旧单文件重新出现：r1 + r2
  fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, entries: { r1: { t: "a" }, r2: { t: "b" } } }));

  const store = openArchiveStore(jsonPath, silent);
  assert.deepEqual(Object.keys(store.entries).sort(), ["r1", "r2"], "缺失的 r2 应并入");
  const recs = readJsonLines(journal).records;
  assert.ok(recs.some((r) => r.rid === "r2"), "r2 应真正写进日志");
  assert.equal(recs.filter((r) => r.rid === "r1").length, 1, "已存在的 r1 不应重复并入");
  // 旧文件不原位保留，改名为备份（无既有 .imported 时即用 .imported）
  assert.ok(!fs.existsSync(jsonPath));
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith("usage-archive.json.imported"));
  assert.equal(backups.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), "utf8")).entries.r2);
});

test("旧 json 并入日志失败时保留原文件、不当作已完成迁移", () => {
  const dir = tmp();
  const jsonPath = path.join(dir, "usage-archive.json");
  const journal = journalPathForArchive(jsonPath);
  fs.mkdirSync(journal); // 用目录占位，令日志读/追加失败
  fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, entries: { r2: { t: "b" } } }));

  const store = openArchiveStore(jsonPath, silent);
  assert.equal(store.entries.r2, undefined);
  assert.ok(fs.existsSync(jsonPath), "合并失败时旧 json 必须保留原位");
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("usage-archive.json.imported")).length, 0, "不得产生改名备份");
});
