// 「当前范围」筛选状态条：Agent / 供应商 / 模型 三个常驻可点 chip，
// 以及仅在筛选生效时出现的类型 chip 与「清除筛选」按钮。
//
// 抽成独立模块的原因：
//   1) workspace.mjs 已经过长，这一段只是「展示 + 回写 state」；
//   2) 拆出来后可以拿 mock state 单独渲染验证，不必拉起整个 WorkspaceApp。
//
// 关键设计：
//   · 常驻 chip 一律把选择写回宿主 state（onPatch），与明细筛选行、看板同源同步；
//   · Agent / 供应商 / 模型用原生 <select> 作选项来源（视觉隐藏），交给 mountSelect 换成自绘触发器；
//     三颗的 × 都在触发器内部（clearable），显示与清除同一个框。
//   · 这四个筛选都是多选的：下拉面板里 Shift / Ctrl 点可以一次挑多项（语义见 selection.mjs），
//     面板不会点一下就关，好连着挑；选中的项在面板里带勾。
//   · 时间不进这里：范围统一由看板右上角那排 pills + 日期选择负责，且范围是单选（一个连续窗口）。
//   · 重建前先 closeOpenSelect()：自绘下拉浮层挂在 body 上，
//     不清理的话，loadDashboard 直接调用本函数时就会留下孤儿浮层。
//   · 供应商 / 模型 用了两套标签：chip 上用「供应商：」「模型：」这种显示名，state 里存的是真实 id。

import { h, selectOptions } from "./components.mjs";
import { mountSelect, closeOpenSelect } from "./custom-select.mjs";
import { asList, pickValues, modsOf } from "./selection.mjs";

// Shift 整段加选的锚点：只关系到本次会话的点选手感，不是筛选状态，所以不进 state、不落盘。
const chipAnchors = { agent: null, provider: null, model: null };
// 刚在哪个 chip 的下拉里点过（带时间戳）。每选一项都会重建整条筛选条（自绘下拉随之被关掉），
// 所以接下来几次重绘都要把它重新打开，多选才能连着点。
// 时间是必要的：一次点击会连着重建两次（状态一变一次、看板数据回来再一次）。
// 超过窗口就不再自动打开，否则下一次定时刷新会把下拉弹出来。
let reopenChip = null;
const REOPEN_WINDOW_MS = 3000;
const CHIP_ARIA = { agent: "Agent 筛选", provider: "供应商筛选", model: "模型筛选" };

// 调用方可能把「全部 Agent / 全部模型」占位项拼在数组首位（见 workspace），也可能只传真实选项。
// 两种情况都归一成「占位项在首位」的列表，避免出现两个占位项。
function withPlaceholder(options, placeholderLabel) {
  const list = (Array.isArray(options) ? options : []).filter(Boolean).map((item) => ({ ...item }));
  if (list.some((item) => item.value === "")) return list;
  return [{ value: "", label: placeholderLabel }, ...list];
}

// 触发器文案：挑得多的时候别把筛选条撑破——最多列两个，其余用「等 N 项」收尾。
// 完整清单挂在 title 上，鼠标停一下能看到。
function summarize(values, plain) {
  const names = values.map((v) => plain(v) || v);
  if (names.length <= 2) return names.join("、");
  return `${names.slice(0, 2).join("、")} 等 ${names.length} 项`;
}

// 类型 chip：供应商的 × 已经搬进它自己的下拉框里了，供应商不再需要这颗独立 chip；
// 类型没有常驻入口，继续用它表示与清除（多选时一项一颗，各自能单独摘掉）。
function filterChip(key, label, value, onClear) {
  return h("span", { className: "tt-filter-chip active", title: `${label}：${value}` },
    h("span", { className: "tt-filter-chip-text" }, `${label}：${value}`),
    h("button", { type: "button", "data-filter": key, "aria-label": `清除${label}筛选`, title: `清除${label}筛选`, onClick: onClear },
      h("span", { "aria-hidden": "true" }, "×")));
}

