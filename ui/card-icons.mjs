// Small outline glyphs share the host's currentColor and rounded stroke style.
const paths = {
  overview: ['M4 19V11', 'M10 19V5', 'M16 19V8', 'M22 19V3'],
  balance: ['M4 6h15v4H4a2 2 0 0 1 0-4Z', 'M3 8v11h18V10H4', 'M16 13h5v3h-5Z'],
  details: ['M6 3h12v18H6Z', 'M9 8h6', 'M9 12h6', 'M9 16h4'],
  realtime: ['M2 12h5l3-8 4 16 3-8h5'],
  agents: ['M3 5h7l2 3h9v12H3Z'],
  heat: ['M4 4h5v5H4Z', 'M15 4h5v5h-5Z', 'M4 15h5v5H4Z', 'M15 15h5v5h-5Z'],
  distribution: ['M3 19c5 0 4-14 9-14s4 14 9 14', 'M3 20h18'],
  hours: ['M3 19h18', 'M3 15c3 0 3-8 6-8s3 9 6 9 3-12 6-12'],
  daily: ['M4 20V9h4v11Z', 'M10 20V4h4v16Z', 'M16 20v-8h4v8Z'],
  refresh: ['M20 7v5h-5', 'M19 12a7 7 0 1 0-2 6', 'M20 12a8 8 0 0 0-3-7'],
  expand: ['M14 3h7v7', 'M21 3l-9 9', 'M10 5H3v16h16v-7'],
};
export function cardIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  if (name === 'more') {
    for (const x of [5, 12, 19]) { const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', x); dot.setAttribute('cy', 12); dot.setAttribute('r', 1.6); dot.setAttribute('fill', 'currentColor'); dot.setAttribute('stroke', 'none'); svg.append(dot); }
  } else for (const d of paths[name] || paths.overview) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
