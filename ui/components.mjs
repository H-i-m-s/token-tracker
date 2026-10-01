// 时间范围的唯一口径。看板工具栏、卡片工具栏、数据大屏都读这一份。
// 之前这里是 7 项（今日/本周/本月/全年/近3天/近7天/近30天），analytics.mjs 里另有一份 4 项，
// card.mjs 还内联了一份 —— 同一个「近7天」在界面上有三个入口、两套词表。
// 收敛成：四个滚动窗口 + 本月 + 全部历史；自定义日期由看板的日期选择负责。
export const RANGES = [
  { key: "today", label: "今日" },
  { key: "last3", label: "近3天" },
  { key: "last7", label: "近7天" },
  { key: "last30", label: "近30天" },
  { key: "month", label: "本月" },
  { key: "all", label: "全部历史" },
];

export const PROVIDERS = ["DeepSeek", "GLM", "MiniMax", "商汤", "火山方舟", "OpenCode Go"];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) el.append(...child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
  return el;
}

export function fmt(n) {
  if (n == null || n === 0) return "0";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(1) + "亿";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toLocaleString();
}

export function fmtCost(n) {
  if (n == null) return "—";
  if (n === 0) return "$0";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v < 0.01) return "$" + v.toFixed(4).replace(/\.?0+$/, "");
  return "$" + v.toFixed(2).replace(/\.?0+$/, "").replace(/\.$/, "");
}

export function fmtPct(n, digits = 0) {
  const v = Number(n) || 0;
  return v.toFixed(digits) + "%";
}

export function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// 明细表用：带上年月日，否则只看 HH:mm 分不清是哪天的
// 列窄时会在空格处自动折成两行（日期一行、时间一行）
export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

export function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return "刚刚";
  if (s < 60) return s + "秒前";
  if (s < 3600) return Math.floor(s / 60) + "分钟前";
  return Math.floor(s / 3600) + "小时前";
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function selectOptions(items, selected = "", placeholder = "") {
  const opts = [];
  if (placeholder) opts.push(h("option", { value: "" }, placeholder));
  for (const item of items) {
    // 这里不能写成 `item.value || item.id`：空串是“全部”这个合法取值，会被 || 折叠掉，
    // 生成的 <option> 就没了 value 属性，浏览器改用它的文案当值（于是“全部 Agent”成了筛选值，
    // 界面上看着是“全部”，后端却在按一个不存在的 agent 过滤）。
    const value = typeof item === "string" ? item : item.value !== undefined ? item.value : item.id;
    const label = typeof item === "string" ? item : item.label || item.name || value;
    opts.push(h("option", { value, selected: value === selected ? "" : undefined }, label));
  }
  return opts;
}

/**
 * 胶囊选择条。返回的节点上带着 update()：
 * 高亮不画在按钮上，而是后面一块会滑的底（.tt-pill-thumb）。点另一项时整排不重建，
 * 只把这块底平移过去 —— 和页签滑轨是同一套手感。renderPills 是它的薄包装（一次性用、只取节点）。
 */
export function createPills(items, activeKey, onChange, extraClass = "") {
  const root = h("div", { className: `tt-pills ${extraClass}`.trim() });
  const thumb = h("span", { className: "tt-pill-thumb", "aria-hidden": "true" });
  const buttons = items.map((item) =>
    h("button", {
      className: "tt-pill",
      type: "button",
      "aria-pressed": "false",
      onClick: () => onChange(item.key),
    }, item.label));
  root.append(thumb, ...buttons);

  let current = null;
  let placed = false; // 有没有把高亮摆到过位置上：第一次就位不滑，直接落上去

  function place(animate) {
    const index = items.findIndex((item) => item.key === current);
    const button = index >= 0 ? buttons[index] : null;
    if (!button) { thumb.style.opacity = "0"; return; }
    thumb.style.opacity = "";
    const box = root.getBoundingClientRect();
    if (!box.width) return; // 还没挂进页面量不到位置：ResizeObserver 会在它入册时补一次
    const rect = button.getBoundingClientRect();
    const width = `${rect.width}px`;
    const height = `${rect.height}px`;
    const transform = `translate(${rect.left - box.left}px, ${rect.top - box.top}px)`;
    // 目标没变就什么都别碰：尺寸观察器在你点完之后还会响一次，
    // 那一下若照旧重写一遍样式（要加 tt-no-anim 再强制回流），会把正在跑的那次滑动打断 ——
    // 表现就是“有时候没有滑动效果”。
    if (thumb.style.width === width && thumb.style.height === height && thumb.style.transform === transform) {
      placed = true;
      return;
    }
    const still = !animate || !placed;
    if (still) root.classList.add("tt-no-anim");
    thumb.style.width = width;
    thumb.style.height = height;
    thumb.style.transform = transform;
    if (still) {
      void thumb.offsetWidth; // 先让它落到位置上，再把过渡放回来
      root.classList.remove("tt-no-anim");
      placed = true;
    }
  }

  function update(key, { animate = true } = {}) {
    if (key === current) return;
    const index = items.findIndex((item) => item.key === key);
    current = key;
    buttons.forEach((button, i) => {
      const on = i === index;
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
    });
    place(animate);
  }

  // 尺寸或断点变化时重新就位。这里用 animate=true：
  // 真在滑的时候如果碰上一个尺寸变化（滚动条出现、布局换档…），宁可让它滑到新位置，
  // 也不要瞬移 —— 瞬移会把那次滑动直接打断（tt-no-anim 一加，过渡就没了）。
  // 首次就位仍然不滑：那是 placed=false，走的是强制落位那条路。
  if (typeof ResizeObserver === "function") new ResizeObserver(() => place(true)).observe(root);
  update(activeKey, { animate: false });

  root.update = (key, options) => update(key, options);
  return { root, update };
}

export function renderPills(items, activeKey, onChange, extraClass = "") {
  return createPills(items, activeKey, onChange, extraClass).root;
}

export function rankAgents(rows, agentNames = {}) {
  const map = new Map();
  for (const r of rows) {
    const id = r.agent || r.agentId;
    if (!id) continue;
    const prev = map.get(id) || { id, totalTokens: 0 };
    prev.totalTokens += r.totalTokens || 0;
    map.set(id, prev);
  }
  const list = Array.from(map.values());
  const total = list.reduce((s, a) => s + a.totalTokens, 0) || 1;
  return list
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((a) => ({
      id: a.id,
      name: agentNames[a.id] || a.id,
      totalTokens: a.totalTokens,
      percent: total > 0 ? Math.round((a.totalTokens / total) * 100) : 0,
    }));
}
