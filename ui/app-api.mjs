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
    const data = await this.fetchJson(`/dashboard?${qs}${mock ? "&mock=1" : ""}`);
    return data.dashboard;
  }

  async getBalances({ mock = false } = {}) {
    const data = await this.fetchJson(`/balance${this._mockQs(mock)}`);
    return data.balances;
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
