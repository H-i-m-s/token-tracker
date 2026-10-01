// 自绘下拉（HanaSelect 风格，配色全部走 --tt-* 变量，随宿主与三态外观变化）。
//
// 关键契约：原生 <select> 原地保留、仅视觉隐藏。单选时它仍是唯一状态源；
// 多选（options.multiple）时它退为「选项清单」的来源，选中集合由调用方持有
// （getValues 读、onPick 写），因为一个 select.value 装不下多个值。
// 触发器只负责展示与交互，选中后写回 select.value 并派发原生 change 事件，
// 因此所有既有读取方式（querySelector(...).value / addEventListener("change") /
// onChange 回调）无需任何改动，行为与原生一致。
import { asList } from "./selection.mjs";

// 同一时刻只开一个下拉；换成日历弹层时也应各自持有自己的“当前打开者”。
let activeCloser = null;
// 面板已挂到 body（或正处于 130ms 淡出、等待摘除）的实例集合。
// 渲染入口在重建宿主容器前调用 closeOpenSelect()，把它们整批立即摘除，避免面板变孤儿。
const livePanels = new Set();

// 关闭当前所有打开（或等待摘除）的自绘下拉：立即移除面板并解绑 document/window 监听。
// 供会替换触发器宿主容器的渲染入口（renderDetails / renderBoardControls）在重建前调用。
export function closeOpenSelect() {
  for (const instance of [...livePanels]) instance.closeNow();
}

