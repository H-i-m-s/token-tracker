import { applyAppearance } from "./appearance.mjs";
import { applyBoardLayout } from "./board-layout.mjs";
import { renderAnalytics, BOARD_RANGES } from "./analytics.mjs";
import { renderFilterStatus as renderFilterChips } from "./filter-chips.mjs";
import { saveDetailsCSV } from "./csv-export.mjs";
import { bootstrap } from "./bootstrap.mjs";
import { AppApi } from "./app-api.mjs";
import { h, RANGES, fmt, fmtPct, formatDateTime, renderPills, selectOptions, timeAgo } from "./components.mjs";
import { enhanceSelects, closeOpenSelect } from "./custom-select.mjs";
import { createDateField, closeOpenDate } from "./custom-date.mjs";
import { drawSparkline, drawRing } from "./charts.mjs";

const PAGE_SIZE = 10;
const POLL_INTERVAL_MS = 5000;
const MAX_SPARK_POINTS = 40;

// 选项里的占位文案曾被当成真实筛选值存进 state（见 components.mjs selectOptions 的注释）。
// 这种值只能来自那个 bug，不可能是真实的 agent / 模型 / 供应商 id，见到即清。
const PLACEHOLDER_VALUES = new Set(["全部 Agent", "全部模型", "全部 Provider", "全部类型"]);

// 名册按显示名排序，且中文按拼音排；只比 id 的话中文名会全部排到英文后面去。
function byLabel(a, b) {
  return String(a.label || a).localeCompare(String(b.label || b), "zh-Hans-CN");
}

export class WorkspaceApp {
  constructor({ hana, api, state, container, mock = false }) {
    this.hana = hana;
    this.api = api;
    this.state = state;
    this.container = container;
    this.mock = mock;

    this.snapshot = null;
    this.dashboard = null;
    this.balances = [];
    this.sparkHistory = [];
    this.loading = 0;
    this.foregroundLoads = 0;
    this.busyTimer = null;
    this.busyVisible = false;
    this.error = "";
    this.dashboardRequest = 0;
    this.disposed = false;
    this.visible = true;
    this.eventController = null;
    this.filterKey = "";
    this.detailsPage = 1;
    this.agentNames = new Map();

    this.pollTimer = null;
    this.disposers = [];
  }

  async init() {
    this.renderShell();
    const initial = this.state.get();
    this.filterKey = JSON.stringify([initial.range, initial.from, initial.to, initial.agent, initial.model, initial.provider, initial.type]);
    this.disposers.push(
      this.state.subscribe((s) => this.onStateChange(s)),
      this.subscribeLifecycle(),
    );
    await this.loadAll();
    this.startPolling();
  }

  dispose() {
    this.disposed = true;
    this.stopPolling();
    this.clearBusyTimer();
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
    this.view = "overview";
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
    this.filterStatus = h("div", { className: "tt-filter-status", role: "region", "aria-label": "当前筛选状态" });
    this.container.append(chrome, nav, this.filterStatus, this.statusEl, this.mainEl);
    this.renderBoardControls();
    for (const id of ["overview", "balance", "details", "realtime"]) this.mainEl.append(h("section", { id: `${id}-module`, className: "tt-module", role: "tabpanel", "aria-labelledby": `tab-${id}` }));
    this.selectView(this.view);
  }

  selectView(view) {
    this.view = view;
    this.mainEl.dataset.view = view;
    for (const section of this.mainEl.children) section.hidden = section.id !== `${view}-module`;
    for (const tab of this.viewTabs.children) {
      tab.setAttribute("aria-selected", String(tab.dataset.view === view));
      tab.tabIndex = tab.dataset.view === view ? 0 : -1;
    }
  }

  // ---------- data loading ----------

  async loadAll(force = false, { silent = false } = {}) {
    this.clearError();
    await Promise.all([
      this.loadSnapshot(force, { silent }),
      this.loadDashboard(force, { silent }),
      this.loadBalances(force, { silent }),
    ]);
  }

  async loadSnapshot(force = false, { silent = false } = {}) {
    this.setLoading(1, { silent });
    try {
      this.snapshot = await this.api.getSnapshot({ mock: this.mock });
      if (this.snapshot?.realtime) {
        this.sparkHistory.push(Number(this.snapshot.realtime.tps) || 0);
        if (this.sparkHistory.length > MAX_SPARK_POINTS) this.sparkHistory.shift();
      }
      this.renderRealtime();
    } catch (err) {
      this.setError(`实时数据加载失败：${err.message}`);
    } finally {
      this.setLoading(-1, { silent });
    }
  }

