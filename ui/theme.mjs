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
      applyThemeClass(snapshot.theme, doc, snapshot.appearance);
      resolve(absolute);
    });
    link.addEventListener("error", () => reject(new Error("theme stylesheet failed to load")));
    doc.head.appendChild(link);
  });
}

export function applyThemeClass(theme, doc = document, appearance) {
  const root = doc.documentElement;
  root.setAttribute("data-hana-theme", theme || "light");
  if (appearance === "dark" || (!appearance && theme === "dark")) {
    root.classList.add("hana-dark");
    root.classList.remove("hana-light");
  } else {
    root.classList.add("hana-light");
    root.classList.remove("hana-dark");
  }
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
  });
}
