// 「模型价格」那张卡。
//
// 为什么单独一个文件而不是塞进 settings.mjs：
//   这一张卡的操作方式和其他四张卡不一样。其他卡是「改一处 → 提交整张卡」，
//   这里是几百个独立的小格子、还要支持批量套用，需要自己的一套状态（选中集、批量栏）。
//   硬塞进去会让那套「read/baseline/diff」机制多出一堆特例。
//
// 保存契约仍是设置页那一条：改完就存，没有保存按钮。
// 差别在粒度：按项存。一个输入框失焦就 PATCH 它自己那一项，
// 批量套用是一次 PATCH 多项。这样 58 个模型 × 4 个框才改得动。
//
// 价格来源用三种标记说清，不靠颜色猜：
//   「你填的」   用户表里有这一项，输入框显示它
//   「默认」     程序自带的价格，输入框留空、显示默认值作占位
//   「未填」     谁都没给，这一项算不出钱
import { h } from "./components.mjs";
import { moneySymbol } from "./currency.mjs";

// 四个价位。cacheWrite 放最后：绝大多数模型是 0，用户确认过「不写就是 0」。
export const PRICE_FIELDS = [
  { key: "input", label: "输入", hint: "缓存未命中" },
  { key: "cacheRead", label: "缓存读", hint: "命中缓存" },
  { key: "output", label: "输出", hint: "" },
  { key: "cacheWrite", label: "缓存写", hint: "多数模型为 0" },
];

function compactTokens(n) {
  if (!n) return "";
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [base, suffix] of units) {
    if (n >= base) return (n / base).toFixed(n >= base * 10 ? 0 : 1) + suffix;
  }
  return String(n);
}

// 一个价格对象 → 界面上的四个字符串。缺的项给空串（不是 0）：空 = 没填。
function priceToValues(price) {
  const out = {};
  for (const f of PRICE_FIELDS) {
    const v = price?.[f.key];
    out[f.key] = Number.isFinite(v) ? String(v) : "";
  }
  return out;
}

export class PriceCard {
  constructor({ api, mock, log = () => {} }) {
    this.api = api;
    this.mock = mock;
    this.log = log;
    this.data = null;          // 服务端给的并集清单
    this.selected = new Set(); // 勾选的 key（批量套用用）
    this.collapsed = true;     // 默认收起：这一卡有 58 行，不收起会把整页顶下去
    this.batch = { input: "", cacheRead: "", output: "", cacheWrite: "" };
    this.saving = new Set();
    this.el = null;
    this.bodyEl = null;
    this.batchEl = null;
    this.staleValues = new Map(); // key → 正在编辑但还没保存的值，避免重绘把字冲掉
  }

  async load() {
    const res = await this.api.getPriceTable({ mock: this.mock });
    this.data = res;
    return res;
  }

  // 卡片骨架。价格数据是异步来的，先把壳挂上去，数据到了再填，避免整页等一次请求。
  render() {
    const countEl = h("span", { className: "tts-badge" }, "…");
    this.countEl = countEl;
    const toggle = h("button", {
      type: "button",
      className: "tts-price__toggle",
      "aria-expanded": String(!this.collapsed),
      onClick: () => this.setCollapsed(!this.collapsed),
    }, this.collapsed ? "展开" : "收起");
    this.toggleEl = toggle;

    this.bodyEl = h("div", { className: "tts-price__body" });
    this.bodyEl.hidden = this.collapsed;
    this.batchEl = h("div", { className: "tts-price__batch" });
    this.batchEl.hidden = true;

    this.el = h("section", { className: "tts-card tts-price" },
      h("div", { className: "tts-card__head" },
        h("h2", { className: "tts-card__title" }, "模型价格"),
        h("div", { className: "tts-card__right" }, countEl, toggle),
      ),
      h("p", { className: "tts-card__desc" },
        "按用量给每个模型算钱。单位是「", moneySymbol() === "¥" ? "美元" : "美元",
        " / 每百万 token」，与显示用的货币无关 —— 价格本身永远存美元，换币种只是显示时换算。",
        "填了才会计入预估费用；没填的模型在消费明细里显示「未完整定价」。",
        "价格存在 price-table.json，也可以直接用编辑器改。"),
      this.bodyEl,
    );
    return this.el;
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    if (this.bodyEl) this.bodyEl.hidden = collapsed;
    if (this.toggleEl) {
      this.toggleEl.textContent = collapsed ? "展开" : "收起";
      this.toggleEl.setAttribute("aria-expanded", String(!collapsed));
    }
  }