// 多选下拉 chip：把原生 <select> 挂进 chips（它现在是选项清单的来源），再用自绘触发器替换。
// 选中集合由这里持有并写回 state；面板里的每次点击都带修饰键信息，交给 pickValues 算新集合。
function appendMultiChip(parent, { key, label, ariaLabel, options, values, onChange, clearable = true }) {
  const list = asList(values);
  const select = h("select", { className: "tt-filter-chip", "aria-label": ariaLabel, title: `${label}：${list.join("、") || "全部"}` },
    ...selectOptions(options, ""));
  parent.appendChild(select);
  // 选项里除占位项之外的真实值，按显示顺序排：Shift 整段加选就按这个顺序取区间。
  const ordered = options.map((item) => String(item.value)).filter((v) => v !== "");
  mountSelect(select, {
    multiple: true,
    clearable,
    getValues: () => list,
    labelFor: (v, plain) => (v ? `${label}：${plain || v}` : `全部${label}`),
    labelForValues: (vals, plain) => (vals.length ? `${label}：${summarize(vals, plain)}` : `全部${label}`),
    onPick: (value, event) => {
      if (value === "") { reopenChip = null; onChange([]); return; }
      const mods = modsOf(event);
      const next = pickValues(list, value, ordered, mods, chipAnchors[key]);
      if (!mods.range) chipAnchors[key] = value;
      reopenChip = { key, at: Date.now() };
      onChange(next);
    },
  });
  return select;
}

// 渲染整块 .tt-filter-status。返回的节点可直接替换宿主里的旧节点。
export function renderFilterStatus({ state, agentLabel, agentOptions, providerOptions, modelOptions, onPatch } = {}) {
  // 自绘下拉浮层挂在 body 上：本函数会重建整块筛选条，先把旧浮层摘干净，免留孤儿。
  closeOpenSelect();

  const s = state || {};
  const patch = typeof onPatch === "function" ? onPatch : () => {};
  const lists = { agent: asList(s.agent), provider: asList(s.provider), model: asList(s.model) };
  // 「已筛选 · N 项」按选中的值个数算：多选之后按字段数算会严重低报。
  const activeCount = lists.agent.length + lists.provider.length + lists.model.length + asList(s.type).length;

  const root = h("div", { className: "tt-filter-status", role: "region", "aria-label": "当前筛选状态" });
  const chips = h("div", { className: "tt-filter-chips" });
  appendMultiChip(chips, {
    key: "agent", label: "Agent", ariaLabel: "Agent 筛选",
    options: withPlaceholder(agentOptions, "全部 Agent"),
    values: lists.agent,
    onChange: (next) => patch({ agent: next }),
  });
  // 供应商夹在 Agent 与模型之间：谁提供 → 谁在跑 → 跑哪个型号。
  // × 由触发器自带（clearable），不再另外挂一颗独立 chip——显示与清除在同一个框里。
  appendMultiChip(chips, {
    key: "provider", label: "供应商", ariaLabel: "供应商筛选",
    options: withPlaceholder(providerOptions, "全部供应商"),
    values: lists.provider,
    onChange: (next) => patch({ provider: next }),
  });
  appendMultiChip(chips, {
    key: "model", label: "模型", ariaLabel: "模型筛选",
    options: withPlaceholder(modelOptions, "全部模型"),
    values: lists.model,
    onChange: (next) => patch({ model: next }),
  });

  // 清除后 state 通知会同步重建筛选条；在重建后的节点上找回焦点，键盘操作不丢位置。
  const clearAndFocus = (patchObj, key) => {
    patch(patchObj);
    const live = root.isConnected ? root : (root.ownerDocument.querySelector(".tt-filter-status") || root);
    const target = live.querySelector(`[data-filter="${key}"]`) || live.querySelector("button") || live.querySelector(".tt-filter-summary");
    if (target && typeof target.focus === "function") target.focus();
  };
  // 类型一项一颗，各自能单独摘掉
  asList(s.type).forEach((value) => {
    chips.appendChild(filterChip("type", "类型", value, () => clearAndFocus({ type: asList(s.type).filter((v) => v !== value) }, "type")));
  });

  root.append(
    h("span", { className: "tt-filter-summary", role: "status", "aria-live": "polite", tabIndex: "-1" }, activeCount ? `已筛选 · ${activeCount} 项` : "当前范围"),
    chips,
  );
  if (activeCount) {
    root.appendChild(h("button", {
      type: "button", className: "tt-filter-clear",
      title: "清除 Agent、模型、供应商和类型筛选，保留时间范围",
      onClick: () => clearAndFocus({ agent: [], model: [], provider: [], type: [] }, "range"),
    }, "清除筛选"));
  }
  // 重建后把刚在用的那颗下拉重新打开（要等调用方把它挂进文档，否则量不到位置）。
  if (reopenChip && Date.now() - reopenChip.at < REOPEN_WINDOW_MS) {
    const key = reopenChip.key;
    queueMicrotask(() => {
      const trigger = root.querySelector(`.tt-select[aria-label="${CHIP_ARIA[key]}"]`);
      if (trigger && trigger.isConnected) trigger._ttSelect?.open?.();
    });
  } else {
    reopenChip = null;
  }
  return root;
}
