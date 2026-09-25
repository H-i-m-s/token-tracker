// 自绘日期字段 + 日历弹层。完全不触发浏览器原生 input[type=date] 的日历弹层，
// 配色全部走 --tt-* 变量（深色 / 浅色 / 宿主三态都自然）。
//
// 关键契约：返回的元素带 value 属性（get/set，格式 YYYY-MM-DD，空串=未选），
// 语义与原生 <input type="date">.value 一致，故调用方读取与比较逻辑无需改动。

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

// 所有自绘日期弹层共享“同一时刻只开一个”。
let activeCloser = null;
// 弹层已挂到 body（或处于 130ms 淡出、等待摘除）的实例集合。
// 渲染入口在重建宿主容器前调用 closeOpenDate()，把它们整批立即摘除，避免弹层变孤儿。
const livePopups = new Set();

// 关闭当前所有打开（或等待摘除）的日期弹层：立即移除并解绑 document/window 监听。
export function closeOpenDate() {
  for (const instance of [...livePopups]) instance.closeNow();
}

const pad2 = (n) => String(n).padStart(2, "0");
const toISO = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());

function parseISO(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalize(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : toISO(value);
  const d = parseISO(value);
  return d ? toISO(d) : "";
}

export function createDateField(options = {}) {
  const doc = options.document || document;
  const win = doc.defaultView || window;
  const placeholder = options.placeholder || "选择日期";

  let current = normalize(options.value);
  let view = parseISO(current) || new Date();
  view = new Date(view.getFullYear(), view.getMonth(), 1);

  const el = doc.createElement("div");
  el.className = "tt-date-field";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-haspopup", "dialog");
  if (options.ariaLabel) el.setAttribute("aria-label", options.ariaLabel);
  const labelEl = doc.createElement("span");
  labelEl.className = "tt-date-field-label";
  el.append(labelEl);

  const popup = doc.createElement("div");
  popup.className = "tt-date-popup";
  popup.setAttribute("role", "dialog");
  if (options.ariaLabel) popup.setAttribute("aria-label", options.ariaLabel + "日历");

  const head = doc.createElement("div");
  head.className = "tt-date-popup-hd";
  const prev = doc.createElement("button");
  prev.type = "button";
  prev.className = "tt-date-nav";
  prev.setAttribute("aria-label", "上个月");
  prev.textContent = "\u2039";
  const next = doc.createElement("button");
  next.type = "button";
  next.className = "tt-date-nav";
  next.setAttribute("aria-label", "下个月");
  next.textContent = "\u203a";
  const monthLabel = doc.createElement("span");
  monthLabel.className = "tt-date-month";
  head.append(prev, monthLabel, next);

  const grid = doc.createElement("div");
  grid.className = "tt-date-grid";
  popup.append(head, grid);

  let open = false;

  Object.defineProperty(el, "value", {
    configurable: true,
    enumerable: true,
    get() { return current; },
    set(value) {
      current = normalize(value);
      const d = parseISO(current);
      if (d) view = new Date(d.getFullYear(), d.getMonth(), 1);
      renderLabel();
      if (open) renderCalendar();
    },
  });

  function renderLabel() {
    labelEl.textContent = current || placeholder;
    el.classList.toggle("empty", !current);
  }

  function renderCalendar() {
    monthLabel.textContent = view.getFullYear() + "年" + (view.getMonth() + 1) + "月";
    const today = toISO(new Date());
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7; // 以周一为一周起点
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(new Date(view.getFullYear(), view.getMonth(), d));
    while (cells.length % 7 !== 0) cells.push(null);

    const weekdayRow = WEEKDAYS.map((w) => {
      const span = doc.createElement("span");
      span.className = "tt-date-weekday";
      span.textContent = w;
      return span;
    });

    const dayNodes = cells.map((d) => {
      if (!d) {
        const blank = doc.createElement("span");
        blank.className = "tt-date-day blank";
        return blank;
      }
      const iso = toISO(d);
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "tt-date-day";
      btn.dataset.date = iso;
      btn.textContent = String(d.getDate());
      btn.setAttribute("aria-label", iso);
      if (iso === current) {
        btn.classList.add("selected");
        btn.setAttribute("aria-pressed", "true");
      } else if (iso === today) {
        btn.classList.add("today");
        btn.setAttribute("aria-current", "date");
      }
      btn.addEventListener("click", (e) => { e.stopPropagation(); pick(iso); });
      return btn;
    });

    grid.replaceChildren(...weekdayRow, ...dayNodes);
  }

  function pick(iso) {
    current = iso;
    renderLabel();
    if (open) renderCalendar();
    if (typeof options.onChange === "function") options.onChange(current);
    close();
  }

  function openCalendar() {
    if (open) return;
    if (activeCloser && activeCloser !== close) activeCloser();
    renderCalendar();
    // 每次打开才挂到 body：重渲染不会留下孤儿弹层，fixed 定位也不被 overflow 容器裁剪。
    doc.body.appendChild(popup);

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
    activeCloser = close;
    livePopups.add(instance);
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

  // 立即摘除弹层并解绑监听：跳过 130ms 淡出等待，供渲染入口在重建宿主容器前彻底清理。
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
    if (open) close(); else openCalendar();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) close(); else openCalendar();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  });
  prev.addEventListener("click", (e) => {
    e.stopPropagation();
    view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
    renderCalendar();
  });
  next.addEventListener("click", (e) => {
    e.stopPropagation();
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    renderCalendar();
  });

  const instance = { closeNow };
  renderLabel();
  el._ttDateField = { popup, open: openCalendar, close, closeNow, label: labelEl };
  return el;
}
