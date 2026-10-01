import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionCacheStatus, CACHE_ITEM_ID } from "../lib/session-cache.mjs";
import { createInputStatusPrefs, normalizePrefs, DEFAULT_PREFS } from "../lib/input-status-prefs.mjs";

const silent = () => {};

// 一条能算得出缓存命中率、输出与次数的账本记录。
const entry = () => ({
  requestId: "r1",
  startedAt: "2026-10-01T10:00:00Z",
  model: { provider: "p", modelId: "m" },
  usage: { cache: { readTokens: 800 }, input: { uncachedTokens: 200 }, output: { totalTokens: 100 } },
});

// 建一个被观测的 SessionCacheStatus：记下每次 inputStatus.set 与 bus.request 的名字。
function harness({ prefs = null, entries = [entry()], speed = { tps: 42, ttft: 1500, scope: "session" } } = {}) {
  const applied = [];
  const asked = [];
  let speedCalls = 0;
  const status = new SessionCacheStatus({
    bus: {
      subscribe: () => () => {},
      request: async (name) => { asked.push(name); return name === "usage:list" ? { entries } : {}; },
    },
    inputStatus: { set: async (payload) => { applied.push(payload); } },
    log: silent,
    speedQuery: async () => { speedCalls += 1; return speed; },
    getPrefs: prefs ? () => prefs : null,
  });
  return { status, applied, asked, speedCalls: () => speedCalls, last: () => applied[applied.length - 1] };
}

test("card=false：refresh 直接推 visible:false，不查账本也不查速度", async () => {
  const h = harness({ prefs: { card: false, cache: true, speed: true, ttft: true } });
  await h.status.refresh("s1");
  assert.deepEqual(h.asked, [], "card 关着时不该问宿主账本");
  assert.equal(h.speedCalls(), 0, "card 关着时不该查速度");
  assert.equal(h.last()?.id, CACHE_ITEM_ID);
  assert.equal(h.last()?.visible, false);
  assert.equal(h.last()?.text, undefined, "收起不该带文本");
});

test("cache 关掉：文本里没有缓存那一段，速度/首字仍在", async () => {
  const h = harness({ prefs: { card: true, cache: false, speed: true, ttft: true } });
  await h.status.refresh("s1");
  const text = h.last()?.text || "";
  assert.equal(h.last()?.visible, true);
  assert.ok(!text.includes("缓存"), `不该出现缓存段：${text}`);
  assert.ok(text.includes("速度：42 tok/s"), `应保留速度段：${text}`);
  assert.ok(text.includes("首字：1.5 s"), `应保留首字段：${text}`);
});

test("speed 关掉：文本里没有速度那一段", async () => {
  const h = harness({ prefs: { card: true, cache: true, speed: false, ttft: true } });
  await h.status.refresh("s1");
  const text = h.last()?.text || "";
  assert.ok(!text.includes("速度"), `不该出现速度段：${text}`);
  assert.ok(text.includes("缓存：80.0%"), `应保留缓存段：${text}`);
  assert.ok(text.includes("首字：1.5 s"), `应保留首字段：${text}`);
});

test("ttft 关掉：文本里没有首字那一段", async () => {
  const h = harness({ prefs: { card: true, cache: true, speed: true, ttft: false } });
  await h.status.refresh("s1");
  const text = h.last()?.text || "";
  assert.ok(!text.includes("首字"), `不该出现首字段：${text}`);
  assert.ok(text.includes("缓存：80.0%"), `应保留缓存段：${text}`);
  assert.ok(text.includes("速度：42 tok/s"), `应保留速度段：${text}`);
});

test("三个字段全关：等价于卡片不显示（visible:false，不保留上一次文本）", async () => {
  const h = harness({ prefs: { card: true, cache: false, speed: false, ttft: false } });
  await h.status.refresh("s1");
  assert.equal(h.last()?.visible, false);
  assert.equal(h.last()?.text, undefined);
});