  // 数据到了：重画整块。价格表重画是廉价的（58 行），不值得为增量更新写一套 diff。
  paint() {
    if (!this.data) return;
    const { groups, count, pricedCount } = this.data;
    if (this.countEl) this.countEl.textContent = `${pricedCount} / ${count} 已定价`;
    this.bodyEl.replaceChildren();
    if (!groups.length) {
      this.bodyEl.append(h("p", { className: "tts-price__empty" }, "还没有可填的模型。用过或配置过模型之后这里会自动出现。"));
      return;
    }
    // 批量栏在最上面：勾选项 → 一次填四价 → 套用。
    this.bodyEl.append(this.renderBatchBar());
    for (const group of groups) this.bodyEl.append(this.renderGroup(group));
    this.syncBatchBar();
  }

  // ── 批量套用栏 ──
  renderBatchBar() {
    const inputs = {};
    this.batchInputs = inputs;
    const field = (spec) => {
      const input = h("input", {
        type: "text",
        inputmode: "decimal",
        className: "tts-price__cell",
        placeholder: "0",
        name: `batch-${spec.key}`,
        title: spec.hint ? `${spec.label}（${spec.hint}）` : spec.label,
      });
      input.addEventListener("input", () => { this.batch[spec.key] = input.value; this.syncBatchBar(); });
      inputs[spec.key] = input;
      return h("label", { className: "tts-price__batch-cell" },
        h("span", { className: "tts-price__batch-label" }, spec.label), input);
    };
    this.applyBtn = h("button", {
      type: "button",
      className: "tt-btn",
      onClick: () => this.applyBatch(),
    }, "套用到选中");
    this.clearBtn = h("button", {
      type: "button",
      className: "tt-btn ghost",
      onClick: () => this.clearSelection(),
    }, "取消选择");
    this.batchNote = h("span", { className: "tts-price__batch-note" });

    return h("div", { className: "tts-price__batch-inner" },
      h("div", { className: "tts-price__batch-head" },
        h("span", { className: "tts-price__batch-title" }, "批量填价"),
        this.batchNote,
      ),
      h("div", { className: "tts-price__batch-fields" }, PRICE_FIELDS.map(field)),
      h("div", { className: "tts-price__batch-actions" }, this.clearBtn, this.applyBtn),
    );
  }

  syncBatchBar() {
    if (!this.batchNote) return;
    const n = this.selected.size;
    this.batchNote.textContent = n ? `已选 ${n} 个模型` : "先勾选模型，或勾上某个供应商的名字整块选中";
    // 没选东西、或者四格全空，就不给按 —— 避免「点了没反应」。
    const anyFilled = PRICE_FIELDS.some((f) => String(this.batch[f.key] ?? "").trim() !== "");
    this.applyBtn.disabled = n === 0 || !anyFilled;
    this.clearBtn.disabled = n === 0;
    if (this.batchEl) this.batchEl.hidden = n === 0;
  }

