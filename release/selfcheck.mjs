// SPDX-License-Identifier: MPL-2.0
//
// 本文件的结构与部分实现取自 H-i-m-s/git-save-load 的 release/selfcheck.mjs；
// 那部分又衍生自 GitHana（Copyright (c) 2026 Nyasers，以 MPL-2.0 授权）。
// 本文件已由 token-tracker-app 按本插件的结构重写，修改后的版本同样以 MPL-2.0 发布。
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// This Source Code Form is "Incompatible With Secondary Licenses", as
// defined by the Mozilla Public License, v. 2.0.
//
// release/selfcheck.mjs — Token 用量 的出包前自检。
//
// 这是整个 release/ 里跟插件绑得最紧的文件之一（另一个是 config.json）。
// 换插件要么重写它，要么删掉它并把 config.json 的 pack.selfcheck 改成 "none"。
//
// 只做「不依赖任何外部工具也能判定、坏了就是坏了」的那部分，给发版一个实际门槛：
//   1) manifest.json 能解析、必备字段齐全，entry 与 icon 指向的文件都在
//   2) manifest 里声明的每个 UI route 都有对应的 ui/ 页面（改了 manifest 忘了建页面，这里拦）
//   3) index.js / lib/ / runtime/ / ui/ 下所有 .js 与 .mjs 能通过语法检查
//   4) 本插件自己的测试套（node --test test/*.test.js）全绿
//
// 用法：
//   node release/selfcheck.mjs          # 人类可读，失败以非零码退出
//   node release/selfcheck.mjs --json   # { ok, errors, warnings, files, tests }
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(RELEASE_DIR, "..");
const JSON_MODE = process.argv.slice(2).includes("--json");

const errors = [];
const warnings = [];
const rel = (p) => relative(ROOT, p).split(sep).join("/");
const fail = (m) => errors.push(m);
const note = (m) => warnings.push(m);

// ── 1) manifest.json 与它指向的文件 ─────────────────────────────────────────
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
} catch (e) {
  fail(`manifest.json 无法解析：${(e && e.message) || e}`);
}

const REQUIRED_FIELDS = ["manifestVersion", "id", "name", "version", "entry", "icon"];
if (manifest) {
  for (const field of REQUIRED_FIELDS) {
    const value = manifest[field];
    if (value === undefined || value === null || value === "") fail(`manifest.json 缺少必备字段：${field}`);
  }
  if (typeof manifest.entry === "string" && manifest.entry && !existsSync(join(ROOT, manifest.entry))) {
    fail(`entry 指向的文件不存在：${manifest.entry}`);
  }
  if (typeof manifest.icon === "string" && manifest.icon && !existsSync(join(ROOT, manifest.icon))) {
    fail(`icon 指向的文件不存在：${manifest.icon}`);
  }
  if (manifest.capabilities !== undefined && !Array.isArray(manifest.capabilities)) {
    fail("manifest.json 的 capabilities 不是数组");
  }
}

// ── 2) manifest 声明的 UI route 必须有页面 ──────────────────────────────────
// 页面基准目录是 ui/：设置页、卡片页、函数面板都从那里取。
// 卡片封面（contributes.cards[].face.image）故意不查 —— 它写的 assets/... 实际落在 ui/assets/ 下，
// 换个基准就能对上，查了只会误报。
const UI_DIR = join(ROOT, "ui");
if (manifest) {
  const contributes = manifest.contributes || {};
  const declared = [];
  const decl = (route, from) => {
    if (typeof route === "string" && route) declared.push({ route, from });
  };
  decl(contributes.settings?.ui?.route, "contributes.settings.ui.route");
  for (const card of Array.isArray(contributes.cards) ? contributes.cards : []) {
    const id = (card && card.id) || "?";
    decl(card?.route, `contributes.cards[${id}].route`);
    decl(card?.functionPanel?.route, `contributes.cards[${id}].functionPanel.route`);
    decl(card?.detached?.route, `contributes.cards[${id}].detached.route`);
  }
  for (const { route, from } of declared) {
    const file = join(UI_DIR, route.replace(/^\/+/, ""));
    if (!existsSync(file)) {
      fail(`${from} 指向的页面不存在：ui${route.startsWith("/") ? route : "/" + route}`);
    }
  }
}

// ── 3) 会被宿主加载的 JS 都要能解析 ─────────────────────────────────────────
function collectJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) collectJs(p, out);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const jsFiles = [];
const seen = new Set();
const addJs = (p) => {
  if (existsSync(p) && !seen.has(p)) {
    seen.add(p);
    jsFiles.push(p);
  }
};
addJs(join(ROOT, "index.js"));
for (const dir of ["lib", "runtime", "ui"]) {
  for (const f of collectJs(join(ROOT, dir))) addJs(f);
}