test("tooltip 随 cache 开关：开时有命中/未命中，关掉整段不拼（可能为空就不传该字段）", async () => {
  const on = harness({ prefs: { card: true, cache: true, speed: true, ttft: true } });
  await on.status.refresh("s1");
  assert.ok((on.last()?.tooltip || "").includes("命中"), "cache 开着应带缓存派生 tooltip");
  assert.ok((on.last()?.tooltip || "").includes("未命中"));

  const off = harness({ prefs: { card: true, cache: false, speed: true, ttft: true } });
  await off.status.refresh("s1");
  const tip = off.last()?.tooltip;
  assert.ok(!("tooltip" in (off.last() || {})) || !tip, "cache 关掉后 tooltip 不该带缓存派生内容");
  assert.ok(off.last()?.visible, "还有速度段，卡片仍应显示");
});

test("缺省 getPrefs：行为与加开关之前一致（三条都有就都出现）", async () => {
  const h = harness({ prefs: null });
  await h.status.refresh("s1");
  const text = h.last()?.text || "";
  assert.ok(text.includes("缓存：80.0%"));
  assert.ok(text.includes("速度：42 tok/s"));
  assert.ok(text.includes("首字：1.5 s"));
  assert.ok((h.last()?.tooltip || "").includes("命中"));
});

test("card 由开变关：hideAll 把已挂卡片的会话逐个收起", async () => {
  const h = harness({ prefs: { card: true, cache: true, speed: true, ttft: true } });
  await h.status.refresh("s1");
  await h.status.refresh("s2");
  assert.ok(h.last()?.visible, "刷新后应挂着卡片");
  await h.status.hideAll();
  const hidden = h.applied.slice(-2);
  assert.deepEqual(hidden.map((p) => p.sessionId).sort(), ["s1", "s2"]);
  assert.ok(hidden.every((p) => p.visible === false));
});

// ---------- 偏好文件：读写合并语义 ----------

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-inputstatus-"));
  return path.join(dir, "input-status.json");
}

test("normalizePrefs：只认四个键的布尔值，其余丢弃，缺失回落全 true", () => {
  assert.deepEqual(normalizePrefs(null), { ...DEFAULT_PREFS });
  assert.deepEqual(normalizePrefs({ card: false }), { card: false, cache: true, speed: true, ttft: true });
  assert.deepEqual(normalizePrefs({ cache: "yes", speed: 0, bogus: true }), { ...DEFAULT_PREFS });
});

test("偏好文件缺失 → 回落全 true，不抛错", () => {
  const store = createInputStatusPrefs({ file: tmpFile(), log: silent });
  assert.deepEqual(store.read(), { ...DEFAULT_PREFS });
});

test("只覆盖传入的键，其余保持原值", () => {
  const file = tmpFile();
  const store = createInputStatusPrefs({ file, log: silent });
  assert.deepEqual(store.write({ card: false }), { card: false, cache: true, speed: true, ttft: true });
  assert.deepEqual(store.write({ cache: false }), { card: false, cache: false, speed: true, ttft: true });
  // 落盘后重新读，得到同一份
  assert.deepEqual(createInputStatusPrefs({ file, log: silent }).read(), { card: false, cache: false, speed: true, ttft: true });
});

test("非法值与未知键不落盘", () => {
  const file = tmpFile();
  const store = createInputStatusPrefs({ file, log: silent });
  store.write({ card: false });
  const before = store.read();
  const after = store.write({ card: "no", speed: 0, ttft: null, nope: true });
  assert.deepEqual(after, before, "非法值/未知键都应被忽略");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), before, "文件内容也不该变");
});

test("损坏的 JSON → 回落全 true，不抛错", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ this is not json");
  const store = createInputStatusPrefs({ file, log: silent });
  assert.deepEqual(store.read(), { ...DEFAULT_PREFS });
});
