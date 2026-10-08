// 数字量级单位的唯一口径：中文（万 / 亿）与英文（K / M / B）两套。开关在 App 设置 → 显示。
//
// 为什么单独一个文件：同一件事原来在四个地方各写了一遍 ——
//   ui/components.mjs     fmt()              中文「亿」和英文「M / k」混在同一份里
//   ui/analytics.mjs      compact()          中文「万 / 亿」，数字与单位之间有一个空格
//   ui/charts.mjs         fmtTokensShort()   英文「K / M / B」
//   lib/session-cache.mjs fmtNum() / fmtK()  中文「万 / 亿」，输出 token 另走英文「k」
// 四份的档位、精度、空格各不相同，谁也做不到「一次切换」。
// 这里只收敛三件事：选哪一档、后缀是什么、留几位小数。其余由调用点传参决定
// （要不要空格、不够最小档时怎么写原数）—— 它们确实是不同的版面。
//
// 放在 ui/ 下而不是 lib/：这份要被 iframe 里的页面直接 import（浏览器只拿得到 ui/ 这一层），
// 主进程 lib/session-cache.mjs 用相对路径 ../ui/units.mjs 引同一份，两边永远同一个口径。

// digits 是这一档留几位小数，取的是各调用点今天已经在用的那套：大档多留一位，K 只留一位。
export const UNIT_SYSTEMS = [
  {
    key: "zh",
    label: "中文（万 / 亿）",
    steps: [
      { min: 1e12, div: 1e12, suffix: "万亿", digits: 2 },
      { min: 1e8, div: 1e8, suffix: "亿", digits: 2 },
      { min: 1e4, div: 1e4, suffix: "万", digits: 1 },
    ],
  },
  {
    key: "en",
    label: "英文（K / M / B）",
    steps: [
      { min: 1e12, div: 1e12, suffix: "T", digits: 2 },
      { min: 1e9, div: 1e9, suffix: "B", digits: 2 },
      { min: 1e6, div: 1e6, suffix: "M", digits: 2 },
      { min: 1e3, div: 1e3, suffix: "K", digits: 1 },
    ],
  },
];

export const DEFAULT_UNIT_SYSTEM = "zh";

// 认不出来的值一律回到默认那套：设置是磁盘上的字符串，坏值不该让整页数字变形。
export function normalizeUnitSystem(value) {
  return UNIT_SYSTEMS.some((s) => s.key === value) ? value : DEFAULT_UNIT_SYSTEM;
}

let current = DEFAULT_UNIT_SYSTEM;

// 每个页面（iframe）各自一份模块实例，bootstrap 读完设置调一次就够。
// 主进程不调它：那边按调用点传 system，少一份跨进程共享的可变全局。
export function setUnitSystem(value) {
  current = normalizeUnitSystem(value);
  return current;
}

export function getUnitSystem() {
  return current;
}

export function stepsOf(system = current) {
  const found = UNIT_SYSTEMS.find((s) => s.key === normalizeUnitSystem(system));
  return (found || UNIT_SYSTEMS[0]).steps;
}

// 选档：返回这一档的 { div, suffix, digits }；不够最小档时返回 null，
// 原数怎么写交给调用点（看板写 8,500，图表刻度写 8500，各有各的版面要求）。
export function unitStep(value, system = current) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  for (const step of stepsOf(system)) {
    if (v >= step.min) return step;
  }
  return null;
}

// 快照里带的数字单位（引擎把设置里的这一项搭在 /snapshot 上）。
// 没有这一项就返回 null：「这次没告诉我」与「告诉我用中文」是两回事 ——
// 前者不该让页面把数字按中文重画一遍（mock、旧引擎都不会带这一项）。
export function unitsFromSnapshot(snapshot) {
  const value = snapshot?.display?.units;
  return value === "en" || value === "zh" ? value : null;
}

// 缩到当前单位制最合适的一档。
//   system  用哪一套，默认当前生效的那套
//   digits  覆盖这一档的小数位，默认用档位自带的那套
//   space   数字与单位之间垫什么，默认不垫
//   trim    去掉多余的小数尾零（1.50M → 1.5M、10.00亿 → 10亿）
//   plain   不够最小档时怎么写原数，默认取整
export function scaleText(value, options = {}) {
  const { system = current, digits = null, space = "", trim = false, plain = null } = options;
  const v = Number(value);
  if (!Number.isFinite(v)) return "—";
  const writePlain = typeof plain === "function" ? plain : (n) => String(Math.round(n));
  const step = unitStep(v, system);
  if (!step) return writePlain(v);
  let text = (v / step.div).toFixed(digits ?? step.digits);
  // 只在真带小数的时候裁尾零：整数 "300" 不能被裁成 "3"。
  if (trim && text.includes(".")) text = text.replace(/\.?0+$/, "");
  return text + space + step.suffix;
}
