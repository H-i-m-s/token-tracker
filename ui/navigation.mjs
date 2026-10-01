import { applyAppearance } from "./appearance.mjs";
import { saveDetailsCSV } from "./csv-export.mjs";
import { decodeRows } from "./details-view.mjs";
import { bootstrap } from "./bootstrap.mjs";
import { h, RANGES, fmt, fmtCost, fmtPct, renderPills, rankAgents } from "./components.mjs";

export class NavigationApp {
  constructor({ hana, api, state, container, mock = false }) {
    this.hana = hana;
    this.api = api;
    this.state = state;
    this.container = container;
    this.mock = mock;

    this.snapshot = null;
    this.dashboard = null;
    this.loading = false;
    this.loadRequest = 0;
    this.disposed = false;
  }

  async init() {
    this.renderShell();
    this.state.subscribe(() => {
      this.renderFilters();
      if (this.filterKey !== this.currentFilterKey()) this.loadAll();
    });
    await this.loadAll();
  }

  dispose() {
    this.disposed = true;
    ++this.loadRequest;
    this.state.dispose();
  }

  renderShell() {
    this.container.innerHTML = "";
    this.container.className = "tt-nav";

    this.summarySection = h("div", { className: "tt-nav-section" });
    this.balanceSection = h("div", { className: "tt-nav-section" });
    this.rankSection = h("div", { className: "tt-nav-section" });
    this.filterSection = h("div", { className: "tt-nav-section" });

    this.container.append(
      this.summarySection,
      this.balanceSection,
      this.rankSection,
      this.filterSection,
    );

    this.renderFilters();
  }

  currentFilterKey() {
    const s = this.state.get();
    return JSON.stringify([s.range, s.from, s.to, s.agent, s.model, s.provider, s.type]);
  }

  async loadAll() {
    this.filterKey = this.currentFilterKey();
    const request = ++this.loadRequest;
    const filters = this.state.get();
    const current = () => !this.disposed && request === this.loadRequest;
    this.dashboard = null;
    this.summarySection.textContent = "正在读取所选范围…";
    this.rankSection.replaceChildren();
    await Promise.all([
      (async () => {
        let snapshot = null;
        try {
          snapshot = await this.api.getSnapshot({ mock: this.mock });
          if (!snapshot.balances?.length) snapshot.balances = await this.api.getBalances({ mock: this.mock });
        } catch {}
        if (!current()) return;
        this.snapshot = snapshot;
        this.renderBalance();
      })(),
      (async () => {
        let dashboard = null;
        try { dashboard = decodeRows(await this.api.getDashboard(filters, { mock: this.mock })); } catch {}
        if (!current()) return;
        this.dashboard = dashboard;
        this.renderSummary();
        this.renderRanking();
      })(),
    ]);
  }

  renderSummary() {
    if (!this.dashboard) { this.summarySection.textContent = "所选范围加载失败，请刷新重试"; return; }
    const summary = this.dashboard.summary;
    this.summarySection.innerHTML = "";
    this.summarySection.append(
      h("div", { className: "tt-nav-title" }, (RANGES.find(r => r.key === this.state.get().range)?.label || "所选范围") + "摘要"),
      h("div", { className: "tt-nav-row" }, h("span", { className: "k" }, "Token"), h("span", { className: "v" }, fmt(summary.totalTokens))),
      h("div", { className: "tt-nav-row" }, h("span", { className: "k" }, "成本"), h("span", { className: "v" }, (summary.totalTokens > 0 && !summary.estimatedCost ? "未完整定价" : fmtCost(summary.estimatedCost)))),
      h("div", { className: "tt-nav-row" }, h("span", { className: "k" }, "活跃 Agent"), h("span", { className: "v" }, String(summary.agentCount || 0))),
    );
  }

  renderBalance() {
    const balances = this.snapshot?.balances || [];
    this.balanceSection.innerHTML = "";
    this.balanceSection.append(h("div", { className: "tt-nav-title" }, "余额/配额"));

    if (!balances.length) {
      this.balanceSection.appendChild(h("div", { className: "tt-empty" }, "未配置"));
      return;
    }

    for (const b of balances) {
      this.balanceSection.appendChild(
        h("div", { className: "tt-nav-row" },
          h("span", { className: "k" }, b.provider),
          h("span", { className: "v", style: `color:${b.barColor}` }, b.limit > 0 ? `${b.usedPercent.toFixed(0)}%` : b.display),
        ),
      );
      if (b.limit > 0) {
        this.balanceSection.appendChild(
          h("div", { className: "tt-bal-track" },
            h("div", { className: "tt-bal-fill", style: `width:${b.usedPercent.toFixed(1)}%;background:${b.barColor}` }),
          ),
        );
      }
    }
  }

  renderRanking() {
    const rows = (this.dashboard?.agents || []).map(a => ({ agent: a.id, totalTokens: a.totalTokens }));
    const ranks = rankAgents(rows, this.snapshot?.agentNames || {});
    this.rankSection.innerHTML = "";
    this.rankSection.append(h("div", { className: "tt-nav-title" }, "Agent 排名"));

    if (!ranks.length) {
      this.rankSection.appendChild(h("div", { className: "tt-empty" }, "暂无数据"));
      return;
    }

    const list = h("div", { className: "tt-nav-list" });
    for (const a of ranks.slice(0, 6)) {
      list.appendChild(
        h("div", { className: "tt-nav-item" },
          h("span", { className: "name" }, a.name),
          h("span", { className: "meta" }, `${fmt(a.totalTokens)} · ${a.percent}%`),
        ),
      );
    }
    this.rankSection.appendChild(list);
  }

  renderFilters() {
    applyAppearance(this.state.get().appearance);
    const s = this.state.get();
    this.filterSection.innerHTML = "";
    this.filterSection.append(
      h("div", { className: "tt-nav-title" }, "筛选"),
      renderPills(RANGES, s.range, (v) => this.state.patch({ range: v, from: "", to: "" }), ""),
      h("div", { style: "display:flex;gap:6px;margin-top:8px" },
        h("button", { className: "tt-btn primary", onClick: () => this.onRefresh() }, "↻ 刷新"),
        h("button", { className: "tt-btn ghost", onClick: () => this.onExport() }, "⤓ 导出"),
      ),
    );


  }

  async onRefresh() {
    try {
      await this.api.refresh({ force: true, mock: this.mock });
      await this.loadAll();
    } catch (err) {
      this.summarySection.appendChild(h("div", { className: "tt-error" }, `刷新失败：${err.message}`));
    }
  }

  async onExport() {
    try {
      // 明细已服务端分页，这一页拿不到「全部行」：CSV 必须由引擎按当前筛选/排序拼好再保存。
      const csv = await this.api.getDetailsCsv(this.state.get(), { mock: this.mock });
      await saveDetailsCSV(this.hana, csv, this.state.get().range);
    } catch (err) {
      this.summarySection.appendChild(h("div", { className: "tt-error" }, `导出失败：${err.message}`));
    }
  }
}

export async function bootNavigation(options = {}) {
  const ctx = await bootstrap(options);
  const mock = options.mock || new URLSearchParams(window.location.search).get("mock") === "1";
  const container = document.getElementById("app-root");
  if (!container) throw new Error("#app-root not found");
  const app = new NavigationApp({ ...ctx, container, mock });
  await app.init();
  window.addEventListener("pagehide", () => app.dispose(), { once: true });
  return app;
}
