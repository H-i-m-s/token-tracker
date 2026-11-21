import { pinnedThemeId } from "./theme-catalog.mjs";
import { currentAppearance, reapplyAppearance } from "./appearance.mjs";

export async function loadHanaStylesheet(hanaTheme, doc = document) {
  const snapshot = hanaTheme.getSnapshot?.() || hanaTheme;
  const cssUrl = snapshot?.cssUrl;
  if (!cssUrl) return null;

  const absolute = new URL(cssUrl, doc.location.href).toString();
  const existing = doc.querySelector('link[data-hana-token-tracker-theme]');
  if (existing && existing.href === absolute) return absolute;

  return new Promise((resolve, reject) => {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = absolute;
    link.setAttribute("data-hana-token-tracker-theme", absolute);
    link.addEventListener("load", () => {
      for (const old of doc.querySelectorAll('link[data-hana-token-tracker-theme]')) {
        if (old !== link) old.remove();
      }
      keepPinLast(doc);
      resolve(absolute);
    });
    link.addEventListener("error", () => reject(new Error("theme stylesheet failed to load")));
    doc.head.appendChild(link);
  });
}

export function applyThemeClass(theme, doc = document, appearance) {
  const root = doc.documentElement;
  root.setAttribute("data-hana-theme", theme || "light");
  // 指名了主题时明暗由它自己定（见 appearance.mjs），这里不插手。
  if (root.dataset.ttThemePin) return;
  if (appearance === "dark" || (!appearance && theme === "dark")) {
    root.classList.add("hana-dark");
    root.classList.remove("hana-light");
  } else {
    root.classList.add("hana-light");
    root.classList.remove("hana-dark");
  }
}

const PIN_ATTR = "data-tt-theme-pin";

// 指名的主题表：按 id 向宿主取一份，插在 head 最末尾。
// 顺序是关键 —— 宿主自己那份主题表也写在 :root 上，同权重下后出现的赢，
// 所以每次宿主换表之后都要把这张挪回最后（keepPinLast）。
export async function applyPinnedTheme(value, doc = document) {
  const id = pinnedThemeId(value);
  for (const old of doc.querySelectorAll(`link[${PIN_ATTR}]`)) {
    if (!id || old.getAttribute(PIN_ATTR) !== id) old.remove();
  }
  if (!id) return null;

  const href = new URL(`/api/apps/theme.css?theme=${encodeURIComponent(id)}`, doc.location.origin).toString();
  const existing = doc.querySelector(`link[${PIN_ATTR}]`);
  if (existing && existing.href === href) {
    keepPinLast(doc);
    return href;
  }
  if (existing) existing.remove();

  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute(PIN_ATTR, id);
  const loaded = await new Promise((resolve) => {
    link.addEventListener("load", () => resolve(true), { once: true });
    // 取不到就算取不到：下拉仍显示这个名字，但表没换上，调用方据此不宣称已生效。
    link.addEventListener("error", () => resolve(false), { once: true });
    doc.head.appendChild(link);
  });
  if (!loaded) {
    link.remove();
    return null;
  }
  keepPinLast(doc);
  return href;
}

function keepPinLast(doc) {
  const pin = doc.querySelector(`link[${PIN_ATTR}]`);
  if (pin && pin !== doc.head.lastElementChild) doc.head.appendChild(pin);
}

export async function initTheme(hana, doc = document) {
  const params = new URLSearchParams(doc.location?.search || "");
  const paramTheme = params.get("hana-theme") || params.get("theme");
  const paramAppearance = params.get("hana-theme-appearance");

  if (!hana?.theme) {
    if (paramTheme) applyThemeClass(paramTheme, doc, paramAppearance);
    return;
  }

  const initial = hana.theme.getSnapshot?.();
  const theme = paramTheme || initial?.theme;
  if (initial?.cssUrl) {
    try { await loadHanaStylesheet(hana.theme, doc); } catch {}
  }
  applyThemeClass(theme, doc, initial?.appearance || paramAppearance);

  hana.theme.subscribe?.((next) => {
    applyThemeClass(next.theme, doc, next.appearance);
    if (next.cssUrl) {
      loadHanaStylesheet(hana.theme, doc).catch(() => {});
    }
    // 宿主换表会把它那张插到我们后面：把指名的那张挪回最后，并把明暗重新落一次。
    keepPinLast(doc);
    const pin = currentAppearance().pin;
    if (pin) {
      reapplyAppearance(doc);
      applyPinnedTheme(`theme:${pin}`, doc).catch(() => {});
    }
  });
}
