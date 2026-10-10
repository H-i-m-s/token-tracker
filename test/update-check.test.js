// 「检查更新」的数据层：解析、比较、缓存、以及那两级「不弹了」的语义。
//
// 这一份的样本直接照着 GitHub releases.atom 的真实形状写（说明正文是转义过的 HTML），
// 因为解析一旦对不上真实输入，界面里表现成「说明是空的」，很难从别处看出来。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ATOM_URL,
  compareVersions,
  createUpdateCheck,
  displayVersion,
  humanizeFetchError,
  parseAtom,
  parseNotesHtml,
  plainText,
  unescapeEntities,
} from "../lib/update-check.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tt-update-"));

// ── 纯函数 ────────────────────────────────────────────────────────────────

test("版本比较：数字段优先，正式版高于同号预发布，认不出返回 null", () => {
  assert.equal(compareVersions("8.5.0", "8.6.0"), -1);
  assert.equal(compareVersions("v8.6.0", "8.6.0"), 0);
  assert.equal(compareVersions("8.10.0", "8.9.9"), 1, "10 比 9 大，不能按字符串比");
  assert.equal(compareVersions("8.5.0", "8.5.0-beta.1"), 1, "同号里正式版更高");
  assert.equal(compareVersions("8.5.0-beta.1", "8.5.0-beta.2"), -1);
  assert.equal(compareVersions("nightly", "8.5.0"), null, "认不出就不猜");
  assert.equal(compareVersions("8.5", "8.5.0"), null, "两段式不认");
});

test("显示版本：统一去掉 v 前缀", () => {
  assert.equal(displayVersion("v8.5.0"), "8.5.0");
  assert.equal(displayVersion("8.5.0"), "8.5.0");
  assert.equal(displayVersion("v8.5.0-beta.1"), "8.5.0");
  assert.equal(displayVersion(""), "");
});

test("实体还原：&amp; 必须最后处理，否则 &amp;lt; 会被连解两层", () => {
  assert.equal(unescapeEntities("&lt;b&gt;粗&lt;/b&gt;"), "<b>粗</b>");
  assert.equal(unescapeEntities("&amp;lt;"), "&lt;");
  assert.equal(plainText("<li>a &amp; b</li>"), "a & b");
});

test("说明解析：按三级标题分组；二级标题与分隔线之后的安装指引都丢掉", () => {
  const html = [
    "<h2>Token 用量 v8.7.0</h2>",
    "<h3>新增</h3><ul><li>明细表可以按未命中缓存排序</li><li>更新说明弹窗</li></ul>",
    "<h3>修复</h3><ul><li>中文供应商名筛选返回 0 行</li></ul>",
    "<hr><p>安装：下载附件 zip 拖入 HanaAgent 设置 → 插件</p>",
  ].join("\n");
  assert.deepEqual(parseNotesHtml(html), [
    { heading: "新增", items: ["明细表可以按未命中缓存排序", "更新说明弹窗"] },
    { heading: "修复", items: ["中文供应商名筛选返回 0 行"] },
  ]);
});

test("说明解析：没有三级标题时退化成一组无标题条目，内容一条不丢", () => {
  const html = "<h2>Token 用量 v8.5.0</h2><ul><li>甲</li><li>乙</li><li>丙</li></ul><hr><p>安装说明</p>";
  assert.deepEqual(parseNotesHtml(html), [{ heading: "", items: ["甲", "乙", "丙"] }]);
});

test("说明解析：段落与列表混排时按出现顺序收进同一组", () => {
  const html = "<p>这次改动比较大</p><ul><li>甲</li></ul><p>另外</p><ul><li>乙</li></ul>";
  assert.deepEqual(parseNotesHtml(html), [{ heading: "", items: ["这次改动比较大", "甲", "另外", "乙"] }]);
});

test("说明解析：空输入不炸", () => {
  assert.deepEqual(parseNotesHtml(""), []);
  assert.deepEqual(parseNotesHtml(null), []);
});

// ── atom ─────────────────────────────────────────────────────────────────

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from token-tracker</title>
  <entry>
    <id>tag:github.com,2008:Repository/1/v8.6.0</id>
    <updated>2026-10-11T02:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/H-i-m-s/token-tracker/releases/tag/v8.6.0"/>
    <title>Token 用量 v8.6.0</title>
    <content type="html">&lt;h2&gt;Token 用量 v8.6.0&lt;/h2&gt;
