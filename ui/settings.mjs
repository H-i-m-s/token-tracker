import { bootstrap } from "./bootstrap.mjs";
import { h } from "./components.mjs";
import { closeOpenSelect, enhanceSelects } from "./custom-select.mjs";
import { UNIT_SYSTEMS, normalizeUnitSystem, scaleText } from "./units.mjs";

// 供应商表。id 必须与服务端 runtime/engine/services/settings.js 的 PROVIDERS 逐字一致：
// 不认识的名字、或者某个 id 下多写一个键，写回时整条会被拒收。
// fields 为空（DeepSeek / GLM）表示这里只能开关——那两家的密钥由引擎自己从 Hana 的模型配置里读，
// 填了也存不进去；其它带 token 的（Minimax TokenPlan、商汤）才真的收凭据。
const PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "密钥自动读 Hana 里已配的 DeepSeek 密钥，这里只管开关",
    fields: [],
  },
  {
    id: "glm",
    label: "GLM",
    hint: "密钥自动读 Hana 里已配的 GLM 密钥，这里只管开关",
    fields: [],
  },
  {
    id: "minimax-token-plan",
    label: "MiniMax TokenPlan",
    hint: "官网 Token Plan 的 5 小时额度和周额度",
    fields: [{ key: "token", label: "Token Plan 密钥", secret: true }],
  },
  {
    id: "sensenova",
    label: "商汤",
    hint: "用官网账号密码登录换取 access_token，约 3 小时自动续期",
    fields: [
      { key: "token", label: "Access Token", secret: true, hint: "可选：填了就不再走账号密码登录" },
      { key: "username", label: "账号" },
      { key: "password", label: "密码", secret: true },
    ],
  },
  {
    id: "volcengine-coding",
    label: "火山方舟",
    hint: "Coding Plan 余量",
    fields: [
      { key: "ak", label: "Access Key", secret: true },
      { key: "sk", label: "Secret Key", secret: true },
      { key: "region", label: "Region", hint: "例如 cn-beijing" },
    ],
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    hint: "工作区页面解析 + 本地估算",
    fields: [
      { key: "workspaceId", label: "Workspace ID", hint: "粘整条链接也行，会自动截成 id" },
      { key: "cookie", label: "Cookie", secret: true, hint: "opencode.ai 的登录 Cookie" },
    ],
  },
];

const DENSITIES = [
  { key: "compact", label: "紧凑" },
  { key: "comfortable", label: "舒适" },
];

// 与服务端 write 里那组区间同源。前端先拦一道，用户不至于填完才挨一句「超出范围」。
const RANGES = {
  "scan-interval": [10, 86400],
  "high-threshold": [0, 1e12],
};
const NUMBER_LABELS = { "scan-interval": "扫描间隔", "high-threshold": "高消耗阈值" };

// 设置页自己的样例：拿一个够大的数，按选中的那套写一遍。
// 这一页除了阈值没有别的数字，不给样例就看不出两套写法的差别。空格与看板一致（看板上是「260.92 亿」）。
const SAMPLE_TOKENS = 123456789;
const unitSample = (key) => scaleText(SAMPLE_TOKENS, { system: key, space: " " });

export class SettingsApp {
  constructor({ hana, api, container, mock = false, update = null }) {
    this.hana = hana;
    this.api = api;
    this.container = container;
    this.mock = mock;
    // 更新说明的控制器（弹窗、快照、开关都归它）。预览模式可能拿不到，所以先允许空。
    this.update = update;
    this.unsubscribeUpdate = null;
    this.settings = null;
    this.baseline = "";
    this.message = null;   // 结论性提示（已保存 / 保存失败）：留着，直到下一次改动
    this.saving = false;
    this.provRows = [];
  }

  async init() {
    this.renderShell();
    this.setNote("读取设置…");
    // 「关于」卡片跟着更新快照走：不管弹窗有没有浮起来，版本号和标记都要是最新的。
    this.unsubscribeUpdate = this.update?.subscribe(() => this.syncAbout()) || null;
    try {
      this.settings = await this.api.loadSettings({ mock: this.mock });
    } catch (err) {
      this.settings = this.defaultSettings();
      this.renderForm();
      this.setNote(`读取设置失败：${err.message}`, "err");
      return;
    }
    this.renderForm();
  }

