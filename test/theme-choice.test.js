import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPinned, pinValue, pinnedThemeId, appearanceHintOf, HOST_THEMES,
  refreshSkins, skinSnapshot, themeSelectGroups,
} from '../ui/theme-catalog.mjs';
import { applyAppearance } from '../ui/appearance.mjs';
import { isValidAppearance } from '../ui/app-state.mjs';

// 显示设置里的「主题」从三颗按压按钮换成了下拉：取值空间也多出一类 theme:<id>。
// 这些用例盯的就是那条边界：本卡三档、指名主题、坏值，各走各的路。

test('指名主题的取值编解码', () => {
  assert.equal(pinValue('midnight'), 'theme:midnight');
  assert.equal(pinnedThemeId('theme:midnight'), 'midnight');
  assert.equal(isPinned('theme:midnight'), true);
  assert.equal(isPinned('theme:'), false, '只有前缀没有 id 不算指名');
  assert.equal(isPinned('dark'), false);
  assert.equal(pinnedThemeId('dark'), '');
});

test('存储校验放行 theme:<id>，仍挡住别的乱值', () => {
  for (const v of ['dark', 'light', 'system', '', 'theme:midnight', 'theme:hana-xiaohongshu']) {
    assert.equal(isValidAppearance(v), true, String(v));
  }
  for (const v of ['theme:', 'theme:有中文', 'auto', null, undefined, 42]) {
    assert.equal(isValidAppearance(v), false, String(v));
  }
});

test('明暗取自被指名的主题，而不是宿主当前明暗', () => {
  assert.equal(appearanceHintOf('dark'), 'dark');
  assert.equal(appearanceHintOf('light'), 'light');
  assert.equal(appearanceHintOf('system'), 'system');
  assert.equal(appearanceHintOf('theme:midnight'), 'dark');
  assert.equal(appearanceHintOf('theme:warm-paper'), 'light');
  // 清单里没有的 id 不猜：交回宿主决定，界面不会凭空宣称一个明暗。
  assert.equal(appearanceHintOf('theme:not-installed'), 'system');
});

test('applyAppearance：指名主题一律落到 system 档，并记下 pin', () => {
  const doc = fakeDoc();
  const look = applyAppearance('theme:midnight', doc);
  assert.equal(doc.documentElement.dataset.ttAppearance, 'system');
  assert.equal(doc.documentElement.dataset.ttThemePin, 'midnight');
  assert.equal(look.pin, 'midnight');
  assert.equal(look.appearance, 'dark');
  // 指名的主题自带明暗：hana-dark 由它决定，别跟宿主当前明暗走。
  assert.equal(doc.documentElement.classList.has('hana-dark'), true);
});

test('applyAppearance：切回本卡两档 / 跟随时把 pin 摘干净', () => {
  const doc = fakeDoc();
  applyAppearance('theme:midnight', doc);
  const look = applyAppearance('light', doc);
  assert.equal(doc.documentElement.dataset.ttAppearance, 'light');
  assert.equal('ttThemePin' in doc.documentElement.dataset, false);
  assert.equal(look.pin, '');
});

test('外观取值的缺省与坏值一律当自动', () => {
  const doc = fakeDoc();
  assert.equal(applyAppearance('', doc).base, 'system');
  assert.equal(applyAppearance('乱写的', doc).base, 'system');
  assert.equal(doc.documentElement.dataset.ttAppearance, 'system');
});

test('皮肤清单取不到时如实留原因，不假装成空清单', async () => {
  const failing = { fetchJson: async () => { throw new Error('衣橱未授权'); } };
  const snapshot = await refreshSkins(failing);
  assert.equal(snapshot.status, 'error');
  assert.match(snapshot.error, /衣橱未授权/);
  assert.equal(snapshot.themes.length, 0);
  assert.equal(skinSnapshot().status, 'error');
});

test('皮肤取到后进清单，明暗也跟着它走', async () => {
  const api = { fetchJson: async () => ({ ok: true, themes: [{ id: 'hana-x', name: '小红', appearance: 'light' }] }) };
  const snapshot = await refreshSkins(api);
  assert.equal(snapshot.status, 'ok');
  assert.deepEqual(snapshot.themes.map((t) => t.id), ['hana-x']);
  assert.equal(appearanceHintOf('theme:hana-x'), 'light');
});

test('主题下拉：首项是自动，下面只有宿主主题与衣橱皮肤两组', () => {
  const { lead, groups } = themeSelectGroups('dark');
  assert.deepEqual(lead, { value: 'system', label: '自动' });
  assert.deepEqual(groups.map((g) => g.label), ['宿主内置主题', '衣橱皮肤', '当前']);
  const hostGroup = groups.find((g) => g.label === '宿主内置主题');
  assert.equal(hostGroup.items.length, HOST_THEMES.length);
  assert.ok(hostGroup.items.some((i) => i.value === 'theme:midnight'));
  const skinGroup = groups.find((g) => g.label === '衣橱皮肤');
  assert.deepEqual(skinGroup.items.map((i) => i.value), ['theme:hana-x']);
});

test('旧值变的是「当前」组而不是消失：深黑仍有名字', () => {
  const { groups } = themeSelectGroups('dark');
  const last = groups[groups.length - 1];
  assert.equal(last.label, '当前');
  assert.deepEqual(last.items, [{ value: 'dark', label: '深黑' }]);
});

test('已选值不在清单里时单独列出来，不被顶成第一项', () => {
  const { groups } = themeSelectGroups('theme:gone-skin');
  const last = groups[groups.length - 1];
  assert.equal(last.label, '当前');
  assert.deepEqual(last.items, [{ value: 'theme:gone-skin', label: 'gone-skin' }]);
});

// 只用到 dataset 与 classList。不引整棵 DOM：这些逻辑本来就不该依赖真实节点。
function fakeDoc() {
  const classes = new Set();
  const documentElement = {
    dataset: {},
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      has(name) { return classes.has(name); },
    },
  };
  return { documentElement, querySelector: () => null, querySelectorAll: () => [] };
}