/** 把一段源码交给 `node --check`，只问语法。 */
function checkSyntaxOnce(src, inputType) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--input-type=" + inputType, "--check"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    child.on("error", (e) => done({ ok: false, out: `起进程失败：${(e && e.message) || e}` }));
    child.on("close", (code) => done(code === 0 ? { ok: true } : { ok: false, out: out.trim() }));
    child.stdin.on("error", () => {}); // 子进程先退出时忽略 EPIPE
    child.stdin.end(src);
  });
}

/** 一个文件的语法检查。
 *
 * 不走「node --check <文件>」：Node 24 对 .js 会做模块自动探测，即便后面真有语法错误也可能返回 0
 * （git-save-load 那边实测过），会漏报。所以显式指定 --input-type：
 * .mjs 只按 ESM 检一遍；.js 两种模式各检一遍，有一种过就算语法合法
 * （ui/sdk/ui.js 这类宿主 SDK bundle 可能是 CJS 或 UMD）。
 */
async function checkSyntax(file) {
  let src;
  try {
    src = readFileSync(file);
  } catch (e) {
    return { ok: false, out: `读取失败：${(e && e.message) || e}` };
  }
  const asEsm = await checkSyntaxOnce(src, "module");
  if (asEsm.ok) return { ok: true };
  if (file.endsWith(".mjs")) return { ok: false, out: asEsm.out };
  const asCjs = await checkSyntaxOnce(src, "commonjs");
  if (asCjs.ok) return { ok: true };
  return { ok: false, out: /\b(import|export)\b/.test(src.toString("utf8")) ? asEsm.out : asCjs.out };
}

/** 并发跑完所有文件。
 *
 * 串行 spawn 在 Windows 上每个 node 起步约 90ms，59 个文件要 5 秒多；并发 8 路压到 1 秒内。
 * 并发度不往上加：几十个 node 进程同时起会吃不消，这里的瓶颈本来就是进程创建而不是 CPU。 */
async function checkAllSyntax(files, concurrency = 8) {
  const results = new Map();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= files.length) return;
      results.set(files[i], await checkSyntax(files[i]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}

const syntax = await checkAllSyntax(jsFiles);
for (const file of jsFiles) {
  const r = syntax.get(file);
  if (r && !r.ok) {
    // node --check 从 stdin 读时，报错里的文件名是 `[stdin]`，且代码帧后面跟空行；
    // 直接取前三行会只剩一个 [stdin]:102 加两行空白，把 SyntaxError 那行丢掉。
    const text = (r.out || "").replace(/\[stdin\]/g, rel(file));
    const head = text
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 4)
      .join("\n    ");
    fail(`语法检查失败：${rel(file)}${head ? "\n    " + head : ""}`);
  }
}

// ── 4) 本插件自己的测试套 ───────────────────────────────────────────────────
const TEST_GLOB = "test/*.test.js";
let testCount = 0;
if (!existsSync(join(ROOT, "test"))) {
  note(`没找到 test/ 目录，跳过测试套（${TEST_GLOB}）`);
} else {
  const r = spawnSync(process.execPath, ["--test", TEST_GLOB], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const lines = out.split("\n");

  // 摘要行的前缀随 reporter 变：非 TTY 下 Node 24 用 spec reporter，打的是 `ℹ tests 241`；
  // TAP 是 `# tests 241`。两种都认，免得换个 Node 版本或环境就数不出来。
  const summary = [];
  for (const line of lines) {
    const m = line.trim().match(/^(?:ℹ|#)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/);
    if (!m) continue;
    summary.push(`${m[1]} ${m[2]}`);
    if (m[1] === "tests") testCount = Number(m[2]);
  }

  if (r.status !== 0) {
    const bad = lines
      .filter((l) => /^\s*(not ok|✖)\s/.test(l))
      .slice(0, 8)
      .map((l) => l.trim());
    fail(
      `测试套未通过（${TEST_GLOB}，退出码 ${r.status ?? "?"}）` +
        (bad.length ? `\n    ${bad.join("\n    ")}` : "") +
        (summary.length ? `\n    ${summary.join(" · ")}` : ""),
    );
  } else if (!summary.length) {
    note("测试套退出码为 0，但没看到摘要行，用例数未知");
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────
const ok = errors.length === 0;

if (JSON_MODE) {
  console.log(JSON.stringify({ ok, errors, warnings, files: jsFiles.length, tests: testCount }, null, 2));
} else {
  for (const w of warnings) console.log(`  warn: ${w}`);
  for (const e of errors) console.error(`  FAIL: ${e}`);
  console.log(
    `[selfcheck] 语法 ${jsFiles.length} 个文件 · 测试 ${testCount} 个用例 · ` +
      `错误 ${errors.length} · 警告 ${warnings.length} · ${ok ? "OK" : "FAILED"}`,
  );
}

process.exit(ok ? 0 : 1);
