export function drawSparkline(container, data, opts = {}) {
  if (!container) return null;
  const values = Array.isArray(data) ? data.filter((n) => Number.isFinite(n)) : [];
  if (!values.length) {
    container.innerHTML = "";
    return null;
  }

  const width = opts.width || 320;
  const height = opts.height || 40;
  const stroke = opts.stroke || "var(--tt-blue)";
  const strokeWidth = opts.strokeWidth || 1.5;
  const fill = opts.fill || "var(--tt-blue)";
  const fillOpacity = opts.fillOpacity ?? 0.10;
  const dot = opts.dot !== false;
  const padX = opts.padX ?? 2;
  const padY = opts.padY ?? 4;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values.map((v, i) => {
    const x = padX + (values.length <= 1 ? width / 2 : (i / (values.length - 1)) * (width - padX * 2));
    const y = height - padY - ((v - min) / span) * (height - padY * 2);
    return [x, y];
  });

  const polyline = points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const areaPath = `M${points[0][0]},${height} L${points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L")} L${points[points.length - 1][0]},${height} Z`;
  const last = points[points.length - 1];

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";

  const area = document.createElementNS(ns, "path");
  area.setAttribute("d", areaPath);
  area.setAttribute("fill", fill);
  area.setAttribute("fill-opacity", String(fillOpacity));
  svg.appendChild(area);

  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", polyline);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", String(strokeWidth));
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  if (dot && last) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(last[0].toFixed(1)));
    circle.setAttribute("cy", String(last[1].toFixed(1)));
    circle.setAttribute("r", String(opts.dotRadius || 2.5));
    circle.setAttribute("fill", opts.dotColor || "var(--tt-blue)");
    svg.appendChild(circle);
  }

  container.innerHTML = "";
  container.appendChild(svg);
  return svg;
}

export function drawRing(container, opts = {}) {
  if (!container) return null;

  const size = opts.size || 44;
  const strokeWidth = opts.strokeWidth || 4;
  const percent = Math.max(0, Math.min(100, Number(opts.percent) || 0));
  const color = opts.color || "var(--tt-blue)";
  const bgColor = opts.bgColor || "var(--tt-empty)";
  const showText = opts.showText !== false;
  const text = opts.text !== undefined ? String(opts.text) : `${Math.round(percent)}%`;
  const textColor = opts.textColor || color;

  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const dash = (percent / 100) * c;
  const offset = c - dash;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";

  const bg = document.createElementNS(ns, "circle");
  bg.setAttribute("cx", String(size / 2));
  bg.setAttribute("cy", String(size / 2));
  bg.setAttribute("r", String(r));
  bg.setAttribute("fill", "none");
  bg.setAttribute("stroke", bgColor);
  bg.setAttribute("stroke-width", String(strokeWidth));
  svg.appendChild(bg);

  const fg = document.createElementNS(ns, "circle");
  fg.setAttribute("cx", String(size / 2));
  fg.setAttribute("cy", String(size / 2));
  fg.setAttribute("r", String(r));
  fg.setAttribute("fill", "none");
  fg.setAttribute("stroke", color);
  fg.setAttribute("stroke-width", String(strokeWidth));
  fg.setAttribute("stroke-linecap", "round");
  fg.setAttribute("stroke-dasharray", String(c));
  fg.setAttribute("stroke-dashoffset", String(offset));
  fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  svg.appendChild(fg);

  if (showText) {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", String(size / 2));
    t.setAttribute("y", String(size / 2));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "central");
    t.setAttribute("font-family", "var(--font-sans)");
    t.setAttribute("font-size", String(opts.fontSize || size * 0.28));
    t.setAttribute("font-weight", "700");
    t.setAttribute("fill", textColor);
    t.textContent = text;
    svg.appendChild(t);
  }

  container.innerHTML = "";
  container.appendChild(svg);
  return svg;
}
