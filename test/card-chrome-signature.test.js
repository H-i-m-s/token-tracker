import test from 'node:test';
import assert from 'node:assert/strict';
import { CardApp } from '../ui/card.mjs';

// 基类 onStateChange 只在 chromeSignature 变化时才重画顶部控件。卡片的签名必须把
// cardActive / cardTabs 算进去，否则点页签、在菜单里勾功能都只改状态、不重画 ——
// 页签高亮不动、新勾的功能也不会变成页签（高亮停在「用量」、内容换成别的图那种错位）。
const sig = (state, prefs = { card: true, cache: true, speed: true, ttft: true }) =>
  CardApp.prototype.chromeSignature.call({ inputStatusPrefs: prefs }, state);

const base = {
  range: 'today', from: '', to: '', appearance: 'system',
  cardTabs: ['overview', 'balance', 'realtime'], cardActive: 'overview',
};

test('切页签会改变签名（不带上 cardActive 就不重画）', () => {
  assert.notEqual(sig({ ...base, cardActive: 'balance' }), sig(base));
});

test('菜单里增删功能会改变签名', () => {
  assert.notEqual(sig({ ...base, cardTabs: ['overview', 'balance'] }), sig(base));
  assert.notEqual(sig({ ...base, cardTabs: ['overview', 'balance', 'realtime', 'heat'] }), sig(base));
});

test('无效的功能项被滤掉后签名和默认值一致', () => {
  assert.equal(sig({ ...base, cardTabs: ['overview', 'balance', 'realtime', '不存在的功能'] }), sig(base));
});

test('时间范围、配色、输入栏开关仍然算进签名', () => {
  assert.notEqual(sig({ ...base, from: '2026-10-01', to: '2026-10-02' }), sig(base));
  assert.notEqual(sig({ ...base, range: 'all' }), sig(base));
  assert.notEqual(sig({ ...base, appearance: 'dark' }), sig(base));
  assert.notEqual(sig(base, { card: false, cache: true, speed: true, ttft: true }), sig(base));
});

// 卡片顶部那排里，「已筛选」与「清除」的显隐全看四个筛选。这四个不进签名的话，点了「清除」
// 状态已经清了，界面却还写着「已筛选」——看起来像是清不掉（看板不受影响：那排胶囊是原地更新的）。
test('四个筛选都算进签名（否则清了界面还写着「已筛选」）', () => {
  const filterKeys = ['agent', 'model', 'provider', 'type'];
  for (const key of filterKeys) {
    assert.notEqual(sig({ ...base, [key]: ['x'] }), sig(base), `${key} 变了签名却没变`);
    assert.notEqual(sig({ ...base, [key]: ['x', 'y'] }), sig(base, undefined), `${key} 多一项也要算`);
  }
  // 顺序不同但集合相同时不该重画（selectionKey 是对集合取键）
  assert.equal(sig({ ...base, agent: ['a', 'b'] }), sig({ ...base, agent: ['b', 'a'] }));
  assert.notEqual(sig({ ...base, agent: ['a'] }), sig({ ...base, agent: ['a', 'b'] }));
});

test('状态没变时签名稳定（不会每拍白重画一次）', () => {
  assert.equal(sig(base), sig({ ...base }));
});
