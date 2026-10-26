import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readTextFile } from "../runtime/engine/services/platform.js";

// 旧实现：不管有没有匹配都复制两份。新实现先探测再决定是否归一。
// 行为必须逐字节等价：BOM 只在开头去掉，CRLF 与孤立 CR 都归一成 LF。
const legacy = (file) => fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-readtext-"));

function write(name, buffer) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buffer);
  return p;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const body = Buffer.from([
  '{"type":"message"}',
  '{"type":"message","text":"中文与 emoji 😀"}',
  '',
  'line with lone CR: a\rb',
  'tail',
].join("\n"), "utf8");

const cases = [
  { name: "无 BOM + LF", buf: body },
  { name: "有 BOM + LF", buf: Buffer.concat([BOM, body]) },
  { name: "无 BOM + CRLF", buf: Buffer.from(body.toString("utf8").replace(/\n/g, "\r\n"), "utf8") },
  { name: "有 BOM + CRLF", buf: Buffer.concat([BOM, Buffer.from(body.toString("utf8").replace(/\n/g, "\r\n"), "utf8")]) },
];

test("readTextFile 与旧实现在 BOM × 换行 四种组合下逐字节一致", () => {
  for (const c of cases) {
    const p = write(c.name.replace(/[^\w]/g, "_") + ".txt", c.buf);
    const got = readTextFile(p);
    const want = legacy(p);
    assert.equal(got, want, "内容必须一致：" + c.name);
    assert.equal(Buffer.byteLength(got, "utf8"), Buffer.byteLength(want, "utf8"), "字节数必须一致：" + c.name);
    assert.ok(!got.includes("\r"), "输出里不该残留 CR：" + c.name);
    assert.notEqual(got.charCodeAt(0), 0xfeff, "输出开头不该残留 BOM：" + c.name);
  }

  // 归一后的正文确实一样：四种组合都该得到同一串
  const outs = cases.map((c) => readTextFile(write(c.name.replace(/[^\w]/g, "_") + "_same.txt", c.buf)));
  for (const o of outs) assert.equal(o, outs[0], "四种组合归一后应完全相同");
  assert.ok(outs[0].includes("lone CR: a\nb"), "孤立 CR 也要归一成 LF");
});

test("readTextFile：干净文件原样返回，BOM 只在开头去掉", () => {
  const clean = write("clean.txt", Buffer.from("a\nb\n", "utf8"));
  assert.equal(readTextFile(clean), "a\nb\n");

  // 中间出现的 U+FEFF 不是 BOM，旧实现也不会删（^ 只锚开头）
  const inner = write("inner.txt", Buffer.from("a\uFEFFb\n", "utf8"));
  assert.equal(readTextFile(inner), legacy(inner));
  assert.equal(readTextFile(inner), "a\uFEFFb\n", "正文里的 U+FEFF 不该被当成 BOM 删掉");

  // 空文件
  const empty = write("empty.txt", Buffer.alloc(0));
  assert.equal(readTextFile(empty), "");
});

test("readTextFile：连续多个 BOM 只吃第一个（与旧实现一致）", () => {
  const p = write("double-bom.txt", Buffer.concat([BOM, BOM, Buffer.from("x\r\ny", "utf8")]));
  assert.equal(readTextFile(p), legacy(p));
  assert.equal(readTextFile(p), "\uFEFFx\ny");
});
