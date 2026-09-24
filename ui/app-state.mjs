export const DEFAULT_APP_STATE = {
  range: "today",
  from: "",
  to: "",
  agent: "",
  model: "",
  provider: "",
  type: "",
  autoRefresh: true,
  lastError: null,
};

export class AppState {
  constructor({ hana, slot, cardInstanceId }) {
    this.hana = hana;
    this.slot = slot || "card";
    this.cardInstanceId = cardInstanceId;
    this.useCardState = ! ["functionPanel", "function-panel"].includes(this.slot) && typeof cardInstanceId === "string" && cardInstanceId.length > 0;
    if (!cardInstanceId) {
      throw new Error("AppState requires a host-issued cardInstanceId; refusing shared anonymous fallback.");
    }
    this.storageKey = `token-tracker-app:state:${cardInstanceId}`;
    this.listeners = new Set();
    this.unsubscribeStorage = null;
    this.cache = { ...DEFAULT_APP_STATE };
    this.disposed = false;
    this.writeQueue = Promise.resolve();
    this.pendingWrites = 0;
    this.readGeneration = 0;
  }

  async init() {
    const stored = await this._storageGet(this.storageKey, null);
    this.cache = { ...DEFAULT_APP_STATE, ...(stored || {}) };

    if (this.hana?.storage?.global?.onChanged) {
      this.unsubscribeStorage = this.hana.storage.global.onChanged((keys) => {
        if (this.disposed || !keys.includes(this.storageKey)) return;
        this._syncStorage();
      });
    }

    return this.cache;
  }

  get() {
    return { ...this.cache };
  }

  async patch(patch) {
    if (this.disposed) return this.get();
    const next = { ...this.cache, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.cache)) return next;
    ++this.readGeneration;
    ++this.pendingWrites;
    this.cache = next;
    this._notify(next);
    const write = this.writeQueue.catch(() => {}).then(() => this._persist(next));
    this.writeQueue = write;
    try { await write; }
    finally {
      --this.pendingWrites;
      if (!this.pendingWrites) await this._syncStorage();
    }
    return next;
  }

  async _syncStorage() {
    const generation = ++this.readGeneration;
    if (this.pendingWrites || this.disposed) return;
    try {
      const next = await this._storageGet(this.storageKey, null);
      if (this.disposed || this.pendingWrites || generation !== this.readGeneration || !next) return;
      const merged = { ...DEFAULT_APP_STATE, ...next };
      if (JSON.stringify(merged) === JSON.stringify(this.cache)) return;
      this.cache = merged;
      this._notify(merged);
    } catch { /* Keep the last known selection on a transient storage read failure. */ }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.disposed = true;
    if (this.unsubscribeStorage) {
      try { this.unsubscribeStorage(); } catch {}
      this.unsubscribeStorage = null;
    }
    this.listeners.clear();
  }

  _notify(state) {
    for (const listener of this.listeners) {
      try { listener(state); } catch {}
    }
  }

  async _persist(state) {
    const promises = [];
    if (this.hana?.storage?.global?.set) {
      promises.push(this.hana.storage.global.set(this.storageKey, state));
    }
    if (this.useCardState && this.hana?.state?.set) {
      promises.push(this.hana.state.set("tokenTracker", state));
    }
    await Promise.all(promises);
  }

  async _storageGet(key, fallback) {
    if (!this.hana?.storage?.global?.get) return fallback;
    const result = await this.hana.storage.global.get(key);
    if (result && Object.prototype.hasOwnProperty.call(result, "value")) {
      return result.value === undefined ? fallback : result.value;
    }
    return result ?? fallback;
  }
}
