import test from "node:test";
import assert from "node:assert/strict";
import {
  UNIT_SYSTEMS, DEFAULT_UNIT_SYSTEM, normalizeUnitSystem, setUnitSystem, getUnitSystem,
  stepsOf, unitStep, scaleText, unitsFromSnapshot,
} from "../ui/units.mjs";

// 两套单位制的档位表本身要自洽：档位从大到小、每档的除数就是它的下限。
test("档位表：从大到小、div 与 min 一致", () => {
  for (const system of UNIT_SYSTEMS) {
    const mins = system.steps.map((s) => s.min);
    assert.deepEqual(mins, [...mins].sort((a, b) => b - a), `${system.key} 的档位没有从大到小`);
    for (const step of system.steps) {
      assert.equal(step.div, step.min, `${system.key}/${step.suffix} 的除数与下限不一致`);
      assert.ok(step.suffix, `${system.key} 有一档没写后缀`);
      assert.ok(Number.isInteger(step.digits) && step.digits >= 0, `${system.key}/${step.suffix} 的小数位不合法`);
    }
  }
  assert.equal(DEFAULT_UNIT_SYSTEM, "zh", "默认必须是中文那一套：没配置过的人看到的东西不能变");
});

test("认不出来的值一律回到默认那套", () => {
  assert.equal(normalizeUnitSystem("en"), "en");
  assert.equal(normalizeUnitSystem("zh"), "zh");
  assert.equal(normalizeUnitSystem("EN"), "zh", "大小写不认");
  assert.equal(normalizeUnitSystem("pt"), "zh");
  assert.equal(normalizeUnitSystem(null), "zh");
  assert.equal(normalizeUnitSystem(42), "zh");
});

test("中文：万 / 亿 / 万亿，不到万就写原数", () => {
  const zh = { system: "zh" };
  assert.equal(scaleText(9999, zh), "9999");
  assert.equal(scaleText(10000, zh), "1.0万");
  assert.equal(scaleText(45678, zh), "4.6万");
  assert.equal(scaleText(241000, zh), "24.1万");
  assert.equal(scaleText(81799000, zh), "8179.9万", "亿之前那一档会很长，这是中文分档本身的样子");
  assert.equal(scaleText(1e8, zh), "1.00亿");
  assert.equal(scaleText(26092400000, zh), "260.92亿", "看板合计那一行的写法");
  assert.equal(scaleText(1e12, zh), "1.00万亿");
  assert.equal(scaleText(0, zh), "0");
});

test("英文：K / M / B / T", () => {
  const en = { system: "en" };
  assert.equal(scaleText(999, en), "999");
  assert.equal(scaleText(1000, en), "1.0K");
  assert.equal(scaleText(2580000, en), "2.58M");
  assert.equal(scaleText(81900000, en), "81.90M");
  assert.equal(scaleText(1e9, en), "1.00B");
  assert.equal(scaleText(26092400000, en), "26.09B", "同一个数字，英文那一档");
  assert.equal(scaleText(2.5516e11, en), "255.16B");
  assert.equal(scaleText(1e12, en), "1.00T");
});

test("trim / space / plain / digits 四个口子各自管一件事", () => {
  assert.equal(scaleText(1e8, { system: "zh", trim: true }), "1亿");
  assert.equal(scaleText(12345, { system: "zh", trim: true }), "1.2万");
  assert.equal(scaleText(1.5e6, { system: "en", trim: true }), "1.5M");
  assert.equal(scaleText(300, { trim: true }), "300", "整数不能被当尾零裁掉");
  assert.equal(scaleText(26092400000, { system: "zh", space: " " }), "260.92 亿", "看板那边数字与单位之间有空格");
  assert.equal(scaleText(8500, { plain: (v) => v.toLocaleString("en-US") }), "8,500");
  assert.equal(scaleText(26092400000, { system: "zh", digits: 1 }), "260.9亿");
  assert.equal(scaleText(1.23456789e9, { system: "en", digits: 0 }), "1B");
});

test("非数字给破折号，数字字符串照收", () => {
  assert.equal(scaleText(NaN), "—");
  assert.equal(scaleText(undefined), "—");
  assert.equal(scaleText("abc"), "—");
  assert.equal(scaleText(Infinity), "—");
  assert.equal(scaleText("12345"), "1.2万", "接口给回来的字符串也得认");
});

test("选档：不到最小档返回 null", () => {
  assert.equal(unitStep(9999), null);
  assert.equal(unitStep(10000)?.suffix, "万");
  assert.equal(unitStep(1e8)?.suffix, "亿");
  assert.equal(unitStep(2e3, "en")?.suffix, "K");
  assert.equal(unitStep(1e6, "en")?.suffix, "M");
  assert.equal(unitStep(999, "en"), null);
  assert.equal(unitStep(NaN), null);
  assert.equal(stepsOf("en").length, 4);
  assert.equal(stepsOf("不存在的那套").length, stepsOf("zh").length, "认不出来就按中文");
});

test("快照里带的单位：认得出就认，认不出/没带就不动", () => {
  assert.equal(unitsFromSnapshot({ display: { units: "en" } }), "en");
  assert.equal(unitsFromSnapshot({ display: { units: "zh" } }), "zh");
  assert.equal(unitsFromSnapshot({ display: {} }), null, "没带就当「这次没告诉我」，不能默认成中文");
  assert.equal(unitsFromSnapshot({}), null);
  assert.equal(unitsFromSnapshot(null), null);
  assert.equal(unitsFromSnapshot({ display: { units: "pt" } }), null);
});

test("当前那一套：默认中文，换过之后跟着换", () => {
  assert.equal(getUnitSystem(), "zh");
  const wasSet = setUnitSystem("en");
  assert.equal(wasSet, "en");
  try {
    assert.equal(getUnitSystem(), "en");
    assert.equal(scaleText(2500), "2.5K", "不传 system 时用当前生效的那套");
  } finally {
    setUnitSystem("zh");
  }
  assert.equal(scaleText(2500), "2500");
  assert.equal(setUnitSystem("乱写"), "zh", "坏值回默认");
});
