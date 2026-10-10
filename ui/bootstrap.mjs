import { AppApi } from "./app-api.mjs";
import { AppState } from "./app-state.mjs";
import { initTheme } from "./theme.mjs";
import { setUnitSystem } from "./units.mjs";
import { installUpdateNotice } from "./update-notice.mjs";

export const APP_ID = "token-tracker-app";

export async function bootstrap(options = {}) {
  let hana = options.hana;
  if (!hana) {
    const sdk = await import("./sdk/ui.js");
    hana = sdk.createHanaAppUiSdk({ targetWindow: window });
  }

  if (hana.ready) hana.ready();

  const surface = await (async () => {
    if (!hana.surface?.getContext) return null;
    const ctx = hana.surface.getContext();
    if (ctx) return ctx;
    return new Promise((resolve) => {
      let off, timer;
      const finish = (next) => {
        if (!next) return;
        clearTimeout(timer);
        queueMicrotask(() => off?.());
        resolve(next);
      };
      timer = setTimeout(() => { off?.(); resolve(null); }, 3000);
      off = hana.surface.onContextChanged?.(finish);
    });
  })();

  const slot = surface?.slot || options.slot || "card";
  const cardInstanceId = surface?.cardInstanceId || null;

  await initTheme(hana);

  const api = new AppApi({ apiFetch: hana.api.fetch.bind(hana.api) });

  // 更新说明弹窗：每个界面都装一份（设置页与卡片主界面都要能弹），跨界面靠事件流同步。
  // 预览模式拿的是插件给的固定样张，不自动浮起来，但「查看更新说明」仍能看形状。
  const mockMode = options.mock || new URLSearchParams(window.location.search).get("mock") === "1";
  const update = installUpdateNotice({
    hana,
    api,
    mock: !!mockMode,
    log: (message) => { try { console.warn("[token-tracker]", message); } catch {} },
  });

  if (options.stateless) {
    return { hana, slot, cardInstanceId, api, state: null, update };
  }

  try {
    const settings = await api.loadSettings();
    document.documentElement.dataset.density = settings.display?.density || "compact";
    // 数字单位（万/亿 ↔ K/M/B）要在本页渲染任何数字之前定下来：
    // 各页的 fmt/compact/fmtTokensShort 都读 ui/units.mjs 里那一份当前值。
    setUnitSystem(settings.display?.units);
  } catch {}
  const state = new AppState({ hana, slot, cardInstanceId });
  await state.init();

  return { hana, slot, cardInstanceId, api, state, update };
}
