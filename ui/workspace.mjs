import { applyAppearance } from "./appearance.mjs";
import { applyBoardLayout } from "./board-layout.mjs";
import { renderAnalytics } from "./analytics.mjs";
import { createFilterStatus } from "./filter-chips.mjs";
import { asList, selectionKey } from "./selection.mjs";
import { saveDetailsCSV } from "./csv-export.mjs";
import { bootstrap } from "./bootstrap.mjs";
import { VALID_VIEWS } from "./app-state.mjs";
import { AppApi } from "./app-api.mjs";
import { h, RANGES, fmt, formatDateTime, renderPills, selectOptions, timeAgo } from "./components.mjs";
import { enhanceSelects, closeOpenSelect } from "./custom-select.mjs";
import { DETAIL_SORTS, DETAIL_THRESHOLDS, viewRows, sumTokens, pageSlice, hitRate, decodeRows } from "./details-view.mjs";
import { createDateField, closeOpenDate } from "./custom-date.mjs";
import { drawSparkline, drawRing, drawUsageChart, fmtTokensShort } from "./charts.mjs";

const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 5000;
// 四块视图的先后顺序：切页签时用它判断方向（往右的页签 = 内容往左滑）。
const VIEW_ORDER = ["overview", "balance", "details", "realtime"];

// 「点得开」抽屉里的小组件（模块级：不依赖实例状态）
const turnFact = (label, value) => h("span", { className: "tt-turn-fact" }, h("em", {}, label), value);
// 只取时分秒：同一轮的调用都在同一天里
function clockOf(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 行数/次数这类「数了多少个」的整数：要精确可读（17,393），不能像 token 那样缩写成 17.4k。
function fmtInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "—";
}
// 文件大小：MB 以上才像会话文件该有的量级（70.6 MB 这种数要看得见）
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1048576) return (v / 1048576).toFixed(1) + " MB";
  if (v >= 1024) return (v / 1024).toFixed(0) + " KB";
  return v + " B";
}
// 当前选中的字符数（拿不到就当 0）。只用来比较「这一次手势有没有选出新文字」。
function selectedLength() {
  try { return typeof window.getSelection === "function" ? String(window.getSelection() || "").length : 0; } catch { return 0; }
}
// 距上一条消息的间隔。含排队与工具往返，只是间隔，不是生成耗时，所以不叫「耗时」。
function gapText(ms) {
  const s = Number(ms) / 1000;
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + Math.round(s - m * 60) + "s";
  return (s / 3600).toFixed(1) + "h";
}
const MAX_SPARK_POINTS = 40;

// 选项里的占位文案曾被当成真实筛选值存进 state（见 components.mjs selectOptions 的注释）。
// 这种值只能来自那个 bug，不可能是真实的 agent / 模型 / 供应商 id，见到即清。
const PLACEHOLDER_VALUES = new Set(["全部 Agent", "全部模型", "全部 Provider", "全部类型"]);

// 名册按显示名排序，且中文按拼音排；只比 id 的话中文名会全部排到英文后面去。
function byLabel(a, b) {
  return String(a.label || a).localeCompare(String(b.label || b), "zh-Hans-CN");
}

