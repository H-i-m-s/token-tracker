import { selectionParam } from "./selection.mjs";

// 多选筛选字段：值要按「URI 编码后逗号连接」写信，其余字段仍是单值。
const LIST_FILTER_KEYS = ["agent", "model", "provider", "type"];

export class AppApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class AppApi {
  constructor({ apiFetch }) {
    this.apiFetch = apiFetch;
  }

  async fetchJson(path, init = {}) {
    const res = await this.apiFetch(path, init);
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok || (body && body.ok === false)) {
      const err = body?.error || {};
      throw new AppApiError(err.code || `HTTP_${res.status}`, err.message || `请求失败 (${res.status})`);
    }
    return body;
  }

  async watchEvents({ signal, onEvent }) {
    const response = await this.apiFetch('/events', { signal });
    if (!response.ok || !response.body) throw new AppApiError(`HTTP_${response.status}`, '实时连接失败');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        pending = pending.replace(/\r\n/g, '\n');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) onEvent(JSON.parse(data));
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  _mockQs(mock) {
    return mock ? "?mock=1" : "";
  }

  // 把筛选写进 query：四个多选字段按「URI 编码 + 逗号连接」写，其余按单值原样写。
  // 空集合（数组为空 / 空串 / 未给）就不发这个参数 —— 引擎侧「不发」与「空」同义，都是不筛。
  _applyFilters(qs, filters, keys) {
    for (const k of keys) {
      if (LIST_FILTER_KEYS.includes(k)) {
        const v = selectionParam(filters[k]);
        if (v) qs.set(k, v);
      } else if (filters[k]) {
        qs.set(k, String(filters[k]));
      }
    }
  }

  async getSnapshot({ mock = false } = {}) {
    const data = await this.fetchJson(`/snapshot${this._mockQs(mock)}`);
    return data.snapshot;
  }

  async getDashboard(filters = {}, { mock = false } = {}) {
    const qs = new URLSearchParams();
    this._applyFilters(qs, filters, ["range", "from", "to", "agent", "model", "provider", "type"]);
    // 明细已服务端分页：页码、排序、门槛都要带上去，否则拿回来的永远是第一页的默认排序。
    if (filters.page) qs.set("page", String(filters.page));
    if (filters.pageSize) qs.set("pageSize", String(filters.pageSize));
    if (filters.sortKey) qs.set("sortKey", filters.sortKey);
    if (filters.order) qs.set("order", filters.order);
    if (filters.minTokens) qs.set("minTokens", String(filters.minTokens));
    const data = await this.fetchJson(`/dashboard?${qs}${mock ? "&mock=1" : ""}`);
    return data.dashboard;
  }

  // 明细导出：拿引擎按「当前筛选 + 当前排序」拼好的 CSV 文本（明细分页后前端只有一页）。
  async getDetailsCsv(filters = {}, { mock = false } = {}) {
    const qs = new URLSearchParams();
    this._applyFilters(qs, filters, ["range", "from", "to", "agent", "model", "provider", "type", "sortKey", "order"]);
    if (filters.minTokens) qs.set("minTokens", String(filters.minTokens));
    const data = await this.fetchJson(`/details.csv?${qs}${mock ? "&mock=1" : ""}`);
    return data.csv;
  }

  // 「点得开」：某一轮的调用拆解。引擎会从会话文件重读（文件是权威），不从缓存里拼。
  async getTurn(sessionKey, seq, { mock = false } = {}) {
    const qs = new URLSearchParams({ sessionKey: String(sessionKey || ""), seq: String(seq || 0) });
    const data = await this.fetchJson(`/turn?${qs}${mock ? "&mock=1" : ""}`);
    return data.turn;
  }

  // 只看明细这一块：翻页/换排序/换门槛用它，免得为了一页明细把概览的图也重算重画一遗。
  // 参数与 getDashboard 同源，免得两处口径漂移。
  async getDetails(filters = {}, { mock = false } = {}) {
    const qs = new URLSearchParams();
    this._applyFilters(qs, filters, ["range", "from", "to", "agent", "model", "provider", "type", "sortKey", "order"]);
    if (filters.page) qs.set("page", String(filters.page));
    if (filters.pageSize) qs.set("pageSize", String(filters.pageSize));
    if (filters.minTokens) qs.set("minTokens", String(filters.minTokens));
    const data = await this.fetchJson(`/details?${qs}${mock ? "&mock=1" : ""}`);
    return { details: data.details ?? null, summary: data.summary || {} };
  }

  // 体检：库/表规模、落盘统计、账本来源，以及（bytes=1 时）整份看板的逐块字节分解。
  async getDiagnostics({ bytes = false, mock = false } = {}) {
    const qs = new URLSearchParams();
    if (bytes) qs.set("bytes", "1");
    if (mock) qs.set("mock", "1");
    const data = await this.fetchJson(`/diagnostics?${qs}`);
    return data.diagnostics || {};
  }

  async getBalances({ mock = false } = {}) {
    const data = await this.fetchJson(`/balance${this._mockQs(mock)}`);
    return data.balances;
  }

  // DeepSeek 官网用量（platform.deepseek.com 官方账单）。
  // days：往回看多少天（默认 30）；也可用 from/to（unix 秒）显式指定区间，from=0 表示“不设下限”。
  // 区间窄到一天左右时官网会给小时粒度，返回值里的 range.bucket 说明粒度（86400 天 / 3600 小时）。
  async getDsUsage({ days = 30, from = null, to = null, force = false, history = true, mock = false } = {}) {
    const qs = new URLSearchParams();
    if (from != null) qs.set("from", String(Math.floor(from)));
    if (to != null) qs.set("to", String(Math.floor(to)));
    if (from == null && days) qs.set("days", String(days));
    if (force) qs.set("force", "1");
    if (!history) qs.set("history", "0");
    if (mock) qs.set("mock", "1");
    const data = await this.fetchJson(`/ds-usage?${qs}`);
    return data.dsUsage;
  }

  async refresh({ force = false, mock = false } = {}) {
    const qs = [];
    if (force) qs.push("force=1");
    if (mock) qs.push("mock=1");
    const data = await this.fetchJson(`/refresh${qs.length ? "?" + qs.join("&") : ""}`, { method: "POST" });
    return data;
  }

  // 更新说明：内容与版本判断都在插件进程（那边去读 GitHub Release），这里只取快照、回报「看了没」。
  async getUpdateCheck({ force = false, mock = false } = {}) {
    const qs = new URLSearchParams();
    if (force) qs.set("force", "1");
    if (mock) qs.set("mock", "1");
    const query = qs.toString();
    const data = await this.fetchJson(`/update-check${query ? `?${query}` : ""}`);
    return data.update;
  }

  // action：ack = 我已知晓（落盘，直到下个版本）；later = 先不看（只在插件进程内存里）；
  // toggle = 更新提示开关。三个都走同一格，写完插件会广播给其他界面。
  async dismissUpdate({ action, version = "", enabled = null, mock = false } = {}) {
    const body = { action };
    if (version) body.version = version;
    if (enabled !== null) body.enabled = !!enabled;
    const data = await this.fetchJson(`/update-check${this._mockQs(mock)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return data.update;
  }

  async loadSettings({ mock = false } = {}) {
    const data = await this.fetchJson(`/settings${this._mockQs(mock)}`);
    return data.settings;
  }

  async saveSettings(settings, { mock = false } = {}) {
    const data = await this.fetchJson(`/settings${this._mockQs(mock)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    return data.settings;
  }

  // 输入栏状态位卡片的四个开关（card/cache/speed/ttft）。真相在插件侧，这里只做透传。
  async getInputStatusPrefs() {
    const data = await this.fetchJson(`/input-status-prefs`);
    return data.prefs;
  }

  async saveInputStatusPrefs(patch) {
    const data = await this.fetchJson(`/input-status-prefs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return data.prefs;
  }
}
