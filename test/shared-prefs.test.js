// 卡片是「每次打开都是一个新实例」：实例 id 形如 wb-card-plugin-webview-card-muwv71pb-9，
// 关掉再打开就换一个。所以「我选了全部历史，重开又变今日」的原因是：时间窗和筛选只存在实例键里，
// 实例一走就没了。这里把规矩钉住：这些属于用户的选择，必须和 pageTabs 一样存在固定的共享键上。
import test from "node:test";
import assert from "node:assert/strict";
import { AppState, DEFAULT_APP_STATE, SHARED_KEYS, SHARED_PREFS_KEY } from "../ui/app-state.mjs";
import { RANGES } from "../ui/components.mjs";

// 一个只认 global storage 的假宿主（真宿主另有 hana.state 与 onChanged，这条路径用不到）。
function fakeHana(entries) {
  return {
    storage: {
      global: {
        async get(key) { return entries.has(key) ? { value: entries.get(key) } : null; },
        async set(key, value) { entries.set(key, structuredClone(value)); },
        onChanged() { return () => {}; },
      },
    },
  };
}

async function open(entries, cardInstanceId) {
  const state = new AppState({ hana: fakeHana(entries), slot: "card", cardInstanceId });
  await state.init();
  return state;
}

test("换一个实例打开：上次选的时间窗、自定义区间、筛选都读得回来", async () => {
  const entries = new Map();
  const first = await open(entries, "card-aaa-1");
  await first.patch({ range: "all", from: "", to: "", agent: ["codingagent"], type: ["chat"] });
  first.dispose();

  const second = await open(entries, "card-bbb-2");
  const state = second.get();
  assert.equal(state.range, "all", "「全部历史」要跨实例记着");
  assert.deepEqual(state.agent, ["codingagent"]);
  assert.deepEqual(state.type, ["chat"]);
});

test("共享记录落在固定的 prefs 键上，只带该记的项（瞬时错误不进）", async () => {
  const entries = new Map();
  const state = await open(entries, "card-aaa-1");
  await state.patch({ range: "last30", lastError: "炸了" });

  const prefs = entries.get(SHARED_PREFS_KEY);
  assert.ok(prefs, "共享键应该被写出来");
  assert.equal(prefs.range, "last30");
  assert.ok(!("lastError" in prefs), "lastError 是这一次的瞬时状态，不该记");
  // cardTabs 在没动过菜单之前是 null，null 不往共享记录里写（不能拿「没选过」盖掉别人选过的）
  assert.deepEqual(Object.keys(prefs).sort(), SHARED_KEYS.filter((key) => key !== "cardTabs").sort());
});

test("两张卡片同时开着：先开的那个写自己的选择，不该抹掉后开的那个刚写进去的项", async () => {
  const entries = new Map();
  const a = await open(entries, "card-a-1");        // 先开，这时还没有共享记录
  const b = await open(entries, "card-b-2");
  await b.patch({ cardTabs: ["overview", "heat"] }); // b 去菜单里选了页签
  await a.patch({ range: "all" });                    // a 手上那份 cardTabs 还是 null
  const prefs = entries.get(SHARED_PREFS_KEY);
  assert.deepEqual(prefs.cardTabs, ["overview", "heat"], "a 的写入不该抹掉 b 的菜单选择");
  assert.equal(prefs.range, "all");
});

test("共享记录里的坏值一律丢掉，回落到默认，不往界面上传", async () => {
  const entries = new Map([[SHARED_PREFS_KEY, { range: 42, agent: 7, autoRefresh: "yes", view: "不存在", from: 5 }]]);
  const state = (await open(entries, "card-aaa-1")).get();
  assert.equal(state.range, DEFAULT_APP_STATE.range);
  assert.deepEqual(state.agent, []);
  assert.equal(state.autoRefresh, DEFAULT_APP_STATE.autoRefresh);
  assert.equal(state.view, DEFAULT_APP_STATE.view);
  assert.equal(state.from, "");
});

test("RANGES 的每一档都认得，表外的档位才丢", async () => {
  for (const { key } of RANGES) {
    const entries = new Map([[SHARED_PREFS_KEY, { range: key }]]);
    assert.equal((await open(entries, `card-${key}-1`)).get().range, key);
  }
  const entries = new Map([[SHARED_PREFS_KEY, { range: "本周" }]]);
  assert.equal((await open(entries, "card-x-1")).get().range, "today");
});

test("两个实例同时对同一份共享记录：后写的那个说了算，重新打开以共享为准", async () => {
  const entries = new Map();
  const mine = await open(entries, "card-aaa-1");
  await mine.patch({ range: "last7" });

  const other = await open(entries, "card-bbb-2");
  await other.patch({ range: "all" });

  // 老实例的实例键里还留着 last7，但重新初始化时共享的那份盖在上面
  const again = await open(entries, "card-aaa-1");
  assert.equal(again.get().range, "all");
});

// 空串不是一项。图表里「没记 model」的那批被引擎归成 ''，点它就会把 '' 写进筛选：
// 界面说「已筛选」，请求里却什么都没筛（asList 会把空串丢掉），点完看不出发生了什么。
test('空值进不了筛选：空串/纯空白一律当没筛，旧版的单值字符串仍然收', async () => {
  const entries = new Map();
  const state = await open(entries, "card-aaa-1");

  await state.patch({ model: [""] });
  assert.deepEqual(state.get().model, [], "空串不算一项");
  assert.equal(entries.get(SHARED_PREFS_KEY), undefined, "归一后跟原来一样，就不写盘（更不该把空项写进去）");

  await state.patch({ model: ["  "] });
  assert.deepEqual(state.get().model, [], "纯空白同样不算");

  await state.patch({ model: "A" });
  assert.deepEqual(state.get().model, ["A"], "旧版存的单值字符串仍然当一项收");

  await state.patch({ model: ["A", "", "B"] });
  assert.deepEqual(state.get().model, ["A", "B"], "混在里面的空项被摸掉，其余保留");
});
