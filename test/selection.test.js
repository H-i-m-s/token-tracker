// 多选语义的唯一出处，所以在这里把规矩钉死：
// 看板上的图例、agent 行、单轮大小分布行、筛选下拉全都走 ui/selection.mjs，
// 这些是纯函数（不碰 DOM），可以直接跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { asList, modsOf, pickValues, selectionParam, selectionKey } from "../ui/selection.mjs";
import { DEFAULT_APP_STATE, normalizeFilterLists } from "../ui/app-state.mjs";

// dashboard.js 在模块顶层就要求这两个环境变量，所以先设好再动态 import。
// 一律用临时目录，绕不碰用户真实数据目录。
process.env.HANA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sel-home-"));
process.env.TOKEN_TRACKER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sel-data-"));
const { toList } = await import("../runtime/engine/routes/dashboard.js");

const ORDER = ["A", "B", "C", "D"];

test("asList：字符串、数组、空值都归一成数组", () => {
  assert.deepEqual(asList(["A", "B"]), ["A", "B"]);
  assert.deepEqual(asList("A"), ["A"], "旧状态里存的是字符串，读出来当一项");
  assert.deepEqual(asList(""), []);
  assert.deepEqual(asList(null), []);
  assert.deepEqual(asList(undefined), []);
  assert.deepEqual(asList([""]), [], "空串不算一项");
  assert.deepEqual(asList([1, 2]), ["1", "2"]);
});

test("modsOf：Ctrl 与 Cmd 同等对待，Shift 单独识别", () => {
  assert.deepEqual(modsOf(null), { multi: false, range: false });
  assert.deepEqual(modsOf({}), { multi: false, range: false });
  assert.deepEqual(modsOf({ ctrlKey: true }), { multi: true, range: false });
  assert.deepEqual(modsOf({ metaKey: true }), { multi: true, range: false }, "Mac 上按 Cmd 才是习惯动作");
  assert.deepEqual(modsOf({ shiftKey: true }), { multi: false, range: true });
  assert.deepEqual(modsOf({ ctrlKey: true, shiftKey: true }), { multi: true, range: true });
});

test("pickValues：不带修饰键 = 只留它；它本来就是唯一选中项时清空", () => {
  assert.deepEqual(pickValues([], "A", ORDER), ["A"]);
  assert.deepEqual(pickValues(["A"], "B", ORDER), ["B"], "平静点另一项 = 换成一个");
  assert.deepEqual(pickValues(["A"], "A", ORDER), [], "再点自己 = 取消（保留旧习惯）");
  assert.deepEqual(pickValues(["A", "B"], "B", ORDER), ["B"], "平静点多选里的一项 = 收敛到它");
});

test("pickValues：Ctrl / Cmd 点 = 加一项或去掉一项", () => {
  const ctrl = { multi: true };
  assert.deepEqual(pickValues([], "A", ORDER, ctrl), ["A"]);
  assert.deepEqual(pickValues(["A"], "B", ORDER, ctrl), ["A", "B"]);
  assert.deepEqual(pickValues(["A", "B"], "A", ORDER, ctrl), ["B"], "已选中的再 Ctrl 点 = 去掉");
  assert.deepEqual(pickValues(["A", "B"], "B", ORDER, ctrl), ["A"]);
  assert.deepEqual(pickValues(["A", "B"], "C", ORDER, ctrl), ["A", "B", "C"]);
});

test("pickValues：Shift 点 = 从锚点到这一项整段加选（按控件里的显示顺序）", () => {
  const shift = { range: true };
  assert.deepEqual(pickValues(["A"], "C", ORDER, shift, "A"), ["A", "B", "C"]);
  assert.deepEqual(pickValues(["B"], "D", ORDER, shift, "A"), ["A", "B", "C", "D"], "锚点不在选中集合里也能整段补上");
  assert.deepEqual(pickValues(["C"], "A", ORDER, shift, "C"), ["A", "B", "C"], "往回选也一样");
  assert.deepEqual(pickValues(["A", "B", "C"], "C", ORDER, shift, "A"), [], "这一段本来就全选中 = 整段取消（Shift 再点能撤回）");
});