  // ── 一个供应商一块 ──
  renderGroup(group) {
    const allBox = h("input", { type: "checkbox", className: "tts-price__box" });
    const keys = group.items.map((i) => i.key);
    const syncAll = () => {
      const on = keys.filter((k) => this.selected.has(k)).length;
      allBox.checked = on === keys.length && keys.length > 0;
      allBox.indeterminate = on > 0 && on < keys.length;
    };
    allBox.addEventListener("change", () => {
      if (allBox.checked) for (const k of keys) this.selected.add(k);
      else for (const k of keys) this.selected.delete(k);
      this.paint();
    });
    syncAll();

    const head = h("div", { className: "tts-price__group-head" },
      h("label", { className: "tts-price__group-label" },
        allBox,
        h("span", { className: "tts-price__group-name" }, group.provider),
        h("span", { className: "tts-price__group-meta" },
          `${group.total} 个模型`,
          group.tokens ? ` · ${compactTokens(group.tokens)} tokens` : "",
          group.pricedCount ? ` · ${group.pricedCount} 个已定价` : " · 都还没定价"),
      ),
    );

    const rows = group.items.map((item) => this.renderRow(item));
    return h("div", { className: "tts-price__group" }, head, h("div", { className: "tts-price__rows" }, rows));
  }

  renderRow(item) {
    const box = h("input", { type: "checkbox", className: "tts-price__box", checked: this.selected.has(item.key) ? "" : undefined });
    box.addEventListener("change", () => {
      if (box.checked) this.selected.add(item.key);
      else this.selected.delete(item.key);
      this.syncBatchBar();
      // 只重画块头的全选框状态，不重画整行（重画会打断正在编辑的输入框）
      const groupEl = box.closest(".tts-price__group");
      const groupBox = groupEl?.querySelector(".tts-price__group-label .tts-price__box");
      if (groupBox) {
        const boxes = [...groupEl.querySelectorAll(".tts-price__rows .tts-price__box")];
        const on = boxes.filter((b) => b.checked).length;
        groupBox.checked = on === boxes.length;
        groupBox.indeterminate = on > 0 && on < boxes.length;
      }
    });

    // 显示用哪一份价：填过的显示填的，否则把默认价当占位符（灰色），一眼能分出是不是自己填的。
    const shown = item.price || null;
    const placeholder = item.defaultPrice || null;
    const cells = {};
    for (const spec of PRICE_FIELDS) {
      const input = h("input", {
        type: "text",
        inputmode: "decimal",
        className: "tts-price__cell",
        value: shown?.[spec.key] ?? "",
        placeholder: placeholder?.[spec.key] != null ? String(placeholder[spec.key]) : "0",
        title: `${spec.label}${spec.hint ? `（${spec.hint}）` : ""}`,
      });
      input.dataset.key = item.key;
      input.dataset.field = spec.key;
      input.addEventListener("input", () => this.staleValues.set(item.key, this.readRow(cells)));
      input.addEventListener("blur", () => void this.commitRow(item, cells));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      cells[spec.key] = input;
    }

    const restore = h("button", {
      type: "button",
      className: "tts-price__restore",
      title: "从文件里删掉这一项，回到程序默认价",
      onClick: () => void this.restoreRow(item),
    }, "恢复默认");
    restore.hidden = item.source !== "user";

    const sourceTag = h("span", {
      className: "tts-price__tag",
      "data-source": item.source,
    }, item.source === "user" ? "你填的" : item.source === "default" ? "默认" : "未填");

    // 用量那一栏：这是「值不值得填」的判断依据，比模型名本身更有用。
    const meta = h("span", { className: "tts-price__meta" },
      item.tokens ? compactTokens(item.tokens) : "未用过",
      item.lastDay ? ` · 最后 ${item.lastDay}` : "");

    return h("div", { className: "tts-price__row" },
      h("label", { className: "tts-price__row-name" }, box, h("span", { className: "tts-price__model", title: item.model }, item.model)),
      h("div", { className: "tts-price__cells" }, PRICE_FIELDS.map((f) => cells[f.key])),
      meta,
      sourceTag,
      restore,
    );
  }