&lt;h3&gt;新增&lt;/h3&gt;
&lt;ul&gt;
&lt;li&gt;余额卡片支持商汤 TokenPlan 积分池&lt;/li&gt;
&lt;/ul&gt;
&lt;hr&gt;
&lt;p&gt;安装：下载附件 zip 拖入 HanaAgent 设置 → 插件&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/v8.5.0</id>
    <updated>2026-10-07T04:54:09Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/H-i-m-s/token-tracker/releases/tag/v8.5.0"/>
    <title>Token 用量 v8.5.0</title>
    <content type="html">&lt;h2&gt;Token 用量 v8.5.0&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;多功能卡：显示设置改成与看板同一套&lt;/li&gt;
&lt;li&gt;修复：清除筛选后界面仍写着「已筛选」&lt;/li&gt;
&lt;/ul&gt;
&lt;hr&gt;
&lt;p&gt;安装：下载附件 zip&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/nightly</id>
    <updated>2026-10-05T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/H-i-m-s/token-tracker/releases/tag/nightly"/>
    <title>nightly</title>
    <content type="html">&lt;p&gt;随手发的一版&lt;/p&gt;</content>
  </entry>
</feed>`;

test("atom 解析：认得出 tag、按版本从新到旧排，认不出的条目直接跳过", () => {
  const list = parseAtom(ATOM);
  assert.equal(list.length, 2, "nightly 这种认不出版本号的条目要跳过，不能猜");
  assert.deepEqual(list.map((r) => r.tag), ["v8.6.0", "v8.5.0"]);
  assert.equal(list[0].version, "8.6.0");
  assert.equal(list[0].date, "2026-10-11T02:00:00Z");
  assert.equal(list[0].url, "https://github.com/H-i-m-s/token-tracker/releases/tag/v8.6.0");
  assert.deepEqual(list[0].sections, [{ heading: "新增", items: ["余额卡片支持商汤 TokenPlan 积分池"] }]);
  assert.deepEqual(list[1].sections, [{
    heading: "",
    items: ["多功能卡：显示设置改成与看板同一套", "修复：清除筛选后界面仍写着「已筛选」"],
  }], "没写三级标题的那版退化成平铺，条目一条不少");
});

test("atom 解析：空输入与垃圾输入都只回空数组", () => {
  assert.deepEqual(parseAtom(""), []);
  assert.deepEqual(parseAtom("<feed></feed>"), []);
  assert.deepEqual(parseAtom(null), []);
});

// ── 状态与缓存 ────────────────────────────────────────────────────────────

function stubFetch(body, { status = 200, etag = '"abc"', throwCode = "" } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    if (throwCode) { const e = new Error("fetch failed"); e.cause = { code: throwCode }; throw e; }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (String(k).toLowerCase() === "etag" ? etag : null) },
      text: async () => body,
    };
  };
  return { impl, calls };
}

test("检查：有新版就给说明，并算出「该不该自动浮起来」", async () => {
  let t = 1_000_000;
  const { impl, calls } = stubFetch(ATOM);
  const uc = createUpdateCheck({ dataDir: tmp(), appVersion: "8.5.0", fetchImpl: impl, now: () => t });

  const snap = await uc.check();
  assert.equal(snap.current, "8.5.0");
  assert.equal(snap.latest.version, "8.6.0");
  assert.equal(snap.hasUpdate, true);
  assert.equal(snap.shouldAutoShow, true);
  assert.deepEqual(snap.notes.map((n) => n.version), ["8.6.0"], "只列当前版本之后的");
  assert.equal(snap.notes[0].sections[0].heading, "新增");
  assert.equal(snap.error, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ATOM_URL);

  // TTL 之内不再打网络
  t += 60_000;
  await uc.check();
  assert.equal(calls.length, 1, "一小时之内重复调用不该再问 GitHub");
  // force 才真的去问
  await uc.check({ force: true });
  assert.equal(calls.length, 2);
});

test("检查：落后多个版本时，中间那几版的说明一起给，从新到旧", async () => {
  const { impl } = stubFetch(ATOM);
  const uc = createUpdateCheck({ dataDir: tmp(), appVersion: "8.4.0", fetchImpl: impl });
  const snap = await uc.check();
  assert.deepEqual(snap.notes.map((n) => n.version), ["8.6.0", "8.5.0"]);
  assert.equal(snap.latest.version, "8.6.0");
});

test("检查：本机比线上还新时不提醒", async () => {
  const { impl } = stubFetch(ATOM);
  const uc = createUpdateCheck({ dataDir: tmp(), appVersion: "8.9.0", fetchImpl: impl });
  const snap = await uc.check();
  assert.equal(snap.hasUpdate, false);
  assert.equal(snap.shouldAutoShow, false);
  assert.deepEqual(snap.notes, []);
});

test("不弹的两级：「先不看」只在本次进程里，「我已知晓」落盘并挡到下个版本", async () => {
  const dir = tmp();
  const { impl } = stubFetch(ATOM);
  const uc = createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: impl });
  await uc.check();

  // 先不看：内存里记着，重启即忘
  uc.dismiss("v8.6.0", "later");
  assert.equal(uc.snapshot().shouldAutoShow, false);
  assert.equal(uc.snapshot().dismissedThisSession, true);
  assert.equal(uc.snapshot().ackVersion, "", "先不看不能污染「已知晓」");
  const reborn1 = createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: impl });
  assert.equal(reborn1.snapshot().shouldAutoShow, true, "换了进程还会再提醒一次");

  // 我已知晓：落盘
  uc.dismiss("v8.6.0", "read");
  assert.equal(uc.snapshot().ackVersion, "v8.6.0");
  assert.equal(uc.snapshot().shouldAutoShow, false);
  const reborn2 = createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: impl });
  assert.equal(reborn2.snapshot().shouldAutoShow, false, "新进程也不再提醒");
  assert.equal(reborn2.snapshot().hasUpdate, true, "「已知晓」不等于「没有新版」");
});

test("关掉更新提示：一律不自动弹，但手动查仍然能看到有没有新版", async () => {
  const { impl } = stubFetch(ATOM);
  const uc = createUpdateCheck({ dataDir: tmp(), appVersion: "8.5.0", fetchImpl: impl });
  await uc.check();
  uc.setEnabled(false);
  const snap = uc.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.shouldAutoShow, false);
  assert.equal(snap.hasUpdate, true, "关掉的是提醒，不是检查");
});

test("取回失败：说人话、保留手里的旧说明、不清缓存", async () => {
  const dir = tmp();
  const ok = stubFetch(ATOM);
  const first = createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: ok.impl });
  await first.check();

  const bad = stubFetch("", { throwCode: "ENOTFOUND" });
  const second = createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: bad.impl });
  const snap = await second.check({ force: true });
  assert.equal(snap.error, "网络不通");
  assert.equal(snap.hasUpdate, true, "旧说明还在");
  assert.equal(snap.latest.version, "8.6.0");
});

test("304：算命中缓存，不算失败", async () => {
  const dir = tmp();
  const first = stubFetch(ATOM);
  await createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: first.impl }).check();

  const notModified = stubFetch("", { status: 304 });
  const second = createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: notModified.impl });
  const snap = await second.check({ force: true });
  assert.equal(snap.error, "");
  assert.equal(snap.fromCache, true);
  assert.equal(notModified.calls[0].headers["If-None-Match"], '"abc"', "带上了上次的 ETag");
});

test("没有网络能力时给一句明确的话，不抛异常", async () => {
  const uc = createUpdateCheck({ dataDir: tmp(), appVersion: "8.5.0", fetchImpl: null });
  const snap = await uc.check();
  assert.equal(snap.error, "当前环境没有网络能力");
  assert.equal(snap.hasUpdate, false);
});

test("取回失败的人话映射", () => {
  assert.equal(humanizeFetchError({ cause: { code: "ENOTFOUND" } }), "网络不通");
  assert.equal(humanizeFetchError(new Error("HTTP 403")), "GitHub 暂时拒绝了这次请求");
  assert.equal(humanizeFetchError(new Error("HTTP 500")), "GitHub 那边出了点问题");
  assert.equal(humanizeFetchError({ name: "AbortError" }), "请求超时");
  assert.equal(humanizeFetchError(new Error("说不清")), "取回更新说明失败");
});

test("状态文件损坏时回落到默认，不把整个功能拖下水", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "update-notice.json"), "{ 这不是 JSON");
  const { impl } = stubFetch(ATOM);
  const uc = createUpdateCheck({ dataDir: dir, appVersion: "8.5.0", fetchImpl: impl });
  assert.equal(uc.snapshot().enabled, true, "坏文件按默认（开着）处理");
  const snap = await uc.check();
  assert.equal(snap.hasUpdate, true, "照样能取回并提醒");
});

test("广播签名：只有真正影响提醒的东西变了才变", async () => {
  const { impl } = stubFetch(ATOM);
  const uc = createUpdateCheck({ dataDir: tmp(), appVersion: "8.5.0", fetchImpl: impl });
  await uc.check();
  const a = uc.signature();
  assert.equal(uc.signature(), a, "同样的状态签名一样");
  uc.setEnabled(false);
  assert.notEqual(uc.signature(), a, "开关变了签名要变");
});
