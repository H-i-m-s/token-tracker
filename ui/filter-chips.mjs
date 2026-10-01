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
//   · 这块筛选条只建一次，之后都是原地更新（改文本、换 <option>、加减类型 chip）。
//     早先的写法是每次重画都整条 replaceWith，代价有两个：挂在 body 上的下拉浮层被摘成孤儿、
//     已经展开的面板被关掉（当时靠「3 秒内自动重开」硬补）。原地更新之后这两件事都不需要了。
//   · 供应商 / 模型 用了两套标签：chip 上用「供应商：」「模型：」这种显示名，state 里存的是真实 id。

import { h, selectOptions } from "./components.mjs";
import { mountSelect } from "./custom-select.mjs";
import { asList, pickValues, modsOf } from "./selection.mjs";

// Shift 整段加选的锚点：只关系到本次会话的点选手感，不是筛选状态，所以不进 state、不落盘。
const chipAnchors = { agent: null, provider: null, model: null };

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
function typeChip(value, onClear) {
  return h("span", { className: "tt-filter-chip active", title: `类型：${value}` },
    h("span", { className: "tt-filter-chip-text" }, `类型：${value}`),
    h("button", { type: "button", "data-filter": "type", "aria-label": "清除类型筛选", title: "清除类型筛选", onClick: onClear },
      h("span", { "aria-hidden": "true" }, "×")));
}

// 一颗多选下拉 chip。原生 <select> 常驻（自绘下拉的选项清单来源），选中集合由 holder 持有，
// 所以状态变化时只要换 <option> 再 sync 一下，触发器与已展开的面板都不必重建。
// 注意：必须先把 select 挂进父节点再 mountSelect —— 触发器是插在 select 后面的兄弟节点，
// select 还在游离状态时 mount 会找不到 parentNode，触发器就不会被插进去（整条筛选条会空掉）。
function createMultiChip({ parent, key, label, ariaLabel, onPatch }) {
  const holder = { values: [], ordered: [] };
  const select = h("select", { className: "tt-filter-chip", "aria-label": ariaLabel, title: `${label}：全部` });
  if (parent) parent.appendChild(select);
  mountSelect(select, {
    multiple: true,
    clearable: true,
    getValues: () => holder.values,
    labelFor: (v, plain) => (v ? `${label}：${plain || v}` : `全部${label}`),
    labelForValues: (vals, plain) => (vals.length ? `${label}：${summarize(vals, plain)}` : `全部${label}`),
    onPick: (value, event) => {
      if (value === "") { onPatch({ [key]: [] }); return; }
      const mods = modsOf(event);
      const next = pickValues(holder.values, value, holder.ordered, mods, chipAnchors[key]);
      if (!mods.range) chipAnchors[key] = value;
      onPatch({ [key]: next });
    },
  });
  return {
    select,
    update({ values, options }) {
      holder.values = asList(values);
      const list = Array.isArray(options) ? options.filter(Boolean) : [];
      // 除占位项之外的真实值，按显示顺序排：Shift 整段加选就按这个顺序取区间。
      holder.ordered = list.map((item) => String(item.value)).filter((v) => v !== "");
      select.replaceChildren(...selectOptions(list, ""));
      const nameOf = (v) => list.find((item) => String(item.value) === v)?.label || v;
      const title = `${label}：${holder.values.length ? holder.values.map(nameOf).join("、") : "全部"}`;
      select.title = title;
      const instance = select._ttSelect;
      if (instance) {
        instance.sync?.();               // 重算触发器文案与 × 的显隐
        if (instance.trigger) instance.trigger.title = title;   // title 在挂载时抄了一份，得同步
      }
    },
  };
}

// 建一块筛选条，返回 { root, update }。root 只在宿主里挂一次，之后一律走 update。
export function createFilterStatus({ state, agentOptions, providerOptions, modelOptions, onPatch } = {}) {
  const patch = typeof onPatch === "function" ? onPatch : () => {};

  const summaryEl = h("span", { className: "tt-filter-summary", role: "status", "aria-live": "polite", tabIndex: "-1" }, "当前范围");
  const chips = h("div", { className: "tt-filter-chips", "data-tt-view": "" });
  const clearBtn = h("button", {
    type: "button", className: "tt-filter-clear", hidden: true,
    title: "清除 Agent、模型、供应商和类型筛选，保留时间范围",
    onClick: () => clearAndFocus({ agent: [], model: [], provider: [], type: [] }, "range"),
  }, "清除筛选");
  const root = h("div", { className: "tt-filter-status", role: "region", "aria-label": "当前筛选状态" }, summaryEl, chips, clearBtn);

  // 清除后把焦点放回筛选条上，键盘操作不丢位置（这块不再重建，根节点一直是活的）。
  function clearAndFocus(patchObj, key) {
    patch(patchObj);
    const target = root.querySelector(`[data-filter="${key}"]`) || chips.querySelector("button") || summaryEl;
    if (target && typeof target.focus === "function") target.focus();
  }

  const chipOf = {
    agent: createMultiChip({ parent: chips, key: "agent", label: "Agent", ariaLabel: "Agent 筛选", onPatch: patch }),
    provider: createMultiChip({ parent: chips, key: "provider", label: "供应商", ariaLabel: "供应商筛选", onPatch: patch }),
    model: createMultiChip({ parent: chips, key: "model", label: "模型", ariaLabel: "模型筛选", onPatch: patch }),
  };
  // 供应商夹在 Agent 与模型之间：谁提供 → 谁在跑 → 跑哪个型号。（顺序由上面的 parent.append 定下）

  function update({ state: next = {}, agentOptions: ao, providerOptions: po, modelOptions: mo } = {}) {
    const s = next || {};
    chipOf.agent.update({ values: s.agent, options: withPlaceholder(ao, "全部 Agent") });
    chipOf.provider.update({ values: s.provider, options: withPlaceholder(po, "全部供应商") });
    chipOf.model.update({ values: s.model, options: withPlaceholder(mo, "全部模型") });
    // 类型一项一颗：先把上一轮的摘掉再补（它们没有常驻入口，数量随 state 变）。
    for (const el of chips.querySelectorAll('[data-filter="type"]')) el.remove();
    for (const value of asList(s.type)) {
      chips.appendChild(typeChip(value, () => clearAndFocus({ type: asList(s.type).filter((v) => v !== value) }, "type")));
    }
    // 「已筛选 · N 项」按选中的值个数算：多选之后按字段数算会严重低报。
    const activeCount = asList(s.agent).length + asList(s.provider).length + asList(s.model).length + asList(s.type).length;
    summaryEl.textContent = activeCount ? `已筛选 · ${activeCount} 项` : "当前范围";
    clearBtn.hidden = activeCount === 0;
  }

  if (state) update({ state, agentOptions, providerOptions, modelOptions });
  return { root, update };
}
