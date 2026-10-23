// 模型价格详情弹窗：双击主卡里的模型名进来。
//
// 为什么单开一屏而不是在主卡里再排一行框：
//   主卡一行要扫几十个模型，行高就是扫读效率。分时定价一段就是「时段 + 四个价」，
//   上下文分档再加几行，塞进一行等于把那几十行全毁了。
//   所以主卡只留最常用的四个数，复杂的都退到这一屏。
//
// 外壳照抄更新说明弹窗（ui/update-notice.mjs）：native <dialog>.showModal，
// ::backdrop 负责压暗与模糊，退场先加类等动效走完再 close。样式在
// settings-price.css 的 .tts-pdetail 一节。
//
// 保存口径：这里提交的是**整项替换**。后端 applyPricePatches 走 table[key] = norm，
// 所以四价、按次、分档、分时四块必须一起交，漏一块就等于把那一块删了。

import { h } from "./components.mjs";
import { PRICE_FIELDS } from "./price-card.mjs";
import { createTimeField, closeOpenTime } from "./time-field.mjs";

// 注意：这里不能把 PRICE_FIELDS 提到模块顶层存成常量。
// price-card 也会 import 本模块（双击入口），两边形成环，
// 顶层就去读对方的 const 会撞上暂时性死区。
// 只在函数体里用，那时两边模块都已初始化完。

/** 读 CSS 里退场动效的时长。读不到当没有动效，直接收。 */
function exitMs(node) {
  try {
    const parts = String(getComputedStyle(node).animationDuration || "")
      .split(",")
      .map((p) => p.trim())
      .map((p) => (p.endsWith("ms") ? parseFloat(p) : parseFloat(p) * 1000))
      .filter((n) => Number.isFinite(n) && n > 0);
    return parts.length ? Math.min(Math.max(...parts), 600) : 0;
  } catch { return 0; }
}

