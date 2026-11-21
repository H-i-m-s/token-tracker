// 主题清单：本卡外观两档 + 跟随宿主 + 可指名的主机主题 + 衣橱皮肤。
//
// 宿主只提供「按 id 取某一张表」（/api/apps/theme.css?theme=<id>），不提供「一共有哪些」。
// 所以内置那批写在代码里；衣橱皮肤由衣橱自己报（经本 App 的 /themes 路由透传）。
// 拿不到皮肤清单时 status 会说明白，不假装成「一张都没有」。

export const LOCAL_THEMES = [
  { value: "dark", label: "深黑" },
  { value: "light", label: "浅色" },
];

// 下拉第一项。自动 = 跟着宿主当前主题走，不需要再写一个「跟随宿主」分组 -
// 一列里就那一项，分组只多一层壳。
export const FOLLOW_THEME = { value: "system", label: "自动" };

// 宿主内置主题。light / dark / auto 不列：它们与上面那三档是同一件事，
// 两处都给一遍，人只会纠结该点哪一处。
export const HOST_THEMES = [
  { id: "warm-paper", label: "暖纸", appearance: "light" },
  { id: "new-warm-paper", label: "新暖纸", appearance: "light" },
  { id: "midnight", label: "青夜", appearance: "dark" },
  { id: "midnight-contrast", label: "青夜·高对比", appearance: "dark" },
  { id: "high-contrast", label: "素白", appearance: "light" },
  { id: "grass-aroma", label: "草香", appearance: "light" },
  { id: "contemplation", label: "沉思", appearance: "dark" },
  { id: "absolutely", label: "Absolutely", appearance: "dark" },
  { id: "delve", label: "Delve", appearance: "dark" },
  { id: "deep-think", label: "Deep Think", appearance: "dark" },
  { id: "coral", label: "珊瑚", appearance: "light" },
];

// 指名主题的取值形如 "theme:midnight"。用它而不是另开一个字段：
// 外观这件事只存一处，看板与卡片的 chromeSignature 也就不用多记一个键。
export const PIN_PREFIX = "theme:";

export function isPinned(value) {
  return typeof value === "string" && value.startsWith(PIN_PREFIX) && value.length > PIN_PREFIX.length;
}

export function pinnedThemeId(value) {
  return isPinned(value) ? value.slice(PIN_PREFIX.length) : "";
}

export function pinValue(id) {
  return id ? PIN_PREFIX + id : "";
}

// 皮肤清单快照。status: idle / loading / ok / error。
let skins = { status: "idle", themes: [], error: "" };

export function skinSnapshot() {
  return skins;
}

export async function refreshSkins(api) {
  if (!api || typeof api.fetchJson !== "function") return skins;
  if (skins.status === "loading") return skins;
  skins = { ...skins, status: "loading" };
  try {
    const body = await api.fetchJson("/themes");
    const list = Array.isArray(body?.themes) ? body.themes : [];
    skins = {
      status: "ok",
      error: String(body?.error || ""),
      themes: list
        .filter((t) => t && t.id)
        .map((t) => ({
          id: String(t.id),
          label: String(t.name || t.id),
          appearance: t.appearance === "light" ? "light" : "dark",
        })),
    };
  } catch (error) {
    // 衣橱没装、没授权、或它自己报错：都原样留着说给人听，下拉只是少一组。
    skins = { status: "error", themes: [], error: String(error?.message || error) };
  }
  return skins;
}

function findTheme(id) {
  return HOST_THEMES.find((t) => t.id === id) || skins.themes.find((t) => t.id === id) || null;
}

// 某个取值自己声明是深还是浅。本卡两档直接答；指名的主题看清单；
// 清单里也没有（比如皮肤还没拉回来）就交给宿主当前明暗，不猜。
export function appearanceHintOf(value) {
  if (value === "dark" || value === "light") return value;
  const id = pinnedThemeId(value);
  if (!id) return "system";
  const hit = findTheme(id);
  if (!hit) return "system";
  return hit.appearance === "light" ? "light" : "dark";
}

// 下拉里那一串（纯数据，不碰 DOM）：组件按它渲染，测试也测它。
// 「自动」不单独挂在外面，就当「宿主内置主题」那组的第一项——它本来也是宿主那一侧的取值。
// 剩下就两类：宿主内置主题（含自动）、衣橱皮肤。
// 已选值不在清单里时（旧版本的 dark/light、皮肤还没拉回来、或已卸掉）单列一组「当前」：
// 不单列的话下拉会跳回第一项，看上去像主题被人换掉了。
export function themeSelectGroups(value = "") {
  const selected = String(value || "");
  const builtin = HOST_THEMES.map((t) => ({ value: pinValue(t.id), label: t.label }));
  const skinItems = skins.themes.map((t) => ({ value: pinValue(t.id), label: t.label }));
  const known = new Set([FOLLOW_THEME.value, ...builtin.map((o) => o.value), ...skinItems.map((o) => o.value)]);
  const orphan = selected && !known.has(selected)
    ? [{ value: selected, label: labelOfLeftover(selected) }]
    : [];
  return {
    groups: [
      { label: "宿主内置主题", items: [FOLLOW_THEME, ...builtin] },
      { label: "衣橱皮肤", items: skinItems },
      { label: "当前", items: orphan },
    ].filter((group) => group.items.length > 0),
  };
}

// 不在清单里的旧值也给人话名字：深黑/浅色是本卡早期两档，别直接摆一个 "dark" 上去。
function labelOfLeftover(value) {
  const pinned = pinnedThemeId(value);
  if (pinned) return findTheme(pinned)?.label || pinned;
  return LOCAL_THEMES.find((t) => t.value === value)?.label || value;
}

export function themeLabelOf(value) {
  if (!value) return FOLLOW_THEME.label;
  if (isPinned(value)) {
    const id = pinnedThemeId(value);
    return findTheme(id)?.label || id;
  }
  return [...LOCAL_THEMES, FOLLOW_THEME].find((t) => t.value === value)?.label || value;
}
