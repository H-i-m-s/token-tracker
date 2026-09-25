import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameToBackup } from "../runtime/engine/services/jsonl-log.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "tt-rename-")); }

test("无既有备份时用原名", () => {
  const dir = tmp();
  const f = path.join(dir, "a.json");
  fs.writeFileSync(f, "cur");
  const dest = renameToBackup(f, ".imported");
  assert.equal(dest, f + ".imported");
  assert.equal(fs.readFileSync(dest, "utf8"), "cur");
  assert.ok(!fs.existsSync(f));
});

test("已有备份时不删除/覆盖，改用带时间戳的新名", () => {
  const dir = tmp();
  const f = path.join(dir, "a.json");
  fs.writeFileSync(f, "cur");
  fs.writeFileSync(f + ".imported", "OLD-BACKUP");
  const dest = renameToBackup(f, ".imported");
  assert.ok(dest.startsWith(f + ".imported-"), "应带时间戳");
  assert.equal(fs.readFileSync(f + ".imported", "utf8"), "OLD-BACKUP", "既有备份必须原样保留");
  assert.equal(fs.readFileSync(dest, "utf8"), "cur");
  assert.ok(!fs.existsSync(f));
});