// 账单图的窗口起止：写到分钟，跟着图的粒度走。
function dsClock(ts) {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class WorkspaceApp {
  constructor({ hana, api, state, container, mock = false }) {
    this.hana = hana;
    this.api = api;
    this.state = state;
    this.container = container;
    this.mock = mock;

    this.dsSeq = 0;
    this.snapshot = null;
    this.dashboard = null;
    this.balances = [];
    this.dsUsage = null;
    this.sparkHistory = [];
    this.loading = 0;
    this.foregroundLoads = 0;
    this.busyTimer = null;
    this.busyVisible = false;
    this.error = "";
    this.notReady = false;
    this.dashboardRequest = 0;
    this.detailsRequest = 0;   // 单独的计数器：翻页只动明细，不能让先发出的整份请求把它盖回去
    this.disposed = false;
    this.visible = true;
    this.eventController = null;
    this.filterKey = "";
    // 顶部那排控件（范围 pills / 日期 / 显示设置）与筛选条各自记住“上一次画成什么样”。
    // 切页签也会走 onStateChange，若无条件重建，点一次页签就把这两块换一遍 —— 页签切换的“闪”就出在这里。
    this.chromeKey = "";
    this.detailsPage = 1;
    // 明细的“看”法：默认跟后端一样的时间倒序；考古时改成按用量倒序 + 设门槛。
    this.detailsSort = "time";
    this.detailsMin = 0;
    this.agentNames = new Map();
    // 「点得开」：展开的那几行按 key（sessionKey#seq）记着；面板数据按同一把 key 缓存。
    this.turnOpen = new Set();
    this.turnDetail = new Map();

    this.pollTimer = null;
    this.disposers = [];
    // 横向滑动的收尾状态：出场那块与兼底定时器。
    this.slidingOut = null;
    this.slideTimer = null;
    // 体检（只读）：切到体检那一页才取一次；载荷分解要重算一遍看板，所以再单独点一次才量。
    this.diagData = null;
    this.diagError = "";
    this.diagLoading = false;
  }

  async init() {
    this.renderShell();
    const initial = this.state.get();
    this.filterKey = JSON.stringify([initial.range, initial.from, initial.to, selectionKey(initial.agent), selectionKey(initial.model), selectionKey(initial.provider), selectionKey(initial.type)]);
    this.disposers.push(
      this.state.subscribe((s) => this.onStateChange(s)),
      this.subscribeLifecycle(),
    );
    await this.initialLoad();
    this.startPolling();
  }

  dispose() {
    this.disposed = true;
    this.stopPolling();
    this.clearBusyTimer();
    this.settleSlide();
    for (const d of this.disposers) {
      try { d(); } catch {}
    }
    this.disposers = [];
    this.state.dispose();
  }

  // ---------- lifecycle ----------

  subscribeLifecycle() {
    if (!this.hana.lifecycle?.subscribe) return () => {};
    let hiddenAt = 0;
    const off = this.hana.lifecycle.subscribe((life) => {
      if (life?.state === "hidden" || life?.visible === false) {
        hiddenAt = Date.now();
        this.visible = false;
        this.stopPolling();
      } else if (hiddenAt > 0) {
        this.visible = true;
        this.loadAll();
        this.startPolling();
        hiddenAt = 0;
      }
    });
    return off || (() => {});
  }

  startPolling() {
    this.stopPolling();
    if (!this.visible || this.disposed || !this.state.get().autoRefresh) return;
    if (!this.mock && this.api.watchEvents) {
      this.eventController = new AbortController();
      this.api.watchEvents({ signal: this.eventController.signal, onEvent: (event) => {
        if (event.type === "update" && !this.loading && !this.disposed && this.visible) this.loadSnapshot(false, { silent: true });
      } }).catch(() => { /* periodic snapshot remains the reconnect fallback */ });
    }
    this.pollTimer = setInterval(async () => {
      if (this.loading || this.disposed) return;
      await this.loadSnapshot(false, { silent: true });
      if (Date.now() - (this.balanceFetchedAt || 0) > 60000) await this.loadBalances(true, { silent: true });
      if (this.snapshot?.updatedAt !== this.lastDashboardScan) {
        this.lastDashboardScan = this.snapshot?.updatedAt;
        await this.loadDashboard(true, { silent: true });
      }
    }, POLL_INTERVAL_MS);
  }

  stopPolling() {
    this.eventController?.abort();
    this.eventController = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------- loading / error ----------

  setLoading(delta, { silent = false } = {}) {
    this.loading = Math.max(0, this.loading + delta);
    if (!silent) this.foregroundLoads = Math.max(0, this.foregroundLoads + delta);
    this.syncStatus();
  }

  // Background refreshes stay invisible. A foreground load only speaks up once
  // the request has had time to answer, so an instant reply never flashes.
  syncStatus() {
    if (!this.statusEl) return;
    const busy = !this.error && this.foregroundLoads > 0;
    if (!busy) {
      this.clearBusyTimer();
      this.busyVisible = false;
      this.statusEl.className = this.error ? "tt-status-bar error" : "tt-status-bar";
      this.statusEl.textContent = this.error || "";
      return;
    }
    if (this.busyVisible || this.busyTimer) return;
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      if (this.foregroundLoads > 0 && !this.error) {
        this.busyVisible = true;
        this.statusEl.className = "tt-status-bar loading";
        this.statusEl.textContent = "加载中…";
      }
    }, 400);
  }

  clearBusyTimer() {
    if (this.busyTimer) {
      clearTimeout(this.busyTimer);
      this.busyTimer = null;
    }
  }

  setError(msg) {
    this.error = msg || "";
    this.syncStatus();
  }

  clearError() {
    this.setError("");
  }

  // ---------- shell ----------

  renderShell() {
    this.container.innerHTML = "";
    this.container.className = "tt-app tt-dashboard-app";
    this.statusEl = h("div", { className: "tt-status-bar" });

    const refreshBtn = h("button", { className: "tt-btn ghost tt-icon-btn", title: "刷新", "aria-label": "刷新", onClick: () => this.onRefresh() }, "↻");
    this.boardControls = h("div", { className: "tt-board-controls" });
    this.appearanceControls = h("div", { className: "tt-appearance-controls" });
    const chrome = h("header", { className: "tt-chrome" },
      h("div", { className: "tt-board-heading" }, h("h1", {}, "Token 消耗看板"), h("p", {}, "本地日志汇总 · Agent 归属 · 会话轮次口径")),
      this.boardControls,
    );
    // 上次停在哪个界面，这次就回到哪个界面（跨实例记住，存在固定 key 里）
    const rememberedView = this.state.get().view;
    this.view = VALID_VIEWS.includes(rememberedView) ? rememberedView : "overview";
    this.viewTabs = h("div", { className: "tt-view-tabs", role: "tablist", "aria-label": "用量视图" },
      ...[["overview", "数据大屏"], ["balance", "余额与额度"], ["details", "消费明细"], ["realtime", "实时监控"]].map(([key,label]) =>
        h("button", { type: "button", role: "tab", id: `tab-${key}`, "data-view": key, "aria-controls": `${key}-module`, "aria-selected": String(key === this.view), onClick: () => this.selectView(key) }, label)),
    );
    this.viewTabs.addEventListener("keydown", event => {
      const tabs = [...this.viewTabs.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(document.activeElement);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      this.selectView(tabs[next].dataset.view); tabs[next].focus();
    });
    const nav = h("div", { className: "tt-board-nav" }, this.viewTabs,
      h("div", { className: "tt-toolbar" }, refreshBtn, this.appearanceControls));
    this.mainEl = h("main", { className: "tt-main", "data-view": this.view });
    // 筛选条只建一次（createFilterStatus 返回 root + update），之后一律原地更新：
    // 顶部那排状态因此不会在每次筛选/每次看板重画时被整条换掉，下拉也不会被连带关掉。
    this.filterChips = createFilterStatus({ state: this.state.get(), onPatch: (patchObj) => this.state.patch(patchObj) });
    this.filterStatus = this.filterChips.root;
    this.container.append(chrome, nav, this.filterStatus, this.statusEl, this.mainEl);
    this.renderBoardControls();
    for (const id of ["overview", "balance", "details", "realtime"]) this.mainEl.append(h("section", { id: `${id}-module`, className: "tt-module", role: "tabpanel", "aria-labelledby": `tab-${id}` }));
    this.selectView(this.view);
  }

  selectView(view, { persist = true, animate = true } = {}) {
    if (!VALID_VIEWS.includes(view)) view = "overview";
    const from = this.view;
    const changed = view !== from;
    // 上一次滑动没收尾就又被点了一下：先把残留的出场块收干净，别留下半路冻住的视图。
    this.settleSlide();
    const outgoing = changed ? this.mainEl.querySelector(`#${from}-module`) : null;
    const forward = VIEW_ORDER.indexOf(view) > VIEW_ORDER.indexOf(from);
    const willSlide = animate && changed && !!outgoing && !this.prefersReducedMotion();
    this.view = view;
    this.mainEl.dataset.view = view;
    // 要滑动时出场那块得留可见：它要跟着一起平移出去，动画结束再藏（见 settleSlide）。
    for (const section of this.mainEl.children) {
      section.hidden = section.id !== `${view}-module` && !(willSlide && section === outgoing);
    }
    for (const tab of this.viewTabs.children) {
      tab.setAttribute("aria-selected", String(tab.dataset.view === view));
      tab.tabIndex = tab.dataset.view === view ? 0 : -1;
    }
    if (willSlide) this.slideView(outgoing, forward);
    // 体检挂在实时监控页底部（不占页签位）：只有真的切到这一页才去取一次。
    if (view === "realtime") {
      if (!this.diagData && !this.diagLoading) this.loadDiagnostics();
      else this.renderDiagnostics();
    }
    // 只有用户自己切的才回写；否则 onStateChange 同步过来的会再写一次，绕成环
    if (persist && this.state.get().view !== view) this.state.patch({ view });
  }

  prefersReducedMotion() {
    try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch { return false; }
  }

  // 四块视图横向滑动。入场那块留在文档流里（它决定容器新的内容高度、滚动回到顶部），
  // 出场那块临时绝对定位、用像素把现在的视觉位置钉死，于是两块能并排同时平移。
  slideView(outgoing, forward) {
    const main = this.mainEl;
    const incoming = main.querySelector(`#${this.view}-module`);
    const mainRect = main.getBoundingClientRect();
    const r = outgoing.getBoundingClientRect();
    // 按“视觉位置”钉（top 不含 scrollTop），紧跟着把滚动归零，它就不会跳。
    outgoing.style.left = `${Math.round(r.left - mainRect.left)}px`;
    outgoing.style.top = `${Math.round(r.top - mainRect.top)}px`;
    outgoing.style.width = `${Math.round(r.width)}px`;
    outgoing.style.height = `${Math.round(r.height)}px`;
    outgoing.classList.add("tt-leaving", forward ? "tt-slide-out-next" : "tt-slide-out-prev");
    main.scrollTop = 0;
    main.classList.add("tt-sliding");
    incoming?.classList.remove("tt-slide-in-next", "tt-slide-in-prev");
    void incoming?.offsetWidth; // 强制回流：animation 不会因为 hidden 切换自己重跑
    incoming?.classList.add(forward ? "tt-slide-in-next" : "tt-slide-in-prev");
    this.slidingOut = outgoing;
    clearTimeout(this.slideTimer);
    // animationend 在无头/后台标签页里可能不来，定时器兼底（略长于 160ms）。
    this.slideTimer = setTimeout(() => this.settleSlide(), 300);
    incoming?.addEventListener("animationend", () => this.settleSlide(), { once: true });
  }

  settleSlide() {
    clearTimeout(this.slideTimer);
    this.slideTimer = null;
    const outgoing = this.slidingOut;
    this.slidingOut = null;
    if (outgoing) {
      outgoing.classList.remove("tt-leaving", "tt-slide-out-next", "tt-slide-out-prev");
      outgoing.style.left = outgoing.style.top = outgoing.style.width = outgoing.style.height = "";
      // 连点页签时它可能已经不是当前视图了；是的话就别藏。
      if (outgoing.id !== `${this.view}-module`) outgoing.hidden = true;
    }
    const incoming = this.mainEl?.querySelector(`#${this.view}-module`);
    incoming?.classList.remove("tt-slide-in-next", "tt-slide-in-prev");
    this.mainEl?.classList.remove("tt-sliding");
  }

  // ---------- data loading ----------

  async loadAll(force = false, { silent = false } = {}) {
    this.clearError();
    this.notReady = false;
    await Promise.all([
      this.loadSnapshot(force, { silent }),
      this.loadDashboard(force, { silent }),
      this.loadBalances(force, { silent }),
      this.loadDsUsage(force, { silent }),
    ]);
  }

  // 首屏加载。runtime 的 HTTP 服务故意比数据扫描先就绪（免得大历史被当成启动失败），
  // 于是打开瞬间的第一波请求经常撞上“数据扫描中”。干等 5 秒轮询周期太久，这里用短间隔顶上去。
  async initialLoad() {
    for (let attempt = 0; attempt < 60; attempt++) {
      await this.loadAll(false, { silent: attempt > 0 });
      if (!this.notReady) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async loadSnapshot(force = false, { silent = false } = {}) {
    this.setLoading(1, { silent });
    try {
      this.snapshot = await this.api.getSnapshot({ mock: this.mock });
      // 扫描未完成时后端会回 ready:false（不算错误），记下来让 initialLoad 继续重试
      if (this.snapshot && this.snapshot.ready === false) this.notReady = true;
      if (this.snapshot?.realtime) {
        this.sparkHistory.push(Number(this.snapshot.realtime.tps) || 0);
        if (this.sparkHistory.length > MAX_SPARK_POINTS) this.sparkHistory.shift();
      }
      this.renderRealtime();
    } catch (err) {
      if (err?.code === "NOT_READY") this.notReady = true;
      else this.setError(`实时数据加载失败：${err.message}`);
    } finally {
      this.setLoading(-1, { silent });
    }
  }

  async loadDashboard(force = false, { silent = false } = {}) {
    if (!force && this.dashboard) return;
    this.setLoading(1, { silent });
    const request = ++this.dashboardRequest;
    this.detailsRequest++;   // 作废还在路上的「只取明细」请求：它带回的可能是旧页旧排序
    try {
      // 明细已服务端分页：页码/排序/门槛跟着一起发；后台静默刷新用当前页，别把读者送回第一页。
      const filters = {
        ...this.state.get(),
        page: this.detailsPage, pageSize: PAGE_SIZE,
        sortKey: this.detailsSort, order: "desc", minTokens: this.detailsMin,
      };
      const dashboard = await this.api.getDashboard(filters, { mock: this.mock });
      if (request !== this.dashboardRequest || this.disposed) return;
      // 行是数组编码来的，在这一层解回对象；下面所有渲染都按对象行读。
      this.dashboard = decodeRows(dashboard);
      // Agent 名单以宿主名册为准（dashboard.agentNames 由后端的 agent:list 覆盖），
      // 账本里有用量但名册里已经没有的（被删掉的 agent）只补名字，不能作为唯一来源。
      for (const [id, name] of Object.entries(dashboard.agentNames || {})) this.agentNames.set(id, name || id);
      for (const agent of dashboard.agents || []) this.agentNames.set(agent.id, agent.name || agent.id);
      this.renderFilterStatus();
      // A background refresh must not send the reader back to page one.
      if (!silent) this.detailsPage = 1;
      this.renderOverview({ preserveScroll: silent });
      this.renderDetails({ preserveScroll: silent });
    } catch (err) {
      if (request === this.dashboardRequest && !this.disposed) {
        if (err?.code === "NOT_READY") this.notReady = true;
        else this.setError(`明细加载失败：${err.message}`);
      }
    } finally {
      this.setLoading(-1, { silent });
    }
  }

  // 只看明细这一块。翻个页/换个排序/换个门槛只会动明细，没必要把整份看板（全历史时 329 KB，
  // 其中 analytics.heatmap 占 72%）重取一遍，更不该让引擎把图的数据重算、让前端把概览重画。
  // 拿不到这一块（旧引擎、路由没就绪、网络抖）就退回整份看板，行为与以前完全一致。
  async loadDetails({ silent = true } = {}) {
    if (this.mock || typeof this.api.getDetails !== "function") { await this.loadDashboard(true, { silent }); return; }
    const request = ++this.detailsRequest;
    if (!silent) this.setLoading(1);
    try {
      const filters = {
        ...this.state.get(),
        page: this.detailsPage, pageSize: PAGE_SIZE,
        sortKey: this.detailsSort, order: "desc", minTokens: this.detailsMin,
      };
      const part = await this.api.getDetails(filters, { mock: this.mock });
      if (request !== this.detailsRequest || this.disposed) return;
      // 连整份看板都还没拿到（刚打开、后端刚重启）：退回整份，别把明细留在半路上。
      if (!this.dashboard || !part?.details) { await this.loadDashboard(true, { silent }); return; }
      // 行仍是数组编码，交给 renderDetails 里的 decodeRows 解一次（与整份那条路完全一样）。
      this.dashboard.details = part.details;
      if (part.summary) this.dashboard.summary = { ...this.dashboard.summary, ...part.summary };
      this.renderDetails({ preserveScroll: true });
    } catch {
      if (request !== this.detailsRequest || this.disposed) return;
      // 单独取这一块失败不该让明细卡在半路：退回整份（那条路本来就有完整的错误处理）。
      await this.loadDashboard(true, { silent });
    } finally {
      if (!silent) this.setLoading(-1);
    }
  }

  async loadBalances(force = false, { silent = false } = {}) {
    if (!force && this.balances.length) return;
    this.setLoading(1, { silent });
    try {
      this.balances = await this.api.getBalances({ mock: this.mock });
      this.balanceFetchedAt = Date.now();
      this.renderBalance();
    } catch (err) {
      if (err?.code === "NOT_READY") this.notReady = true;
      else this.setError(`余额加载失败：${err.message}`);
    } finally {
      this.setLoading(-1, { silent });
    }
  }

  // 账单图的时间窗直接跟着顶部那排范围走，不另设一套选择器。
  // today → 今天（逐小时）；last3/7/30 → 近 N 天；自定义日期 → 用选定起止。
  dsWindowFromState(state = this.state.get()) {
    const day = 86400;
    const todayStart = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
    switch (state.range) {
      case "today": return { from: todayStart, to: todayStart + day };
      case "last3": return { from: todayStart - 2 * day, to: todayStart + day };
      case "last7": return { from: todayStart - 6 * day, to: todayStart + day };
      case "last30": return { from: todayStart - 29 * day, to: todayStart + day };
      case "week": return { from: todayStart - 6 * day, to: todayStart + day };
      case "month": return { from: todayStart - 29 * day, to: todayStart + day };
      default: {
        if (state.from && state.to) {
          const f = Math.floor(new Date(state.from + "T00:00:00").getTime() / 1000);
          const t = Math.floor(new Date(state.to + "T00:00:00").getTime() / 1000) + day;
          if (Number.isFinite(f) && Number.isFinite(t) && t > f) return { from: f, to: t };
        }
        // 「全部历史」：不设下限（from=0），由后端交出库里最早到现在的整段。
        // 这里曾经默认成 30 天，于是选了“全部历史”却只看得到一个月。
        return { from: 0, to: todayStart + day };
      }
    }
  }

  async loadDsUsage(force = false, { silent = false, window: win = null } = {}) {
    const w = win || this.dsWindowFromState();
    const key = `${w.from}:${w.to}`;
    // 短窗口（≤ 3 天）每次重新取，别让缓存挡住“你看的这一刻”；长窗口给 2 分钟。
    const ttl = (w.to - w.from) <= 3 * 86400 ? 0 : 120000;
    if (!force && this.dsUsage && this.dsKey === key && Date.now() - (this.dsFetchedAt || 0) < ttl) return;
    // 连续切范围时几个请求会同时飞出去，回来顺序不定；只认最后一次，旧响应直接丢。
    const seq = ++this.dsSeq;
    this.setLoading(1, { silent });
    try {
      const res = await this.api.getDsUsage({ from: w.from, to: w.to, force, mock: this.mock });
      if (seq !== this.dsSeq) return;
      this.dsUsage = res;
      this.dsFetchedAt = Date.now();
      this.dsKey = key;
      this.dsError = "";
      this.renderBalance();
    } catch (err) {
      if (seq !== this.dsSeq) return;
      if (err?.code === "NOT_READY") {
        // 扫描还没完成，别把“稍后再来”当成取数失败落到面板上
        this.notReady = true;
      } else {
        this.dsUsage = this.dsUsage || null;
        this.dsError = err.message || "官网用量加载失败";
        this.renderBalance();
      }
    } finally {
      this.setLoading(-1, { silent });
    }
  }

  // 图表要的序列：服务端已经算好每一点的 tokens / hitRate，这里只挑出所需的几个字段。
  // 粒度（天/小时）原样从后端透传，不自己猜。
  dsSeries() {
    const range = this.dsUsage?.range || null;
    const points = (range?.points || []).map((p) => ({ t: p.t, tokens: Number(p.tokens) || 0, hitRate: p.hitRate == null ? null : p.hitRate }));
    // 窗口行展示“实际有数据的范围”，而不是请求范围：
    // “全部历史”的请求 from 是 0（无下限），直接格式化会变成 1970 年。
    return {
      points,
      bucket: range?.bucket || 86400,
      live: !!range?.live,
      totals: range?.totals || null,
      history: this.dsUsage?.history || null,
      rangeFrom: points.length ? points[0].t : (range?.from ?? null),
      rangeTo: points.length ? points[points.length - 1].t : (range?.to ?? null),
      requestedFrom: range?.from ?? null,
      requestedTo: range?.to ?? null,
    };
  }

  async onRefresh() {
    this.setLoading(1);
    try {
      await this.api.refresh({ force: true, mock: this.mock });
      await this.loadAll(true);
    } catch (err) {
      this.setError(`刷新失败：${err.message}`);
    } finally {
      this.setLoading(-1);
    }
  }

  onStateChange(state) {
    // 只在真的变了才重建顶部那排控件：范围、日期、主题。切页签会带着同一个值进来，这时什么都不必重建。
    const chromeKey = JSON.stringify([state.range, state.from, state.to, state.appearance]);
    if (chromeKey !== this.chromeKey) {
      this.chromeKey = chromeKey;
      this.renderBoardControls();
    }
    this.startPolling();
    applyBoardLayout(this.container, state);
    // 界面选择可能来自别处（比如另一张卡改了共享偏好）：跟着切，但不再回写。
    if (state.view && state.view !== this.view) this.selectView(state.view, { persist: false });
    // 顶部范围变了，账单图也跟着换时间窗
    const w = this.dsWindowFromState(state);
    if (`${w.from}:${w.to}` !== this.dsKey) this.loadDsUsage(false, { silent: true, window: w });
    const key = JSON.stringify([state.range, state.from, state.to, selectionKey(state.agent), selectionKey(state.model), selectionKey(state.provider), selectionKey(state.type)]);
    if (key === this.filterKey) return;
    this.filterKey = key;
    this.detailsPage = 1;
    this.clearError();
    // 这里不再先把看板置空、用空数据画一遍：那正是“整个界面消失再出现”里“消失”的那一下
    // （取数期间会露出一段“正在读取用量统计…”的空白）。旧内容留着，等 loadDashboard 取回新数据一次画成。
    this.renderFilterStatus();
    this.loadDashboard(true);
  }

  // ---------- overview module ----------

  renderBoardControls() {
    // 本函数会重建 .tt-board-controls，其中的日期字段随之被替换：先摘掉它自己的浮层。
    // 只关这一块里的：筛选条那三颗下拉不在里面，不该被牵连关掉。
    closeOpenSelect(this.boardControls);
    closeOpenDate();
    if (!this.boardControls) return;
    const state = this.state.get();
    const appearance = applyAppearance(state.appearance);
    const isDark = appearance === "dark" || (appearance === "system" && document.documentElement.classList.contains("hana-dark"));
    const settings = h("details", { className: "tt-display-settings" }, h("summary", { title: "显示设置" }, "显示设置"),
      h("div", { className: "tt-display-menu", role: "group", "aria-label": "看板主题" },
        ...[["dark", "深黑"], ["light", "浅色"], ["system", "Hana 原生"]].map(([key,label]) =>
          h("button", { type: "button", "aria-pressed": String(appearance === key), onClick: () => this.state.patch({ appearance: key }) }, label))));
    this.appearanceControls?.replaceChildren(
      h("button", { type: "button", className: "tt-theme-toggle", "aria-label": isDark ? "切换浅色主题" : "切换深黑主题", onClick: () => this.state.patch({ appearance: isDark ? "light" : "dark" }) }, isDark ? "浅色" : "深黑"), settings);
    // 自绘日期字段：返回元素带 .value（YYYY-MM-DD，空串=未选），取值语义与原生日期输入一致。
    const from = createDateField({ value: state.from, ariaLabel: "开始日期" });
    const to = createDateField({ value: state.to, ariaLabel: "结束日期" });
    const apply = h("button", { className: "tt-pill", onClick: () => {
      if (!from.value || !to.value || from.value > to.value) { this.setError("请选择有效日期，结束日期不能早于开始日期。"); return; }
      const days = (new Date(to.value) - new Date(from.value)) / 86400000;
      if (days > 366) { this.setError("自定义日期范围最多 367 天，请缩小范围。"); return; }
      this.clearError();
      this.state.patch({ range: "all", from: from.value, to: to.value });
    } }, "应用日期");
    this.boardControls.replaceChildren(
      // 「全部历史」现在就在 RANGES 里，和别的范围同一排、同一套词表。
      renderPills(RANGES, state.range, range => this.state.patch({ range, from: "", to: "" })),
      h("details", { className: "tt-date-picker" }, h("summary", {}, state.from ? `${state.from} — ${state.to}` : "年 / 月 / 日"), h("div", { className: "tt-board-dates" }, from, h("span", {}, "至"), to, apply)),
    );
    this.renderFilterStatus();
  }

  // 选项列表里的占位文案曾被当成真实筛选值存进 state（见 components.mjs selectOptions 的注释）。
  // 这种值只可能来自那个 bug，不可能是真实的 agent / 模型 / 供应商 id，见到即清。
  stripPlaceholderFilters(state) {
    const dirty = {};
    for (const key of ["agent", "model", "provider", "type"]) {
      // 现在是多值：只把混进值里的占位项（如“全部模型”那类）摸掉，其余保留。
      const list = asList(state[key]);
      const kept = list.filter((v) => !PLACEHOLDER_VALUES.has(v));
      if (kept.length !== list.length) dirty[key] = kept;
    }
    if (Object.keys(dirty).length) this.state.patch(dirty);
  }

  // Agent 选项以宿主名册为准：dashboard.agentNames（后端用 agent:list 覆盖，含所有现存 agent，
  // 包括一次都没用过的）；账本里还有用量、名册里已消失的（删过的 agent）补在后面，历史才筛得到。
  // 插件里不写死任何 agent 名，换台机器、分享给别人都是对方自己的名册。
  agentOptions() {
    const roster = this.dashboard?.agentNames || {};
    const items = Object.keys(roster).map(id => ({ value: id, label: roster[id] || id }));
    const known = new Set(items.map(item => item.value));
    for (const a of this.dashboard?.agents || []) {
      if (known.has(a.id)) continue;
      items.push({ value: a.id, label: a.name || a.id });
    }
    items.sort(byLabel);
    return [{ value: "", label: "全部 Agent" }, ...items];
  }

  // 模型选项用后端的 modelOptions：它取的是「模型筛选之前」的池子，选中一个之后仍能换別的；
  // 而 models 是按当前筛选算出来的结果集，拿来当下拉源会自我坍缩成一个（选中项）。
  // 没这个字段时（例如 mock 数据）退回 models，行为与之前一致。
  modelOptions() {
    const list = this.dashboard?.modelOptions?.length ? this.dashboard.modelOptions : (this.dashboard?.models || []);
    return [{ value: "", label: "全部模型" }, ...list.map(m => ({ value: m, label: m }))];
  }

  // 供应商选项：后端的 providers 已经是「不受筛选影响的去重供应商名」，直接当下拉源。
  providerOptions() {
    const items = (this.dashboard?.providers || []).map(p => (typeof p === "string" ? p : p?.provider)).filter(Boolean);
    return [{ value: "", label: "全部供应商" }, ...items.map(p => ({ value: p, label: p }))];
  }

  renderFilterStatus() {
    if (!this.filterStatus || !this.filterChips) return;
    const state = this.state.get();
    this.stripPlaceholderFilters(state);
    // 时间范围已交由看板右上角那排统一负责，这里只管 Agent / 供应商 / 模型（以及类型）。
    // 这里不再 closeOpen*：原地更新不会扔下孤儿浮层，也没有需要重建的宿主容器。
    this.filterChips.update({
      state,
      agentOptions: this.agentOptions(),
      providerOptions: this.providerOptions(),
      modelOptions: this.modelOptions(),
    });
  }

  renderOverview({ preserveScroll = false } = {}) {
    const el = this.container.querySelector("#overview-module");
    if (!el) return;
    const keepScroll = preserveScroll ? el.scrollTop : 0;
    renderAnalytics(el, this.dashboard, this.state.get(), patch => this.state.patch(patch));
    if (preserveScroll) el.scrollTop = keepScroll;
  }

  metricEl(label, value, unit = "") {
    return h("div", { className: "tt-metric" },
      h("div", { className: "tt-metric-label" }, label),
      h("div", { className: "tt-metric-value" },
        h("span", { className: "n" }, value),
        unit ? h("span", { className: "u" }, unit) : null,
      ),
    );
  }

  // ---------- balance module ----------

  renderBalance() {
    let el = this.container.querySelector("#balance-module");
    if (!el) {
      el = h("section", { id: "balance-module", className: "tt-module" });
      this.mainEl.appendChild(el);
    }

    const rows = this.balances || [];
    const body = h("div", { className: "tt-module-bd dense" });
    const ds = this.dsSeries();

    if (!rows.length) {
      body.appendChild(h("div", { className: "tt-empty" }, "未配置余额/余量 API"));
    } else {
      const list = h("div", { className: "tt-bal-list" });
      for (const b of rows) {
        const pctLabel = b.limit > 0 ? `${b.remainPercent.toFixed(0)}% 剩` : "";
        const sub = b.updatedAt ? timeAgo(b.updatedAt) : "";
        list.appendChild(
          h("div", { className: "tt-bal-row" },
            h("div", { className: "tt-bal-main" },
              h("div", { className: "tt-bal-name", title: b.provider },
                b.provider,
                sub ? h("span", { className: "tt-bal-sub" }, sub) : null,
              ),
              h("div", { className: "tt-bal-value" },
                b.display,
                pctLabel ? h("span", { className: "tt-bal-pct", style: `color:${b.barColor}` }, pctLabel) : null,
              ),
            ),
            b.limit > 0 ? h("div", { className: "tt-bal-track" },
              h("div", { className: "tt-bal-fill", style: `width:${b.usedPercent.toFixed(1)}%;background:${b.barColor}` }),
            ) : null,
          ),
        );
      }
      body.appendChild(list);
    }

    el.innerHTML = "";
    el.append(
      h("div", { className: "tt-module-hd" }, h("span", { className: "tt-module-title" }, "余额与额度")),
      body,
    );

    // ── DeepSeek 官网账单：余额旁的「总消费」 + 一张按打开时间算的趋势图 ──
    const dsPanel = h("div", { className: "tt-ds-panel" });
    const hist = ds.history;
    const dsHead = h("div", { className: "tt-ds-head" },
      h("div", { className: "tt-ds-title" }, "DeepSeek 官网账单"),
      hist && hist.cost > 0
        ? h("div", { className: "tt-ds-total" },
            h("span", { className: "tt-ds-total-label" }, "累计消费"),
            h("span", { className: "tt-ds-total-value" }, "¥" + hist.cost.toFixed(2)),
          )
        : null,
    );
    dsPanel.appendChild(dsHead);

    // 时间窗跟着顶部那排范围走（顶部已有选择器，这里不再重复一套）
    if (!this.dsUsage) {
      dsPanel.appendChild(h("div", { className: "tt-empty" }, this.dsError || "未取到官网用量"));
    } else if (!ds.points.length) {
      // 一无所获（没缓存也没拉到）：把原因说清楚，而不是一句笼统的「没登录态」。
      const diag = this.dsUsage.diagnostics;
      let why = "磁盘上没有可用的 DeepSeek 登录态，请先用内置浏览器登录一次";
      if (diag) {
        if (!diag.partitionsDir) why = "找不到浏览器数据目录（环境变量缺失），插件无法自行定位登录态";
        else if (!diag.exists || !diag.readable) why = "浏览器数据目录读不到（" + (diag.error || "未知") + "），可能是这个 App 的运行沙箱没放行";
        else if (!diag.filesWithTokenKey) why = "浏览器数据目录里没有 DeepSeek 登录记录（共 " + diag.entries + " 个存储区）";
      } else if (this.dsUsage.tokenError === "DS_TOKEN_INVALID") {
        why = "官网登录态已失效，请到内置浏览器重新登录";
      } else if (this.dsUsage.tokenError) {
        why = "取数失败：" + this.dsUsage.tokenError;
      }
      dsPanel.appendChild(h("div", { className: "tt-empty" }, why));
    } else {
      const isHour = ds.bucket === 3600;
      const legend = h("div", { className: "tt-ds-legend" },
        h("span", { className: "tt-ds-leg tt-ds-leg-area" }, "总 token（左轴）"),
        h("span", { className: "tt-ds-leg tt-ds-leg-rate" }, "缓存命中率（右轴）"),
        h("span", { className: "tt-ds-grain" }, isHour ? "按小时" : "按天"),
      );
      const chartBox = h("div", { className: "tt-ds-chart" });
      dsPanel.appendChild(legend);
      dsPanel.appendChild(chartBox);
      drawUsageChart(chartBox, ds.points, { width: 680, height: 190, bucket: ds.bucket, areaColor: "var(--tt-blue)", rateColor: "var(--tt-green)" });

      const tot = ds.totals || {};
      const foot = h("div", { className: "tt-ds-foot" },
        // 把窗口起止写在图上，免得“这到底是几天”只能靠猜
        h("span", { className: "tt-ds-window" }, `${dsClock(ds.rangeFrom)} → ${dsClock(ds.rangeTo)} · ${ds.points.length} 点`),
        h("span", {}, `${fmtTokensShort(tot.tokens || 0)} tokens · ${(tot.request || 0).toLocaleString()} 次请求`),
        h("span", {}, `¥${(tot.cost || 0).toFixed(2)}`),
        tot.hitRate != null ? h("span", {}, `命中率 ${tot.hitRate.toFixed(1)}%`) : null,
      );
      dsPanel.appendChild(foot);
      // 登录态过期：官网已经拒了这枚 token，图上这些点不会再长。把「停在哪天」写出来，
      // 否则你看到的是一张完好的旧图 + 一个刷到「刚刚」的时间戳，看不出数据早就停了。
      if (this.dsUsage.tokenError === "DS_TOKEN_INVALID") {
        const lastT = ds.points[ds.points.length - 1]?.t;
        const stopped = Number.isFinite(lastT)
          ? `，数据停在 ${ds.bucket === 86400 ? dsClock(lastT).slice(0, 5) : dsClock(lastT)}`
          : "";
        dsPanel.appendChild(h("div", { className: "tt-ds-note" }, `官网登录态已失效${stopped}；请到内置浏览器重新登录`));
      } else if (!this.dsUsage.hasToken) {
        dsPanel.appendChild(h("div", { className: "tt-ds-note" }, "显示的是已缓存数据，当前取不到登录态"));
      }
    }
    if (this.dsError && this.dsUsage) {
      dsPanel.appendChild(h("div", { className: "tt-ds-note" }, "上次刷新失败：" + this.dsError));
    }
    body.appendChild(dsPanel);
  }

  // ---------- details module ----------

  renderDetails({ preserveScroll = false } = {}) {
    // 范围与筛选由页面顶部那两排统一负责（顶右的范围行 + 「当前范围」筛选行），这里只留表格、排序/门槛与翻页。
    // 同一个 state 摆两套控件只会互相打架：顶部选「全部历史」时，这一排的 pills 一个都不亮。
    // 下面两个下拉会让模块重建，钳住已经摊开的浮层，避免面板变孤儿。
    // 只钳这一块里的：顶部筛选条那三颗下拉在模块之外，不能因为这里重画就被关掉。
    let el = this.container.querySelector("#details-module");
    if (!el) {
      el = h("section", { id: "details-module", className: "tt-module" });
      this.mainEl.appendChild(el);
    }
    closeOpenSelect(el);

    // 两条路：引擎给了 details 就用它（排序/门槛/分页都在数据层做完了，这里只渲染这一页），
    // 拿不到 details（mock 预览、或引擎没拿到 SQLite 驱动）才退回本地这套，语义相同。
    const server = this.dashboard?.details || null;
    const rows = this.dashboard?.rows || [];
    const view = server ? [] : viewRows(rows, { sort: this.detailsSort, minTokens: this.detailsMin });
    const slice = server
      ? { page: server.page, totalPages: server.totalPages, rows: decodeRows({ rows: server.rows, rowCols: server.rowCols }).rows }
      : pageSlice(view, this.detailsPage, PAGE_SIZE);
    const { page, totalPages, rows: pageRows } = slice;
    this.detailsPage = page; // 夹过界的页码写回去，否则输入框会一直显示一个不存在的页
    const total = server ? server.total : view.length;
    const sum = server ? server.sumTokens : sumTokens(view);
    const maxTokens = Math.max(...pageRows.map((r) => r.totalTokens || 0), 1);

    const keepScroll = preserveScroll ? el.scrollTop : 0;
    el.innerHTML = "";
    el.append(
      h("div", { className: "tt-module-hd" },
        h("span", { className: "tt-module-title" }, "消费明细"),
        h("div", { className: "tt-module-actions" },
          h("span", { className: "tt-module-meta" }, `共 ${total.toLocaleString()} 条 · 合计 ${fmt(sum)} tok`),
          h("select", { id: "details-sort", className: "tt-pill", "aria-label": "明细排序" },
            ...selectOptions(DETAIL_SORTS.map((s) => ({ value: s.key, label: s.label })), this.detailsSort)),
          h("select", { id: "details-min", className: "tt-pill", "aria-label": "按单轮用量过滤" },
            ...selectOptions(DETAIL_THRESHOLDS.map((t) => ({ value: String(t.key), label: t.label })), String(this.detailsMin))),
          h("button", { type: "button", id: "details-export", className: "tt-btn ghost" }, "⤓ 导出"),
        ),
      ),
      h("div", { className: "tt-module-bd dense" },
        this.renderDetailsTable(pageRows, maxTokens,
          total ? "当前门槛之上没有轮次，把门槛放宽些" : "该时间范围内无消费记录"),
        this.renderDetailsPagination(total, page, totalPages),
      ),
    );
    if (preserveScroll) el.scrollTop = keepScroll;

    // 原生 select 留着当状态源，换成自绘下拉（幂等）；改完排序/门槛都回到第 1 页。
    enhanceSelects(this.container);
    // 服务端分页时，排序/门槛都得重新取一次（语义在后端）；本地退回那套就地重渲染。
    const refresh = () => {
      this.detailsPage = 1;
      // 服务端分页时，排序/门槛都得重新取一次（语义在后端）；本地退回那套就地重渲染。
      // 只碰得到明细这一块，所以走轻量路；概览不重算也不重画。
      if (this.dashboard?.details) this.loadDetails();
      else this.renderDetails();
    };
    this.container.querySelector("#details-sort")?.addEventListener("change", (e) => {
      this.detailsSort = e.target.value; refresh();
    });
    this.container.querySelector("#details-min")?.addEventListener("change", (e) => {
      this.detailsMin = Number(e.target.value) || 0; refresh();
    });
    this.container.querySelector("#details-export")?.addEventListener("click", () => this.exportCSV());
    this.bindDetailsPagination();
  }

  renderDetailsTable(pageRows, maxTokens, emptyText = "该时间范围内无消费记录") {
    if (!pageRows.length) {
      return h("div", { className: "tt-empty" }, emptyText);
    }

    const thead = h("thead", {},
      h("tr", {},
        h("th", { style: "width:17%" }, "时间"),
        h("th", { style: "width:13%" }, "Agent"),
        h("th", { style: "width:13%" }, "Provider"),
        h("th", { style: "width:15%" }, "模型"),
        h("th", { style: "width:42%;text-align:right" }, "Token"),
      ),
    );

    const tbody = h("tbody", {},
      ...pageRows.flatMap((r) => {
        const ratio = maxTokens > 0 ? Math.min(100, ((r.totalTokens || 0) / maxTokens) * 100) : 0;
        const hr = hitRate(r);
        const turnKey = this.turnKey(r);
        const open = !!turnKey && this.turnOpen.has(turnKey);
        let selAtDown = 0;
        return [h("tr", {
          className: (this.dashboard?.summary?.highUsageThreshold > 0 && r.totalTokens >= this.dashboard.summary.highUsageThreshold ? "tt-high-usage " : "") + (open ? "tt-turn-open" : ""),
          "data-turn-row": turnKey || null,
          "data-turn-session": turnKey ? r.sessionKey : null,
          "data-turn-seq": turnKey ? String(r.seq) : null,
          title: turnKey ? (open ? "点一下收起这一轮的调用明细" : "点这一行看它的调用明细") : null,
          // 整行就是「这一轮」的入口。拖动选中文字不该被当成点击，所以按下时记一次选中长度、
          // 抬起时比较；不能拿「当前有没有选中」当条件——页面上残留的选中会让整行永久点不动。
          onMouseDown: turnKey ? () => { selAtDown = selectedLength(); } : null,
          onClick: turnKey ? () => {
            if (selectedLength() > selAtDown) return;
            this.toggleTurn(turnKey, r.sessionKey, r.seq).catch((err) => this.setError(`展开这一轮失败：${err?.message || err}`));
          } : null,
        },
          h("td", { className: "tt-turn-time" }, formatDateTime(r.time)),
          h("td", { title: r.agent }, r.agentName || r.agent || "—"),
          h("td", { title: r.provider }, r.provider || "—"),
          h("td", { title: r.model }, r.model || "—"),
          h("td", { className: "dual" },
            h("div", { style: "display:flex;align-items:baseline;justify-content:flex-end;gap:4px" },
              h("span", { className: "tt-table-unit", style: "margin-right:auto" },
                r.inputTokens != null || r.outputTokens != null
                  ? "输入 " + fmt(r.inputTokens || 0) + " · 输出 " + fmt(r.outputTokens || 0)
                  : "输入 / 输出 —",
                // 缓存拆分与调用次数：这两项才是「这一笔为什么贵」的答案（命中部分单价低一个量级）。
                // 没有口径的记录（老数据）就不显示，不用 0 冒充。
                hr != null ? h("span", { title: "命中缓存的输入占输入总量的比例（命中部分单价低一个量级）" }, ` · 缓存 ${(hr * 100).toFixed(1)}%`) : null,
                r.calls != null ? h("span", { title: "这一轮里的模型调用次数" }, ` · ${r.calls} 次`) : null,
              ),
              h("span", { className: "out" }, fmt(r.totalTokens || 0)),
              h("span", { className: "tt-table-unit" }, "tok"),
            ),
            h("div", { className: "tt-inline-bar", ariaHidden: "true" },
              h("i", { style: `width:${ratio.toFixed(1)}%` }),
            ),
          ),
        ),
        // 抽屉行：关着就只是一条壳（不给高度），点开才去取数
        turnKey ? h("tr", { className: "tt-turn-drawer" + (open ? "" : " tt-turn-closed"), "data-turn-cell": turnKey },
          h("td", { colSpan: 5 }, this.renderTurnPanel(this.turnDetail.get(turnKey))),
        ) : null];
      }),
    );

    return h("div", { className: "tt-table-wrap" },
      h("table", { className: "tt-table" }, thead, tbody),
    );
  }

  // 分页器不再为每一页渲染一个按钮：全部历史 17,345 条 ÷ 50 条/页 = 347 页，
  // 旧写法会把 347 个按钮塞进 DOM（10 条/页时是 1,735 个）。只留首/上/下/末 + 跳页输入。
  renderDetailsPagination(total, page, totalPages) {
    if (total <= PAGE_SIZE) return h("div");
    // 坑：h() 对每一个非 null 的键都走 setAttribute，disabled: false 也会把属性写出去，
    // 而 disable 属性只要存在按钮就是禁用的 —— 所以状态只能在元素建好之后赋值。
    const step = (target, label, title, off) => {
      const btn = h("button", { type: "button", className: "tt-pill", "data-page": target, title }, label);
      btn.disabled = off;
      return btn;
    };
    return h("div", { className: "tt-details-pager" },
      h("div", { className: "tt-pager-ctrl" },
        step("first", "«", "第一页", page <= 1),
        step("prev", "‹", "上一页", page <= 1),
        h("span", { className: "tt-pager-page" }, "第",
          h("input", { id: "details-page-jump", className: "tt-page-jump", type: "text", inputMode: "numeric", value: String(page), "aria-label": "跳转到第几页" }),
          `/ ${totalPages.toLocaleString()} 页`),
        step("next", "›", "下一页", page >= totalPages),
        step("last", "»", "最后一页", page >= totalPages),
      ),
    );
  }

  bindDetailsPagination() {
    const server = this.dashboard?.details || null;
    const totalPages = server ? server.totalPages : Math.max(1, Math.ceil((this.dashboard?.rows || []).length / PAGE_SIZE));
    const go = (next) => {
      const target = Math.min(totalPages, Math.max(1, next));
      this.detailsPage = Number.isFinite(target) ? target : 1;
      // 服务端分页：页码在后端生效，只重取明细这一页（静默，不重建整页控件）；本地模式就地重渲染。
      if (server) this.loadDetails({ silent: true });
      else this.renderDetails();
    };
    this.container.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.page;
        if (p === "first") go(1);
        else if (p === "prev") go(this.detailsPage - 1);
        else if (p === "next") go(this.detailsPage + 1);
        else if (p === "last") go(totalPages);
      });
    });
    // 跳页：只在回车或失焦时生效。范围一换页数就变，所以每次都重新夹一遍上下界；
    // 输不合法的值时会重建这一块，输入框自己回到当前页，也算给了反馈。
    const jump = this.container.querySelector("#details-page-jump");
    if (jump) {
      const submit = () => {
        const n = Number(String(jump.value).replace(/[^0-9]/g, ""));
        go(n > 0 ? n : this.detailsPage);
      };
      jump.addEventListener("change", submit);
      jump.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); jump.blur(); } });
    }
  }

  async exportCSV() {
    try {
      // 明细服务端分页之后前端只有一页，而导出的语义是「当前筛选 + 当前排序下的全部行」：
      // CSV 只能由引擎拼好（同一套口径，不会出现「导出的和看得见的不一致」）。
      const label = DETAIL_THRESHOLDS.find((t) => t.key === this.detailsMin)?.label || "";
      const suffix = this.detailsMin > 0 ? `-${label.replace("≥", "")}` : "";
      const filters = { ...this.state.get(), sortKey: this.detailsSort, order: "desc", minTokens: this.detailsMin };
      const csv = await this.api.getDetailsCsv(filters, { mock: this.mock });
      await saveDetailsCSV(this.hana, csv, this.state.get().range, { suffix, count: this.dashboard?.details?.total ?? 0 });
    } catch (err) {
      this.setError(`导出失败：${err.message}`);
    }
  }

  // ---------- 体检（只读） ----------
  // 它是「这台机器自己」的状态（扫描 / 落盘 / 库规模 / 载荷），不是用量数据的一个视图，
  // 所以挂在实时监控页底部、不占页签位：切到这一页才取一次，没进来看就一点代价都不花。
  // 那一页每 5 秒重画一次，这个块由 renderRealtime 搬过去、不重建（见那里的注释）。
  // 用词：这里的「写入」指把会话扫描结果写进本地库（派生数据，写入量跟变化量走），
  // 跟模型侧的提示缓存不是一回事——界面里提到「缓存」时默认指后者，别撞名。
  renderDiagnostics() {
    const mod = this.container.querySelector("#realtime-module");
    if (!mod) return;
    let el = mod.querySelector("#realtime-diag");
    if (!el) {
      el = h("section", { id: "realtime-diag" });
      mod.appendChild(el);
    }
    const keepScroll = mod.scrollTop;
    el.innerHTML = "";
    el.append(
      h("div", { className: "tt-diag-head" },
        h("span", { className: "tt-module-title" }, "体检"),
        h("span", { className: "tt-module-meta", title: "这里的写入是把会话扫描结果写进本地库的写入量，与模型侧的提示缓存命中无关" }, "只读 · 本地扫描结果的库与落盘统计"),
        h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.loadDiagnostics({ bytes: !!this.diagData?.payload }) }, "刷新"),
      ),
      this.buildDiagnostics(),
    );
    mod.scrollTop = keepScroll;
  }

  // bytes=true 时后端会把整份看板重算一遍再拆字节，所以那一下就单独点，不跟着这一页一起做。
  async loadDiagnostics({ bytes = false } = {}) {
    this.diagLoading = true;
    this.renderDiagnostics();
    try {
      this.diagData = await this.api.getDiagnostics({ bytes, mock: this.mock });
      this.diagError = "";
    } catch (err) {
      this.diagError = err?.message || "取不到体检数据";
    } finally {
      this.diagLoading = false;
      this.renderDiagnostics();
    }
  }

  buildDiagnostics() {
    const box = h("div", { className: "tt-diag-bd" });
    if (this.diagError) {
      box.appendChild(h("div", { className: "tt-diag-note" }, "取不到体检数据：" + this.diagError,
        h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.loadDiagnostics({ bytes: !!this.diagData?.payload }) }, "重试")));
      return box;
    }
    const d = this.diagData;
    if (!d) { box.appendChild(h("div", { className: "tt-diag-note" }, this.diagLoading ? "正在取…" : "还没取过，点右上角「刷新」取一次。")); return box; }

    // 一行一条，label 在左、数字在右、后面跟一句它是从哪来的（数字没有出处就等于没有可信度）。
    const row = (label, value, note) => h("div", { className: "tt-diag-row" },
      h("span", { className: "tt-diag-label" }, label),
      h("span", { className: "tt-diag-value" }, value),
      // 这一行窄下来会被省略号截断，所以把全文挂在 title 上，悬停能看完整
      note ? h("span", { className: "tt-diag-sub", title: note }, note) : null,
    );
    const t = d.tables || {}, db = d.db || {}, c = d.cache || {}, lg = d.ledger || {}, p = d.persist || null;
    box.appendChild(h("div", { className: "tt-diag-grid" },
      row("sessions 行", fmtInt(t.sessions), "整表，含下面的账本行"),
      row("轮次行", fmtInt(t.turns), "turns 表（明细的来源）"),
      row("账本行", fmtInt(t.ledger), "宿主账本按天聚合"),
      row("库文件", fmtBytes(db.bytes), db.walBytes ? "另有 WAL " + fmtBytes(db.walBytes) : "含空闲页"),
      row("缓存版本", c.version != null ? "v" + c.version : "—", c.scanning ? "正在扫描" : (c.ready === false ? "未就绪" : "已就绪")),
      row("最近扫描", c.lastScan ? formatDateTime(c.lastScan) : "—", this.snapshot?.updatedAt ? "快照 " + clockOf(this.snapshot.updatedAt) : ""),
      row("账本来源", lg.file || lg.source || "—", lg.entries != null ? fmtInt(lg.entries) + " 条" : ""),
      p
        ? row("累计写入", fmtInt(p.writes) + " 次 / " + fmtBytes(p.bytes), "今天 " + fmtInt(p.dayWrites) + " 次 / " + fmtBytes(p.dayBytes))
        : row("落盘统计", "—", "引擎还没落过盘"),
      p ? row("最近一次落盘", p.lastReason || "—", [
        p.lastAt ? timeAgo(new Date(p.lastAt).getTime()) : "",   // 多久之前：以前这行在实时那块，删了之后搬进来
        p.lastRows != null ? fmtInt(p.lastRows) + " 行 / " + fmtBytes(p.lastBytes) : "",
        p.lastMs != null ? p.lastMs + " ms" : "",
        p.lastDetail || "",
        p.lastScope || "",
      ].filter(Boolean).join(" · ")) : null,
    ));

    box.appendChild(h("div", { className: "tt-diag-payload" },
      h("div", { className: "tt-diag-payload-hd" },
        h("span", { className: "tt-diag-label" }, "整份看板载荷"),
        d.payload ? h("span", { className: "tt-diag-value" }, fmtBytes(d.payload.totalBytes)) : null,
        h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.loadDiagnostics({ bytes: true }) }, d.payload ? "重量一次" : "量一次"),
      ),
      d.payload
        ? h("div", { className: "tt-diag-bars" }, ...this.buildPayloadBars(d.payload))
        : h("div", { className: "tt-diag-note" }, "量这一下会把整份看板重算一遍（几十毫秒），所以不跟着面板常驻。"),
      d.payload ? h("div", { className: "tt-diag-foot" }, "analytics.xxx 是 analytics 内部的细分，不另计；百分比都是占整份的比例。") : null,
    ));
    return box;
  }

  buildPayloadBars(payload) {
    const parts = (Array.isArray(payload.parts) ? payload.parts.slice() : []).sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const max = Math.max(...parts.map((x) => x.bytes || 0), 1);
    const total = payload.totalBytes || parts.reduce((s, x) => s + (x.bytes || 0), 0) || 1;
    return parts.map((x) => h("div", { className: "tt-diag-bar" },
      h("span", { className: "tt-diag-bar-name", title: x.key }, x.key),
      h("div", { className: "tt-diag-bar-track" }, h("i", { style: `width:${(((x.bytes || 0) / max) * 100).toFixed(1)}%` })),
      h("span", { className: "tt-diag-bar-bytes" }, fmtBytes(x.bytes),
        h("em", {}, ((x.bytes || 0) / total * 100).toFixed(0) + "%")),
    ));
  }

  // ---------- 「点得开」：某一轮的调用拆解 ----------
  // 明细行回答「这一轮多贵」，不回答「为什么贵」。展开后由引擎从会话文件重读这一轮，
  // 逐条列出调用（未命中 / 缓存读 / 输出 / 缓存写 / 推理），并给出会话文件的绝对路径。
  // 入口就是行本身（由 renderDetailsTable 直接绑在 <tr> 上），这里不挂代理监听。

  // 这两个字段只有后端给了才点得开（mock 预览的行、老格式的行都没有）。
  turnKey(r) {
    return r && r.sessionKey && r.seq != null ? `${r.sessionKey}#${r.seq}` : "";
  }

  async toggleTurn(key, sessionKey, seq) {
    if (!key) return;
    if (this.turnOpen.has(key)) {
      this.turnOpen.delete(key);
      this.paintTurnRow(key);
      return;
    }
    this.turnOpen.add(key);
    this.paintTurnRow(key);
    const known = this.turnDetail.get(key);
    if (known && known.status === "ready") return; // 同一行反复开合不必重读文件
    await this.loadTurn(key, sessionKey, seq);
  }

  async loadTurn(key, sessionKey, seq) {
    if (!key) return;
    this.rememberTurn(key, { status: "loading", key, sessionKey, seq });
    this.paintTurnRow(key);
    if (this.mock) {
      this.rememberTurn(key, { status: "error", key, sessionKey, seq, message: "预览模式没有会话文件" });
      this.paintTurnRow(key);
      return;
    }
    try {
      const turn = await this.api.getTurn(sessionKey, seq, { mock: this.mock });
      if (turn && turn.ok === false) throw Object.assign(new Error(turn.message || "读取失败"), { code: turn.code });
      this.rememberTurn(key, { status: "ready", key, sessionKey, seq, data: turn || {} });
    } catch (err) {
      this.rememberTurn(key, { status: "error", key, sessionKey, seq, message: err?.message || "读取失败" });
    }
    this.paintTurnRow(key);
  }

  // 面板状态也留一手上限：一行拖一份调用清单，点开几十行不设限会一直涨。
  rememberTurn(key, state) {
    if (this.turnDetail.size >= 40 && !this.turnDetail.has(key)) {
      const oldest = this.turnDetail.keys().next().value;
      this.turnDetail.delete(oldest);
      this.turnOpen.delete(oldest);
    }
    this.turnDetail.set(key, state);
  }

  // 只换这一行的抽屉，不重渲染整张表：否则同屏其他展开的行、滚动位置都会抖一下。
  paintTurnRow(key) {
    try {
      this.paintTurnRowInner(key);
    } catch (err) {
      this.setError(`展开这一轮失败：${err?.message || err}`);
    }
  }

  paintTurnRowInner(key) {
    const open = this.turnOpen.has(key);
    for (const row of this.container.querySelectorAll("tr[data-turn-row]")) {
      if (row.dataset.turnRow !== key) continue;
      row.classList.toggle("tt-turn-open", open);
      break;
    }
    for (const cell of this.container.querySelectorAll("[data-turn-cell]")) {
      if (cell.dataset.turnCell !== key) continue;
      const holder = cell.firstElementChild;
      if (holder) {
        holder.innerHTML = "";
        holder.appendChild(this.renderTurnPanel(this.turnDetail.get(key)));
      }
      cell.classList.toggle("tt-turn-closed", !open);
      break;
    }
  }

  // 抽屉内容的构建兼一层兜底：它出意外只坏这一块，不连累整张明细表。
  renderTurnPanel(state) {
    try {
      return this.buildTurnPanel(state);
    } catch (err) {
      return h("div", { className: "tt-turn-body" }, h("div", { className: "tt-turn-note" }, `展开失败：${err?.message || err}`));
    }
  }

  buildTurnPanel(state) {
    const body = h("div", { className: "tt-turn-body" });
    if (!state || state.status === "loading") {
      body.appendChild(h("div", { className: "tt-turn-note" }, "正在读出这一轮的调用…"));
      return body;
    }
    const { key, sessionKey, seq } = state;
    const reread = () => this.loadTurn(key, sessionKey, seq);
    if (state.status === "error") {
      body.appendChild(h("div", { className: "tt-turn-note" },
        "读不出来：" + (state.message || "未知原因"),
        h("button", { type: "button", className: "tt-btn ghost", onClick: reread }, "重读"),
      ));
      return body;
    }

    const t = state.data || {};
    if (t.kind === "ledger") {
      body.appendChild(h("div", { className: "tt-turn-note" }, "这是宿主账本按天聚合出来的一行（memory / utility 子系统），没有会话文件，也就拆不出单次调用。"));
      return body;
    }
    if (t.fileExists === false) {
      body.appendChild(h("div", { className: "tt-turn-note" }, "会话文件已不在（可能被归档或删掉）：" + (t.filePath || "路径未知")));
      return body;
    }

    body.appendChild(h("div", { className: "tt-turn-hd" },
      h("span", { className: "tt-turn-seq" }, `第 ${t.seq != null ? t.seq : seq} 轮`),
      h("span", { className: "tt-turn-when" }, formatDateTime(t.time)),
      h("span", { className: "tt-turn-model", title: [t.provider, t.model].filter(Boolean).join(" / ") }, t.model || "—"),
      h("span", { className: "tt-turn-spacer" }),
      h("span", { className: "tt-turn-count" }, `${t.calls != null ? t.calls : 0} 次调用`),
      t.failedCalls > 0 ? h("span", { className: "tt-turn-skip" }, `${t.failedCalls} 次失败未计入`) : null,
      h("button", { type: "button", className: "tt-btn ghost", onClick: reread }, "重读"),
    ));

    const filePath = t.filePath || "";
    body.appendChild(h("div", { className: "tt-turn-file" },
      h("span", { className: "tt-turn-file-tag" }, t.fileExists === false ? "文件已不在" : "会话文件"),
      filePath ? h("code", { className: "tt-turn-path", title: filePath }, filePath) : h("span", { className: "tt-turn-path" }, "—"),
      // 文件多大、一共多少轮：70 MB 的会话为什么第一下慢、这一轮排在文件里第几位，看这两个数。
      t.fileSize != null || t.turnCount != null
        ? h("span", { className: "tt-turn-file-meta", title: "会话文件大小 · 这份文件里的总轮数" },
            `${fmtBytes(t.fileSize)} · 共 ${t.turnCount != null ? fmt(t.turnCount) : "—"} 轮`)
        : null,
      filePath ? h("button", { type: "button", className: "tt-btn ghost", onClick: (e) => this.copyText(filePath, e.currentTarget) }, "复制路径") : null,
    ));

    body.appendChild(h("div", { className: "tt-turn-facts" },
      turnFact("输入（含命中）", fmt(t.input)),
      turnFact("其中未命中", fmt(Math.max(0, (Number(t.input) || 0) - (Number(t.cacheRead) || 0)))),
      turnFact("缓存读", fmt(t.cacheRead)),
      turnFact("缓存写", fmt(t.cacheWrite)),
      turnFact("输出", fmt(t.output)),
      turnFact("推理", fmt(t.reasoning)),
      turnFact("合计", fmt(t.totalTokens)),
    ));

    const list = Array.isArray(t.callList) ? t.callList : [];
    if (!list.length) {
      body.appendChild(h("div", { className: "tt-turn-note" }, "这一轮里没有成功的调用（可能全部失败或被中断）。"));
      return body;
    }
    body.appendChild(h("div", { className: "tt-table-wrap tt-turn-calls" },
      h("table", { className: "tt-table" },
        h("thead", {}, h("tr", {},
          h("th", { style: "width:34px" }, "#"),
          h("th", { style: "width:132px" }, "时间"),
          h("th", {}, "模型"),
          h("th", { className: "num" }, "未命中输入"),
          h("th", { className: "num" }, "缓存读"),
          h("th", { className: "num" }, "输出"),
          h("th", { className: "num" }, "缓存写"),
          h("th", { className: "num" }, "推理"),
          h("th", { className: "num" }, "合计"),
        )),
        h("tbody", {}, ...list.map((c, i) => h("tr", { className: c.failed ? "tt-turn-call is-failed" : "tt-turn-call" },
          h("td", { className: "num" }, String(i + 1)),
          h("td", { title: c.time || "" }, clockOf(c.time) + (c.gapMs == null ? "" : "  ·" + gapText(c.gapMs))),
          h("td", { title: c.model || "" }, c.model || "—"),
          h("td", { className: "num" }, fmt(c.input)),
          h("td", { className: "num" }, fmt(c.cacheRead)),
          h("td", { className: "num" }, fmt(c.output)),
          h("td", { className: "num" }, fmt(c.cacheWrite)),
          h("td", { className: "num" }, fmt(c.reasoning)),
          h("td", { className: "num" }, fmt(c.totalTokens)),
        ))),
      ),
    ));
    body.appendChild(h("div", { className: "tt-turn-foot" },
      "读的是会话文件本身（明细行的权威来源）" + (t.truncated ? "，这里只列出前 400 次调用" : "") + "；失败或中断的调用不计入上面的合计与调用次数。",
    ));
    return body;
  }

  async copyText(text, btn) {
    try {
      if (this.hana?.clipboard?.writeText) await this.hana.clipboard.writeText(text);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("当前环境不支持写剪贴板");
      if (btn) {
        const before = btn.textContent;
        btn.textContent = "已复制";
        setTimeout(() => { if (btn.isConnected) btn.textContent = before; }, 1200);
      }
    } catch (err) {
      this.setError(`复制失败：${err?.message || err}`);
    }
  }

  // ---------- realtime module ----------

  renderRealtime() {
    let el = this.container.querySelector("#realtime-module");
    if (!el) {
      el = h("section", { id: "realtime-module", className: "tt-module" });
      this.mainEl.appendChild(el);
    }

    const rt = this.snapshot?.realtime || { connected: false, tps: 0, ttft: 0, contextPercent: 0, model: "—", agentName: "—", contextTokens: 0, contextWindow: 0, updatedAt: null };
    const cpShow = rt.contextPercent > 100 ? "99+" : Math.round(rt.contextPercent).toString();
    const ttftShow = rt.ttft > 0 ? (rt.ttft / 1000).toFixed(1) + " s" : "—";

    const keepScroll = el.scrollTop;   // 这一页底部还挂着体检块，重建别把人拽回顶部
    const diag = el.querySelector("#realtime-diag");   // 体检不是实时数据：重建时把它排到最后就好
    el.innerHTML = "";
    el.append(
      h("div", { className: "tt-module-hd" },
        h("span", { className: "tt-module-title" }, "实时监控"),
        h("div", { style: "display:flex;gap:6px;align-items:center" },
          h("span", { className: "tt-live-dot" }),
          h("span", { style: "font-size:9px;font-weight:600;color:var(--tt-green)" }, rt.connected ? "LIVE" : "等待用量"),
        ),
      ),
      h("div", { className: "tt-module-bd dense" },
        h("div", { className: "tt-ring-wrap" },
          h("div", { id: "realtime-ring", className: "tt-ring" }),
          h("div", { className: "tt-rt-metrics" },
            h("div", { className: "tt-rt-metric" }, h("span", { className: "l" }, "tok/s"), h("span", { className: "v accent" }, fmt(rt.tps))),
            h("div", { className: "tt-rt-metric" }, h("span", { className: "l" }, "首字"), h("span", { className: "v" }, ttftShow)),
            h("div", { className: "tt-rt-metric" }, h("span", { className: "l" }, "上下文"), h("span", { className: "v" }, `${fmt(rt.contextTokens)} / ${fmt(rt.contextWindow)}`)),
            h("div", { className: "tt-rt-metric" }, h("span", { className: "l" }, "当前模型"), h("span", { className: "v" }, rt.model || "—")),
            h("div", { className: "tt-rt-metric" }, h("span", { className: "l" }, "Agent"), h("span", { className: "v" }, rt.agentName || "—")),
          ),
        ),
        h("div", { className: "tt-rt-footer" },
          h("span", { className: "tt-model-chip" },
            h("span", { className: "tt-model-chip-dot" }),
            rt.model || "—",
            h("span", { className: "tt-model-chip-val" }, timeAgo(rt.updatedAt)),
          ),
          h("span", {}, rt.connected ? `上下文占用 ${cpShow}%` : "未连接"),
        ),
        h("div", { id: "realtime-spark", className: "tt-sparkline" }),
        h("div", { className: "tt-spark-labels" },
          h("span", {}, "tps 趋势"),
          h("span", {}, `峰值 ${fmt(Math.max(...this.sparkHistory, 0))}`),
        ),
      ),
    );
    if (diag) el.appendChild(diag);
    el.scrollTop = keepScroll;

    const ringContainer = el.querySelector("#realtime-ring");
    if (ringContainer) {
      drawRing(ringContainer, {
        size: 44,
        strokeWidth: 4,
        percent: rt.contextPercent,
        color: "var(--tt-blue)",
        bgColor: "var(--tt-empty)",
        text: cpShow + "%",
        textColor: "var(--tt-blue)",
        fontSize: 12,
      });
    }

    const sparkContainer = el.querySelector("#realtime-spark");
    if (sparkContainer && this.sparkHistory.length > 1) {
      drawSparkline(sparkContainer, this.sparkHistory, { stroke: "var(--tt-blue)", fill: "var(--tt-blue)", fillOpacity: 0.10, dot: false, height: 40 });
    }
  }
}

export async function bootWorkspace(options = {}) {
  const ctx = await bootstrap(options);
  const mock = options.mock || new URLSearchParams(window.location.search).get("mock") === "1";
  const container = document.getElementById("app-root");
  if (!container) throw new Error("#app-root not found");
  const app = new WorkspaceApp({ ...ctx, container, mock });
  await app.init();
  window.addEventListener("pagehide", () => app.dispose(), { once: true });
  return app;
}