  defaultSettings() {
    return {
      scanInterval: 60,
      highUsageThreshold: 30000,
      balanceApis: {},
      display: { density: "compact", units: "zh", colorScheme: "auto" },
    };
  }

  // ── 骨架：卡片容器与吸底操作条各建一次。重画只换卡片，底部那颗「已保存」不会被顺手抹掉。
  renderShell() {
    this.container.innerHTML = "";
    this.container.className = "";
    this.root = h("main", { className: "tts" });

    this.cardsEl = h("div", { className: "tts-cards" });
    this.saveBtn = h("button", { type: "button", className: "tt-btn primary", onClick: () => this.onSave() }, "保存");
    this.resetBtn = h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.onDiscard() }, "放弃改动");
    this.noteEl = h("span", { className: "tts-foot__note", role: "status" });

    this.root.append(
      h("p", { className: "tts-sub" }, "扫描、阈值和余额 API 都在这儿改；改完点下面的保存。"),
      this.cardsEl,
      h("div", { className: "tts-foot-wrap" },
        h("footer", { className: "tts-foot" }, this.saveBtn, this.resetBtn, this.noteEl),
      ),
    );
    this.container.append(this.root);
    this.refreshFooter();
  }

  renderForm() {
    const s = this.settings || this.defaultSettings();
    // 自绘下拉的浮层挂在 body 上：重建容器前先收掉，免得留下孤儿面板。
    closeOpenSelect(this.cardsEl);
    this.cardsEl.innerHTML = "";
    this.provRows = [];
    this.cardsEl.append(this.basicCard(s), this.balanceCard(s), this.displayCard(s), this.aboutCard());
    enhanceSelects(this.cardsEl);
    // 徽章与计数都读实时 DOM（比如「凭据填了没有」要看输入框），所以必须等这一批卡片挂进页面之后再算一次。
    for (const row of this.provRows) row.sync();
    this.syncBalanceCount();
    this.syncAbout();
    this.baseline = this.snapshot();
    this.message = null;
    this.refreshFooter();
  }

  // ── 卡片 1：扫描
  basicCard(s) {
    return h("section", { className: "tts-card" },
      h("div", { className: "tts-card__head" }, h("h2", { className: "tts-card__title" }, "扫描")),
      h("p", { className: "tts-card__desc" }, "后台扫描的节奏，以及明细里「高消耗」这条线画在哪里。"),
      h("div", { className: "tts-fields" },
        this.numberField({
          id: "scan-interval",
          title: "扫描间隔（秒）",
          hint: "后台多久扫一次新用量",
          min: 10,
          max: 86400,
          step: 10,
          value: s.scanInterval ?? 60,
        }),
        this.numberField({
          id: "high-threshold",
          title: "高消耗阈值（Token）",
          hint: "单个会话超过这个数，明细里会标出来",
          min: 0,
          max: 1e12,
          step: 1000,
          value: s.highUsageThreshold ?? 30000,
        }),
      ),
    );
  }

  numberField({ id, title, hint, min, max, step, value }) {
    const input = h("input", {
      className: "tts-input tts-input--num",
      type: "number",
      id,
      min: String(min),
      max: String(max),
      step: String(step),
      inputmode: "numeric",
      value: String(value ?? ""),
    });
    input.addEventListener("input", () => this.onEdit());
    return h("div", { className: "tts-field" },
      h("div", { className: "tts-field__label" },
        h("span", { className: "tts-field__title" }, title),
        h("span", { className: "tts-field__hint" }, hint),
        h("span", { className: "tts-field__error", hidden: true }),
      ),
      h("div", { className: "tts-field__control" }, input),
    );
  }

  // ── 卡片 2：余额与配额
  balanceCard(s) {
    const apis = s.balanceApis || {};
    this.balanceCountEl = h("span", { className: "tts-badge" });
    const rows = PROVIDERS.map((spec) => {
      const row = this.providerRow(spec, apis[spec.id] || {});
      this.provRows.push(row);
      return row.node;
    });
    const card = h("section", { className: "tts-card" },
      h("div", { className: "tts-card__head" },
        h("h2", { className: "tts-card__title" }, "余额与配额"),
        this.balanceCountEl,
      ),
      h("p", { className: "tts-card__desc" }, "开着才会去看板的「余额」里出现。密钥只写进本机数据目录，界面不回显；留空表示不动已存的值。"),
      rows,
    );
    return card;
  }

  providerRow(spec, cfg = {}) {
    const enabled = cfg.enabled === true;
    const body = h("div", { className: "tts-prov__body" }, spec.fields.map((field) => this.fieldRow(spec, field, cfg)));
    body.hidden = !enabled;

    const checkbox = h("input", { type: "checkbox", id: `enable-${spec.id}`, checked: enabled ? "" : undefined });
    // 整行是 label：点名字、点说明、点开关都是同一次开合。
    const head = h("label", { className: "tts-prov__head" },
      h("div", { className: "tts-prov__label" },
        h("span", { className: "tts-prov__name" }, spec.label),
        h("span", { className: "tts-prov__hint" }, spec.hint),
      ),
      h("span", { className: "tts-badge" }),
      h("span", { className: "tts-switch" },
        checkbox,
        h("span", { className: "tts-switch__track" }, h("span", { className: "tts-switch__thumb" })),
      ),
    );
    const badge = head.querySelector(".tts-badge");

    const sync = () => {
      const on = checkbox.checked;
      body.hidden = !on;
      const state = this.badgeFor(spec, on);
      badge.textContent = state.text;
      badge.dataset.state = state.state;
    };
    checkbox.addEventListener("change", () => {
      sync();
      this.syncBalanceCount();
      this.onEdit();
    });
    sync();

    return { node: h("div", { className: "tts-prov" }, head, body), sync, checkbox };
  }

  // 徽章只说一件事：这条通道此刻能不能用。关着＝灰，缺凭据＝橙，齐了＝绿。
  badgeFor(spec, enabled) {
    if (!enabled) return { text: "已关闭", state: "off" };
    const secrets = spec.fields.filter((f) => f.secret === true);
    if (!secrets.length) return { text: "已开启", state: "ok" };
    const stored = this.settings?.balanceApis?.[spec.id]?.configured || {};
    const missing = secrets.filter((f) => {
      const typed = (this.root.querySelector(`#field-${spec.id}-${f.key}`)?.value || "").trim();
      return !typed && stored[f.key] !== true;
    });
    if (!missing.length) return { text: "已配置", state: "ok" };
    return { text: secrets.length === 1 ? "待填密钥" : `待填 ${missing.length} 项`, state: "todo" };
  }

  fieldRow(spec, field, cfg) {
    const isSecret = field.secret === true;
    const stored = cfg.configured?.[field.key] === true;
    const input = h("input", {
      className: "tts-input",
      type: isSecret ? "password" : "text",
      id: `field-${spec.id}-${field.key}`,
      // 凭据从不回显：服务端只告诉我们「存过没有」，所以这里只放一句占位。
      value: isSecret ? "" : (typeof cfg[field.key] === "string" ? cfg[field.key] : ""),
      autocomplete: "off",
      spellcheck: "false",
      placeholder: isSecret && stored ? "已配置，留空保留" : "",
    });
    input.addEventListener("input", () => this.onEdit());
    return h("div", { className: "tts-field" },
      h("div", { className: "tts-field__label" },
        h("span", { className: "tts-field__title" }, field.label),
        field.hint ? h("span", { className: "tts-field__hint" }, field.hint) : null,
      ),
      h("div", { className: "tts-field__control" }, input),
    );
  }

  // 一行「左标签右下拉」。做成一个口子是因为这一张卡片里两行同构，不必各写一遍标记。
  // hint 传字符串就是静态说明，传函数就用它的返回值（样例需要跟着选中项实时重算）。
  selectField({ id, title, hint, options, value, onChange }) {
    const select = h("select", { id, className: "tts-select" },
      options.map((o) => h("option", { value: o.key, selected: o.key === value ? "" : undefined }, o.label)),
    );
    select.addEventListener("change", () => onChange(select.value));
    const hintEl = h("span", { className: "tts-field__hint" }, typeof hint === "function" ? hint(value) : hint);
    return {
      hintEl,
      node: h("div", { className: "tts-field" },
        h("div", { className: "tts-field__label" },
          h("span", { className: "tts-field__title" }, title),
          hintEl,
        ),
        h("div", { className: "tts-field__control" }, select),
      ),
    };
  }

  // ── 卡片 3：显示
  displayCard(s) {
    const density = s.display?.density === "comfortable" ? "comfortable" : "compact";
    const units = normalizeUnitSystem(s.display?.units);
    const densityField = this.selectField({
      id: "display-density",
      title: "表格密度",
      hint: "紧凑少一行高，舒适留白多一点",
      options: DENSITIES,
      value: density,
      onChange: () => this.onEdit(),
    });
    const unitsField = this.selectField({
      id: "display-units",
      title: "数字单位",
      hint: (key) => `当前写法：${unitSample(key)}`,
      options: UNIT_SYSTEMS,
      value: units,
      onChange: (key) => {
        unitsField.hintEl.textContent = `当前写法：${unitSample(key)}`;
        this.onEdit();
      },
    });
    return h("section", { className: "tts-card" },
      h("div", { className: "tts-card__head" }, h("h2", { className: "tts-card__title" }, "显示")),
      h("p", { className: "tts-card__desc" }, "只影响这个 App 自己的页面：看板、卡片、明细和输入栏状态位都跟着走。"),
      h("div", { className: "tts-fields" }, densityField.node, unitsField.node),
    );
  }

  // ── 卡片 4：关于
  // 版本与更新说明。说明一字不落地来自 GitHub Release（插件进程去取），不随 App 打包。
  // 这一格也是「关掉自动弹窗」之后仍然看得见版本与新版标记的地方。
  aboutCard() {
    this.aboutCurrent = h("b", { className: "tts-about__ver" }, "—");
    this.aboutLatest = h("b", { className: "tts-about__ver" }, "—");
    this.aboutTag = h("button", {
      type: "button", className: "tts-about__tag", hidden: true,
      title: "打开更新说明",
      onClick: () => this.update?.openManual(),
    }, "有新版本");

    const toggle = h("input", { type: "checkbox", id: "tt-update-notice" });
    this.aboutToggle = toggle;
    toggle.addEventListener("change", async () => {
      const on = toggle.checked;
      this.setNote(on ? "已开启更新提示" : "已关闭更新提示", "ok");
      try {
        await this.api.dismissUpdate({ action: "toggle", enabled: on, mock: this.mock });
      } catch (err) {
        this.setNote(`更新提示没能存下来：${err.message}`, "err");
      }
    });

    const row = (label, ...kids) => h("div", { className: "tts-about__row" },
      h("span", { className: "tts-about__label" }, label), ...kids);

    return h("section", { className: "tts-card" },
      h("div", { className: "tts-card__head" }, h("h2", { className: "tts-card__title" }, "关于")),
      h("p", { className: "tts-card__desc" }, "版本与更新说明。说明内容来自 GitHub Release，不随 App 打包；关掉更新提示后仍可在这里手动看。"),
      h("div", { className: "tts-about" },
        row("当前版本", this.aboutCurrent),
        row("最新版本", this.aboutLatest, this.aboutTag),
        h("label", { className: "tts-about__row tts-about__row--toggle" },
          h("span", { className: "tts-about__label" }, "更新提示"),
          h("span", { className: "tts-about__hint" }, "扫描到新版本就弹窗提醒"),
          h("span", { className: "tts-switch" },
            toggle,
            h("span", { className: "tts-switch__track" }, h("span", { className: "tts-switch__thumb" })),
          ),
        ),
        row("检查",
          h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.update?.openManual() }, "检查更新"),
          h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.update?.openCached() }, "查看更新说明"),
        ),
      ),
    );
  }

  // 快照一到就刷这一格：版本号、新版标记、开关状态。不自己算版本高低，只听服务端的判断。
  syncAbout() {
    if (!this.aboutCurrent) return;
    const d = this.update?.data;
    this.aboutCurrent.textContent = d?.current ? `v${d.current}` : "—";
    this.aboutLatest.textContent = d ? (d.latest ? `v${d.latest.version}` : "—") : "…";
    const showTag = !!d?.hasUpdate;
    this.aboutTag.hidden = !showTag;
    if (showTag) this.aboutTag.textContent = `有新版本 v${d.latest.version}`;
    if (this.aboutToggle) this.aboutToggle.checked = d ? d.enabled !== false : true;
  }

  // ── 取值与状态
  snapshot() {
    return JSON.stringify(this.collectSettings());
  }

  isDirty() {
    return this.snapshot() !== this.baseline;
  }

  collectSettings() {
    const apis = {};
    for (const p of PROVIDERS) {
      const cfg = { enabled: this.root.querySelector(`#enable-${p.id}`)?.checked === true };
      for (const f of p.fields) {
        const input = this.root.querySelector(`#field-${p.id}-${f.key}`);
        if (input) cfg[f.key] = input.value;
      }
      apis[p.id] = cfg;
    }
    return {
      scanInterval: this.numberValue("scan-interval"),
      highUsageThreshold: this.numberValue("high-threshold"),
      balanceApis: apis,
      display: {
        density: this.root.querySelector("#display-density")?.value || "compact",
        units: normalizeUnitSystem(this.root.querySelector("#display-units")?.value),
      },
    };
  }

  numberValue(id) {
    const raw = this.root.querySelector(`#${id}`)?.value ?? "";
    const v = Number(raw);
    return raw.trim() !== "" && Number.isFinite(v) ? v : null;
  }

  onEdit() {
    this.message = null;
    this.refreshFooter();
    this.syncProvBadges();
  }

  syncProvBadges() {
    for (const row of this.provRows) row.sync();
    this.syncBalanceCount();
  }

  syncBalanceCount() {
    if (!this.balanceCountEl) return;
    const on = this.provRows.filter((row) => row.checkbox?.checked).length;
    this.balanceCountEl.textContent = on ? `${on} 个已开启` : "全部关闭";
    this.balanceCountEl.dataset.state = on ? "ok" : "off";
  }

  refreshFooter() {
    const dirty = this.isDirty();
    this.saveBtn.disabled = !dirty || this.saving;
    this.resetBtn.disabled = !dirty || this.saving;
    if (this.saving || this.message) return;
    this.setNote(dirty ? "有未保存的改动" : "");
  }

  setNote(text, kind = "") {
    this.noteEl.textContent = text || "";
    if (kind) this.noteEl.dataset.kind = kind;
    else delete this.noteEl.dataset.kind;
  }

  // 校验只做数字两项：区间与服务端同一组，错误就地写在那一行下面，别让人滚回去找。
  validate() {
    const problems = [];
    for (const [id, [min, max]] of Object.entries(RANGES)) {
      const input = this.root.querySelector(`#${id}`);
      if (!input) continue;
      const row = input.closest(".tts-field");
      const errEl = row?.querySelector(".tts-field__error");
      const raw = input.value ?? "";
      const v = Number(raw);
      let msg = "";
      if (raw.trim() === "" || !Number.isFinite(v)) msg = "请填一个数字";
      else if (v < min || v > max) msg = `范围 ${min} – ${max}`;
      input.setAttribute("aria-invalid", msg ? "true" : "false");
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = !msg;
      }
      if (msg) problems.push(`${NUMBER_LABELS[id]}：${msg}`);
    }
    return problems;
  }

  async onSave() {
    const problems = this.validate();
    if (problems.length) {
      this.message = { text: problems.join("；"), kind: "err" };
      this.setNote(this.message.text, "err");
      return;
    }
    this.saving = true;
    this.refreshFooter();
    this.setNote("保存中…");
    try {
      this.settings = await this.api.saveSettings(this.collectSettings(), { mock: this.mock });
      const density = this.settings.display?.density || "compact";
      document.documentElement.dataset.density = density;
      this.renderForm();
      this.message = { text: "已保存", kind: "ok" };
      this.setNote(this.message.text, "ok");
    } catch (err) {
      this.message = { text: `保存失败：${err.message}`, kind: "err" };
      this.setNote(this.message.text, "err");
    } finally {
      this.saving = false;
      this.refreshFooter();
    }
  }

  // 放弃改动＝回到读进来的那一份，不再往返一次服务端：没保存过，磁盘上就是它。
  onDiscard() {
    this.renderForm();
    this.message = { text: "已放弃未保存的改动", kind: "" };
    this.setNote(this.message.text);
  }
}

export async function bootSettings(options = {}) {
  const ctx = await bootstrap({ ...options, stateless: true });
  const mock = options.mock || new URLSearchParams(window.location.search).get("mock") === "1";
  const container = document.getElementById("app-root");
  if (!container) throw new Error("#app-root not found");
  const app = new SettingsApp({ hana: ctx.hana, api: ctx.api, container, mock, update: ctx.update });
  await app.init();
  return app;
}
