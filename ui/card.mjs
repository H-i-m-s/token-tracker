import { WorkspaceApp } from './workspace.mjs';
import { bootstrap } from './bootstrap.mjs';
import { applyAppearance } from './appearance.mjs';
import { renderAnalytics } from './analytics.mjs';
import { h, RANGES, THEME_OPTIONS, createUnitRow, selectOptions, installDetailsDismiss } from './components.mjs';
import { asList, selectionKey } from './selection.mjs';
import { enhanceSelects } from './custom-select.mjs';
import { closeAllPickers } from './custom-pickers.mjs';
import { cardIcon } from './card-icons.mjs';
import { CARD_VIEWS, cardSelection, toggleCardTab } from './card-tabs.mjs';

const CHART_SELECTORS = {
  agents: '.tt-agent-panel', heat: '.tt-heat-panel', distribution: '.tt-dist-panel',
  hours: '.tt-board-right > section:first-child', daily: '.tt-board-right > section:last-child',
};
// 把某一枚页签拨进视野：只动这条带子的 scrollLeft，不碰外层。
// （用 scrollIntoView 会连带滚它的祖先，卡片外面那一层是首页，不能推。）
function revealTab(bar, button) {
  if (!bar || !button) return;
  const left = button.offsetLeft, right = left + button.offsetWidth;
  if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - 6);
  else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 6;
}
export class CardApp extends WorkspaceApp {
  renderShell() {
    this.container.replaceChildren();
    this.container.className = 'tt-app tt-switch-card';
    this.tabBar = h('div', { className: 'tt-card-tabs', role: 'tablist', 'aria-label': '卡片功能' });
    // 显示设置复用看板那一套（<details> + .tt-display-menu + 胶囊开关 + 主题三档）：同一份样式、
    // 同一套开合手势，不再自己发明一套复选框菜单。开合（点外面 / Esc 收起）见 installDetailsDismiss。
    this.menu = h('div', { className: 'tt-display-menu', role: 'group', 'aria-label': '卡片显示设置' });
    this.settings = h('details', { className: 'tt-display-settings tt-card-settings' },
      h('summary', { className: 'tt-card-more', title: '显示设置', 'aria-label': '卡片显示设置' }, cardIcon('more')),
      this.menu);
    this.filterBar = h('div', { className: 'tt-card-filters' });
    this.statusEl = h('div', { className: 'tt-status-bar', role: 'status' });
    this.mainEl = h('main', { className: 'tt-card-content', id: 'card-content', role: 'tabpanel' });
    for (const id of ['overview', 'balance', 'details', 'realtime']) this.mainEl.append(h('section', { id: `${id}-module`, className: 'tt-module' }));
    this.container.append(h('header', { className: 'tt-card-header' }, this.tabBar, this.settings), this.filterBar, this.statusEl, this.mainEl);
    installDetailsDismiss();
    this.bindTabStripWheel();
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

  // 页签带没有纵向内容可滚，滚轮直接当横向用：滚动条是藏起来的，靠它找看不见的页签无从下手。
  bindTabStripWheel() {
    this.tabBar.addEventListener('wheel', e => {
      if (!e.deltaY || e.deltaX) return;
      e.preventDefault();
      this.tabBar.scrollLeft += e.deltaY;
    }, { passive: false });
  }

  // 基类只在 chromeSignature 变化时才重画顶部控件。卡片顶部那排「画成什么样」的输入有：时间窗、
  // 四个筛选（「已筛选」与「清除」的显隐靠它们）、配色、菜单勾选项、当前页签。少算一个，
  // 改它就只动状态不重画 —— 点了「清除」界面还写着「已筛选」，人就会觉得清不掉。
  // 看板那边不受影响，它不继承这份签名（它的筛选胶囊是原地更新的）。
  chromeSignature(state) {
    const { tabs, active } = cardSelection(state);
    return JSON.stringify([
      state.range, state.from, state.to,
      selectionKey(state.agent), selectionKey(state.model), selectionKey(state.provider), selectionKey(state.type),
      state.appearance, this.inputStatusPrefs, tabs, active,
    ]);
  }

  renderBoardControls() {
    // 本函数会重建筛选条与显示设置菜单：自绘下拉随之被替换，先把已打开的浮层摘干净。
    closeAllPickers();
    if (!this.tabBar) return;
    const state = this.state.get(), { tabs, active } = cardSelection(state);
    const appearance = applyAppearance(state.appearance || 'system');
    // 页签整排会被换掉：先记下焦点原本落在哪个页签上，重画完再还回去，免得点一下就掉到 body。
    const focusedTab = this.tabBar.contains(document.activeElement) ? document.activeElement.dataset.view : null;
    this.tabBar.replaceChildren(...tabs.map(id => {
      const view = CARD_VIEWS.find(v => v.id === id);
      return h('button', { type: 'button', role: 'tab', id: `card-tab-${id}`, 'data-view': id, 'aria-controls': 'card-content', 'aria-selected': String(id === active), tabindex: id === active ? '0' : '-1', title: view.title, onClick: () => this.state.patch({ cardActive: id }) },
        cardIcon(view.icon), h('span', {}, view.label));
    }));
    if (focusedTab) this.tabBar.querySelector(`[data-view="${focusedTab}"]`)?.focus();
    // 页签多了就是一条滚动带：切到看不见的那一枚时把它拨回视野（只在选中项真变了的那一拍做）。
    if (active !== this.revealedTab) {
      this.revealedTab = active;
      revealTab(this.tabBar, this.tabBar.querySelector(`[data-view="${active}"]`));
    }
    this.mainEl.setAttribute('aria-labelledby', `card-tab-${active}`);
    const module = ['balance', 'details', 'realtime'].includes(active) ? active : 'overview';
    for (const section of this.mainEl.children) section.hidden = section.id !== `${module}-module`;
    const focusedOption = this.menu.contains(document.activeElement) ? document.activeElement?.dataset.option : null;
    // 与看板显示设置同构：先主题三档（按压行），一条分隔线，再是一行一个胶囊开关的功能清单。
    // 之前这里是原生复选框：能不能勾、满没满，全靠浏览器给的默认样子说话，和看板是两套语言。
    this.menu.replaceChildren(
      ...THEME_OPTIONS.map(({ key, label }) =>
        h('button', { type: 'button', 'aria-pressed': String(appearance === key), title: `卡片配色：${label}`, onClick: () => this.state.patch({ appearance: key }) }, label)),
      h('div', { className: 'tt-display-sep' }),
      // 与看板同一行同一个口子（写法、落盘、重画都在基类的 applyUnits 里）。
      createUnitRow(key => this.applyUnits(key)),
      h('div', { className: 'tt-display-sep' }),
      ...CARD_VIEWS.map(view => {
        const checked = tabs.includes(view.id), blocked = checked && tabs.length === 1;
        const hint = blocked ? '至少保留一项' : view.title;
        const switchEl = h('button', {
          type: 'button', className: 'tt-switch', 'data-option': view.id,
          'aria-pressed': String(checked), 'aria-label': view.title, title: hint,
          ...(blocked ? { disabled: '' } : {}),
          onClick: () => { const patch = toggleCardTab(this.state.get(), view.id); if (patch) this.state.patch(patch); },
        });
        return h('div', { className: 'tt-inputstatus-row', title: hint, ...(blocked ? { 'data-blocked': '' } : {}) },
          h('span', { className: 'tt-inputstatus-label' }, view.title), switchEl);
      }),
      // 已经没有上限了，这行只说清还剩几条、以及最后一条关不掉。
      h('p', { className: 'tt-card-menu-hint' }, `已显示 ${tabs.length} 项 · 至少保留 1 项`),
    );
    if (focusedOption) {
      const option = this.menu.querySelector(`[data-option="${focusedOption}"]`);
      if (option && !option.disabled) option.focus(); else this.settings.querySelector('summary')?.focus();
    }
    // 筛选标示把筛的东西名字列出来，不只写「已筛选」：卡片里没有看板那排筛选胶囊，
    // 只写三个字等于告诉他「有筛选」，却不说是哪一项、去哪儿清。完整清单挂在 title 上。
    const filterNames = [
      ...asList(state.agent).map(v => `Agent：${v}`),
      ...asList(state.model).map(v => `模型：${v}`),
      ...asList(state.provider).map(v => `供应商：${v}`),
      ...asList(state.type).map(v => `类型：${v}`),
    ];
    const filterText = !filterNames.length
      ? '全部用量'
      : (filterNames.length <= 2 ? filterNames.join('、') : `${filterNames.slice(0, 2).join('、')} 等 ${filterNames.length} 项`);
    this.filterBar.replaceChildren(...[
      h('select', { 'aria-label': '卡片时间范围', onChange: e => this.state.patch({ range: e.target.value, from: '', to: '' }) },
        ...selectOptions([...(state.from ? [{ value: 'all', label: `${state.from} — ${state.to}` }] : []), ...RANGES.map(v => ({ value: v.key, label: v.label }))], state.range)),
      h('span', { className: 'tt-card-filter-label', title: filterNames.length ? filterNames.join(' · ') : '当前没有筛选' }, filterText),
      filterNames.length || state.from ? h('button', { type: 'button', className: 'tt-btn ghost', onClick: () => this.state.patch({ agent: [], model: [], provider: [], type: [], from: '', to: '', ...(state.from ? { range: 'today' } : {}) }) }, '清除') : null,
      h('button', { type: 'button', className: 'tt-card-more', title: '刷新', 'aria-label': '刷新', onClick: () => this.onRefresh() }, cardIcon('refresh')),
      h('button', { type: 'button', className: 'tt-card-more', title: '打开完整看板', 'aria-label': '打开完整看板', onClick: async () => { try { await this.hana.cards.open('workspace'); } catch (e) { this.setError(`打开看板失败：${e.message}`); } } }, cardIcon('expand')),
    ].filter(Boolean));
    // 时间范围下拉换成自绘控件（原生 select 仍是状态源）。
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
