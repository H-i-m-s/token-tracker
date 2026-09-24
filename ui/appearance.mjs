// UI-only preference, shared by the workspace and its function panel.
export function applyAppearance(preference = 'dark', doc = document) {
  const theme = ['dark', 'light', 'system'].includes(preference) ? preference : 'dark';
  doc.documentElement.dataset.ttAppearance = theme;
  return theme;
}
