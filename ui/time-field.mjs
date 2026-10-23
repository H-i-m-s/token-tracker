// 自绘时间字段 + 时分弹层。
//
// 为什么不用原生 <input type="time">：那套滚轮是系统配色，深色卡片上会突然浮出一块
// 白底控件，而且各家平台长得完全不一样 —— 在设置页里它就像一个外来组件。
// 这里跟自绘日期（ui/custom-date.mjs）同一套骨架：触发区 + 挂到 body 的弹层、
// 同一时刻只开一个、value 属性 get/set（"HH:MM"，空串 = 没填）。
// 外观直接复用 .tt-date-field / .tt-date-popup，只把图标换成钟表。

const pad2 = (n) => String(n).padStart(2, "0");

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h > 23 || mi > 59) return null;
  return { h, mi };
}

function normalize(value) {
  const t = parseTime(value);
  return t ? `${pad2(t.h)}:${pad2(t.mi)}` : "";
}

// 同一时刻只开一个弹层；设置页重建容器前会调 closeOpenTime() 把它们整批摘掉。
let activeCloser = null;
const livePopups = new Set();

export function closeOpenTime() {
  for (const instance of [...livePopups]) instance.closeNow();
}

export function createTimeField(options = {}) {
  const doc = options.document || document;
  const win = doc.defaultView || window;
  const placeholder = options.placeholder || "选择时刻";

  let current = normalize(options.value);
  let open = false;
  let hideTimer = null;

  const el = doc.createElement("div");
  el.className = "tt-date-field tt-time-field";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-haspopup", "dialog");
  if (options.ariaLabel) el.setAttribute("aria-label", options.ariaLabel);
  const labelEl = doc.createElement("span");
  labelEl.className = "tt-date-field-label";
  el.append(labelEl);

  const popup = doc.createElement("div");
  popup.className = "tt-date-popup tt-time-popup";
  popup.setAttribute("role", "dialog");
  if (options.ariaLabel) popup.setAttribute("aria-label", options.ariaLabel + "时间");

  const cols = doc.createElement("div");
  cols.className = "tt-time-cols";
  const hourCol = doc.createElement("div");
  hourCol.className = "tt-time-col";
  const minCol = doc.createElement("div");
  minCol.className = "tt-time-col";
  const hdHour = doc.createElement("span");
  hdHour.className = "tt-time-hd";
  hdHour.textContent = "时";
  const hdMin = doc.createElement("span");
  hdMin.className = "tt-time-hd";
  hdMin.textContent = "分";
  const hourWrap = doc.createElement("div");
  hourWrap.className = "tt-time-colwrap";
  hourWrap.append(hdHour, hourCol);
  const minWrap = doc.createElement("div");
  minWrap.className = "tt-time-colwrap";
  minWrap.append(hdMin, minCol);
  cols.append(hourWrap, minWrap);
  popup.append(cols);

  const hourBtns = [];
  const minBtns = [];

  function pickPart(h, mi) {
    current = `${pad2(h)}:${pad2(mi)}`;
    renderLabel();
    syncSelected();
  }

  function buildCols() {
    if (hourBtns.length) return;
    for (let h = 0; h < 24; h++) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "tt-time-item";
      b.textContent = pad2(h);
      b.dataset.h = String(h);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = parseTime(current) || { h: 0, mi: 0 };
        pickPart(h, cur.mi);
        if (typeof options.onChange === "function") options.onChange(current);
      });
      hourBtns.push(b);
      hourCol.append(b);
    }
    for (let mi = 0; mi < 60; mi++) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "tt-time-item";
      b.textContent = pad2(mi);
      b.dataset.m = String(mi);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = parseTime(current) || { h: 0, mi: 0 };
        pickPart(cur.h, mi);
        if (typeof options.onChange === "function") options.onChange(current);
        close();
      });
      minBtns.push(b);
      minCol.append(b);
    }
  }

  function syncSelected() {
    const cur = parseTime(current) || { h: 0, mi: 0 };
    for (const b of hourBtns) {
      const on = Number(b.dataset.h) === cur.h;
      b.classList.toggle("selected", on);
      if (on) b.setAttribute("aria-pressed", "true");
      else b.removeAttribute("aria-pressed");
    }
    for (const b of minBtns) {
      const on = Number(b.dataset.m) === cur.mi;
      b.classList.toggle("selected", on);
      if (on) b.setAttribute("aria-pressed", "true");
      else b.removeAttribute("aria-pressed");
    }
  }

  /** 把选中的那一项滚进视野（打开时用，免得每次都要自己找）。 */
  function revealSelected() {
    for (const [col, btns] of [[hourCol, hourBtns], [minCol, minBtns]]) {
      const sel = btns.find((b) => b.classList.contains("selected"));
      if (!sel || !col.clientHeight) continue;
      // 居中：减去半屏高，浏览器会自己夹到 0..scrollHeight 之间。
      col.scrollTop = Math.max(0, sel.offsetTop - col.clientHeight / 2 + sel.offsetHeight / 2);
    }
  }

  function renderLabel() {
    labelEl.textContent = current || placeholder;
    el.classList.toggle("empty", !current);
  }

  Object.defineProperty(el, "value", {
    configurable: true,
    enumerable: true,
    get() { return current; },
    set(value) {
      current = normalize(value);
      renderLabel();
      if (open) syncSelected();
    },
  });

  function detach() {
    doc.removeEventListener("pointerdown", onDocPointer, true);
    doc.removeEventListener("keydown", onDocKey, true);
    win.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("resize", close, true);
  }

  /**
   * 弹层挂到哪里。
   *
   * 默认挂 body，但**在模态 dialog 里必须挂进 dialog 本身**：
   * showModal() 会把 dialog 与 ::backdrop 提到浏览器的 top layer，
   * 此时 body 下其他节点全部 inert、并且被遮罩盖住 —— 挂 body 的弹层
   * 既点不动也看不见。options.mount 传函数是为了避开构建顺序：
   * 时段行先建、dialog 后建，只有到真正打开那一刻才需要这个节点。
   */
  function mountPoint() {
    const m = options.mount;
    const node = typeof m === "function" ? m() : m;
    return node || doc.body;
  }

  function openPopup() {
    if (open) return;
    if (activeCloser && activeCloser !== close) activeCloser();
    buildCols();
    syncSelected();
    mountPoint().appendChild(popup);

    const r = el.getBoundingClientRect();
    const vh = win.innerHeight || doc.documentElement.clientHeight || 480;
    const vw = win.innerWidth || doc.documentElement.clientWidth || 320;
    const pad = 8;
    const gap = 6;

    popup.style.left = Math.round(r.left) + "px";
    popup.style.top = Math.round(r.bottom + gap) + "px";
    popup.classList.remove("flip");

    open = true;
    const ph = popup.offsetHeight;
    const pw = popup.offsetWidth;
    if (r.bottom + gap + ph > vh - pad && r.top - gap - ph >= pad) {
      popup.style.top = Math.round(r.top - gap - ph) + "px";
      popup.classList.add("flip");
    }
    if (r.left + pw > vw - pad) {
      popup.style.left = Math.max(pad, vw - pw - pad) + "px";
    }

    popup.classList.add("open");
    el.classList.add("open");
    revealSelected();
    activeCloser = close;
    livePopups.add(instance);
    doc.addEventListener("pointerdown", onDocPointer, true);
    doc.addEventListener("keydown", onDocKey, true);
    win.addEventListener("scroll", onScroll, true);
    win.addEventListener("resize", close, true);
  }

  function clearHideTimer() {
    if (hideTimer != null) { win.clearTimeout(hideTimer); hideTimer = null; }
  }

  function close() {
    if (!open) return;
    open = false;
    popup.classList.remove("open");
    el.classList.remove("open");
    detach();
    if (activeCloser === close) activeCloser = null;
    clearHideTimer();
    hideTimer = win.setTimeout(() => {
      hideTimer = null;
      if (!open) popup.remove();
      livePopups.delete(instance);
    }, 130);
  }

  function closeNow() {
    if (open) {
      open = false;
      popup.classList.remove("open");
      el.classList.remove("open");
      detach();
    }
    if (activeCloser === close) activeCloser = null;
    clearHideTimer();
    popup.remove();
    livePopups.delete(instance);
  }

  function onDocPointer(e) {
    if (popup.contains(e.target) || el.contains(e.target)) return;
    close();
  }
  function onScroll(e) {
    if (popup.contains(e.target)) return;
    close();
  }
  function onDocKey(e) {
    if (e.key === "Escape" && open) { e.preventDefault(); close(); el.focus(); }
  }

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) close(); else openPopup();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) close(); else openPopup();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  });

  const instance = { closeNow };
  renderLabel();
  return el;
}
