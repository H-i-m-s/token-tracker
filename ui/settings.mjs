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

// 检查间隔的合法区间与服务端 lib/update-check.mjs 同源。本地先拦一道给个立即可见的反馈，
// 真正的规矩在服务端（文本输入能绕过前端）。
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 10080;
function parseInterval(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= INTERVAL_MIN && n <= INTERVAL_MAX ? n : null;
}

// 「已保存」浮多久。默认什么都不显示，动过之后才浮一下，然后自己走，不留噪声。
const SAVED_FADE_MS = 2000;

// 设置页自己的样例：拿一个够大的数，按选中的那套写一遍。
// 这一页除了阈值没有别的数字，不给样例就看不出两套写法的差别。空格与看板一致（看板上是「260.92 亿」）。
const SAMPLE_TOKENS = 123456789;
const unitSample = (key) => scaleText(SAMPLE_TOKENS, { system: key, space: " " });

// ── 这一页的契约 ──
// 改了就是改了，没有整页保存。每张卡自己提交：下拉、开关一改就写；文本框在失焦或回车时写。
// 每次只发这一张卡的那几项，服务端按份合并（见 runtime/engine/services/settings.js 的 write），
// 所以「扫描间隔 + 阈值」不需要一起发也不会写出半份状态。
//
// 「关于」卡另外两格走的是另一条通道（更新提示开关与检查间隔存在插件进程的状态文件里），
// 但用户看到的仍然只有一种契约：改完就生效。
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
    this.provRows = [];
    // 每张卡的提交口，按 id 存。renderForm 重建卡片时会整体换掉。
    this.cards = new Map();
  }

  async init() {
    this.renderShell();
    this.setPageNote("读取设置…");
    // 「关于」卡片跟着更新快照走：不管弹窗有没有浮起来，版本号和标记都要是最新的。
    this.unsubscribeUpdate = this.update?.subscribe(() => this.syncAbout()) || null;
    try {
      this.settings = await this.api.loadSettings({ mock: this.mock });
    } catch (err) {
      this.settings = this.defaultSettings();
      this.renderForm();
      this.setPageNote(`读取设置失败：${err.message}`, "err");
      return;
    }
    this.renderForm();
    this.setPageNote("");
    // 关页面前把还停在输入框里、没来得及失焦的那一笔补上。
    const flush = () => this.flushPending();
    window.addEventListener("pagehide", flush, { once: true });
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.flushPending(); });
  }

  defaultSettings() {
    return {
      scanInterval: 60,
      highUsageThreshold: 30000,
      balanceApis: {},
      display: { density: "compact", units: "zh", colorScheme: "auto" },
    };
  }

  // ── 骨架 ──
  // 整页只有一行小字和卡片组：没有保存按钮，所以没有「有未保存的改动」这种状态要维护。
  renderShell() {
    this.container.innerHTML = "";
    this.container.className = "";
    this.root = h("main", { className: "tts" });
    this.cardsEl = h("div", { className: "tts-cards" });
    // 页面级提示：读取失败、某次保存失败的详细原因。平时是空的（CSS 里 :empty 不占位置）。
    this.pageNoteEl = h("p", { className: "tts-page-note", role: "status" });
    this.root.append(
      h("p", { className: "tts-sub" }, "扫描、阈值和余额 API 都在这儿改；每张卡改完就自己存，不用点保存。"),
      this.pageNoteEl,
      this.cardsEl,
    );
    this.container.append(this.root);
  }

  renderForm() {
    const s = this.settings || this.defaultSettings();
    // 自绘下拉的浮层挂在 body 上：重建容器前先收掉，免得留下孤儿面板。
    closeOpenSelect(this.cardsEl);
    this.cardsEl.innerHTML = "";
    this.cards.clear();
    this.provRows = [];
    this.cardsEl.append(this.basicCard(s), this.balanceCard(s), this.displayCard(s), this.aboutCard());
    enhanceSelects(this.cardsEl);
    // 徽章与计数都读实时 DOM（比如「凭据填了没有」要看输入框），所以必须等这一批卡片挂进页面之后再算一次。
    for (const row of this.provRows) row.sync();
    this.syncBalanceCount();
    this.syncAbout();
    // 基线＝这次打开设置页时每张卡是什么值。「恢复上次的值」就是回到这里。
    for (const card of this.cards.values()) this.markClean(card);
  }

  /**
   * 注册一张卡的提交口。三件事必须成套给，缺一样这张卡就没法自洽：
   *   read()         从 DOM 收这一张卡的值（DOM 仍是唯一状态源，读完不留影子状态）
   *   write(values)  怎么落盘；抛错就由外面摆成「保存失败」
   *   apply(values)  把值写回 DOM（「恢复上次的值」用）
   */
  registerCard(id, { read, write, apply }) {
    const stateEl = h("span", { className: "tts-card__state" });
    const restoreEl = h("button", {
      type: "button",
      className: "tts-card__restore",
      hidden: true,
      title: "恢复成这次打开设置页时的值",
      onClick: () => this.restoreCard(id),
    }, "恢复上次的值");
    const card = { id, read, write, apply, stateEl, restoreEl, baseline: "", busy: false, pending: false, fade: null };
    this.cards.set(id, card);
    return card;
  }

  /** 卡片头：标题在左，右边依次是这张卡自己的东西（徽章之类）、恢复入口、提交状态。 */
  cardHead(title, card, extra = null) {
    return h("div", { className: "tts-card__head" },
      h("h2", { className: "tts-card__title" }, title),
      h("div", { className: "tts-card__right" }, extra, card.restoreEl, card.stateEl),
    );
  }

  // ── 提交 ──
  /** 值变了：立即提交这一张卡（下拉、开关、回车都走这里）。 */
  async commitCard(id, { force = false } = {}) {
    const card = this.cards.get(id);
    if (!card) return;
    // 上一次还没回来：记住这一笔，等它结束再提交，不丢改动。
    if (card.busy) { card.pending = true; return; }
    if (!force && this.cardValue(card) === card.baseline) { this.syncRestoreEntry(card); return; }
    // 本地先拦一道：数字两项填得不对就不发，错误已经写在那一行下面了。
    const problems = id === "basic" ? this.validateNumbers() : [];
    if (problems.length) {
      this.setCardState(card, "error", "填得不对");
      this.setPageNote(problems.join("；"), "err");
      this.syncRestoreEntry(card);
      return;
    }
    card.busy = true;
    this.setCardState(card, "saving", "保存中…");
    const values = card.read();
    try {
      await card.write(values);
      this.markClean(card);
      this.setPageNote("");
      this.setCardState(card, "saved", "已保存", true);
    } catch (err) {
      // 失败之后基线不动：这一笔还在她眼前，点「恢复上次的值」能收回来。
      this.setCardState(card, "error", "保存失败");
      this.setPageNote(`保存失败：${err?.message || err}`, "err");
      this.syncRestoreEntry(card);
    } finally {
      card.busy = false;
      if (card.pending) { card.pending = false; void this.commitCard(id); }
    }
  }
  /** 回到基线值，然后照常走一遍提交（失败提示、校验还是同一套）。 */
  async restoreCard(id) {
    const card = this.cards.get(id);
    if (!card || !card.baseline) return;
    try { card.apply(JSON.parse(card.baseline)); } catch {}
    this.syncRestoreEntry(card);
    // force：还原之后 DOM 等于基线，普通提交会被「没变就不发」这条挡掉，而盘上那一份还是改过的值。
    await this.commitCard(id, { force: true });
  }

  /** 关页面时把没来得及失焦的那一笔补上。异步可能跑不完，总比什么都不做强。 */
  flushPending() {
    for (const card of this.cards.values()) {
      if (card.busy) continue;
      if (this.cardValue(card) !== card.baseline) void this.commitCard(card.id);
    }
  }

  cardValue(card) {
    if (!card) return "";
    try { return JSON.stringify(card.read()); } catch { return card.baseline; }
  }

  markClean(card) {
    card.baseline = this.cardValue(card);
    this.syncRestoreEntry(card);
  }

  syncRestoreEntry(card) {
    if (!card?.restoreEl) return;
    card.restoreEl.hidden = this.cardValue(card) === card.baseline;
  }

  setCardState(card, state, text, fade = false) {
    if (!card.stateEl) return;
    if (card.fade) { clearTimeout(card.fade); card.fade = null; }
    card.stateEl.textContent = text || "";
    if (state) card.stateEl.dataset.state = state;
    else delete card.stateEl.dataset.state;
    if (fade) card.fade = setTimeout(() => this.setCardState(card, "", ""), SAVED_FADE_MS);
  }

  setPageNote(text, kind = "") {
    if (!this.pageNoteEl) return;
    this.pageNoteEl.textContent = text || "";
    if (kind) this.pageNoteEl.dataset.kind = kind;
    else delete this.pageNoteEl.dataset.kind;
  }

  // ── 卡片 1：扫描
  basicCard(s) {
    const card = this.registerCard("basic", {
      read: () => ({
        scanInterval: this.numberValue("scan-interval"),
        highUsageThreshold: this.numberValue("high-threshold"),
      }),
      write: async (values) => {
        this.settings = await this.api.saveSettings(values, { mock: this.mock });
      },
      apply: (values) => {
        this.setNumberValue("scan-interval", values.scanInterval);
        this.setNumberValue("high-threshold", values.highUsageThreshold);
      },
    });
    return h("section", { className: "tts-card" },
      this.cardHead("扫描", card),
      h("p", { className: "tts-card__desc" }, "后台扫描的节奏，以及明细里「高消耗」这条线画在哪里。"),
      h("div", { className: "tts-fields" },
        this.numberField({
          card: "basic",
          id: "scan-interval",
          title: "扫描间隔（秒）",
          hint: "后台多久扫一次新用量",
          min: RANGES["scan-interval"][0],
          max: RANGES["scan-interval"][1],
          step: 10,
          value: s.scanInterval ?? 60,
        }),
        this.numberField({
          card: "basic",
          id: "high-threshold",
          title: "高消耗阈值（Token）",
          hint: "单个会话超过这个数，明细里会标出来",
          min: RANGES["high-threshold"][0],
          max: RANGES["high-threshold"][1],
          step: 1000,
          value: s.highUsageThreshold ?? 30000,
        }),
      ),
    );
  }

  // 数字两项：打字时不写盘（数字打到一半写进去没有意义），只实时校验 + 更新恢复入口；
  // 失焦或回车（原生 change）才提交。
  numberField({ card, id, title, hint, min, max, step, value }) {
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
    input.addEventListener("input", () => {
      this.validateNumbers();
      this.syncRestoreEntry(this.cards.get(card));
    });
    input.addEventListener("change", () => { void this.commitCard(card); });
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
    const card = this.registerCard("balance", {
      read: () => ({
        balanceApis: Object.fromEntries(PROVIDERS.map((spec) => {
          const cfg = { enabled: this.root.querySelector(`#enable-${spec.id}`)?.checked === true };
          for (const f of spec.fields) {
            const input = this.root.querySelector(`#field-${spec.id}-${f.key}`);
            if (input) cfg[f.key] = input.value;
          }
          return [spec.id, cfg];
        })),
      }),
      write: async (values) => {
        this.settings = await this.api.saveSettings({ balanceApis: values.balanceApis }, { mock: this.mock });
        // 凭据从不回显：写成功之后把密码框清空，改由徽章和占位符表示「已配置，留空保留」。
        for (const spec of PROVIDERS) {
          for (const f of spec.fields) {
            if (f.secret !== true) continue;
            const input = this.root.querySelector(`#field-${spec.id}-${f.key}`);
            if (!input) continue;
            input.value = "";
            input.placeholder = this.settings?.balanceApis?.[spec.id]?.configured?.[f.key] ? "已配置，留空保留" : "";
          }
        }
        this.syncProvBadges();
      },
      apply: (values) => {
        for (const spec of PROVIDERS) {
          const cfg = values.balanceApis?.[spec.id] || {};
          const checkbox = this.root.querySelector(`#enable-${spec.id}`);
          if (checkbox) checkbox.checked = cfg.enabled === true;
          for (const f of spec.fields) {
            const input = this.root.querySelector(`#field-${spec.id}-${f.key}`);
            if (!input) continue;
            // 密钥框本来就只放占位符：还原成空 = 服务端那份不动（空值不覆盖已存的凭据）。
            input.value = f.secret === true ? "" : (typeof cfg[f.key] === "string" ? cfg[f.key] : "");
          }
        }
        this.syncProvBadges();
      },
    });

    this.balanceCountEl = h("span", { className: "tts-badge" });
    const rows = PROVIDERS.map((spec) => {
      const row = this.providerRow(spec, apis[spec.id] || {});
      this.provRows.push(row);
      return row.node;
    });
    return h("section", { className: "tts-card" },
      this.cardHead("余额与配额", card, this.balanceCountEl),
      h("p", { className: "tts-card__desc" }, "开着才会去看板的「余额」里出现。密钥只写进本机数据目录，界面不回显；留空表示不动已存的值。"),
      rows,
    );
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
      void this.commitCard("balance");
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
    // 打字时只更新徽章与恢复入口，失焦或回车才真的写盘。
    input.addEventListener("input", () => {
      this.syncProvBadges();
      this.syncRestoreEntry(this.cards.get("balance"));
    });
    input.addEventListener("change", () => { void this.commitCard("balance"); });
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
  selectField({ card, id, title, hint, options, value, onChange }) {
    const select = h("select", { id, className: "tts-select" },
      options.map((o) => h("option", { value: o.key, selected: o.key === value ? "" : undefined }, o.label)),
    );
    select.addEventListener("change", () => {
      onChange(select.value);
      void this.commitCard(card);
    });
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
    const card = this.registerCard("display", {
      read: () => ({
        display: {
          density: this.root.querySelector("#display-density")?.value || "compact",
          units: normalizeUnitSystem(this.root.querySelector("#display-units")?.value),
        },
      }),
      write: async (values) => {
        this.settings = await this.api.saveSettings({ display: values.display }, { mock: this.mock });
        // 密度是这个 App 所有页面的公共档位：这一页自己也跟着变，改完立刻能看见。
        document.documentElement.dataset.density = this.settings.display?.density || "compact";
      },
      apply: (values) => {
        const set = (id, v) => {
          const el = this.root.querySelector(`#${id}`);
          if (!el) return;
          el.value = v;
          // 自绘下拉的触发器是另一个节点：改完原生 select 得让它重画文案，否则屏幕上还是旧值。
          el._ttSelect?.sync?.();
        };
        const units = normalizeUnitSystem(values.display?.units);
        set("display-density", values.display?.density || "compact");
        set("display-units", units);
        if (unitsField) unitsField.hintEl.textContent = `当前写法：${unitSample(units)}`;
      },
    });
    const densityField = this.selectField({
      card: "display",
      id: "display-density",
      title: "表格密度",
      hint: "紧凑少一行高，舒适留白多一点",
      options: DENSITIES,
      value: density,
      onChange: () => {},
    });
    const unitsField = this.selectField({
      card: "display",
      id: "display-units",
      title: "数字单位",
      hint: (key) => `当前写法：${unitSample(key)}`,
      options: UNIT_SYSTEMS,
      value: units,
      onChange: (key) => {
        unitsField.hintEl.textContent = `当前写法：${unitSample(key)}`;
      },
    });
    return h("section", { className: "tts-card" },
      this.cardHead("显示", card),
      h("p", { className: "tts-card__desc" }, "只影响这个 App 自己的页面：看板、卡片、明细和输入栏状态位都跟着走。"),
      h("div", { className: "tts-fields" }, densityField.node, unitsField.node),
    );
  }

  // ── 卡片 4：关于
  // 版本与更新说明。说明一字不落地来自 GitHub Release（插件进程去取），不随 App 打包。
  // 这一格也是「关掉自动弹窗」之后仍然看得见版本与新版标记的地方。
  //
  // 这一张卡的另外两格（更新提示开关、检查间隔）存在插件进程的状态文件里，不走 /settings；
  // 但对用户来说是同一条规则：改完就存。间隔非法时只标红、不提交。
  aboutCard() {
    const card = this.registerCard("about", {
      read: () => ({
        enabled: this.aboutToggle.checked,
        // 输入框非法时退回服务端现在的值：否则点一下开关会把一个坏数字一起发出去。
        intervalMinutes: parseInterval(this.aboutInterval.value) ?? (this.update?.data?.intervalMinutes ?? 360),
      }),
      write: async (values) => {
        await this.api.dismissUpdate({ action: "toggle", enabled: values.enabled, mock: this.mock });
        await this.api.setUpdateInterval(values.intervalMinutes, { mock: this.mock });
        // 新间隔可能已经过期，顺手问一次（间隔没到它不会真出门）。
        void this.update?.refresh();
      },
      apply: (values) => {
        if (this.aboutToggle) this.aboutToggle.checked = values.enabled !== false;
        if (this.aboutInterval) this.aboutInterval.value = String(values.intervalMinutes ?? 360);
        this.setIntervalHint("");
      },
    });

    this.aboutCurrent = h("b", { className: "tts-about__ver" }, "—");
    this.aboutLatest = h("b", { className: "tts-about__ver" }, "—");
    this.aboutTag = h("button", {
      type: "button", className: "tts-about__tag", hidden: true,
      title: "打开更新说明",
      onClick: () => this.update?.openManual(),
    }, "有新版本");

    const toggle = h("input", { type: "checkbox", id: "tt-update-notice" });
    this.aboutToggle = toggle;
    toggle.addEventListener("change", () => { void this.commitCard("about"); });

    // 检查间隔：文本输入框，单位分钟（默认 360，即 6 小时）。
    // 填得不对就只标红、不提交，也不替她改成默认值；失焦或回车才试一次写入。
    const interval = h("input", {
      type: "text", inputMode: "numeric", id: "tt-update-interval", className: "tts-about__num",
      autocomplete: "off", spellcheck: false,
    });
    this.aboutInterval = interval;
    this.intervalHintEl = h("span", { className: "tts-about__hint" }, "超过就自动检查");
    interval.addEventListener("input", () => {
      // 打字时只做一件事：改对了就把红字收回。打到一半不判它错。
      if (parseInterval(interval.value) !== null) this.setIntervalHint("");
      this.syncRestoreEntry(card);
    });
    interval.addEventListener("change", () => {
      if (parseInterval(interval.value) === null) {
        this.setIntervalHint("bad");
        this.syncRestoreEntry(card);
        return;
      }
      this.setIntervalHint("");
      void this.commitCard("about");
    });

    const row = (label, ...kids) => h("div", { className: "tts-about__row" },
      h("span", { className: "tts-about__label" }, label), ...kids);

    return h("section", { className: "tts-card" },
      this.cardHead("关于", card),
      h("p", { className: "tts-card__desc" }, "版本与更新说明。说明内容来自 GitHub Release，不随 App 打包；关掉更新提示后仍可在这里手动看。检查间隔到点就会自动去查一次。"),
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
        h("label", { className: "tts-about__row tts-about__row--interval" },
          h("span", { className: "tts-about__label" }, "检查间隔"),
          this.intervalHintEl,
          h("span", { className: "tts-about__numwrap" }, interval, h("em", {}, "分钟")),
        ),
        row("检查",
          h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.update?.openManual() }, "检查更新"),
          h("button", { type: "button", className: "tt-btn ghost", onClick: () => this.update?.openCached() }, "查看更新说明"),
        ),
      ),
    );
  }

  /** 检查间隔那一行的副文案：平时是一句说明，填得不对时就地变红说清范围。 */
  setIntervalHint(state) {
    const el = this.intervalHintEl;
    if (!el) return;
    if (state === "bad") {
      el.textContent = `要填 ${INTERVAL_MIN} – ${INTERVAL_MAX} 的整数分钟`;
      el.dataset.kind = "err";
    } else {
      el.textContent = "超过就自动检查";
      delete el.dataset.kind;
    }
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
    // 输入框正在填的时候别去覆盖它，否则打字打到一半会被刷走。
    if (this.aboutInterval && document.activeElement !== this.aboutInterval) {
      const minutes = d?.intervalMinutes ?? 360;
      if (this.aboutInterval.value !== String(minutes)) this.aboutInterval.value = String(minutes);
      this.setIntervalHint("");
    }
    this.syncRestoreEntry(this.cards.get("about"));
  }

  // ── 取值与校验
  numberValue(id) {
    const raw = this.root.querySelector(`#${id}`)?.value ?? "";
    const v = Number(raw);
    return raw.trim() !== "" && Number.isFinite(v) ? v : null;
  }

  setNumberValue(id, value) {
    const input = this.root.querySelector(`#${id}`);
    if (input) input.value = String(value ?? "");
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

  // 校验只做数字两项：区间与服务端同一组，错误就地写在那一行下面，别让人滚回去找。
  validateNumbers() {
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
