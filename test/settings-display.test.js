import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSettingsService } from "../runtime/engine/services/settings.js";

// 数字单位落在 app-settings.json 的 display.units 上，跟表格密度同一格。
// 这里只管一件事：读出来的形状稳不稳、写进去的坏值拦不拦、只改密度时会不会把单位抹掉。
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-settings-"));
}
const settingsPath = (dir) => path.join(dir, "app-settings.json");

test("没写过的时候：中文单位 + 紧凑密度", () => {
  const dir = freshDir();
  const service = createSettingsService({ dataDir: dir });
  const read = service.read();
  assert.deepEqual(read.display, { density: "compact", units: "zh", colorScheme: "auto" });
  assert.equal(read.scanInterval, 60);
  assert.equal(read.highUsageThreshold, 30000);
});

test("写入后读回来一致，换个实例读同一份盘也一致", () => {
  const dir = freshDir();
  const service = createSettingsService({ dataDir: dir });
  const saved = service.write({ display: { density: "comfortable", units: "en" } });
  assert.deepEqual(saved.display, { density: "comfortable", units: "en", colorScheme: "auto" });
  const fresh = createSettingsService({ dataDir: dir }).read();
  assert.equal(fresh.display.units, "en");
  assert.equal(fresh.display.density, "comfortable");
});

test("只发一项时另一项保持不动（菜单里只换单位，设置页两项一起发）", () => {
  const dir = freshDir();
  const service = createSettingsService({ dataDir: dir });
  service.write({ display: { density: "comfortable", units: "en" } });

  const byDensity = service.write({ display: { density: "compact" } });
  assert.equal(byDensity.display.units, "en");
  assert.equal(byDensity.display.density, "compact");

  const byUnits = service.write({ display: { units: "zh" } });
  assert.equal(byUnits.display.units, "zh");
  assert.equal(byUnits.display.density, "compact", "只换单位不能把密度带走");
});

// 用户实际踩到的那条：从没在设置页存过（盘上没有 display），在显示设置菜单里只发单位，
// 当时那段兜底沿用的是「盘上那份」= undefined，于是一律判成「无效的显示密度」。
test("从没存过 display 时，只发单位也存得下来（密度按默认兜）", () => {
  const service = createSettingsService({ dataDir: freshDir() });
  const saved = service.write({ display: { units: "en" } });
  assert.deepEqual(saved.display, { density: "compact", units: "en", colorScheme: "auto" });
  assert.equal(service.read().display.units, "en", "读回来也得是英文");
});

test("空补丁拿到的是默认值，与 read() 同一个答案", () => {
  const service = createSettingsService({ dataDir: freshDir() });
  assert.deepEqual(service.write({ display: {} }).display, { density: "compact", units: "zh", colorScheme: "auto" });
});

test("坏值拦下来，且不落盘", () => {
  const dir = freshDir();
  const service = createSettingsService({ dataDir: dir });
  service.write({ display: { density: "compact", units: "en" } });

  assert.throws(() => service.write({ display: { density: "compact", units: "pt" } }), /数字单位/);
  assert.throws(() => service.write({ display: { units: "宽宽松松" } }), /数字单位/);
  assert.throws(() => service.write({ display: { density: "宽宽松松" } }), /显示密度/);
  const after = service.read();
  assert.equal(after.display.units, "en", "被拒的写入不能改动盘上那份");
  assert.equal(after.display.density, "compact");

  // 区间那两项的既有约束也顺手盯一眼，别在改这一块时被带松。
  assert.throws(() => service.write({ scanInterval: 5 }), /超出范围/);
  assert.throws(() => service.write({ highUsageThreshold: -1 }), /超出范围/);
});

test("设置文件被手改坏了：读出来回默认，不倒灌回盘", () => {
  const dir = freshDir();
  fs.writeFileSync(settingsPath(dir), JSON.stringify({ display: { density: "weird", units: "pt" } }));
  const read = createSettingsService({ dataDir: dir }).read();
  assert.deepEqual(read.display, { density: "compact", units: "zh", colorScheme: "auto" });
  assert.equal(JSON.parse(fs.readFileSync(settingsPath(dir), "utf8")).display.units, "pt", "读的时候不改盘");
});
