// The Analysis page: pick datasets (from  npm run generate  and  npm run sweep), see how they balance, compare them.
import type { RunRecord } from '../gen/generate';
import { CAUSES, FATES, histogram, parseJsonl, plannedRisk, summarise, type DatasetMeta, type Summary } from './stats';
import { h, lineChart, stackedBars } from './charts';

const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']; // validated in this order on the panel surface
const MAX = SLOTS.length;
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–');
const pct0 = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–');
const fix = (d: number) => (v: number) => (Number.isFinite(v) ? v.toFixed(d) : '–');

interface Loaded { meta: DatasetMeta; runs: RunRecord[]; sum: Summary }
const cache = new Map<string, Promise<Loaded>>();
let metas: DatasetMeta[] = [];
const slotOf = new Map<string, number>(); // a dataset keeps its colour while it stays selected
let selected: string[] = [];
let detailName = '';

const $ = (id: string) => document.getElementById(id)!;

function load(name: string) {
  if (!cache.has(name)) {
    cache.set(name, (async () => {
      const meta = metas.find((m) => m.name === name)!;
      const text = await (await fetch(`/api/datasets/${encodeURIComponent(name)}`)).text();
      const runs = parseJsonl(text);
      return { meta, runs, sum: summarise(runs, meta.game) };
    })());
  }
  return cache.get(name)!;
}

const colorOf = (name: string) => SLOTS[slotOf.get(name) ?? 0];
const valueText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function setSelected(names: string[]) {
  selected = names.slice(0, MAX);
  for (const n of [...slotOf.keys()]) if (!selected.includes(n)) slotOf.delete(n);
  for (const n of selected) if (!slotOf.has(n)) {
    const free = SLOTS.findIndex((_, i) => ![...slotOf.values()].includes(i));
    slotOf.set(n, free);
  }
  if (!selected.includes(detailName)) detailName = selected[0] ?? '';
  history.replaceState(null, '', selected.length ? `#${selected.map(encodeURIComponent).join(',')}` : location.pathname);
  renderPicker();
  void renderAll();
}

// ------------------------------------------------------------------ the picker

function renderPicker() {
  const groups = new Map<string, DatasetMeta[]>();
  for (const m of metas) if (m.sweep) groups.set(m.sweep.group, [...(groups.get(m.sweep.group) ?? []), m]);
  const rows = metas.map((m) => {
    const on = selected.includes(m.name);
    const box = h('input', { type: 'checkbox', checked: on, disabled: !on && selected.length >= MAX, onchange: () => setSelected(on ? selected.filter((n) => n !== m.name) : [...selected, m.name]) });
    const set = Object.entries(m.set ?? {}).map(([k, v]) => `${k} = ${valueText(v)}`).join(', ');
    return h('tr', { class: on ? 'on' : '' },
      h('td', {}, h('label', { class: 'pick' }, box, on ? h('i', { class: 'sw', style: `--c:${colorOf(m.name)}` }) : h('i', { class: 'sw none' }), m.name)),
      h('td', { class: 'num' }, String(m.count)),
      h('td', {}, new Date(m.created).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })),
      h('td', { class: 'muted' }, set || 'saved levers'));
  });
  const sweeps = [...groups.entries()].map(([g, ms]) => h('button', { class: 'chipBtn', onclick: () => setSelected(ms.sort((a, b) => a.sweep!.index - b.sweep!.index).map((m) => m.name)) }, `Sweep: ${ms[0].sweep!.lever} (${ms.length} values)`));
  $('picker').replaceChildren(
    metas.length ? h('table', { class: 'data picker' }, h('thead', {}, h('tr', {}, h('th', {}, 'Dataset'), h('th', {}, 'Runs'), h('th', {}, 'Made'), h('th', {}, 'Levers changed for it'))), h('tbody', {}, ...rows))
      : h('p', { class: 'empty' }, 'No datasets yet. In a terminal:  npm run generate -- --count 200  then refresh this page.'),
    ...(sweeps.length ? [h('div', { class: 'sweeps' }, h('span', { class: 'muted' }, 'Select a whole sweep: '), ...sweeps)] : []),
    h('p', { class: 'muted small' }, `Up to ${MAX} at once. Colours stay with a dataset while it is selected.`),
  );
}

