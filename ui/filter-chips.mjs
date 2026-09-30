// 「当前范围」筛选状态条：Agent / 供应商 / 模型 三个常驻可点 chip，
// 以及仅在筛选生效时出现的类型 chip 与「清除筛选」按钮。
//
// 抽成独立模块的原因：
//   1) workspace.mjs 已经过长，这一段只是「展示 + 回写 state」；
//   2) 拆出来后可以拿 mock state 单独渲染验证，不必拉起整个 WorkspaceApp。
//
// 关键设计：
//   · 常驻 chip 一律把选择写回宿主 state（onPatch），与明细筛选行、看板同源同步；
//   · Agent / 供应商 / 模型用原生 <select> 作唯一状态源（视觉隐藏），交给 mountSelect 换成自绘触发器；
//     三颗的 × 都在触发器内部（clearable），显示与清除同一个框；
//   · 时间不进这里：范围统一由看板右上角那排 pills + 日期选择负责；
//   · 重建前先 closeOpenSelect()：自绘下拉浮层挂在 body 上，
//     不清理的话，loadDashboard 直接调用本函数时就会留下孤儿浮层。
//   · 供应商 / 模型 用了两套标签：chip 上用「供应商：」「模型：」这种显示名，state 里存的是真实 id。

import { h, selectOptions } from "./components.mjs";
import { mountSelect, closeOpenSelect } from "./custom-select.mjs";

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

// 渲染整块 .tt-filter-status。返回的节点可直接替换宿主里的旧节点。
export function renderFilterStatus({ state, agentLabel, agentOptions, providerOptions, modelOptions, onPatch } = {}) {
  // 自绘下拉浮层挂在 body 上：本函数会重建整块筛选条，先把旧浮层摘干净，免留孤儿。
  closeOpenSelect();

  const s = state || {};
  const patch = typeof onPatch === "function" ? onPatch : () => {};
  const activeCount = [s.agent, s.model, s.provider, s.type].filter(Boolean).length;

  const root = h("div", { className: "tt-filter-status", role: "region", "aria-label": "当前筛选状态" });
  const chips = h("div", { className: "tt-filter-chips" });
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