export function mountSelect(select, options = {}) {
  if (!select || select._ttSelect) return select;
  const doc = select.ownerDocument || document;
  const win = doc.defaultView || window;
  const showDelay = 130; // 与 CSS 淡出时长对齐，动画走完再摘除面板

  // 多选模式：选中集合由调用方持有（getValues 读、onPick 写），原生 select 只当选项清单用。
  const multiple = options.multiple === true;
  const valuesOf = () => (multiple
    ? (typeof options.getValues === "function" ? asList(options.getValues()) : [])
    : (select.value ? [select.value] : []));
  const isOn = (v) => valuesOf().includes(v);

  // 触发器：沿用原 className（例如明细筛选处的 "tt-pill"）以保持外观。
  const trigger = doc.createElement("div");
  trigger.className = [select.className, options.triggerClass, "tt-select"]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  trigger.setAttribute("role", "button");
  trigger.setAttribute("tabindex", "0");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const aria = select.getAttribute("aria-label");
  if (aria) trigger.setAttribute("aria-label", aria);
  const title = select.getAttribute("title");   // 完整选中清单挂在 title 上，触发器文案放不下时能悬停看全
  if (title) trigger.setAttribute("title", title);
  const labelEl = doc.createElement("span");
  labelEl.className = "tt-select-label";
  trigger.append(labelEl);

  // clearable：值非空时在同一个框里给一颗 ×（显示与清除同框，不再另占一格）。
  // 点击只清值、不开面板，所以拦下冒泡。
  const clearBtn = doc.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "tt-select-clear";
  clearBtn.textContent = "×";
  clearBtn.title = "清除";
  clearBtn.setAttribute("aria-label", `${aria || "筛选"}：清除`);
  clearBtn.hidden = true;
  clearBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (multiple) {
      if (!valuesOf().length) return;
      if (typeof options.onPick === "function") options.onPick("", event);
      renderLabel();
      return;
    }
    if (select.value === "") return;
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    renderLabel();
    close();
  });
  if (options.clearable) trigger.append(clearBtn);

  // 原生 select 退居幕后，但仍留在 DOM 里。
  select.setAttribute("data-tt-native-select", "");
  select.style.display = "none";
  select.setAttribute("tabindex", "-1");
  select.setAttribute("aria-hidden", "true");
  if (select.parentNode) select.parentNode.insertBefore(trigger, select.nextSibling);

  const panel = doc.createElement("div");
  panel.className = "tt-select-panel";
  panel.setAttribute("role", "listbox");
  if (multiple) panel.setAttribute("aria-multiselectable", "true");
  if (aria) panel.setAttribute("aria-label", aria);

  let open = false;
  let activeIndex = -1;

  const nodes = () => Array.from(select.options);
  // 选项纯文本：按 value 找原生 option 的 textContent，没有就空串。
  const plainLabel = (v) => {
    const hit = nodes().find((o) => o.value === v);
    return hit ? hit.textContent : "";
  };
  // 触发器文案：调用方给了 labelFor 就用它（可自行加「Agent：」这类前缀），否则退回纯文本。
  const composeLabel = (v) => (typeof options.labelFor === "function" ? options.labelFor(v, plainLabel(v)) : plainLabel(v));

  // 鼠标划过高亮由 setActive 写在选项上；指针离开面板后要收回去，
  // 否则最后划过的那项会一直亮着（和 hover 同一套底色，看起来就是“没收干净”）。
  function clearActive() {
    activeIndex = -1;
    for (const node of panel.children) node.classList.remove("active");
  }

  function renderLabel() {
    const vals = valuesOf();
    if (multiple) {
      labelEl.textContent = typeof options.labelForValues === "function"
        ? options.labelForValues(vals, plainLabel)
        : (vals.length ? vals.map(plainLabel).join("、") : composeLabel(""));
    } else {
      labelEl.textContent = composeLabel(select.value);
    }
    // 占位项（如“全部 Agent”）用弱化色，看起来更像触发器而不是已选中的值。
    const isEmpty = vals.length === 0;
    trigger.classList.toggle("empty", isEmpty);
    // 没值就没东西可清：× 只在选中了具体项时出现。
    if (options.clearable) clearBtn.hidden = isEmpty;
  }

  function buildOptions() {
    panel.replaceChildren(
      ...nodes().map((o, i) => {
        const opt = doc.createElement("div");
        opt.className = "tt-select-option";
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", String(multiple ? isOn(o.value) : o.value === select.value));
        opt.dataset.value = o.value;
        opt.textContent = o.textContent;
        opt.addEventListener("click", (e) => { e.stopPropagation(); pick(o.value, e); });
        opt.addEventListener("pointerenter", () => setActive(i, false));
        return opt;
      }),
    );
  }

  function setActive(i, scroll) {
    const list = Array.from(panel.children);
    if (!list.length) return;
    activeIndex = (i + list.length) % list.length;
    list.forEach((n, idx) => n.classList.toggle("active", idx === activeIndex));
    if (scroll) list[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function choose(value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    renderLabel();
    close();
  }

  // 多选：点一项加/减一项，面板保持打开（连着点几项不用反复展开），由调用方决定怎么合并。
  // 占位项（“全部 X”，value 为空串）在多选里表示全清，选完就收起来。
  function pick(value, event) {
    if (!multiple) return choose(value);
    if (typeof options.onPick === "function") options.onPick(value, event);
    if (value === "") { renderLabel(); close(); return; }
    buildOptions();
    renderLabel();
  }

  function openPanel() {
    if (open) return;
    if (activeCloser && activeCloser !== close) activeCloser();
    buildOptions();
    renderLabel();
    // 每次打开才挂到 body：重渲染时不会留下孤儿面板，fixed 定位也不会被 overflow 容器裁剪。
    doc.body.appendChild(panel);
    panel.addEventListener("pointerleave", clearActive);

    const r = trigger.getBoundingClientRect();
    const vh = win.innerHeight || doc.documentElement.clientHeight || 480;
    const vw = win.innerWidth || doc.documentElement.clientWidth || 320;
    const pad = 8;
    const gap = 4;

    panel.style.minWidth = Math.max(r.width, 120) + "px";
    panel.style.maxHeight = "240px";
    panel.style.left = Math.round(r.left) + "px";
    panel.style.top = Math.round(r.bottom + gap) + "px";
    panel.classList.remove("flip");

    open = true;
    const ph = panel.offsetHeight;
    if (r.bottom + gap + ph > vh - pad) {
      if (r.top - gap - ph >= pad) {
        panel.style.top = Math.round(r.top - gap - ph) + "px";
        panel.classList.add("flip");
      } else {
        panel.style.maxHeight = Math.max(96, vh - pad - r.bottom - gap) + "px";
      }
    }
    if (r.left + panel.offsetWidth > vw - pad) {
      panel.style.left = Math.max(pad, vw - panel.offsetWidth - pad) + "px";
    }

    panel.classList.add("open");
    trigger.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    const selected = multiple
      ? nodes().findIndex((o) => isOn(o.value))
      : nodes().findIndex((o) => o.value === select.value);
    setActive(selected >= 0 ? selected : 0, false);

    activeCloser = close;
    livePanels.add(instance);
    doc.addEventListener("pointerdown", onDocPointer, true);
    doc.addEventListener("keydown", onDocKey, true);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("resize", close, true);
  }

  function detach() {
    doc.removeEventListener("pointerdown", onDocPointer, true);
    doc.removeEventListener("keydown", onDocKey, true);
    win.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("resize", close, true);
  }

  let hideTimer = null;

  function clearHideTimer() {
    if (hideTimer != null) { win.clearTimeout(hideTimer); hideTimer = null; }
  }

  function close() {
    if (!open) return;
    open = false;
    panel.classList.remove("open");
    trigger.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    detach();
    clearActive();
    if (activeCloser === close) activeCloser = null;
    clearHideTimer();
    hideTimer = win.setTimeout(() => {
      hideTimer = null;
      if (!open) panel.remove();
      livePanels.delete(instance);
    }, showDelay);
  }

  // 立即摘除面板并解绑监听：跳过 130ms 淡出等待，供渲染入口在重建宿主容器前彻底清理。
  function closeNow() {
    if (open) {
      open = false;
      panel.classList.remove("open");
      trigger.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      detach();
    }
    clearActive();
    panel.removeEventListener("pointerleave", clearActive);
    if (activeCloser === close) activeCloser = null;
    clearHideTimer();
    panel.remove();
    livePanels.delete(instance);
  }

  function onDocPointer(e) {
    if (panel.contains(e.target) || trigger.contains(e.target)) return;
    close();
  }
  function onScroll(e) {
    if (panel.contains(e.target)) return;
    close();
  }
  function onDocKey(e) {
    if (e.key === "Escape" && open) { e.preventDefault(); close(); trigger.focus(); }
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) close(); else openPanel();
  });
  trigger.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "Enter": {
        e.preventDefault();
        if (!open) { openPanel(); break; }
        const target = panel.children[activeIndex];
        if (target) pick(target.dataset.value, e);
        break;
      }
      case " ": {
        e.preventDefault();
        if (!open) { openPanel(); break; }
        // 多选时空格也用来加/减一项（跟文件管理器里的习惯一致），不关面板
        if (multiple) {
          const target = panel.children[activeIndex];
          if (target) pick(target.dataset.value, e);
          break;
        }
        close();
        break;
      }
      case "ArrowDown":
        e.preventDefault();
        if (!open) openPanel(); else setActive(activeIndex + 1, true);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openPanel(); else setActive(activeIndex - 1, true);
        break;
      case "Home":
        if (open) { e.preventDefault(); setActive(0, true); }
        break;
      case "End":
        if (open) { e.preventDefault(); setActive(nodes().length - 1, true); }
        break;
      default:
        break;
    }
  });

  // 同一份 API 同时挂在原生 select 与触发器上：重建筛选条后，调用方拿得到触发器（它是新的那份），
  // 需要能直接把它重新打开（多选要连着点）。
  const instance = { trigger, panel, open: openPanel, close, closeNow, sync: renderLabel, refresh: renderLabel };
  trigger._ttSelect = instance;
  renderLabel();

  select._ttSelect = instance;
  return select;
}

// 在给定根下把所有尚未替换的原生 select 换成自绘下拉；幂等。
export function enhanceSelects(root = document) {
  const scope = root && typeof root.querySelectorAll === "function" ? root : document;
  scope.querySelectorAll("select:not([data-tt-native-select])").forEach((sel) => mountSelect(sel));
}