// ------------------------------------------------------------------ sections

function leverDiff(ls: Loaded[]) {
  if (ls.length < 2) return null;
  const keys = [...new Set(ls.flatMap((l) => Object.keys(l.meta.levers)))].sort();
  const differ = keys.filter((k) => new Set(ls.map((l) => valueText(l.meta.levers[k] ?? 'default'))).size > 1);
  return h('section', { class: 'card wide' }, h('h3', {}, 'Levers that differ between these datasets'),
    differ.length ? h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Lever'), ...ls.map((l) => h('th', {}, h('i', { class: 'sw', style: `--c:${colorOf(l.meta.name)}` }), l.meta.name)))),
      h('tbody', {}, ...differ.map((k) => h('tr', {}, h('td', {}, k), ...ls.map((l) => h('td', {}, k in l.meta.levers ? valueText(l.meta.levers[k]) : 'default'))))))
      : h('p', { class: 'help' }, 'None: they were run with the same levers (and differ only in seeds or code).'));
}

function headline(ls: Loaded[]) {
  type Row = [string, string, (s: Summary) => string];
  const rows: Row[] = [
    ['Runs', 'spines built, of the seeds tried', (s) => `${s.runs} of ${s.seeds}`],
    ['Natural crash rate', 'all legs, untilted candidates. Compare with the target risk', (s) => `${pct(s.natural.p)} (${pct(s.natural.lo)}–${pct(s.natural.hi)})`],
    ['Crash branches nudged', 'found only with tilt: the further from the plain sim, the more contrived', (s) => pct(s.tilted.crash.p)],
    ['Escape branches nudged', 'the same, for escapes', (s) => pct(s.tilted.escape.p)],
    ['Seeds dropped', 'no spine within game.runBudget', (s) => pct(s.failed.p)],
    ['Legs played', 'expected, by a player who never cashes out', (s) => s.meanLegs.toFixed(2)],
    ['Simulations per run', 'the whole spine, backtracking included', (s) => s.cost.simsPerRun.toFixed(0)],
    ['Backtracks per run', 'escapes given up on because the next checkpoint was a dead end', (s) => s.cost.backtracks.toFixed(2)],
    ['CPU per run', 'mean seconds', (s) => `${s.cost.cpuMean.toFixed(1)} s`],
  ];
  return h('section', { class: 'card wide' }, h('h3', {}, 'At a glance'),
    h('table', { class: 'data glance' }, h('thead', {}, h('tr', {}, h('th', {}, ''), ...ls.map((l) => h('th', {}, h('i', { class: 'sw', style: `--c:${colorOf(l.meta.name)}` }), l.meta.name)))),
      h('tbody', {}, ...rows.map(([name, note, f]) => h('tr', {}, h('td', {}, h('b', {}, name), h('div', { class: 'muted small' }, note)), ...ls.map((l) => h('td', { class: 'num' }, f(l.sum))))))));
}

