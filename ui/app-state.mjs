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
  view: "overview",
  appearance: "",
  cardActive: "",
  cardTabs: null,
};

// 需要跨卡片实例记住的项：停留在哪个界面、主题选了什么、多功能卡显示哪些页。
// 这些不跟 cardInstanceId 走——那个 id 每次打开卡片都可能变，跟着它存下次就找不回来了。
export const SHARED_PREFS_KEY = "token-tracker-app:prefs";
export const SHARED_KEYS = ["view", "appearance", "cardActive", "cardTabs"];
export const VALID_VIEWS = ["overview", "balance", "details", "realtime"];
export const VALID_APPEARANCES = ["dark", "light", "system", ""];

function pickShared(src) {
  const out = {};
  if (!src) return out;
  for (const key of SHARED_KEYS) if (src[key] !== undefined) out[key] = src[key];
  return out;
}

// 挡掉被改坏的存储值。cardActive / cardTabs 的具体有效性由看板自己的
// cardSelection 再滤一道（它本来就会在无效时回到默认页）。
function sanitizeShared(src) {
  const out = pickShared(src);
  if (out.view !== undefined && !VALID_VIEWS.includes(out.view)) delete out.view;
  if (out.appearance !== undefined && !VALID_APPEARANCES.includes(out.appearance)) delete out.appearance;
  if (out.cardActive !== undefined && typeof out.cardActive !== "string") delete out.cardActive;
  if (out.cardTabs !== undefined && !Array.isArray(out.cardTabs)) delete out.cardTabs;
  return out;
}

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
    // 共享偏好另存一份固定 key，不随实例消失
    this.prefsKey = SHARED_PREFS_KEY;
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
    const shared = sanitizeShared(await this._storageGet(this.prefsKey, null));
    // 先实例状态，后共享偏好：共享的 view / appearance 盖在上面
    this.cache = { ...DEFAULT_APP_STATE, ...(stored || {}), ...shared };

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
    const write = this.writeQueue.catch(() => {}).then(async () => {
      await this._persist(next);
      // 改到的是共享项（界面 / 主题）就额外写一份固定 key，下次不管拿到的实例 id 是什么都能读回
      const shared = sanitizeShared(pickShared(next));
      if (Object.keys(shared).length) await this._persistShared(shared);
    });
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

  async _persistShared(shared) {
    if (!this.hana?.storage?.global?.set) return;
    await this.hana.storage.global.set(this.prefsKey, shared);
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
