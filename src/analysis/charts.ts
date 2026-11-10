// Small SVG charts for the Analysis page: lines (with a shared crosshair) and 100% stacked bars. Every chart has a hover
// tooltip and a table view, so no number is reachable by colour or hover alone.
const NS = 'http://www.w3.org/2000/svg';
const W = 640, H = 250, M = { l: 52, r: 16, t: 14, b: 34 };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on')) (e as any)[k] = v;
    else if (k in e) (e as any)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null) e.append(kid);
  return e;
}
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ------------------------------------------------------------------ tooltip
const tip = h('div', { class: 'tip' });
document.body.append(tip);
export function showTip(ev: { clientX: number; clientY: number }, title: string, rows: { color?: string; label: string; value: string; dash?: boolean }[]) {
  tip.replaceChildren(h('div', { class: 'tipTitle' }, title), ...rows.map((r) => h('div', { class: 'tipRow' },
    r.color ? h('i', { class: r.dash ? 'sw dash' : 'sw', style: `--c:${r.color}` }) : h('i', { class: 'sw none' }),
    h('b', {}, r.value), h('span', {}, r.label))));
  tip.style.display = 'block';
  const bw = tip.offsetWidth, bh = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - bw - 8, ev.clientX + 14)}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - bh - 8, ev.clientY - bh / 2))}px`;
}
export const hideTip = () => { tip.style.display = 'none'; };

// ------------------------------------------------------------------ frame
export interface Card { root: HTMLElement }

function card(title: string, help: string, body: Node, legend: Node | null, table: () => HTMLTableElement) {
  const tableBox = h('div', { class: 'tableBox' });
  const toggle = h('button', { class: 'linkish', onclick: () => {
    const open = !tableBox.childElementCount;
    tableBox.replaceChildren(...(open ? [table()] : []));
    toggle.textContent = open ? 'Hide table' : 'Show as table';
  } }, 'Show as table');
  return h('section', { class: 'card' }, h('h3', {}, title), h('p', { class: 'help' }, help), legend, body, h('div', { class: 'cardFoot' }, toggle), tableBox);
}

function legendOf(items: { name: string; color: string; dash?: boolean }[]) {
  return h('div', { class: 'legend' }, ...items.map((i) => h('span', {}, h('i', { class: i.dash ? 'sw dash' : 'sw', style: `--c:${i.color}` }), i.name)));
}

function tableOf(head: string[], rows: (string | number)[][]) {
  return h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, String(c)))))));
}

function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 6 ? 6 : f <= 8 ? 8 : 10) * p; // each quarter of these is a round number
}

function axes(svg: SVGSVGElement, yMax: number, fmt: (v: number) => string, xs: string[], xAt: (i: number) => number, xTitle: string) {
  const y = (v: number) => M.t + (H - M.t - M.b) * (1 - v / yMax);
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: i ? 'gridline' : 'base' }));
    const t = s('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }); t.textContent = fmt(v); svg.append(t);
  }
  const every = Math.max(1, Math.ceil(xs.length / 12));
  xs.forEach((label, i) => {
    if (i % every) return;
    const t = s('text', { x: xAt(i), y: H - M.b + 16, 'text-anchor': 'middle', class: 'tick' }); t.textContent = label; svg.append(t);
  });
  const t = s('text', { x: (M.l + W - M.r) / 2, y: H - 3, 'text-anchor': 'middle', class: 'axisTitle' }); t.textContent = xTitle; svg.append(t);
  return y;
}

// ------------------------------------------------------------------ line chart
export interface Series { name: string; color: string; values: number[]; band?: [number, number][]; dash?: boolean; quiet?: boolean }
export interface LineOpts {
  title: string; help: string; x: string[]; xTitle: string; series: Series[];
  fmt: (v: number) => string; yMax?: number; extraRows?: (i: number) => { label: string; value: string }[];
}

export function lineChart(o: LineOpts): HTMLElement {
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': o.title });
  const all = o.series.flatMap((se) => [...se.values, ...(se.band ?? []).map((b) => b[1])]).filter(Number.isFinite);
  const yMax = o.yMax ?? niceMax(Math.max(...all, 0) * 1.05);
  const n = o.x.length, xAt = (i: number) => M.l + (n <= 1 ? (W - M.l - M.r) / 2 : ((W - M.l - M.r) * i) / (n - 1));
  const y = axes(svg, yMax, o.fmt, o.x, xAt, o.xTitle);
  for (const se of o.series) {
    if (se.band) { // the 95% range, as a faint ribbon behind its line
      const pts = se.band.map((b, i) => [i, b] as const).filter(([, b]) => Number.isFinite(b[0]));
      if (pts.length > 1) svg.append(s('path', { d: `M${pts.map(([i, b]) => `${xAt(i)},${y(b[1])}`).join('L')}L${pts.slice().reverse().map(([i, b]) => `${xAt(i)},${y(b[0])}`).join('L')}Z`, class: 'band', fill: se.color }));
    }
    let d = '', pen = false;
    se.values.forEach((v, i) => { if (Number.isFinite(v)) { d += `${pen ? 'L' : 'M'}${xAt(i)},${y(v)}`; pen = true; } else pen = false; });
    svg.append(s('path', { d, class: se.dash ? 'line dash' : 'line', stroke: se.color, opacity: se.quiet ? 0.7 : 1 }));
    if (!se.dash) se.values.forEach((v, i) => { if (Number.isFinite(v)) svg.append(s('circle', { cx: xAt(i), cy: y(v), r: n > 20 ? 2 : 3.5, fill: se.color, class: 'dot' })); });
  }
  const cross = s('line', { y1: M.t, y2: H - M.b, class: 'cross', visibility: 'hidden' });
  svg.append(cross);
  const hit = s('rect', { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: 'transparent' });
  svg.append(hit);
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect(), px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : ((px - M.l) / (W - M.l - M.r)) * (n - 1))));
    cross.setAttribute('x1', String(xAt(i))); cross.setAttribute('x2', String(xAt(i))); cross.setAttribute('visibility', 'visible');
    showTip(ev, `${o.xTitle} ${o.x[i]}`, [
      ...o.series.map((se) => ({ color: se.color, dash: se.dash, label: se.name, value: Number.isFinite(se.values[i]) ? o.fmt(se.values[i]) + (se.band && Number.isFinite(se.band[i][0]) ? `  (${o.fmt(se.band[i][0])}–${o.fmt(se.band[i][1])})` : '') : '–' })),
      ...(o.extraRows?.(i) ?? []),
    ]);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  const legend = o.series.length > 1 ? legendOf(o.series) : null;
  return card(o.title, o.help, svg, legend, () => tableOf([o.xTitle, ...o.series.map((se) => se.name)],
    o.x.map((x, i) => [x, ...o.series.map((se) => (Number.isFinite(se.values[i]) ? o.fmt(se.values[i]) : '–'))])));
}

// ------------------------------------------------------------------ 100% stacked bars
export interface StackOpts {
  title: string; help: string; x: string[]; xTitle: string;
  segments: { name: string; color: string }[];
  counts: number[][];        // [x][segment]
  totalLabel?: (i: number) => string;
}

export function stackedBars(o: StackOpts): HTMLElement {
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': o.title });
  const n = o.x.length, slot = (W - M.l - M.r) / Math.max(1, n), bw = Math.min(40, slot * 0.7);
  const xAt = (i: number) => M.l + slot * (i + 0.5);
  const y = axes(svg, 1, (v) => `${Math.round(v * 100)}%`, o.x, xAt, o.xTitle);
  const GAP = 2;
  o.counts.forEach((row, i) => {
    const total = row.reduce((a, b) => a + b, 0);
    if (!total) return;
    let acc = 0;
    row.forEach((v, k) => {
      if (!v) return;
      const top = y((acc + v) / total), bottom = y(acc / total);
      acc += v;
      const hgt = Math.max(0.5, bottom - top - GAP);
      const r = s('rect', { x: xAt(i) - bw / 2, y: top + GAP / 2, width: bw, height: hgt, rx: 2, fill: o.segments[k].color, class: 'seg' });
      r.addEventListener('pointermove', (ev) => showTip(ev, `${o.xTitle} ${o.x[i]}`, [
        { color: o.segments[k].color, label: o.segments[k].name, value: `${(100 * v / total).toFixed(1)}%` },
        { label: o.totalLabel?.(i) ?? 'out of', value: String(total) },
      ]));
      r.addEventListener('pointerleave', hideTip);
      svg.append(r);
    });
  });
  return card(o.title, o.help, svg, legendOf(o.segments), () => tableOf([o.xTitle, ...o.segments.map((g) => g.name), 'total'],
    o.counts.map((row, i) => { const t = row.reduce((a, b) => a + b, 0); return [o.x[i], ...row.map((v) => (t ? `${(100 * v / t).toFixed(1)}%` : '–')), t]; })));
}