function legCharts(ls: Loaded[]) {
  const maxLeg = Math.max(...ls.map((l) => l.sum.perLeg.length));
  const x = Array.from({ length: maxLeg }, (_, i) => String(i + 1));
  const byLeg = (l: Loaded, f: (p: Summary['perLeg'][number]) => number) => x.map((_, i) => { const p = l.sum.perLeg.find((q) => q.leg === i); return p ? f(p) : NaN; });
  const minN = 30; // fewer untilted candidates than this and the natural rate is left out, rather than drawn as a wild swing
  const multi = ls.length > 1;
  const sameTarget = new Set(ls.map((l) => JSON.stringify([l.meta.game.legRisk, l.meta.game.maxLegs]))).size === 1;
  const line = (title: string, help: string, fmt: (v: number) => string, f: (p: Summary['perLeg'][number]) => number) =>
    lineChart({ title, help, xTitle: 'Leg', x, fmt, series: ls.map((l) => ({ name: l.meta.name, color: colorOf(l.meta.name), values: byLeg(l, f) })) });
  return [
    lineChart({
      title: 'Natural crash rate against the target', xTitle: 'Leg', x, fmt: pct0,
      help: 'Solid: how often untilted candidates crash from where the spine really gets to, with its 95% range. Dashed: the odds the server draws against. The natural rate does not have to match the target any more, but far from it one side needs many tries and nudging to find, which shows as contrived crashes or escapes.',
      series: [
        ...ls.map((l) => ({ name: multi ? `${l.meta.name}: natural` : 'Natural', color: colorOf(l.meta.name), values: byLeg(l, (p) => (p.natural.n >= minN ? p.natural.p : NaN)), band: x.map((_, i) => { const p = l.sum.perLeg.find((q) => q.leg === i); return p && p.natural.n >= minN ? [p.natural.lo, p.natural.hi] as [number, number] : [NaN, NaN] as [number, number]; }) })),
        ...(sameTarget ? [{ name: 'Target', color: '#9a9ba3', values: x.map((_, i) => plannedRisk(ls[0].meta.game, i)), dash: true }]
          : ls.map((l) => ({ name: `${l.meta.name}: target`, color: colorOf(l.meta.name), values: byLeg(l, (p) => p.planned), dash: true }))),
      ],
    }),
    line('Players still riding', 'Share of players who never cash out that reach each checkpoint. Exact: it follows from the odds alone.', pct0, (p) => p.reached),
    line('Crash branches that needed nudging', 'Share of crash branches found only with tilt (from game.tiltAfter tries). High: the road is too calm here to crash plainly.', pct0, (p) => p.crashTilted.p),
    line('Escape branches that needed nudging', 'Share of escape branches found only with tilt. High: the road is too dangerous here to get through plainly.', pct0, (p) => p.escapeTilted.p),
    line('Tries to find the crash', 'Mean candidates until a usable crash branch was found.', fix(1), (p) => p.crashTries),
    line('Tries to find the escape', 'Mean candidates until the kept escape branch was found.', fix(1), (p) => p.escapeTries),
    line('Escapes abandoned', 'Mean escapes per checkpoint given up on because the checkpoint they led to was a dead end.', fix(2), (p) => p.abandoned),
    line('Simulations per checkpoint', 'Everything spent at the checkpoint, abandoned escapes included.', fix(0), (p) => p.sims),
    line('Robber hull at the checkpoint', 'Mean hull the robber carries into each leg on the spine. Falling fast: late legs start from a wreck-in-waiting.', fix(0), (p) => p.hull),
    line('Chasing cops at the checkpoint', 'Mean police cars in pursuit as each leg starts (heat.cops sets how many are kept alive).', fix(1), (p) => p.cops),
  ];
}