  readRow(cells) {
    const out = {};
    for (const spec of PRICE_FIELDS) out[spec.key] = cells[spec.key].value.trim();
    return out;
  }

  // 一个输入框失焦：把这一行四格一起提交。
  // 为什么整行提交而不是只提交那一格：用户经常连着填「输入」「输出」两格，
  // 一格一次 PATCH 会打出两三个请求；整行一次既有原子性（这一行的价要么全旧要么全新），
  // 也少一半请求。
  async commitRow(item, cells) {
    const values = this.readRow(cells);
    const current = item.price ? priceToValues(item.price) : { input: "", cacheRead: "", output: "", cacheWrite: "" };
    if (PRICE_FIELDS.every((f) => values[f.key] === current[f.key])) return; // 没改
    // 全空 = 用户把这一行清空了 = 恢复默认（从文件里删掉），不是「四个 0」。
    const empty = PRICE_FIELDS.every((f) => values[f.key] === "");
    await this.patch([{ key: item.key, price: empty ? null : this.toPatch(values) }], item.key);
    this.staleValues.delete(item.key);
  }

  // 界面上的字符串 → 提交体。空串不写字段：没填 ≠ 0。
  toPatch(values) {
    const price = {};
    for (const spec of PRICE_FIELDS) {
      const raw = values[spec.key];
      if (raw === "" || raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return null; // 非法：整行不提交
      price[spec.key] = n;
    }
    return Object.keys(price).length ? price : null;
  }

  async restoreRow(item) {
    await this.patch([{ key: item.key, price: null }], item.key);
  }

  async applyBatch() {
    const price = {};
    for (const spec of PRICE_FIELDS) {
      const raw = String(this.batch[spec.key] ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        this.note(`「${spec.label}」填的不是有效数字`, true);
        return;
      }
      price[spec.key] = n;
    }
    if (!Object.keys(price).length) { this.note("四格都空着，没有可套用的价", true); return; }
    const keys = [...this.selected];
    if (!keys.length) { this.note("还没选模型", true); return; }
    this.applyBtn.disabled = true;
    this.note(`正在写入 ${keys.length} 个模型…`);
    const ok = await this.patch(keys.map((key) => ({ key, price })), keys.join(","));
    if (ok) {
      // 套用成功后清空四格并取消选择：这样下一批可以直接开始，不用手动清。
      this.batch = { input: "", cacheRead: "", output: "", cacheWrite: "" };
      for (const el of Object.values(this.batchInputs || {})) el.value = "";
      this.selected.clear();
      this.note(`已写入 ${keys.length} 个模型`);
    }
  }

  // 统一出口：提交 + 重新拉清单（因为「已定价」计数、来源标记都会变）。
  // 不做本地乐观更新：价格直接影响金额，界面上的数必须与盘上一致。
  async patch(patches, token) {
    try {
      await this.api.savePrices(patches, { mock: this.mock });
      await this.load();
      // 保留用户正在编辑、还没提交的其他行，别让重画把它们冲掉
      const editing = new Map(this.staleValues);
      this.paint();
      for (const [key, values] of editing) {
        const row = this.bodyEl.querySelector(`.tts-price__row [data-key="${CSS.escape(key)}"]`)?.closest(".tts-price__row");
        if (!row) continue;
        for (const spec of PRICE_FIELDS) {
          const input = row.querySelector(`[data-field="${spec.key}"]`);
          if (input) input.value = values[spec.key];
        }
      }
      return true;
    } catch (err) {
      this.note(`保存失败：${err?.message || err}`, true);
      this.log("price save failed", err);
      return false;
    } finally {
      this.syncBatchBar();
    }
  }

  note(text, isError = false) {
    if (!this.batchNote) return;
    this.batchNote.textContent = text;
    if (isError) this.batchNote.dataset.kind = "err";
    else delete this.batchNote.dataset.kind;
  }

  clearSelection() {
    this.selected.clear();
    this.paint();
  }
}

export default PriceCard;
