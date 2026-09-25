// 「当前范围」筛选状态条：时间 / Agent / 供应商 / 模型 四个常驻可点 chip，
// 以及仅在筛选生效时出现的类型 chip 与「清除筛选」按钮。
//
// 抽成独立模块的原因：
//   1) workspace.mjs 已经过长，这一段只是「展示 + 回写 state」；
//   2) 拆出来后可以拿 mock state 单独渲染验证，不必拉起整个 WorkspaceApp。
//
// 关键设计：
//   · 四个常驻 chip 一律把选择写回宿主 state（onPatch），与明细筛选行、看板同源同步；
//   · Agent / 供应商 / 模型用原生 <select> 作唯一状态源（视觉隐藏），交给 mountSelect 换成自绘触发器；
//     三颗的 × 都在触发器内部（clearable），显示与清除同一个框；
//   · 时间用 <details> + 面板（快捷范围 pills + 自定义日期）。面板 position: fixed 以逃出
//     .tt-filter-chips 的 overflow-x 裁剪，且留在 details 内部随宿主一起被移除，天然无孤儿；
//   · 重建前先 closeOpenSelect() / closeOpenDate()：自绘下拉与日历浮层都挂在 body 上，
//     不清理的话，loadDashboard 直接调用本函数时就会留下孤儿浮层。
//   · 供应商 / 模型 用了两套标签：chip 上用「供应商：」「模型：」这种显示名，state 里存的是真实 id。

import { h, renderPills, selectOptions } from "./components.mjs";
import { mountSelect, closeOpenSelect } from "./custom-select.mjs";
import { createDateField, closeOpenDate } from "./custom-date.mjs";
import { BOARD_RANGES } from "./analytics.mjs";

// 时间面板里的快捷范围：看板四档 + 全部历史。与看板 / 明细共用同一批 range key。
const TIME_RANGES = [...BOARD_RANGES, { key: "all", label: "全部历史" }];

// 调用方可能把「全部 Agent / 全部模型」占位项拼在数组首位（见 workspace），也可能只传真实选项。
// 两种情况都归一成「占位项在首位」的列表，避免出现两个占位项。
function withPlaceholder(options, placeholderLabel) {
  const list = (Array.isArray(options) ? options : []).filter(Boolean).map((item) => ({ ...item }));
  if (list.some((item) => item.value === "")) return list;
  return [{ value: "", label: placeholderLabel }, ...list];
}

// 类型 chip：供应商的 × 已经搬进它自己的下拉框里了，供应商不再需要这颗独立 chip；
// 类型没有常驻入口，继续用它表示与清除。
function filterChip(key, label, value, onClear) {
  return h("span", { className: "tt-filter-chip active", title: `${label}：${value}` },
    h("span", { className: "tt-filter-chip-text" }, `${label}：${value}`),
    h("button", { type: "button", "data-filter": key, "aria-label": `清除${label}筛选`, title: `清除${label}筛选`, onClick: onClear },
      h("span", { "aria-hidden": "true" }, "×")));
}

// 下拉 chip：把原生 <select> 挂进 chips，再用自绘触发器替换；触发器文案由调用方给定的 labelFor 决定。
// clearable 时，触发器内部自带一颗 ×（显示与清除同框）。
function appendSelectChip(parent, { ariaLabel, options, value, labelFor, clearable = false, onChange }) {
  const select = h("select", { className: "tt-filter-chip", "aria-label": ariaLabel }, ...selectOptions(options, value || ""));
  // 先入 DOM，mountSelect 才能把触发器插到它后面（select.nextSibling）。
  parent.appendChild(select);
  mountSelect(select, { labelFor, clearable });
  select.addEventListener("change", (event) => onChange(event.target.value));
  return select;
}

