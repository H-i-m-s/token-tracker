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

  async getSnapshot({ mock = false } = {}) {
    const data = await this.fetchJson(`/snapshot${this._mockQs(mock)}`);
    return data.snapshot;
  }

  async getDashboard(filters = {}, { mock = false } = {}) {
    const qs = new URLSearchParams();
    if (filters.range) qs.set("range", filters.range);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    if (filters.agent) qs.set("agent", filters.agent);
    if (filters.model) qs.set("model", filters.model);
    if (filters.provider) qs.set("provider", filters.provider);
    if (filters.type) qs.set("type", filters.type);
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
    for (const k of ["range", "from", "to", "agent", "model", "provider", "type", "sortKey", "order"]) {
      if (filters[k]) qs.set(k, String(filters[k]));
    }
    if (filters.minTokens) qs.set("minTokens", String(filters.minTokens));
    const data = await this.fetchJson(`/details.csv?${qs}${mock ? "&mock=1" : ""}`);
    return data.csv;
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
}
