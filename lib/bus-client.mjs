import { BusError, unwrapEnvelope } from "./api-errors.mjs";
import * as fixtures from "./mock-data.mjs";

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Thin wrapper over ctx.bus that also provides a deterministic mock mode.
 *
 * Mock mode answers the same envelope shape as the real v1 bus handlers,
 * so the UI can be developed before the bridge is wired.
 */
export class BusClient {
  constructor({ bus, log, defaultMock = false }) {
    this.bus = bus;
    this.log = log || (() => {});
    this.defaultMock = defaultMock;
  }

  isMock(force) {
    return force ?? this.defaultMock;
  }

  async request(event, payload = {}, { mock } = {}) {
    if (this.isMock(mock)) {
      this.log("debug", `[bus mock] ${event}`, payload);
      return this._mockResponse(event, payload);
    }

    if (!this.bus || typeof this.bus.request !== "function") {
      throw new BusError("BUS_UNAVAILABLE", "ctx.bus.request 不可用");
    }

    try {
      const name = event.replace(/^token-tracker\./, "").replaceAll(".", "/");
      const result = await this._withTimeout((signal) => this.bus.request(`app:token-tracker/${name}`, payload, { signal, timeout: REQUEST_TIMEOUT_MS }));
      const value = unwrapEnvelope(result);
      if (value?.error || value?.ok === false) {
        throw new BusError(value.error?.code || "SERVICE_ERROR", value.error?.message || value.error || "数据服务失败");
      }
      return value;
    } catch (err) {
      this.log("warn", `[bus] ${event} failed:`, err?.message || err);
      throw new BusError(err?.code || "BUS_ERROR", err?.message || `Bus 请求失败：${event}`);
    }
  }

  subscribe(event, handler, { mock } = {}) {
    if (this.isMock(mock)) {
      this.log("debug", `[bus mock] subscribe ${event}`);
      let ticks = 0;
      const id = setInterval(() => {
        ticks += 1;
        const realtime = fixtures.mockRealtime();
        realtime.lastTps = 300 + Math.floor(Math.random() * 600);
        realtime.updatedAt = Date.now();
        handler({ lastScan: Date.now(), realtime, summaryVersion: ticks });
      }, 8000);
      return () => clearInterval(id);
    }

    if (!this.bus || typeof this.bus.subscribe !== "function") {
      this.log("warn", `[bus] subscribe ${event}: ctx.bus.subscribe 不可用`);
      return () => {};
    }

    try {
      const registration = this.bus.subscribe((payload) => {
        if (payload?.type === event) handler(payload);
      }, { types: [event] });
      registration?.ready?.catch((err) => this.log("warn", err.message));
      return registration;
    } catch (err) {
      this.log("warn", `[bus] subscribe ${event} failed:`, err?.message || err);
      return () => {};
    }
  }

  async _withTimeout(work) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new BusError("BUS_TIMEOUT", "Bus 请求超时"));
          }, REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  _mockResponse(event, payload) {
    switch (event) {
      case "token-tracker.snapshot":
        return fixtures.mockSnapshot();
      case "token-tracker.dashboard": {
        const range = payload?.range || "today";
        return fixtures.mockDashboard(range);
      }
      case "token-tracker.balance":
        return fixtures.mockBalance();
      case "token-tracker.refresh":
        return { accepted: true, scanAt: Date.now() };
      case "token-tracker.settings.read":
        return fixtures.readMockSettings();
      case "token-tracker.settings.write": {
        const current = fixtures.readMockSettings();
        const next = { ...current, ...payload };
        return fixtures.writeMockSettings(next);
      }
      default:
        throw new BusError("UNKNOWN_EVENT", `未实现的 mock 事件：${event}`);
    }
  }
}
