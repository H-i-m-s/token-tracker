import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSettingsService } from "../runtime/engine/services/settings.js";

// 设置文件被手改坏（少一个引号、多一个逗号）时的行为。
//
// 以前 load 是裸 JSON.parse：坏一个字符，引擎启动第一行就抛，之后每个请求都回同一个
// SyntaxError，整个 App 白屏。而同一份文件在 lib/display-units.mjs 里是 try/catch 回默认值。
// 现在两边一致：改名留底，本次按默认值继续，并把原因写进日志。

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-settings-broken-"));
}

test("app-settings.json 坏了：不抛、回默认值、坏文件留底", () => {
  const dir = freshDir();
  const file = path.join(dir, "app-settings.json");
  fs.writeFileSync(file, '{ "scanInterval": 30, "display": { "units": "en" ', "utf8");

  const warnings = [];
  const service = createSettingsService({ dataDir: dir, log: { warn: (...a) => warnings.push(a.join(" ")) } });
  const read = service.read();
  assert.equal(read.scanInterval, 60, "坏文件必须退回默认值");
  assert.deepEqual(read.display, { density: "compact", units: "zh", currency: "usd", colorScheme: "auto" });

  assert.equal(fs.existsSync(file), false, "坏文件应该被改名，而不是留在原地继续毒害下一次启动");
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith("app-settings.json.broken-"));
  assert.equal(backups.length, 1, "要留一份坏文件当证据");
  assert.equal(warnings.length, 1, "静默吞掉不行，至少要留一条告警");
});

test("坏文件之后还能正常写：写出来的就是干净的设置", () => {
  const dir = freshDir();
  const file = path.join(dir, "app-settings.json");
  fs.writeFileSync(file, "not json at all", "utf8");
  const service = createSettingsService({ dataDir: dir, log: { warn: () => {} } });
  const saved = service.write({ scanInterval: 120, display: { units: "en" } });
  assert.equal(saved.scanInterval, 120);
  assert.equal(saved.display.units, "en");
  // 盘上这份现在必须是能被解析的
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).scanInterval, 120);
});

test("balance-apis.json 坏了：读设置不炸、写设置也不炸", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "balance-apis.json"), "{ oops", "utf8");
  const service = createSettingsService({ dataDir: dir, log: { warn: () => {} } });
  const read = service.read();
  // 默认口径：deepseek / glm 默认开
  assert.equal(read.balanceApis.deepseek.enabled, true);
  const saved = service.write({ scanInterval: 90 });
  assert.equal(saved.scanInterval, 90);
});

test("内容不是对象（比如一个数组/字符串）也按坏文件处理", () => {
  const dir = freshDir();
  const file = path.join(dir, "app-settings.json");
  fs.writeFileSync(file, '"just a string"', "utf8");
  const service = createSettingsService({ dataDir: dir, log: { warn: () => {} } });
  assert.equal(service.read().scanInterval, 60);
  assert.equal(fs.existsSync(file), false);
});