// 时间 chip：<details> 只做定位壳，chip 外观落在 <summary> 上。
function buildTimeChip({ state, label, patch, fail }) {
  const isSet = state.range !== "all" || !!state.from || !!state.to;
  const details = h("details", { className: `tt-filter-chip tt-filter-time${isSet ? " is-set" : ""}` });
  const summary = h("summary", { title: "时间范围" }, label || "全部历史");
  const panel = h("div", { className: "tt-filter-time-panel" });

  const from = createDateField({ value: state.from, ariaLabel: "开始日期" });
  const to = createDateField({ value: state.to, ariaLabel: "结束日期" });
  const apply = h("button", { type: "button", className: "tt-pill", onClick: () => {
    if (!from.value || !to.value || from.value > to.value) { fail("请选择有效日期，结束日期不能早于开始日期。"); return; }
    const days = (new Date(to.value) - new Date(from.value)) / 86400000;
    if (days > 366) { fail("自定义日期范围最多 367 天，请缩小范围。"); return; }
    patch({ range: "all", from: from.value, to: to.value });
  } }, "应用日期");

  panel.append(
    renderPills(TIME_RANGES, state.from || state.to ? "" : state.range, (key) => patch({ range: key, from: "", to: "" })),
    h("div", { className: "tt-filter-time-sep" }),
    h("div", { className: "tt-filter-time-dates" }, from, h("span", {}, "至"), to),
    h("div", { className: "tt-filter-time-actions" }, apply),
  );
  details.append(summary, panel);

  const doc = details.ownerDocument;
  const win = doc.defaultView;
  const raf = (cb) => (win && typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame(cb) : setTimeout(cb, 0));

  let open = false;
  const onDocPointer = (event) => { if (!details.contains(event.target)) close(); };
  const onDocKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
    if (typeof summary.focus === "function") summary.focus();
  };
  const onScrollOrResize = () => close();

  // 面板 position: fixed，位置必须按 summary 的视口矩形算；下方贴 6px，放不下且上方够高就上翻。
  function position() {
    const rect = summary.getBoundingClientRect();
    const vh = win.innerHeight || doc.documentElement.clientHeight || 480;
    const vw = win.innerWidth || doc.documentElement.clientWidth || 320;
    const pad = 8;
    const gap = 6;
    panel.style.left = Math.round(rect.left) + "px";
    panel.style.top = Math.round(rect.bottom + gap) + "px";
    panel.classList.remove("flip");
    const panelHeight = panel.offsetHeight;
    if (rect.bottom + gap + panelHeight > vh - pad && rect.top - gap - panelHeight >= pad) {
      panel.style.top = Math.round(rect.top - gap - panelHeight) + "px";
      panel.classList.add("flip");
    }
    if (rect.left + panel.offsetWidth > vw - pad) {
      panel.style.left = Math.max(pad, vw - panel.offsetWidth - pad) + "px";
    }
  }

  function openPanel() {
    if (open) return;
    open = true;
    position();
    raf(() => { if (open) panel.classList.add("open"); });
    doc.addEventListener("pointerdown", onDocPointer, true);
    doc.addEventListener("keydown", onDocKey, true);
    win.addEventListener("resize", onScrollOrResize, true);
    win.addEventListener("scroll", onScrollOrResize, true);
  }

  function close() {
    if (!open) return;
    open = false;
    panel.classList.remove("open");
    doc.removeEventListener("pointerdown", onDocPointer, true);
    doc.removeEventListener("keydown", onDocKey, true);
    win.removeEventListener("resize", onScrollOrResize, true);
    win.removeEventListener("scroll", onScrollOrResize, true);
    if (details.open) details.open = false;
  }

  // details 原生负责「再点 summary 关闭」与 Enter/Space 打开；外部点击 / Esc 由这里兜。
  details.addEventListener("toggle", () => { if (details.open) openPanel(); else close(); });
  return details;
}

// 渲染整块 .tt-filter-status。返回的节点可直接替换宿主里的旧节点。
export function renderFilterStatus({ state, rangeLabel, agentLabel, agentOptions, providerOptions, modelOptions, onPatch, onError } = {}) {
  // 自绘下拉 / 日历浮层挂在 body 上：本函数会重建整块筛选条，先把旧浮层摘干净，免留孤儿。
  closeOpenSelect();
  closeOpenDate();

  const s = state || {};
  const patch = typeof onPatch === "function" ? onPatch : () => {};
  const fail = typeof onError === "function" ? onError : () => {};
  const activeCount = [s.agent, s.model, s.provider, s.type].filter(Boolean).length;

  const root = h("div", { className: "tt-filter-status", role: "region", "aria-label": "当前筛选状态" });
  const chips = h("div", { className: "tt-filter-chips" });
  chips.appendChild(buildTimeChip({ state: s, label: rangeLabel, patch, fail }));
  appendSelectChip(chips, {
    ariaLabel: "Agent 筛选",
    options: withPlaceholder(agentOptions, "全部 Agent"),
    value: s.agent,
    labelFor: (v, plain) => (v ? `Agent：${plain || v}` : "全部 Agent"),
    clearable: true,
    onChange: (value) => patch({ agent: value }),
  });
  // 供应商夹在 Agent 与模型之间：谁提供 → 谁在跑 → 跑哪个型号。
  // × 由触发器自带（clearable），不再另外挂一颗独立 chip——显示与清除在同一个框里。
  appendSelectChip(chips, {
    ariaLabel: "供应商筛选",
    options: withPlaceholder(providerOptions, "全部供应商"),
    value: s.provider,
    labelFor: (v, plain) => (v ? `供应商：${plain || v}` : "全部供应商"),
    clearable: true,
    onChange: (value) => patch({ provider: value }),
  });
  appendSelectChip(chips, {
    ariaLabel: "模型筛选",
    options: withPlaceholder(modelOptions, "全部模型"),
    value: s.model,
    labelFor: (v, plain) => (v ? `模型：${plain || v}` : "全部模型"),
    clearable: true,
    onChange: (value) => patch({ model: value }),
  });

  // 清除后 state 通知会同步重建筛选条；在重建后的节点上找回焦点，键盘操作不丢位置。
  const clearAndFocus = (patchObj, key) => {
    patch(patchObj);
    const live = root.isConnected ? root : (root.ownerDocument.querySelector(".tt-filter-status") || root);
    const target = live.querySelector(`[data-filter="${key}"]`) || live.querySelector("button") || live.querySelector(".tt-filter-summary");
    if (target && typeof target.focus === "function") target.focus();
  };
  if (s.type) chips.appendChild(filterChip("type", "类型", s.type, () => clearAndFocus({ type: "" }, "type")));

  root.append(
    h("span", { className: "tt-filter-summary", role: "status", "aria-live": "polite", tabIndex: "-1" }, activeCount ? `已筛选 · ${activeCount} 项` : "当前范围"),
    chips,
  );
  if (activeCount) {
    root.appendChild(h("button", {
      type: "button", className: "tt-filter-clear",
      title: "清除 Agent、模型、供应商和类型筛选，保留时间范围",
      onClick: () => clearAndFocus({ agent: "", model: "", provider: "", type: "" }, "range"),
    }, "清除筛选"));
  }
  return root;
}
