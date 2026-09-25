import { bootstrap } from "./bootstrap.mjs";
import { h } from "./components.mjs";
import { enhanceSelects } from "./custom-select.mjs";

const PROVIDER_ORDER = [
  { key: "deepseek", label: "DeepSeek" },
  { key: "glm", label: "GLM" },
  { key: "minimax-token-plan", label: "MiniMax TokenPlan" },
  { key: "sensenova", label: "商汤" },
  { key: "volcengine-coding", label: "火山方舟" },
  { key: "opencode-go", label: "OpenCode Go" },
];

export class SettingsApp {
  constructor({ hana, api, container, mock = false }) {
    this.hana = hana;
    this.api = api;
    this.container = container;
    this.mock = mock;
    this.settings = null;
  }

  async init() {
    this.renderShell();
    try {
      this.settings = await this.api.loadSettings({ mock: this.mock });
    } catch (err) {
      this.settings = this.defaultSettings();
      this.showError(`读取设置失败：${err.message}`);
      return;
    }
    this.renderForm();
  }

  defaultSettings() {
    return {
      scanInterval: 60,
      highUsageThreshold: 30000,
      balanceApis: {},
      display: { density: "compact", colorScheme: "auto" },
    };
  }

  renderShell() {
    this.container.innerHTML = "";
    this.container.className = "tt-main";
    this.formEl = h("form", { className: "tt-form" });
    this.statusEl = h("div", { className: "tt-status-bar" });
    this.container.append(
      h("h1", { className: "tt-title", style: "margin-bottom:8px" }, "Token 用量 设置"),
      this.statusEl,
      this.formEl,
    );
  }

  renderForm() {
    const s = this.settings || this.defaultSettings();
    const apis = s.balanceApis || {};

    this.formEl.innerHTML = "";
    this.formEl.append(
      h("div", { className: "tt-form-row" },
        h("label", {}, "扫描间隔（秒）"),
        h("input", { type: "number", id: "scan-interval", min: "10", value: String(s.scanInterval ?? 60) }),
        h("span", { className: "tt-form-hint" }, "后台多久扫描一次新用量"),
      ),
      h("div", { className: "tt-form-row" },
        h("label", {}, "高消耗阈值（Token）"),
        h("input", { type: "number", id: "high-threshold", min: "0", value: String(s.highUsageThreshold ?? 30000) }),
        h("span", { className: "tt-form-hint" }, "单个会话超过该值会被标记"),
      ),
      h("div", { className: "tt-form-row" },
        h("label", {}, "余额 API 配置"),
        ...PROVIDER_ORDER.map((p) => this.providerRow(p, apis[p.key] || {})),
      ),
      h("div", { className: "tt-form-row" },
        h("label", {}, "显示偏好"),
        h("select", { id: "display-density" },
          h("option", { value: "compact", selected: s.display?.density === "compact" ? "" : undefined }, "紧凑"),
          h("option", { value: "comfortable", selected: s.display?.density === "comfortable" ? "" : undefined }, "舒适"),
        ),
      ),
      h("div", { className: "tt-form-actions" },
        h("button", { type: "button", className: "tt-btn primary", onClick: () => this.onSave() }, "保存"),
        h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.onReset() }, "重置"),
      ),
    );
    // 显示偏好下拉换成自绘控件（原生 select 仍是状态源，collectSettings 照旧读 .value）。
    enhanceSelects(this.formEl);
  }

  providerRow(provider, cfg = {}) {
    const enabled = cfg.enabled === true;
    const fields = provider.key === "sensenova" ? ["token", "username", "password"]
      : provider.key === "volcengine-coding" ? ["ak", "sk", "region"]
      : provider.key === "opencode-go" ? ["workspaceId", "cookie"] : [];
    return h("div", { className: "tt-nav-section" },
      h("label", {}, h("input", { type: "checkbox", id: `enable-${provider.key}`, checked: enabled ? "" : undefined }), provider.label),
      ...fields.map(field => h("label", { className: "tt-form-row" }, field,
        h("input", { type: ["region", "workspaceId", "username"].includes(field) ? "text" : "password",
          id: `${field}-${provider.key}`, value: cfg[field] || "", autocomplete: "off",
          placeholder: cfg.configured?.[field] ? "已配置，留空保留" : field }))),
    );
  }

  collectSettings() {
    const apis = {};
    for (const p of PROVIDER_ORDER) {
      const enabled = this.formEl.querySelector(`#enable-${p.key}`)?.checked || false;
      const cfg = { enabled };
      for (const field of ["token", "username", "password", "ak", "sk", "region", "workspaceId", "cookie"]) {
        const input = this.formEl.querySelector(`#${field}-${p.key}`);
        if (input) cfg[field] = input.value;
      }
      apis[p.key] = cfg;
    }
    return {
      scanInterval: Number(this.formEl.querySelector("#scan-interval")?.value) || 60,
      highUsageThreshold: Number(this.formEl.querySelector("#high-threshold")?.value ?? 30000),
      balanceApis: apis,
      display: {
        density: this.formEl.querySelector("#display-density")?.value || "compact",
      },
    };
  }

  async onSave() {
    this.showStatus("保存中…", "loading");
    const next = this.collectSettings();
    try {
      this.settings = await this.api.saveSettings(next, { mock: this.mock });
      document.documentElement.dataset.density = this.settings.display?.density || "compact";
      this.showStatus("设置已保存", "info");
      this.renderForm();
    } catch (err) {
      this.showError(`保存失败：${err.message}`);
    }
  }

  async onReset() {
    this.settings = this.defaultSettings();
    this.renderForm();
    this.showStatus("已重置为默认，点保存生效", "info");
  }

  showStatus(msg, kind = "info") {
    this.statusEl.className = `tt-status-bar ${kind}`;
    this.statusEl.textContent = msg;
  }

  showError(msg) {
    this.statusEl.className = "tt-status-bar error";
    this.statusEl.textContent = msg;
  }
}

export async function bootSettings(options = {}) {
  const ctx = await bootstrap({ ...options, stateless: true });
  const mock = options.mock || new URLSearchParams(window.location.search).get("mock") === "1";
  const container = document.getElementById("app-root");
  if (!container) throw new Error("#app-root not found");
  const app = new SettingsApp({ hana: ctx.hana, api: ctx.api, container, mock });
  await app.init();
  return app;
}
