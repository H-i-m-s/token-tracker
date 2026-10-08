import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDisplayUnitsReader } from "../lib/display-units.mjs";
import { engineDataDir } from "../lib/local-client.mjs";
import { createSettingsService } from "../runtime/engine/services/settings.js";

// 这一条盯的是「主进程读的那份，就是引擎写的那份」：
// 设置文件在 dataDir/engine/ 下（引擎自己的数据目录），不在 dataDir 根。两边各拼一遍路径，
// 出错时不会报错，只会安静地一直用默认单位制 —— 所以必须拿真写一次来对。
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tt-units-read-"));

test("引擎写进设置里的数字单位，主进程读得到", () => {
  const dataDir = freshDir();
  // 引擎子进程拿到的就是 engineDataDir(dataDir)（见 lib/local-client.mjs 起它时那份配置）。
  createSettingsService({ dataDir: engineDataDir(dataDir) }).write({ display: { units: "en" } });
  const read = createDisplayUnitsReader({ dataDir });
  assert.equal(read(), "en");
  assert.equal(fs.existsSync(path.join(engineDataDir(dataDir), "app-settings.json")), true, "文件确实落在 engine/ 下");
  assert.equal(fs.existsSync(path.join(dataDir, "app-settings.json")), false, "而不是 dataDir 根下");
});

test("没写过 / 文件坏了 / 没有数据目录：一律 null，由调用方退回默认", () => {
  const dataDir = freshDir();
  assert.equal(createDisplayUnitsReader({ dataDir })(), null);

  fs.mkdirSync(engineDataDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(engineDataDir(dataDir), "app-settings.json"), "{ 这不是 JSON");
  assert.equal(createDisplayUnitsReader({ dataDir })(), null);

  fs.writeFileSync(path.join(engineDataDir(dataDir), "app-settings.json"), JSON.stringify({ scanInterval: 60 }));
  assert.equal(createDisplayUnitsReader({ dataDir })(), null, "没有 display 也是 null，不是默认值");

  assert.equal(createDisplayUnitsReader({ dataDir: null })(), null);
});

test("读的时候不改盘（写是引擎那边的事）", () => {
  const dataDir = freshDir();
  const file = path.join(engineDataDir(dataDir), "app-settings.json");
  createSettingsService({ dataDir: engineDataDir(dataDir) }).write({ display: { density: "compact", units: "zh" } });
  const before = fs.readFileSync(file, "utf8");
  assert.equal(createDisplayUnitsReader({ dataDir })(), "zh");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
