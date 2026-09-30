import { WorkspaceApp } from './workspace.mjs';
import { bootstrap } from './bootstrap.mjs';
import { applyAppearance } from './appearance.mjs';
import { renderAnalytics } from './analytics.mjs';
import { h, RANGES, selectOptions } from './components.mjs';
import { enhanceSelects } from './custom-select.mjs';
import { closeAllPickers } from './custom-pickers.mjs';
import { cardIcon } from './card-icons.mjs';
import { CARD_VIEWS, MAX_CARD_TABS, cardSelection, toggleCardTab } from './card-tabs.mjs';

const CHART_SELECTORS = {
  agents: '.tt-agent-panel', heat: '.tt-heat-panel', distribution: '.tt-dist-panel',
  hours: '.tt-board-right > section:first-child', daily: '.tt-board-right > section:last-child',
};
export class CardApp extends WorkspaceApp {
  renderShell() {
    this.container.replaceChildren();
    this.container.className = 'tt-app tt-switch-card';
    this.tabBar = h('div', { className: 'tt-card-tabs', role: 'tablist', 'aria-label': '卡片功能' });
    this.moreButton = h('button', { type: 'button', className: 'tt-card-more', 'aria-label': '选择卡片功能', 'aria-expanded': 'false', 'aria-controls': 'card-options', title: '选择卡片功能' }, cardIcon('more'));
    this.moreButton.addEventListener('click', () => this.setMenu(!this.menuOpen));
    this.menu = h('div', { id: 'card-options', className: 'tt-card-options', hidden: '', role: 'group', 'aria-label': '可显示的选项卡' });
    this.filterBar = h('div', { className: 'tt-card-filters' });
    this.statusEl = h('div', { className: 'tt-status-bar', role: 'status' });
    this.mainEl = h('main', { className: 'tt-card-content', id: 'card-content', role: 'tabpanel' });
    for (const id of ['overview', 'balance', 'details', 'realtime']) this.mainEl.append(h('section', { id: `${id}-module`, className: 'tt-module' }));
    this.container.append(h('header', { className: 'tt-card-header' }, this.tabBar, this.moreButton, this.menu), this.filterBar, this.statusEl, this.mainEl);
    const onPointer = e => { if (this.menuOpen && !this.menu.contains(e.target) && !this.moreButton.contains(e.target)) this.setMenu(false); };
    const onKey = e => { if (this.menuOpen && e.key === 'Escape') { e.preventDefault(); this.setMenu(false); this.moreButton.focus(); } };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    this.disposers.push(() => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); });
    this.tabBar.addEventListener('keydown', e => {
      const buttons = [...this.tabBar.children], index = buttons.indexOf(document.activeElement);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      const id = buttons[next].dataset.view;
      this.state.patch({ cardActive: id });
      this.tabBar.querySelector(`[data-view="${id}"]`)?.focus();
    });
    this.renderBoardControls();
  }

  setMenu(open) {
    this.menuOpen = open;
    this.menu.hidden = !open;
    this.moreButton.setAttribute('aria-expanded', String(open));
    if (open) this.menu.querySelector('input:not(:disabled)')?.focus();
  }

  renderBoardControls() {
    // 本函数会重建 .tt-card-filters / .tt-card-options，自绘下拉随之被替换：先把已打开的浮层摘干净。
    closeAllPickers();
    if (!this.tabBar) return;
    const state = this.state.get(), { tabs, active } = cardSelection(state);
    const appearance = applyAppearance(state.appearance || 'system');
    this.tabBar.replaceChildren(...tabs.map(id => {
      const view = CARD_VIEWS.find(v => v.id === id);
      return h('button', { type: 'button', role: 'tab', id: `card-tab-${id}`, 'data-view': id, 'aria-controls': 'card-content', 'aria-selected': String(id === active), tabindex: id === active ? '0' : '-1', title: view.title, onClick: () => this.state.patch({ cardActive: id }) },
        tabs.length <= 3 ? cardIcon(view.icon) : null, h('span', {}, view.label));
    }));
    this.mainEl.setAttribute('aria-labelledby', `card-tab-${active}`);
    const module = ['balance', 'details', 'realtime'].includes(active) ? active : 'overview';
    for (const section of this.mainEl.children) section.hidden = section.id !== `${module}-module`;
    const focusedOption = this.menu.contains(document.activeElement) ? document.activeElement?.dataset.option : null;
    this.menu.replaceChildren(
      h('div', { className: 'tt-card-menu-title' }, '显示功能', h('span', {}, `${tabs.length} / ${MAX_CARD_TABS}`)),
      h('p', { id: 'card-option-hint' }, `最多 ${MAX_CARD_TABS} 项，至少保留 1 项`),
      ...CARD_VIEWS.map(view => {
        const checked = tabs.includes(view.id), blocked = checked ? tabs.length === 1 : tabs.length >= MAX_CARD_TABS;
        const input = h('input', { type: 'checkbox', 'data-option': view.id, 'aria-describedby': 'card-option-hint', 'aria-label': view.title });
        input.checked = checked; input.disabled = blocked;
        input.addEventListener('change', () => { const patch = toggleCardTab(this.state.get(), view.id); if (patch) this.state.patch(patch); });
        return h('label', { className: blocked ? 'disabled' : '', title: blocked ? checked ? '至少保留一个选项卡' : '已达上限，请先取消一项' : view.title }, input, cardIcon(view.icon), h('span', {}, view.title));
      }),
      h('label', { className: 'tt-card-theme-label' }, h('span', {}, '配色'), h('select', { 'aria-label': '卡片配色', onChange: e => this.state.patch({ appearance: e.target.value }) },
        ...selectOptions([{ value: 'system', label: 'Hana 原生' }, { value: 'dark', label: '深黑' }, { value: 'light', label: '浅色' }], appearance))),
    );
    if (focusedOption) {
      const option = this.menu.querySelector(`[data-option="${focusedOption}"]`);
      if (option && !option.disabled) option.focus(); else this.moreButton.focus();
    }
    this.filterBar.replaceChildren(...[
      h('select', { 'aria-label': '卡片时间范围', onChange: e => this.state.patch({ range: e.target.value, from: '', to: '' }) },
        ...selectOptions([...(state.from ? [{ value: 'all', label: `${state.from} — ${state.to}` }] : []), ...RANGES.map(v => ({ value: v.key, label: v.label }))], state.range)),
      h('span', { className: 'tt-card-filter-label', title: [state.agent, state.model, state.provider].filter(Boolean).join(' · ') }, state.agent || state.model || state.provider ? '已筛选' : '全部用量'),
      state.agent || state.model || state.provider || state.from ? h('button', { type: 'button', className: 'tt-btn ghost', onClick: () => this.state.patch({ agent: '', model: '', provider: '', type: '', from: '', to: '', ...(state.from ? { range: 'today' } : {}) }) }, '清除') : null,
      h('button', { type: 'button', className: 'tt-card-more', title: '刷新', 'aria-label': '刷新', onClick: () => this.onRefresh() }, cardIcon('refresh')),
      h('button', { type: 'button', className: 'tt-card-more', title: '打开完整看板', 'aria-label': '打开完整看板', onClick: async () => { try { await this.hana.cards.open('workspace'); } catch (e) { this.setError(`打开看板失败：${e.message}`); } } }, cardIcon('expand')),
    ].filter(Boolean));
    // 卡片配色 / 时间范围下拉换成自绘控件（原生 select 仍是状态源）。
    enhanceSelects(this.container);
    this.renderOverview();
  }

  renderOverview() {
    const el = this.container.querySelector('#overview-module');
    if (!el) return;
    const state = this.state.get(), { active } = cardSelection(state);
    if (['balance', 'details', 'realtime'].includes(active)) return;
    el.replaceChildren();
    if (!this.dashboard) { el.append(h('div', { className: 'tt-board-empty' }, '正在读取所选范围…')); return; }
    const board = h('div');
    renderAnalytics(board, this.dashboard, state, patch => this.state.patch(patch));
    if (active === 'overview') {
      el.append(h('header', { className: 'tt-card-summary-title' }, h('h2', {}, '用量总览'), h('span', {}, `${this.dashboard.agents.length} 个活跃 Agent`)), board.querySelector('.tt-board-kpis'));
      const daily = board.querySelector(CHART_SELECTORS.daily);
      if (daily) el.append(daily);
    } else {
      const chart = board.querySelector(CHART_SELECTORS[active]);
      if (chart) el.append(chart);
      else el.append(h('div', { className: 'tt-board-empty' }, '该范围暂无图表数据'));
    }
  }
}

export async function bootCard(options = {}) {
  const context = await bootstrap(options);
  const container = document.getElementById('app-root');
  if (!container) throw new Error('#app-root not found');
  const app = new CardApp({ ...context, container, mock: options.mock || new URLSearchParams(location.search).get('mock') === '1' });
  await app.init();
  window.addEventListener('pagehide', () => app.dispose(), { once: true });
  return app;
}
