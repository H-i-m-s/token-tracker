import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistSensenovaToken } from "../runtime/engine/services/balance.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "tt-sensenova-")); }
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "balance-apis.json"), "utf8"));
const tmpFiles = (dir) => fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mkToken = (expSec) => "h." + b64url({ exp: expSec }) + ".s";

test("无旧文件时原子创建 balance-apis.json，不留 tmp 残渣", async () => {
  const dir = tmp();
  await persistSensenovaToken(dir, { token: "T1" });
  assert.equal(read(dir).sensenova.token, "T1");
  assert.deepEqual(tmpFiles(dir), []);
});

test("令牌无变化时不写盘", async () => {
  const dir = tmp();
  await persistSensenovaToken(dir, { token: "T1" });
  const before = fs.statSync(path.join(dir, "balance-apis.json")).mtimeMs;
  const changed = await persistSensenovaToken(dir, { token: "T1" });
  assert.equal(changed, false);
  assert.equal(fs.statSync(path.join(dir, "balance-apis.json")).mtimeMs, before);
});

test("保留文件里其他 provider 配置", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({ deepseek: { url: "https://x" } }));
  await persistSensenovaToken(dir, { token: "T1", refreshToken: "R1" });
  const f = read(dir);
  assert.deepEqual(f.deepseek, { url: "https://x" });
  assert.equal(f.sensenova.token, "T1");
  assert.equal(f.sensenova.refreshToken, "R1");
});

test("并发写入串行化，不互相覆盖字段", async () => {
  const dir = tmp();
  await Promise.all([
    persistSensenovaToken(dir, { token: "A" }),
    persistSensenovaToken(dir, { refreshToken: "RA" }),
  ]);
  const f = read(dir);
  assert.equal(f.sensenova.token, "A", "token 不应被并发写覆盖丢失");
  assert.equal(f.sensenova.refreshToken, "RA", "refreshToken 不应丢失");
});

test("旧文件读不出时放弃写入，不破坏旧文件", async () => {
  const dir = tmp();
  const p = path.join(dir, "balance-apis.json");
  fs.writeFileSync(p, "{ 这不是 JSON");
  await assert.rejects(persistSensenovaToken(dir, { token: "X" }));
  assert.equal(fs.readFileSync(p, "utf8"), "{ 这不是 JSON");
});

// F7：同字段冲突时，较旧的调用方副本不得覆盖较新的已存令牌。
test("较旧的 token/refreshToken 不得覆盖较新的已存值", async () => {
  const dir = tmp();
  const newer = mkToken(2000000000);
  const older = mkToken(1000000000);
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({
    sensenova: { token: newer, refreshToken: "R-newer" },
  }));

  const changed = await persistSensenovaToken(dir, { token: older, refreshToken: "R-older" });
  assert.equal(changed, false, "旧令牌不应触发写入");
  const f = read(dir);
  assert.equal(f.sensenova.token, newer);
  assert.equal(f.sensenova.refreshToken, "R-newer");
});

test("更新的 token 可以覆盖，并连同本次的 refreshToken 一起更新", async () => {
  const dir = tmp();
  const older = mkToken(1000000000);
  const newest = mkToken(3000000000);
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({
    sensenova: { token: older, refreshToken: "R-old" },
  }));

  const changed = await persistSensenovaToken(dir, { token: newest, refreshToken: "R-new" });
  assert.equal(changed, true);
  const f = read(dir);
  assert.equal(f.sensenova.token, newest);
  assert.equal(f.sensenova.refreshToken, "R-new");
});

test("并发写入不会让较旧副本胜出", async () => {
  const dir = tmp();
  await Promise.all([
    persistSensenovaToken(dir, { token: mkToken(3000000000), refreshToken: "R-new" }),
    persistSensenovaToken(dir, { token: mkToken(1000000000), refreshToken: "R-old" }),
  ]);
  const f = read(dir);
  assert.equal(f.sensenova.token, mkToken(3000000000));
  assert.equal(f.sensenova.refreshToken, "R-new");
});

test("无法解析过期时间时不覆盖已有 token（保守）", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({
    sensenova: { token: "opaque-old", refreshToken: "R-keep" },
  }));
  const changed = await persistSensenovaToken(dir, { token: "opaque-new", refreshToken: "R-keep" });
  assert.equal(changed, false);
  assert.equal(read(dir).sensenova.token, "opaque-old");
});
