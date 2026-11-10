// The Levers panel: every number in config.ts, editable on the page. Only exists under the dev server.
import { CONFIG, DEFAULTS, legRisk } from '../config';
import configSource from '../config.ts?raw';

type Value = number | boolean | number[];

const LIVE_SECTIONS = ['play', 'view'];   // these need a refresh, not a re-record
const HIDDEN_SECTIONS = ['sim'];          // changing the timestep breaks recording rather than balancing anything

const at = (root: object, path: string) => path.split('.').reduce((n: any, k) => n[k], root) as Value;
const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);
const isLive = (path: string) => LIVE_SECTIONS.includes(path.split('.')[0]);
const words = (s: string) => s.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase());

function leafPaths(node: object, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (HIDDEN_SECTIONS.includes(path)) return [];
    return typeof v === 'object' && !Array.isArray(v) ? leafPaths(v, path) : [path];
  });
}

/** The comments in config.ts are the lever descriptions, so there is only one place to keep them. */
function readHints() {
  const hints = new Map<string, string>(), stack: string[] = [];
  for (const raw of configSource.slice(configSource.indexOf('DEFAULTS = {')).split('\n').slice(1)) {
    const [codePart, ...rest] = raw.split('//');
    const code = codePart.trim(), comment = rest.join('//').trim();
    if (code.startsWith('}')) { if (!stack.length) break; stack.pop(); continue; }
    const open = code.match(/^(\w+):\s*\{$/);
    if (open) { stack.push(open[1]); continue; }
    const keys = [...code.matchAll(/(\w+):/g)].map((m) => m[1]);
    if (comment && keys.length) hints.set([...stack, keys[0]].join('.'), comment); // a one-line section's comment lands on its name
    for (const k of keys.slice(1)) if (comment && code.includes('{')) hints.set([...stack, keys[0], k].join('.'), comment);
  }
  return hints;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

export function mountLeverPanel() {
  const draft = new Map<string, Value>();
  const refreshers: (() => void)[] = [];
  const bad = new Set<string>();
  const paths = leafPaths(DEFAULTS);
  for (const p of paths) draft.set(p, at(CONFIG, p));

  const odds = el('div', { id: 'leverOdds' });
  const status = el('div', { id: 'leverStatus' });
  const apply = el('button', { id: 'leverApply' });
  const count = el('input', { type: 'number', value: '16', min: '1', max: '500', title: 'Runs to record', style: 'width:64px' });

  const changed = () => paths.filter((p) => !same(draft.get(p)!, at(CONFIG, p)));
  const needsRecord = () => { const c = changed(); return !c.length || c.some((p) => !isLive(p)); };

  function refresh() {
    for (const r of refreshers) r();
    const g = { legRisk: draft.get('game.legRisk') as number[], maxLegs: draft.get('game.maxLegs') as number };
    let pay = draft.get('game.rtp') as number, reach = 1;
    const first = legRisk(g, 0), last = legRisk(g, g.maxLegs - 1);
    for (let i = 0; i < g.maxLegs; i++) { const r = legRisk(g, i); pay /= 1 - r; reach *= 1 - r; }
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    odds.innerHTML = `Crash chance per leg: <b>${first === last ? pct(first) : `${pct(first)} rising to ${pct(last)}`}</b><br>`
      + `Full run of ${g.maxLegs} legs pays <b>${pay.toFixed(1)}x</b>, reached by <b>${reach < 0.001 ? reach.toExponential(1) : pct(reach)}</b> of runs`;
    apply.disabled = bad.size > 0;
    apply.textContent = bad.size ? 'Fix the outlined values' : needsRecord() ? 'Apply and re-record' : 'Apply';
  }

  function row(path: string, hint: string | undefined) {
    const def = at(DEFAULTS, path);
    const inputs: HTMLInputElement[] = [];
    const read = () => {
      bad.delete(path);
      if (typeof def === 'boolean') { draft.set(path, inputs[0].checked); return; }
      const nums = inputs.map((i) => (i.value.trim() === '' ? NaN : Number(i.value)));
      inputs.forEach((inp, n) => inp.classList.toggle('bad', !Number.isFinite(nums[n])));
      if (nums.some((n) => !Number.isFinite(n))) { bad.add(path); return; }
      draft.set(path, Array.isArray(def) ? nums : nums[0]);
    };
    const write = () => {
      const v = draft.get(path)!;
      if (typeof v === 'boolean') inputs[0].checked = v;
      else (Array.isArray(v) ? v : [v]).forEach((n, i) => { inputs[i].value = String(n); inputs[i].classList.remove('bad'); });
    };
    if (typeof def === 'boolean') inputs.push(el('input', { type: 'checkbox' }));
    else for (let i = 0; i < (Array.isArray(def) ? def.length : 1); i++) inputs.push(el('input', { type: 'number', step: 'any' }));
    for (const i of inputs) i.oninput = () => { read(); refresh(); };
    write();

    const undo = el('button', { className: 'undo', textContent: '↺', title: `Back to default: ${JSON.stringify(def)}` });
    undo.onclick = () => { draft.set(path, def); bad.delete(path); write(); refresh(); };
    const label = words(path.split('.').slice(1).join(' '));
    const box = el('div', { className: 'lv' }, el('div', { className: 'line' }, el('span', { className: 'name', textContent: label }), el('span', { className: 'in' }, ...inputs), undo));
    if (hint) box.append(el('small', { textContent: hint }));
    box.dataset.find = `${path} ${label} ${hint ?? ''}`.toLowerCase();
    refreshers.push(() => box.classList.toggle('changed', !same(draft.get(path)!, def)));
    return box;
  }

  const hints = readHints();
  const list = el('div', { id: 'leverList' });
  const sections = new Map<string, HTMLDetailsElement>();
  for (const p of paths) {
    const name = p.split('.')[0];
    if (!sections.has(name)) {
      const d = el('details', { open: name === 'game' }, el('summary', {}, name, el('small', { textContent: isLive(name) ? 'refresh only' : 're-record' })));
      sections.set(name, d);
      list.append(d);
    }
    const parent = p.split('.').slice(0, -1).join('.');
    sections.get(name)!.append(row(p, hints.get(p) ?? hints.get(parent)));
  }

  const search = el('input', { type: 'search', placeholder: 'Find a lever (try "ram" or "cop")' });
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const d of sections.values()) {
      let hits = 0;
      d.querySelectorAll<HTMLElement>('.lv').forEach((r) => { const on = r.dataset.find!.includes(q); r.style.display = on ? '' : 'none'; if (on) hits++; });
      d.style.display = hits ? '' : 'none';
      if (q) d.open = true;
    }
  };

  async function send() {
    const levers: Record<string, Value> = {};
    for (const p of paths) if (!same(draft.get(p)!, at(DEFAULTS, p))) levers[p] = draft.get(p)!;
    const rerecord = needsRecord();
    apply.disabled = true;
    status.textContent = rerecord ? `Re-recording ${count.value} runs. The page will reload when it's done...` : 'Saving...';
    try {
      const res = await fetch('/api/levers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levers, rerecord, count: Number(count.value) }) });
      if (res.ok) { location.reload(); return; }
      status.textContent = `Nothing was changed. ${await res.text()}`;
    } catch (e) {
      status.textContent = `Could not reach the dev server. ${e}`;
    }
    apply.disabled = false;
  }
  apply.onclick = () => void send();

  const reset = el('button', { id: 'leverReset', textContent: 'All defaults' });
  reset.onclick = () => {
    for (const p of paths) draft.set(p, at(DEFAULTS, p));
    bad.clear();
    void send();
  };

  const panel = el('aside', { id: 'levers' });
  const setOpen = (open: boolean) => { panel.classList.toggle('open', open); history.replaceState(null, '', open ? '#levers' : location.pathname); };
  const close = el('button', { className: 'x', textContent: '✕', title: 'Close' });
  close.onclick = () => setOpen(false);
  panel.append(
    el('header', {}, el('div', { className: 'top' }, 'Levers', close), odds, search),
    list,
    el('footer', {}, status, el('div', { className: 'btns' }, apply, el('label', {}, 'Runs ', count), reset)),
  );
  const toggle = el('button', { id: 'leverToggle', textContent: 'Levers' });
  toggle.onclick = () => setOpen(!panel.classList.contains('open'));
  document.body.append(toggle, panel);
  if (location.hash === '#levers') panel.classList.add('open');
  refresh();
}
