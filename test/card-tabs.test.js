import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_VIEWS, DEFAULT_CARD_TABS, cardSelection, toggleCardTab } from '../ui/card-tabs.mjs';

// 卡片的页签曾经卡在 4 项（满了就锁住其余功能）。现在不设上限，页签带自己横向滚，
// 所以这里要把「能一直加下去」和「只挡最后一项」这两条钉住。
const allIds = CARD_VIEWS.map((view) => view.id);

test('没存过就先给一套默认页签', () => {
  assert.deepEqual(cardSelection({}).tabs, DEFAULT_CARD_TABS);
  assert.deepEqual(cardSelection({ cardTabs: [] }).tabs, DEFAULT_CARD_TABS);
  assert.deepEqual(cardSelection({ cardTabs: ['不存在的功能'] }).tabs, DEFAULT_CARD_TABS);
});

test('不认识的项滤掉、重的并掉，顺序照存的那份', () => {
  assert.deepEqual(cardSelection({ cardTabs: ['heat', 'heat', '不存在的功能', 'overview'] }).tabs, ['heat', 'overview']);
});

test('项数不设上限：九项全要就给九项', () => {
  const { tabs } = cardSelection({ cardTabs: allIds });
  assert.deepEqual(tabs, allIds);
  assert.equal(tabs.length, CARD_VIEWS.length);
});

test('选中项不在列表里就落到第一项', () => {
  assert.equal(cardSelection({ cardTabs: ['heat', 'overview'], cardActive: 'balance' }).active, 'heat');
  assert.equal(cardSelection({ cardTabs: ['heat', 'overview'], cardActive: 'overview' }).active, 'overview');
});

test('开新的：已经有五项，还能再加第六项', () => {
  const five = ['overview', 'balance', 'realtime', 'heat', 'daily'];
  const patch = toggleCardTab({ cardTabs: five, cardActive: 'overview' }, 'details');
  assert.deepEqual(patch.cardTabs, [...five, 'details']);
  assert.equal(patch.cardActive, 'overview');
});

test('关一项：关掉的不是当前项，就还停在当前项', () => {
  const patch = toggleCardTab({ cardTabs: ['overview', 'balance', 'heat'], cardActive: 'overview' }, 'heat');
  assert.deepEqual(patch.cardTabs, ['overview', 'balance']);
  assert.equal(patch.cardActive, 'overview');
});

test('关掉当前项：落到原来位置的下一项，到尾部就往前收', () => {
  const mid = toggleCardTab({ cardTabs: ['overview', 'balance', 'heat'], cardActive: 'balance' }, 'balance');
  assert.deepEqual(mid.cardTabs, ['overview', 'heat']);
  assert.equal(mid.cardActive, 'heat');
  const tail = toggleCardTab({ cardTabs: ['overview', 'balance', 'heat'], cardActive: 'heat' }, 'heat');
  assert.deepEqual(tail.cardTabs, ['overview', 'balance']);
  assert.equal(tail.cardActive, 'balance');
});

test('最后一项关不掉；不认识的功能项一律不理', () => {
  assert.equal(toggleCardTab({ cardTabs: ['overview'], cardActive: 'overview' }, 'overview'), null);
  assert.equal(toggleCardTab({ cardTabs: ['overview', 'balance'] }, '不存在的功能'), null);
});
