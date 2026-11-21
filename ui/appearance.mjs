// App 自己的外观三档 + 指名主题。
//
// 取值空间："" / "dark" / "light" / "system" / "theme:<id>"。
// 指名某个主题时，data-tt-appearance 一律落到 system —— 那一档不做本地配色覆盖，
// 让宿主变量说了算（主题表由 theme.mjs 换成指名的那个）。
// 明暗则由被指名的主题自己声明，通过 hana-dark / hana-light 交给那两处结构规则。
import { appearanceHintOf, isPinned, pinnedThemeId } from "./theme-catalog.mjs";

let current = { preference: "system", base: "system", pin: "", appearance: "system" };

export function currentAppearance() {
  return current;
}

export function applyAppearance(preference = "system", doc = document) {
  const raw = String(preference ?? "");
  const pin = pinnedThemeId(raw);
  // 空值与认不出的值一律当「自动」：本卡自带的深黑/浅色已经不在下拉里了，
  // 没有明确指名就跟着宿主走，不再默默把界面压成深色。
  const base = pin ? "system" : ["dark", "light", "system"].includes(raw) ? raw : "system";
  const hint = appearanceHintOf(raw);
  const root = doc.documentElement;

  root.dataset.ttAppearance = base;
  if (isPinned(raw)) root.dataset.ttThemePin = pin;
  else delete root.dataset.ttThemePin;

  // 指名的主题自带明暗：不让它跟宿主当前明暗打架，免得青夜的主题被套上浅色的结构配色。
  if (pin && (hint === "dark" || hint === "light")) {
    root.classList.toggle("hana-dark", hint === "dark");
    root.classList.toggle("hana-light", hint === "light");
  }

  current = { preference: raw || base, base, pin, appearance: hint };
  return current;
}

// 宿主换主题时重新落一次：指名主题的选择不能被「跟随宿主」悄悄顶掉。
export function reapplyAppearance(doc = document) {
  return applyAppearance(current.preference, doc);
}