  async loadDashboard(force = false, { silent = false } = {}) {
    if (!force && this.dashboard) return;
    this.setLoading(1, { silent });
    const request = ++this.dashboardRequest;
    try {
      const dashboard = await this.api.getDashboard(this.state.get(), { mock: this.mock });
      if (request !== this.dashboardRequest || this.disposed) return;
      this.dashboard = dashboard;
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
      if (request === this.dashboardRequest && !this.disposed) this.setError(`明细加载失败：${err.message}`);
    } finally {
      this.setLoading(-1, { silent });
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
      this.setError(`余额加载失败：${err.message}`);
    } finally {
      this.setLoading(-1, { silent });
    }
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
    this.renderBoardControls();
    this.startPolling();
    applyBoardLayout(this.container, state);
    const key = JSON.stringify([state.range, state.from, state.to, state.agent, state.model, state.provider, state.type]);
    if (key === this.filterKey) return;
    this.filterKey = key;
    this.detailsPage = 1;
    this.dashboard = null;
    this.clearError();
    this.renderOverview();
    this.renderDetails();
    this.loadDashboard(true);
  }

  // ---------- overview module ----------

  renderBoardControls() {
    // 本函数会重建 .tt-board-controls，日期字段随之被替换：先把已打开的浮层摘干净。
    closeOpenSelect();
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
      renderPills(BOARD_RANGES, state.range, range => this.state.patch({ range, from: "", to: "" })),
      h("details", { className: "tt-date-picker" }, h("summary", {}, state.from ? `${state.from} — ${state.to}` : "年 / 月 / 日"), h("div", { className: "tt-board-dates" }, from, h("span", {}, "至"), to, apply)),
    );
    this.renderFilterStatus();
  }

  // 选项列表里的占位文案曾被当成真实筛选值存进 state（见 components.mjs selectOptions 的注释）。
  // 这种值只可能来自那个 bug，不可能是真实的 agent / 模型 / 供应商 id，见到即清。
  stripPlaceholderFilters(state) {
    const dirty = {};
    for (const key of ["agent", "model", "provider", "type"]) {
      if (PLACEHOLDER_VALUES.has(state[key])) dirty[key] = "";
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
    if (!this.filterStatus) return;
    // 自绘下拉 / 日历浮层挂在 body 上，而 loadDashboard() 会直接调用这里（不经过
    // renderBoardControls）：模块内部重建前也会 closeOpen*，这里再兜一道，双保险。
    closeOpenSelect();
    closeOpenDate();
    const state = this.state.get();
    this.stripPlaceholderFilters(state);
    const rangeLabel = state.from || state.to
      ? `${state.from || "不限"} — ${state.to || "不限"}`
      : RANGES.find(item => item.key === state.range)?.label || (state.range === "all" ? "全部历史" : state.range);
    const next = renderFilterChips({
      state,
      rangeLabel,
      agentLabel: this.agentNames.get(state.agent) || state.agent,
      agentOptions: this.agentOptions(),
      providerOptions: this.providerOptions(),
      modelOptions: this.modelOptions(),
      onPatch: (patch) => this.state.patch(patch),
      onError: (message) => this.setError(message),
    });
    this.filterStatus.replaceWith(next);
    this.filterStatus = next;
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

  computeTrend() {
    const points = this.state.get().range === "today" ? this.dashboard?.hourly : this.dashboard?.daily;
    if (points?.length) return { values: points.map(p => Number(p.totalTokens) || 0), labels: [String(points[0].date ?? points[0].hour ?? ""), String(points.at(-1).date ?? points.at(-1).hour ?? "")] };
    const rows = this.dashboard?.rows || [];
    if (!rows.length) return { values: [], labels: ["00:00", "12:00", "现在"] };
    const range = this.state.get().range;
    if (range === "today") {
      const buckets = new Array(24).fill(0);
      for (const r of rows) {
        const d = new Date(r.time);
        if (!isNaN(d.getTime())) buckets[d.getHours()] += r.totalTokens || 0;
      }
      return { values: buckets, labels: ["00:00", "06:00", "12:00", "18:00", "现在"] };
    }
    if (range === "week") {
      const buckets = new Array(7).fill(0);
      for (const r of rows) {
        const d = new Date(r.time);
        if (!isNaN(d.getTime())) buckets[(d.getDay() + 6) % 7] += r.totalTokens || 0;
      }
      return { values: buckets, labels: ["一", "二", "三", "四", "五", "六", "日"] };
    }
    const buckets = new Map();
    for (const r of rows) {
      const d = new Date(r.time);
      if (!isNaN(d.getTime())) {
        const key = `${d.getMonth() + 1}/${d.getDate()}`;
        buckets.set(key, (buckets.get(key) || 0) + (r.totalTokens || 0));
      }
    }
    const values = Array.from(buckets.values());
    return { values, labels: [" earliest", "latest"] };
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
  }

  // ---------- details module ----------

  renderDetails({ preserveScroll = false } = {}) {
    // 本函数会重建 .tt-module-bd，明细筛选的下拉随之被替换：先把已打开的浮层摘干净。
    closeOpenSelect();
    closeOpenDate();
    let el = this.container.querySelector("#details-module");
    if (!el) {
      el = h("section", { id: "details-module", className: "tt-module" });
      this.mainEl.appendChild(el);
    }

    const s = this.state.get();
    const rows = this.dashboard?.rows || [];
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const page = Math.min(this.detailsPage, totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);
    const maxTokens = Math.max(...pageRows.map((r) => r.totalTokens || 0), 1);

    const keepScroll = preserveScroll ? el.scrollTop : 0;
    el.innerHTML = "";
    el.append(
      h("div", { className: "tt-module-hd" }, h("span", { className: "tt-module-title" }, "消费明细")),
      h("div", { className: "tt-module-bd dense" },
        this.renderDetailsFilters(s),
        this.renderDetailsTable(pageRows, maxTokens),
        this.renderDetailsPagination(rows.length, page, totalPages),
      ),
    );
    if (preserveScroll) el.scrollTop = keepScroll;

    this.bindDetailsFilters();
    this.bindDetailsPagination();
  }

  renderDetailsFilters(s) {
    const agents = this.agentOptions();
    const models = this.modelOptions();
    const providers = this.providerOptions();

    return h("div", { className: "tt-pills" },
      renderPills(RANGES, s.range, (v) => this.state.patch({ range: v, from: "", to: "" })),
      h("select", { id: "details-agent", className: "tt-pill" }, ...selectOptions(agents, s.agent)),
      h("select", { id: "details-model", className: "tt-pill" }, ...selectOptions(models, s.model)),
      h("select", { id: "details-provider", className: "tt-pill" }, ...selectOptions(providers, s.provider)),
      h("button", { id: "details-export", className: "tt-btn ghost" }, "⤓ 导出"),
    );
  }

  renderDetailsTable(pageRows, maxTokens) {
    if (!pageRows.length) {
      return h("div", { className: "tt-empty" }, "该时间范围内无消费记录");
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
      ...pageRows.map((r) => {
        const ratio = maxTokens > 0 ? Math.min(100, ((r.totalTokens || 0) / maxTokens) * 100) : 0;
        return h("tr", { className: this.dashboard?.summary?.highUsageThreshold > 0 && r.totalTokens >= this.dashboard.summary.highUsageThreshold ? "tt-high-usage" : "" },
          h("td", {}, formatDateTime(r.time)),
          h("td", { title: r.agent }, r.agentName || r.agent || "—"),
          h("td", { title: r.provider }, r.provider || "—"),
          h("td", { title: r.model }, r.model || "—"),
          h("td", { className: "dual" },
            h("div", { style: "display:flex;align-items:baseline;justify-content:flex-end;gap:4px" },
              h("span", { className: "tt-table-unit", style: "margin-right:auto" },
                r.inputTokens != null || r.outputTokens != null
                  ? "输入 " + fmt(r.inputTokens || 0) + " · 输出 " + fmt(r.outputTokens || 0)
                  : "输入 / 输出 —",
              ),
              h("span", { className: "out" }, fmt(r.totalTokens || 0)),
              h("span", { className: "tt-table-unit" }, "tok"),
            ),
            h("div", { className: "tt-inline-bar", ariaHidden: "true" },
              h("i", { style: `width:${ratio.toFixed(1)}%` }),
            ),
          ),
        );
      }),
    );

    return h("div", { className: "tt-table-wrap" },
      h("table", { className: "tt-table" }, thead, tbody),
    );
  }

  renderDetailsPagination(total, page, totalPages) {
    if (total <= PAGE_SIZE) return h("div");
    return h("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--tt-b3)" },
      h("span", { style: "font-size:10px;color:var(--tt-t3)" }, `共 ${total} 条 · ${PAGE_SIZE} 条/页`),
      h("div", { className: "tt-pills" },
        h("button", { className: "tt-pill", "data-page": "prev" }, "‹"),
        ...Array.from({ length: totalPages }, (_, i) => i + 1).map((p) =>
          h("button", { className: `tt-pill${p === page ? " active" : ""}`, "data-page": String(p) }, String(p))
        ),
        h("button", { className: "tt-pill", "data-page": "next" }, "›"),
      ),
    );
  }

  bindDetailsFilters() {
    // 原生 select 保留为状态源，这里把它们换成自绘下拉（幂等，重复调用无副作用）。
    enhanceSelects(this.container);
    this.container.querySelector("#details-agent")?.addEventListener("change", (e) => this.state.patch({ agent: e.target.value }));
    this.container.querySelector("#details-model")?.addEventListener("change", (e) => this.state.patch({ model: e.target.value }));
    this.container.querySelector("#details-provider")?.addEventListener("change", (e) => this.state.patch({ provider: e.target.value }));
    this.container.querySelector("#details-export")?.addEventListener("click", () => this.exportCSV());
  }

  bindDetailsPagination() {
    this.container.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const totalPages = Math.max(1, Math.ceil((this.dashboard?.rows || []).length / PAGE_SIZE));
        let next = this.detailsPage;
        const p = btn.dataset.page;
        if (p === "prev") next = Math.max(1, next - 1);
        else if (p === "next") next = Math.min(totalPages, next + 1);
        else next = Number(p);
        if (next !== this.detailsPage) {
          this.detailsPage = next;
          this.renderDetails();
        }
      });
    });
  }

  async exportCSV() {
    try {
      await saveDetailsCSV(this.hana, this.dashboard?.rows || [], this.state.get().range);
    } catch (err) {
      this.setError(`导出失败：${err.message}`);
    }
  }

  // ---------- realtime module ----------

  renderRealtime() {
    let el = this.container.querySelector("#realtime-module");
    if (!el) {
      el = h("section", { id: "realtime-module", className: "tt-module" });
      this.mainEl.appendChild(el);
    }

    const rt = this.snapshot?.realtime || { connected: false, tps: 0, contextPercent: 0, model: "—", agentName: "—", contextTokens: 0, contextWindow: 0, updatedAt: null };
    const cpShow = rt.contextPercent > 100 ? "99+" : Math.round(rt.contextPercent).toString();

    // 扫描结果写入统计：这份文件是派生数据，写入量该跟“变化量”走而不是“数据量”（见引擎里的落盘调度器）。
    // 叫“扫描结果”而不是“缓存”：界面里其他地方的“缓存”都指模型侧的提示缓存，不要撞名。
    const persistLine = (() => {
      const p = this.snapshot?.persist;
      if (!p) return null; // 旧引擎没这个字段 → 整行不显示
      const bytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MiB" : n >= 1024 ? Math.round(n / 1024) + " KiB" : n + " B";
      if (!p.lastAt) return "还没写（攒批中）";
      return [
        timeAgo(new Date(p.lastAt).getTime()),
        p.lastBytes ? bytes(p.lastBytes) : null,
        p.lastRows != null ? String(p.lastRows) + " 行" + (p.lastScope ? "（" + p.lastScope + "）" : "") : null,
        p.lastReason || null,
        p.dayBytes ? "今日 " + (p.dayWrites != null ? p.dayWrites + " 次 · " : "") + bytes(p.dayBytes) : null,
      ].filter(Boolean).join(" · ");
    })();

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
        persistLine && h("div", { className: "tt-rt-cache" },
          h("span", { title: "应用把会话扫描结果写进本地文件；与模型侧的缓存命中无关" }, "扫描结果写入"),
          h("span", {}, persistLine),
        ),
      ),
    );

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