/** 数字输入：宽松解析。空串返回 null（= 没填），非法返回 NaN（= 报错）。 */
function readNum(input) {
  const raw = String(input.value ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

function numInput(value, placeholder) {
  return h("input", {
    type: "text",
    inputmode: "decimal",
    className: "tts-pdetail__num",
    value: value == null ? "" : String(value),
    placeholder: placeholder == null ? "" : String(placeholder),
  });
}

/**
 * 打开详情。返回一个 Promise，保存或关闭后 resolve。
 *
 * options:
 *   item      主卡那一项（item.key / item.price / item.defaultPrice / item.model / item.provider）
 *   save(priceOrNull)  真正落盘的函数，返回 Promise<boolean>
 *   onSaved() 落盘成功后通知主卡重画
 */
export function openPriceDetail({ item, save, onSaved }) {
  const user = item?.price || null;
  const def = item?.defaultPrice || null;

  // 每一块的输入节点都先建好，收集时直接从 DOM 读 —— 不留影子状态。
  const baseInputs = new Map();
  const perCallInput = numInput(user?.perCall, def?.perCall);
  const ctxRows = h("div", { className: "tts-pdetail__rows" });
  const timeRows = h("div", { className: "tts-pdetail__rows" });
  const note = h("p", { className: "tts-pdetail__note" });

  // ── 基础四价 ──
  const baseGrid = h("div", { className: "tts-pdetail__grid" });
  for (const spec of PRICE_FIELDS) {
    const input = numInput(user?.[spec.key], def?.[spec.key]);
    baseInputs.set(spec.key, input);
    baseGrid.append(h("label", { className: "tts-pdetail__field", title: spec.hint || "" },
      h("span", { className: "tts-pdetail__flabel" }, spec.label),
      input,
    ));
  }

  // ── 上下文分档 ──
  function addCtxRow(tier = {}) {
    const max = numInput(tier.maxContext, 272000);
    const fields = new Map();
    const cells = PRICE_FIELDS.map((spec) => {
      const input = numInput(tier[spec.key], "");
      fields.set(spec.key, input);
      return h("label", { className: "tts-pdetail__cell", title: spec.hint || "" },
        h("span", { className: "tts-pdetail__flabel" }, spec.label), input);
    });
    const row = h("div", { className: "tts-pdetail__row", "data-kind": "ctx" },
      h("label", { className: "tts-pdetail__cell tts-pdetail__cell--wide" },
        h("span", { className: "tts-pdetail__flabel" }, "单次上下文超过"),
        max,
      ),
      ...cells,
      h("button", {
        type: "button", className: "tts-pdetail__del", title: "删掉这一档",
        onClick: () => row.remove(),
      }, "×"),
    );
    row._read = () => {
      const maxContext = readNum(max);
      if (maxContext == null) return null;
      if (Number.isNaN(maxContext) || maxContext <= 0) return { bad: "分档门槛要填一个大于 0 的数" };
      const out = { maxContext };
      for (const spec of PRICE_FIELDS) {
        const n = readNum(fields.get(spec.key));
        if (Number.isNaN(n)) return { bad: `分档里的「${spec.label}」不是有效数字` };
        if (n != null) out[spec.key] = n;
      }
      return { tier: out };
    };
    ctxRows.append(row);
  }
  for (const tier of user?.contextTiers || []) addCtxRow(tier);

  // ── 分时定价 ──
  // 没有 from/to 的那一段是兜底：不属于任何时间窗的小时都走它。
  function addTimeRow(tier = {}) {
    // 自绘时间字段（ui/time-field.mjs）。没用原生 <input type="time">：
    // 那套滚轮是系统配色，深色卡片上会突然浮出一块白底控件。
    // mount 必须指向 dialog：showModal 之后 body 下其他节点都是 inert，
    // 挂 body 的弹层既点不动也会被遮罩盖住。用函数是为了避开构建顺序
    //（时段行先建，dlg 后建，只有打开那一刻才真的需要它）。
    const from = createTimeField({ value: tier.from || "", placeholder: "开始", ariaLabel: "开始时刻", mount: () => dlg });
    const to = createTimeField({ value: tier.to || "", placeholder: "结束", ariaLabel: "结束时刻", mount: () => dlg });
    const fields = new Map();
    const cells = PRICE_FIELDS.map((spec) => {
      const input = numInput(tier[spec.key], "");
      fields.set(spec.key, input);
      return h("label", { className: "tts-pdetail__cell", title: spec.hint || "" },
        h("span", { className: "tts-pdetail__flabel" }, spec.label), input);
    });
    const row = h("div", { className: "tts-pdetail__row", "data-kind": "time" },
      h("div", { className: "tts-pdetail__clockcell" },
        from,
        h("span", { className: "tts-pdetail__dash" }, "→"),
        to,
      ),
      ...cells,
      h("button", {
        type: "button", className: "tts-pdetail__del", title: "删掉这一段",
        onClick: () => { closeOpenTime(); row.remove(); },
      }, "×"),
    );
    row._read = () => {
      const f = String(from.value || "").trim();
      const t = String(to.value || "").trim();
      const out = {};
      if (f && t) { out.from = f; out.to = t; }
      else if (f || t) return { bad: "时段要起止都填，或者都不填（都不填就是兜底段）" };
      let has = false;
      for (const spec of PRICE_FIELDS) {
        const n = readNum(fields.get(spec.key));
        if (Number.isNaN(n)) return { bad: `时段里的「${spec.label}」不是有效数字` };
        if (n != null) { out[spec.key] = n; has = true; }
      }
      if (!has) return { bad: "这一段一个价都没填" };
      return { tier: out };
    };
    timeRows.append(row);
  }
  for (const tier of user?.timeTiers || []) addTimeRow(tier);

  // ── 收集 ──
  function collect() {
    const price = {};
    for (const spec of PRICE_FIELDS) {
      const n = readNum(baseInputs.get(spec.key));
      if (Number.isNaN(n)) return { bad: `基础单价里的「${spec.label}」不是有效数字` };
      if (n != null) price[spec.key] = n;
    }
    const pc = readNum(perCallInput);
    if (Number.isNaN(pc)) return { bad: "按次计价的数字不合法" };
    if (pc != null) price.perCall = pc;

    const contextTiers = [];
    for (const row of ctxRows.children) {
      const r = row._read();
      if (r.bad) return r;
      if (r.tier) contextTiers.push(r.tier);
    }
    if (contextTiers.length) price.contextTiers = contextTiers;

    const timeTiers = [];
    for (const row of timeRows.children) {
      const r = row._read();
      if (r.bad) return r;
      if (r.tier) timeTiers.push(r.tier);
    }
    if (timeTiers.length) price.timeTiers = timeTiers;

    return { price };
  }

  const dlg = h("dialog", { className: "tts-pdetail" },
    h("div", { className: "tts-pdetail__hd" },
      h("div", {},
        h("h2", { className: "tts-pdetail__title" }, item?.model || "模型价格"),
        h("p", { className: "tts-pdetail__key" }, item?.key || ""),
      ),
      h("button", {
        type: "button", className: "tts-pdetail__x", title: "关闭", "aria-label": "关闭",
        onClick: () => close(),
      }, "×"),
    ),
    h("div", { className: "tts-pdetail__body" },
      h("section", { className: "tts-pdetail__sec" },
        h("h3", { className: "tts-pdetail__h3" }, "基础单价"),
        h("p", { className: "tts-pdetail__hint" }, "人民币 / 每百万 token。留空表示沿用程序自带的价格。"),
        baseGrid,
      ),
      h("section", { className: "tts-pdetail__sec" },
        h("h3", { className: "tts-pdetail__h3" }, "按次计价"),
        h("p", { className: "tts-pdetail__hint" }, "每次调用额外收的钱，与 token 单价相加。按张/按请求计费的模型填这里。"),
        h("label", { className: "tts-pdetail__field tts-pdetail__field--short" },
          h("span", { className: "tts-pdetail__flabel" }, "元 / 次"),
          perCallInput,
        ),
      ),
      h("section", { className: "tts-pdetail__sec" },
        h("h3", { className: "tts-pdetail__h3" }, "长上下文分档"),
        h("p", { className: "tts-pdetail__hint" }, "单次请求的上下文超过门槛后，改用这一档的价格。没填的项沿用基础单价。"),
        ctxRows,
        h("button", {
          type: "button", className: "tt-btn ghost tts-pdetail__add",
          onClick: () => addCtxRow({}),
        }, "加一档"),
      ),
      h("section", { className: "tts-pdetail__sec" },
        h("h3", { className: "tts-pdetail__h3" }, "分时定价"),
        h("p", { className: "tts-pdetail__hint" },
          "按小时归属：左闭右开，起止都填 22:00→08:00 表示跨午夜。从上往下取第一个匹配的段；",
          "不填时段的那个是兜底段，管其余所有小时。"),
        timeRows,
        h("button", {
          type: "button", className: "tt-btn ghost tts-pdetail__add",
          onClick: () => addTimeRow({}),
        }, "加一段"),
      ),
      note,
    ),
    h("div", { className: "tts-pdetail__ft" },
      h("button", {
        type: "button", className: "tt-btn ghost",
        onClick: async () => {
          // 恢复默认 = 从价格文件里删掉这一项，连分时价一起。
          const ok = await save(null);
          if (ok) { onSaved?.(); close(); }
          else note.textContent = "恢复默认失败";
        },
      }, "恢复默认"),
      h("div", { className: "tts-pdetail__spacer" }),
      h("button", { type: "button", className: "tt-btn ghost", onClick: () => close() }, "取消"),
      h("button", {
        type: "button", className: "tt-btn primary",
        onClick: async () => {
          const r = collect();
          if (r.bad) { note.textContent = r.bad; note.dataset.kind = "err"; return; }
          if (!Object.keys(r.price).length) {
            note.textContent = "一个价都没填：要恢复默认请按左下角那个按钮";
            note.dataset.kind = "err";
            return;
          }
          note.textContent = "正在保存…";
          delete note.dataset.kind;
          const ok = await save(r.price);
          if (!ok) { note.textContent = "保存失败"; note.dataset.kind = "err"; return; }
          onSaved?.();
          close();
        },
      }, "保存"),
    ),
  );

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    // 弹层挂在 body 上，不跟着 dialog 一起消失，得自己收。
    closeOpenTime();
    const ms = exitMs(dlg);
    if (!ms) { dlg.close(); dlg.remove(); return; }
    dlg.classList.add("is-closing");
    setTimeout(() => { try { dlg.close(); } catch {} dlg.remove(); }, ms);
  }

  // 点背景关闭（和更新说明同一套：点面板内不会关）。
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });

  document.body.append(dlg);
  // 内容区一滚，触发区就跟着动了，而弹层是 fixed、不会跟 —— 直接关掉，
  // 总比让它停在错位的地方好。
  dlg.querySelector(".tts-pdetail__body")?.addEventListener("scroll", () => closeOpenTime(), { passive: true });
  dlg.showModal();
  // 初始焦点放在弹窗本身，避免浏览器把焦点丢到第一个输入框上直接弹出键盘。
  dlg.setAttribute("tabindex", "-1");
  try { dlg.focus(); } catch {}
  return dlg;
}
