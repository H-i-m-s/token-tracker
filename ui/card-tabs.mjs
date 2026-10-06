// 卡片能显示的页签数不设上限：页签多到装不下时，那条带子自己横向滚（见 card.css 的 .tt-card-tabs）。
// 之前卡在 4 项，是为了不让页签被挤成一条省略号；现在换成滚动，这个限制就不必留了。
export const CARD_VIEWS = [
  { id: 'overview', label: '用量', title: '用量总览', icon: 'overview' },
  { id: 'balance', label: '余额', title: '账户余额', icon: 'balance' },
  { id: 'details', label: '明细', title: '消费明细', icon: 'details' },
  { id: 'realtime', label: '实时', title: '实时监控', icon: 'realtime' },
  { id: 'agents', label: '工作空间', title: '工作空间活跃分布', icon: 'agents' },
  { id: 'heat', label: '日活', title: '日活分布', icon: 'heat' },
  { id: 'distribution', label: '请求分布', title: '单轮请求大小分布', icon: 'distribution' },
  { id: 'hours', label: '时段模型', title: '0–24 时分布 · 按模型', icon: 'hours' },
  { id: 'daily', label: '每日模型', title: '每日模型用量比例', icon: 'daily' },
];
export const DEFAULT_CARD_TABS = ['overview', 'balance', 'realtime'];
const known = new Set(CARD_VIEWS.map(v => v.id));
export function cardSelection(state = {}) {
  const ids = Array.isArray(state.cardTabs) ? [...new Set(state.cardTabs)].filter(id => known.has(id)) : [];
  const tabs = ids.length ? ids : [...DEFAULT_CARD_TABS];
  return { tabs, active: tabs.includes(state.cardActive) ? state.cardActive : tabs[0] };
}
export function toggleCardTab(state, id) {
  const { tabs, active } = cardSelection(state);
  // 只挡两件事：不认识的功能项，和“把最后一个也关掉”（卡片总得显示点什么）。
  if (!known.has(id) || (tabs.includes(id) && tabs.length === 1)) return null;
  const next = tabs.includes(id) ? tabs.filter(value => value !== id) : [...tabs, id];
  const fallback = next[Math.min(tabs.indexOf(active), next.length - 1)] || next[0];
  return { cardTabs: next, cardActive: next.includes(active) ? active : fallback };
}
