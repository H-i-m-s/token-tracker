export const RANGES = [
  { key: "today", label: "今日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "year", label: "全年" },
  { key: "last3", label: "近3天" },
  { key: "last7", label: "近7天" },
  { key: "last30", label: "近30天" },
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
    const value = typeof item === "string" ? item : item.value || item.id;
    const label = typeof item === "string" ? item : item.label || item.name || value;
    opts.push(h("option", { value, selected: value === selected ? "" : undefined }, label));
  }
  return opts;
}

export function renderPills(items, activeKey, onChange, extraClass = "") {
  return h(
    "div",
    { className: `tt-pills ${extraClass}`.trim() },
    ...items.map((item) =>
      h(
        "button",
        {
          className: `tt-pill${item.key === activeKey ? " active" : ""}`,
          type: "button",
          "aria-pressed": String(item.key === activeKey),
          onClick: () => onChange(item.key),
        },
        item.label
      )
    )
  );
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