function distributions(ls: Loaded[]) {
  const secs = Array.from({ length: 12 }, (_, i) => (i === 11 ? '11+' : `${i}–${i + 1}`));
  const hull = Array.from({ length: 8 }, (_, i) => (i === 7 ? '140+' : `${i * 20}–${i * 20 + 20}`));
  return [
    lineChart({
      title: 'When crashes happen', xTitle: 'Seconds into the leg', x: secs, fmt: pct0,
      help: 'Crash branches, by how far into the leg they come. Crashes in the first second or two are over before the player sees any danger building.',
      series: ls.map((l) => ({ name: l.meta.name, color: colorOf(l.meta.name), values: histogram(l.sum.crashTimes, 1, 12) })),
    }),
    lineChart({
      title: 'How long escapes take', xTitle: 'Seconds to reach the bag', x: secs, fmt: pct0,
      help: 'Escape branches, by leg length. This is the pacing of the ride: one bag every this-many seconds.',
      series: ls.map((l) => ({ name: l.meta.name, color: colorOf(l.meta.name), values: histogram(l.sum.escapeTimes, 1, 12) })),
    }),
    lineChart({
      title: 'Hull left after an escape', xTitle: 'Robber hull', x: hull, fmt: pct0,
      help: 'Escape branches, by the robber\'s hull as it reaches the bag. Lots of near-zero escapes look like luck rather than driving.',
      series: ls.map((l) => ({ name: l.meta.name, color: colorOf(l.meta.name), values: histogram(l.sum.escapeHull, 20, 8) })),
    }),
  ];
}

const CAUSE_NAMES: Record<string, string> = { cop: 'Rammed by police', busted: 'Busted', traffic: 'Traffic', truck: 'Truck', wall: 'Wall', stalled: 'Stalled' };

function detail(l: Loaded) {
  const x = l.sum.perLeg.map((p) => String(p.leg + 1));
  return [
    stackedBars({
      title: 'What takes the robber out, by leg', xTitle: 'Leg', x,
      help: 'Causes across each leg\'s crash branches. A leg dominated by one cause is a one-trick leg.',
      segments: CAUSES.map((c, i) => ({ name: CAUSE_NAMES[c], color: SLOTS[i] })),
      counts: l.sum.perLeg.map((p) => CAUSES.map((c) => p.causes[c] ?? 0)),
      totalLabel: () => 'crash branches',
    }),
    stackedBars({
      title: 'What became of the candidates, by leg', xTitle: 'Leg', x,
      help: 'Every candidate simulated at the checkpoints of the spine. The spares came out the way a branch already found did: they are what a lopsided natural rate costs.',
      segments: FATES.map((f, i) => ({ name: f.label, color: SLOTS[i] })),
      counts: l.sum.perLeg.map((p) => FATES.map((f) => p.fates[f.key] ?? 0)),
      totalLabel: () => 'candidates',
    }),
  ];
}

function strategies(ls: Loaded[]) {
  const rtp = ls[0].meta.game.rtp;
  return h('section', { class: 'card wide' }, h('h3', {}, 'Cash-out strategies'),
    h('p', { class: 'help' }, `Exact expected return per unit staked, averaged over runs. The server draws the odds independently of anything on screen, so every line should be ${rtp} on every run. Anything else is a pricing bug.`),
    h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Strategy'), ...ls.map((l) => h('th', {}, h('i', { class: 'sw', style: `--c:${colorOf(l.meta.name)}` }), l.meta.name)))),
      h('tbody', {}, ...ls[0].sum.strategies.map((st, i) => h('tr', {}, h('td', {}, st.name), ...ls.map((l) => {
        const v = l.sum.strategies[i], off = [v.mean, v.min, v.max].some((x) => Math.abs(x - rtp) > 1e-6);
        return h('td', { class: 'num', title: `pays out ${pct(v.paying)} of the time` }, v.mean.toFixed(4), off ? h('span', { class: 'flag' }, ' off') : null);
      }))))));
}