test("pickValues：Shift 但锚点不在清单里时退化成普通点击，不当成整段", () => {
  assert.deepEqual(pickValues(["A"], "C", ORDER, { range: true }, "Z"), ["C"]);
  assert.deepEqual(pickValues(["A"], "C", ORDER, { range: true }, null), ["C"]);
});

test("pickValues：结果按显示顺序排，不因点选先后而变（请求串才稳定）", () => {
  assert.deepEqual(pickValues(["C"], "A", ORDER, { multi: true }), ["A", "C"], "Ctrl 加选后按显示顺序");
  assert.deepEqual(pickValues(["A", "B"], "B", ORDER, { multi: true }), ["A"]);
});

test("selectionParam：每个值编一次，再用半角逗号连接", () => {
  assert.equal(selectionParam(["A", "B"]), "A,B");
  assert.equal(selectionParam("A"), "A", "普通 id 编码前后一样");
  assert.equal(selectionParam(["a,b"]), "a%2Cb", "值里的逗号编成 %2C，不会在路上被当成分隔符");
  assert.equal(selectionParam([]), "");
  assert.equal(selectionParam(null), "");
});

// 传输那一跳必须算进来：app-api 把 selectionParam 的结果 set 进 URLSearchParams，
// 后者会把值里的 % 再转义成 %25。漏掉这一步，测试会绿着而线上筛不出东西
// （中文供应商名曾因此一直返回 0 行）。
const onTheWire = (key, ids) => new URLSearchParams({ [key]: selectionParam(ids) }).toString();
// 宿主那一层：c.req.query(name) 对线上的值解一次码（Hono 的行为）。
const hostHandsToPlugin = (wire) => decodeURIComponent(wire.slice(wire.indexOf("=") + 1));

test("跨层契约：UI 编一次 → 传输转义 → 宿主解一次 → 引擎 toList 还原成同一组值", () => {
  const ids = ["deepseek-flash", "a,b", "名字 带空格", "100%", "slash/and,comma", "商汤科技"];
  assert.deepEqual(toList(hostHandsToPlugin(onTheWire("model", ids))), ids);
  // 把非 ASCII 那一项单独钉住：它曾是「筛选静默返回 0 行」的现场。
  assert.deepEqual(toList(hostHandsToPlugin(onTheWire("provider", ["商汤科技"]))), ["商汤科技"]);
  assert.deepEqual(toList(""), [], "空串 = 不筛");
  assert.deepEqual(toList(["A"]), ["A"], "数组直接收（RPC 里也能是数组）");
  assert.deepEqual(toList("A"), ["A"], "旧单值字符串仍然吃得下");
  assert.deepEqual(toList("%zz"), ["%zz"], "解不开的百分号不抛异常");
});

test("selectionKey：同一组值不管点选先后键都一样，不同组不同", () => {
  assert.equal(selectionKey(["A", "B"]), selectionKey(["B", "A"]));
  assert.notEqual(selectionKey(["A"]), selectionKey(["A", "B"]));
  assert.equal(selectionKey([]), "");
  assert.equal(selectionKey("A"), selectionKey(["A"]), "旧字符串与单元素数组同键（不会因为升级多取一次看板）");
});

test("旧状态迁移：字符串变一项，不是按逗号拆", () => {
  const out = normalizeFilterLists({ agent: "codingagent", model: ["A", "B"], provider: "", type: undefined });
  assert.deepEqual(out.agent, ["codingagent"]);
  assert.deepEqual(out.model, ["A", "B"]);
  assert.deepEqual(out.provider, []);
  assert.deepEqual(out.type, []);
  // id 里本来就可能带逗号：旧值 "a,b" 是一项而不是两项（拆开就筛错了）
  assert.deepEqual(normalizeFilterLists({ model: "a,b" }).model, ["a,b"]);
  assert.deepEqual(normalizeFilterLists({}).agent, [], "缺字段补成空数组");
});

test("默认状态：四个筛选是空数组（不是空串）", () => {
  for (const key of ["agent", "model", "provider", "type"]) {
    assert.deepEqual(DEFAULT_APP_STATE[key], [], `${key} 默认应是空数组`);
  }
});
