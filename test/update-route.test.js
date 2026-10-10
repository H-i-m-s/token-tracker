// 插件侧的路由接线：/update-check 的 GET/POST 与「扫描出结果就顺手看一眼版本」。
//
// 这一层没有别的东西能替它验：界面在浏览器里跑不起来在这里，引擎也不碰这两条路由。
// 所以拿一份假的宿主 ctx 把 apply() 真跑起来，然后直接调路由处理器。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createUpdateCheck } from "../lib/update-check.mjs";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "manifest.json"), "utf8"));

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <updated>2026-10-14T02:00:00Z</updated>
    <link rel="alternate" href="https://github.com/H-i-m-s/token-tracker/releases/tag/v99.0.0"/>
    <title>Token 用量 v99.0.0</title>
    <content type="html">&lt;h2&gt;Token 用量 v99.0.0&lt;/h2&gt;&lt;h3&gt;新增&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;假条目&lt;/li&gt;&lt;/ul&gt;&lt;hr&gt;&lt;p&gt;安装说明&lt;/p&gt;</content>
  </entry>
</feed>`;

/** 假的 Hono app：只记路由，好让测试直接拿处理器来调。 */
function makeHost() {
  const routes = new Map();
  const app = {
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
  return { app, routes };
}

function makeC({ query = {}, body = null } = {}) {
  return {
    req: {
      query: (key) => (key in query ? query[key] : undefined),
      json: async () => {
        if (body === null) throw new Error("没有请求体");
        return body;
      },
    },
    json: (payload, status = 200) => ({ status, payload }),
    text: (text, status = 200) => ({ status, text }),
  };
}

async function boot({ hostNetwork = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-route-"));
  const host = makeHost();
  const seen = { scan: null, methods: [], fetches: 0, netFetches: 0, netUrls: [] };
  const client = {
    subscribe(topic, cb) {
      if (topic === "token-tracker.updated") seen.scan = cb;
      return () => { if (seen.scan === cb) seen.scan = null; };
    },
    async request(method) { seen.methods.push(method); return {}; },
    dispose() {},
  };
  const ctx = {
    dataDir,
    logger: { info() {}, warn() {}, error() {} },
    routes: { register(fn) { fn(host.app); return () => {}; } },
    bus: { async request() { return { sessions: [] }; }, subscribe() { return () => {}; }, handle() { return () => {}; }, emit() {} },
    // 宿主受控出站通道。真机上就是它把请求按 manifest.network.allowedHosts 过一道闸。
    network: {
      async fetch(url) {
        seen.netFetches += 1;
        seen.netUrls.push(url);
        return { ok: true, status: 200, headers: { get: () => '"etag-host"' }, text: async () => ATOM };
      },
    },
  };
  const { apply } = await import("../index.js");
  const options = { clientFactory: () => client };
  if (!hostNetwork) {
    // 网络那一层注掉：路由测试不该真去打 GitHub，返回什么由这里说了算。
    options.updateCheckFactory = (checkOptions) => createUpdateCheck({
      ...checkOptions,
      fetchImpl: async () => ({
        ok: true, status: 200,
        headers: { get: () => '"etag-1"' },
        text: async () => { seen.fetches += 1; return ATOM; },
      }),
    });
  }
  const dispose = apply(ctx, options);
  return { dataDir, routes: host.routes, seen, dispose, call: (name, opts) => host.routes.get(name)(makeC(opts)) };
}

test("GET /update-check：当前版本取自 manifest，说明来自取回的 Release", async () => {
  const { call } = await boot();
  const res = await call("GET /update-check", { query: {} });
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  const update = res.payload.update;
  assert.equal(update.current, MANIFEST.version, "当前版本必须等于包根 manifest 的 version");
  assert.equal(update.latest.version, "99.0.0");
  assert.equal(update.hasUpdate, true);
  assert.equal(update.shouldAutoShow, true);
  assert.deepEqual(update.notes[0].sections, [{ heading: "新增", items: ["假条目"] }]);
  assert.equal(update.notes[0].url, "https://github.com/H-i-m-s/token-tracker/releases/tag/v99.0.0");
});

test("GET /update-check?force=1：真的再去取一次；不带 force 时吃缓存", async () => {
  const { call, seen } = await boot();
  await call("GET /update-check", { query: {} });
  assert.equal(seen.fetches, 1);
  await call("GET /update-check", { query: {} });
  assert.equal(seen.fetches, 1, "一分钟内重复问不该再打 GitHub");
  await call("GET /update-check", { query: { force: "1" } });
  assert.equal(seen.fetches, 2);
});

test("POST /update-check：先不看 / 我已知晓 / 开关，三种都改得动状态", async () => {
  const { call } = await boot();
  const first = await call("GET /update-check", { query: {} });
  const tag = first.payload.update.latest.tag;

  const later = await call("POST /update-check", { body: { action: "later", version: tag } });
  assert.equal(later.payload.update.shouldAutoShow, false);
  assert.equal(later.payload.update.dismissedThisSession, true);
  assert.equal(later.payload.update.ackVersion, "", "先看不看不该写成「已知晓」");

  const ack = await call("POST /update-check", { body: { action: "ack", version: tag } });
  assert.equal(ack.payload.update.ackVersion, tag);

  const off = await call("POST /update-check", { body: { action: "toggle", enabled: false } });
  assert.equal(off.payload.update.enabled, false);
  assert.equal(off.payload.update.shouldAutoShow, false);
});

test("POST /update-check：未知 action 与坏 JSON 都明确报错，不静默吞掉", async () => {
  const { call } = await boot();
  const bad = await call("POST /update-check", { body: { action: "随便" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.error.code, "UNKNOWN_ACTION");
  const broken = await call("POST /update-check", { body: null });
  assert.equal(broken.status, 400);
  assert.equal(broken.payload.error.code, "INVALID_JSON");
});

test("扫描事件触发检查：引擎每报一次新用量，顺手看一眼有没有新版", async () => {
  const { seen } = await boot();
  assert.ok(seen.scan, "订阅了 token-tracker.updated");
  seen.scan({ type: "token-tracker.updated" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.fetches, 1, "扫描一来就去取了一次");
});

test("别的界面点完「我已知晓」，这条广播要发得出去", async () => {
  const { call, routes } = await boot();
  await call("GET /update-check", { query: {} });

  // 接上事件流，然后 POST 一次 ack，应该收到一条带 updateNotice 的帧。
  const controller = new AbortController();
  const eventsRes = routes.get("GET /events")({ req: { raw: { signal: controller.signal } } });
  const reader = eventsRes.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const chunk of decoder.decode(value, { stream: true }).split("\n\n")) {
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (line) frames.push(JSON.parse(line.slice(5)));
        }
      }
    } catch {}
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  await call("POST /update-check", { body: { action: "ack", version: "v99.0.0" } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  await pump.catch(() => {});

  const notices = frames.filter((f) => f.updateNotice);
  assert.ok(notices.length >= 1, `事件流里应有 updateNotice 帧，实际收到 ${JSON.stringify(frames.map((f) => f.type))}`);
  assert.equal(notices.at(-1).updateNotice.shouldAutoShow, false);
  assert.equal(notices.at(-1).updateNotice.ackVersion, "v99.0.0");
});

test("取数走宿主受控通道：App 进程里裸 fetch 出站会被运行时拒掉", async () => {
  const { call, seen } = await boot({ hostNetwork: true });
  const res = await call("GET /update-check", { query: { force: "1" } });
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.update.latest.version, "99.0.0");
  assert.equal(seen.netFetches, 1, "请求真的从 ctx.network.fetch 出去了");
  assert.match(seen.netUrls[0], /^https:\/\/github\.com\/H-i-m-s\/token-tracker\/releases\.atom$/);
  assert.equal(seen.fetches, 0, "没有走裸 fetch");
});

test("预览模式：给一份固定样张，且不会自己浮起来", async () => {
  const { call } = await boot();
  const res = await call("GET /update-check", { query: { mock: "1" } });
  assert.equal(res.payload.update.mock, true);
  assert.equal(res.payload.update.hasUpdate, true);
  assert.equal(res.payload.update.shouldAutoShow, false, "预览里不该每次打开都弹");
  assert.ok(res.payload.update.notes[0].sections.length > 0);
});
