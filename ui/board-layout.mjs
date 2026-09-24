import { h } from './components.mjs';

const clamp = n => Math.min(68, Math.max(32, Number(n) || 50));
function setWidth(row, value) {
  const width = clamp(value);
  row.style.setProperty('--board-left', `${width}fr`);
  row.style.setProperty('--board-right', `${100 - width}fr`);
  row.querySelector('[role="separator"]')?.setAttribute('aria-valuenow', String(Math.round(width)));
  return width;
}
export function applyBoardLayout(container, state) {
  for (const row of container.querySelectorAll('.tt-board-row')) setWidth(row, state[row.dataset.layoutKey]);
}
export function splitRow(key, label, state, patch) {
  const row = h('div', { className: 'tt-board-row', dataset: { layoutKey: key } });
  const handle = h('div', {
    className: 'tt-board-splitter', role: 'separator', tabindex: '0',
    'aria-label': label, 'aria-orientation': 'vertical', 'aria-valuemin': '32', 'aria-valuemax': '68',
    title: '拖动调整面板宽度；方向键微调，双击恢复均分',
  });
  row.append(handle);
  let value = setWidth(row, state[key]), start = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    value = Number(handle.getAttribute('aria-valuenow'));
    start = { x: event.clientX, value };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (!start) return;
    const available = row.getBoundingClientRect().width - handle.getBoundingClientRect().width;
    value = setWidth(row, start.value + (event.clientX - start.x) / available * 100);
  });
  handle.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    patch({ [key]: Math.round(value) });
  });
  handle.addEventListener('lostpointercapture', () => { if (start) { value = setWidth(row, start.value); start = null; } });
  handle.addEventListener('dblclick', () => { value = setWidth(row, 50); patch({ [key]: value }); });
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    value = setWidth(row, event.key === 'Home' ? 32 : event.key === 'End' ? 68 : Number(handle.getAttribute('aria-valuenow')) + (event.key === 'ArrowLeft' ? -2 : 2));
    patch({ [key]: value });
  });
  return { row, append(left, right) { row.prepend(left); row.append(right); } };
}