async function sweepCharts(group: string) {
  const ms = metas.filter((m) => m.sweep?.group === group).sort((a, b) => a.sweep!.index - b.sweep!.index);
  const ls = await Promise.all(ms.map((m) => load(m.name)));
  const lever = ms[0].sweep!.lever, x = ms.map((m) => valueText(m.sweep!.value));
  const one = (title: string, help: string, fmt: (v: number) => string, f: (s: Summary) => number, band?: (s: Summary) => [number, number]) =>
    lineChart({ title, help, xTitle: lever, x, fmt, series: [{ name: title, color: SLOTS[0], values: ls.map((l) => f(l.sum)), band: band ? ls.map((l) => band(l.sum)) : undefined }] });
  const leg1 = (s: Summary) => s.perLeg[0]?.natural;
  return h('section', { class: 'sweepBox' },
    h('h2', {}, `Sweep: ${lever}`),
    h('p', { class: 'help' }, `${ms.length} datasets on the same seeds, one per value. Read across to see what the lever does; the best value is usually where little needs nudging and few seeds are dropped.`),
    h('div', { class: 'grid' },
      one('Natural crash rate, leg 1', 'Untilted crash share on the first leg, with its 95% range.', pct0, (s) => leg1(s)?.p ?? NaN, (s) => [leg1(s)?.lo ?? NaN, leg1(s)?.hi ?? NaN]),
      one('Natural crash rate, all legs', 'Untilted crash share across every leg, with its 95% range.', pct0, (s) => s.natural.p, (s) => [s.natural.lo, s.natural.hi]),
      one('Crash branches nudged', 'Across all legs.', pct0, (s) => s.tilted.crash.p),
      one('Escape branches nudged', 'Across all legs.', pct0, (s) => s.tilted.escape.p),
      one('Seeds dropped', 'No spine within game.runBudget.', pct, (s) => s.failed.p),
      one('Simulations per run', 'Cost of a spine.', fix(0), (s) => s.cost.simsPerRun),
    ));
}

let renderToken = 0;
async function renderAll() {
  const token = ++renderToken;
  const out = $('out');
  if (!selected.length) { out.replaceChildren(h('p', { class: 'empty' }, 'Tick a dataset above.')); return; }
  out.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
  const ls = await Promise.all(selected.map(load));
  if (token !== renderToken) return;
  const groups = [...new Set(ls.map((l) => l.meta.sweep?.group).filter(Boolean))] as string[];
  const sweep = groups.length === 1 && ls.every((l) => l.meta.sweep?.group === groups[0]) ? await sweepCharts(groups[0]) : null;
  if (token !== renderToken) return;
  const det = ls.find((l) => l.meta.name === detailName) ?? ls[0];
  const detSelect = ls.length > 1 ? h('select', { onchange: (e: Event) => { detailName = (e.target as HTMLSelectElement).value; void renderAll(); } },
    ...ls.map((l) => h('option', { value: l.meta.name, selected: l === det }, l.meta.name))) : null;
  const old = ls.filter((l) => l.runs.length && !('ok' in l.runs[0]));
  out.replaceChildren(
    ...(old.length ? [h('p', { class: 'warnLine' }, `⚠ ${old.map((l) => l.meta.name).join(', ')} were made by the old pool generator and can't be read. Generate again.`)] : []),
    ...(sweep ? [sweep] : []),
    h('div', { class: 'grid' }, headline(ls), leverDiff(ls)),
    h('h2', {}, 'Leg by leg'),
    h('div', { class: 'grid' }, ...legCharts(ls)),
    h('h2', {}, 'Inside a leg'),
    h('div', { class: 'grid' }, ...distributions(ls)),
    h('h2', {}, 'Breakdowns ', detSelect ?? h('span', { class: 'muted' }, `· ${det.meta.name}`)),
    h('div', { class: 'grid' }, ...detail(det)),
    h('h2', {}, 'Pricing'),
    strategies(ls),
  );
}

async function main() {
  try {
    metas = await (await fetch('/api/datasets')).json();
  } catch {
    $('picker').replaceChildren(h('p', { class: 'empty' }, 'This page needs the dev server: npm run dev, then open /analysis.html.'));
    return;
  }
  metas.sort((a, b) => b.created.localeCompare(a.created));
  const fromHash = location.hash.slice(1).split(',').map(decodeURIComponent).filter((n) => metas.some((m) => m.name === n));
  setSelected(fromHash.length ? fromHash : metas.slice(0, 1).map((m) => m.name));
}

void main();
