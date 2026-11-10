// The Branch explorer: walk a run's spine checkpoint by checkpoint, and watch either branch from any of them.
// It reads the same runs the game plays (public/runs, from  npm run export ). It changes nothing about the game.
import { CONFIG, simKey } from '../config';
import type { BranchInfo, Candidate, LegRecord } from '../gen/generate';
import type { LegPlayback } from '../serve/localServer';
import { Scene, VIEW } from './render3d';

const BASE = import.meta.env.BASE_URL + 'runs/';
const $ = (id: string) => document.getElementById(id)!;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | false)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on') || k in e) (e as any)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false) e.append(kid);
  return e;
}
const svgEl = (tag: string, attrs: Record<string, string | number>) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const x2 = (m: number) => `${m.toFixed(2)}x`;
const pc = (p: number) => `${Math.round(p * 100)}%`;
const secs = (t: number) => `${t.toFixed(1)} s`;
const CAUSE: Record<string, string> = { cop: 'rammed by police', busted: 'busted', traffic: 'hit traffic', truck: 'hit a truck', wall: 'hit the wall', stalled: 'stalled' };
const tiltWords = (t: number) => (t > 0 ? `nudged nastier (tilt +${t.toFixed(2)})` : `nudged calmer (tilt ${t.toFixed(2)})`);

type Leg = Omit<LegRecord, 'escape' | 'crash'> & { escape: BranchInfo; crash: BranchInfo; start: { frame: number[]; meta: Record<number, [number, number, number]> } };
interface RunFile { seed: number; maxLegs: number; configKey: string; sims: number; backtracks: number; deadEnds: number; legs: Leg[] }
interface IndexFile { configKey: string; maxLegs: number; runs: { seed: number; sims: number; backtracks: number }[] }
type Which = 'escape' | 'crash';

type Phase = 'loading' | 'choose' | 'play' | 'aftermath' | 'after';
const scene = new Scene();
let run: RunFile | null = null;
let at = 0;                       // the checkpoint being looked at
let phase: Phase = 'loading';
let current: { which: Which; leg: LegPlayback } | null = null;
let t = 0, speed = 1, paused = false, aftermathLeft = 0;
const cache = new Map<string, Promise<LegPlayback>>();

const branchFile = (leg: number, which: Which) => {
  const key = `${run!.seed}/${leg}-${which}`;
  if (!cache.has(key)) cache.set(key, fetch(`${BASE}${key}.json`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`${key}: ${r.status}`); return r.json(); }));
  return cache.get(key)!;
};

// ------------------------------------------------------------------ moving along the spine

/** Put the scene at a checkpoint, frozen, as if the robber had just driven there. */
function showCheckpoint(k: number) {
  at = k;
  const l = run!.legs[k];
  scene.reset();
  scene.origin = run!.legs.slice(0, k).reduce((a, p) => a + p.escape.endY, 0);
  scene.addMeta(l.start.meta);
  scene.showFrame(l.start.frame);
  current = null;
  phase = 'choose';
  void branchFile(k, 'escape'); void branchFile(k, 'crash'); // ready before they're asked for
  render();
}

async function play(which: Which) {
  if (phase !== 'choose') showCheckpoint(at); // a replay, or the other branch: back to the checkpoint first
  const leg = await branchFile(at, which);
  if (phase !== 'choose') return;
  current = { which, leg };
  scene.beginLeg(leg);
  t = 0; paused = false;
  phase = 'play';
  render();
}

function arrive() { // the escape reached its bag
  const leg = current!.leg;
  scene.collectBag();
  scene.endLeg(leg);
  if (at + 1 < run!.legs.length) {
    at++;
    const next = run!.legs[at];
    scene.addMeta(next.start.meta);
    scene.showFrame(next.start.frame);
    current = null;
    phase = 'choose';
    void branchFile(at, 'escape'); void branchFile(at, 'crash');
  } else phase = 'after';
  render();
}

function tick(dt: number) {
  const step = paused ? 0 : dt * speed;
  if (current && phase === 'play') {
    t += step;
    const R = current.leg.recording, endT = R.endFrame * VIEW.frameTime;
    if (t >= endT) {
      scene.play(current.leg, endT);
      if (current.leg.outcome === 'crash') {
        scene.explode(current.leg.cause === 'busted');
        aftermathLeft = current.leg.cause === 'busted' ? (R.frames.length - 1 - R.endFrame) * VIEW.frameTime : CONFIG.play.aftermathSeconds;
        phase = 'aftermath';
        render();
      } else arrive();
    } else scene.play(current.leg, t);
  } else if (current && phase === 'aftermath') {
    t += step;
    scene.play(current.leg, t);
    if ((aftermathLeft -= step) <= 0) { phase = 'after'; render(); }
  }
  if (current && (phase === 'play' || phase === 'aftermath')) {
    const R = current.leg.recording, f = Math.min(R.hp.length - 1, Math.floor(t / VIEW.frameTime));
    $('liveHull').style.width = `${Math.max(0, R.hp[f]) / CONFIG.kinds.robber.hp * 100}%`;
    $('liveTime').textContent = `${secs(Math.min(t, R.endFrame * VIEW.frameTime))} of ${secs(R.endFrame * VIEW.frameTime)}`;
  }
  scene.update(step);
}

// ------------------------------------------------------------------ the panel

const FATE_STYLE: Record<string, { label: string; cls: string }> = {
  c: { label: 'crash used', cls: 'f-c' }, r: { label: 'escape used', cls: 'f-r' }, b: { label: 'escape abandoned', cls: 'f-d' },
  C: { label: 'spare crash', cls: 'f-C' }, R: { label: 'spare escape', cls: 'f-R' },
  s: { label: 'rejected', cls: 'f-s' }, x: { label: 'rejected', cls: 'f-s' }, t: { label: 'rejected', cls: 'f-s' },
};
const WHY: Record<string, string> = { s: 'solo crash', x: 'stalled', t: 'touching at the seam' };

function candidateStrip(log: Candidate[]) {
  const n = log.length, W = 360, H = 48, mid = 36, bw = W / Math.max(n, 1);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'strip', role: 'img', 'aria-label': `${n} candidates, in the order they were tried` }) as SVGSVGElement;
  log.forEach((c, i) => {
    const r = svgEl('rect', { x: i * bw, y: 0, width: Math.max(0.6, bw - (bw > 3 ? 1 : 0)), height: 22, class: FATE_STYLE[c[0]].cls });
    const tt = svgEl('title', {}); tt.textContent = `Candidate ${i + 1}: ${FATE_STYLE[c[0]].label}${WHY[c[0]] ? ` (${WHY[c[0]]})` : ''}${c[1] ? ` (${CAUSE[c[1]] ?? c[1]})` : ''}, ${secs(c[2])}, hull ${c[4]}${c[3] ? `, ${tiltWords(c[3])}` : ''}`;
    r.append(tt); svg.append(r);
    if (c[3]) svg.append(svgEl('rect', { x: i * bw, width: Math.max(0.6, bw - (bw > 3 ? 1 : 0)), y: c[3] > 0 ? mid - c[3] * 11 : mid, height: Math.abs(c[3]) * 11, class: 'tiltUp' }));
  });
  svg.append(svgEl('line', { x1: 0, x2: W, y1: mid, y2: mid, class: 'stripBase' }));
  const counts: Record<string, number> = {};
  for (const c of log) counts[FATE_STYLE[c[0]].label] = (counts[FATE_STYLE[c[0]].label] ?? 0) + 1;
  const order = ['crash used', 'escape used', 'escape abandoned', 'spare crash', 'spare escape', 'rejected'];
  return h('div', {}, svg, h('div', { class: 'key' }, ...order.filter((k) => counts[k]).map((k) =>
    h('span', {}, h('i', { class: `sq ${Object.values(FATE_STYLE).find((f) => f.label === k)!.cls}` }), `${k} ${counts[k]}`)),
    log.some((c) => c[3]) ? h('span', {}, h('i', { class: 'sq tiltUp' }), 'tilt bar under a candidate') : null));
}

function branchButton(l: Leg, which: Which) {
  const b = l[which], watching = current?.which === which;
  const result = which === 'crash' ? `✕ ${CAUSE[b.cause ?? ''] ?? b.cause} after ${secs(b.time)}` : `✓ reaches the bag in ${secs(b.time)}, hull ${b.hull}`;
  const odds = which === 'crash' ? `drawn ${pc(l.risk)} of the time` : `drawn ${pc(1 - l.risk)} of the time`;
  const how = `found on try ${b.tries}${b.tilt ? `, ${tiltWords(b.tilt)}` : ''}`;
  return h('button', { class: `branch ${which}${watching ? ' watching' : ''}`, onclick: () => void play(which) },
    h('span', { class: 'bnum' }, which === 'crash' ? '✕' : '✓'),
    h('span', { class: 'btext' }, h('b', {}, result), h('small', {}, [odds, how, which === 'escape' && at + 1 < run!.legs.length ? 'carries on to the next checkpoint' : ''].filter(Boolean).join(' · '))));
}

function spineList() {
  return h('ol', { class: 'spine' }, ...run!.legs.map((l, k) => h('li', { class: k === at ? 'here' : '' },
    h('button', { class: 'linkish', onclick: () => showCheckpoint(k) }, `Leg ${k + 1}`),
    h('span', { class: 'muted' }, ` ${pc(l.risk)} · ✕ ${CAUSE[l.crash.cause ?? ''] ?? l.crash.cause}${l.crash.tilt ? ' (nudged)' : ''} · ✓ ${secs(l.escape.time)}${l.escape.tilt ? ' (nudged)' : ''}`))));
}

function resultCard() {
  if (phase !== 'after' || !current) return null;
  const back = h('button', { class: 'act', onclick: () => showCheckpoint(at) }, '⇤ Back to this checkpoint');
  const again = h('button', { class: 'act', onclick: () => void play(current!.which) }, '↺ Watch again');
  const l = run!.legs[at];
  if (current.which === 'crash') {
    return h('section', { class: 'result bad' }, h('h3', {}, `✕ ${CAUSE[current.leg.cause ?? ''] ?? 'Crashed'}`),
      h('p', {}, `When the server draws a crash on this leg (${pc(l.risk)} of the time), this is what a player still riding sees. The run ends here.`),
      h('div', { class: 'acts' }, back, again));
  }
  return h('section', { class: 'result good' }, h('h3', {}, '✓ Clean getaway'), h('p', {}, `That was the last leg, paid at ${x2(l.multAfter)}.`), h('div', { class: 'acts' }, back, again));
}

function render() {
  if (!run) return;
  const l = run.legs[at];
  const nudged = [l.crash.tilt ? 'the crash' : '', l.escape.tilt ? 'the escape' : ''].filter(Boolean);
  if (nudged.length) nudged[0] = nudged[0][0].toUpperCase() + nudged[0].slice(1);
  const abandoned = l.log.filter((c) => c[0] === 'b').length;
  const rejected = l.log.filter((c) => c[0] === 's' || c[0] === 'x' || c[0] === 't').length;
  $('panelBody').replaceChildren(
    resultCard() ?? '',
    h('section', { class: 'node' },
      h('h2', {}, `Leg ${l.leg + 1} of ${run.maxLegs}: checkpoint`),
      h('div', { class: 'prices' },
        h('div', {}, h('small', {}, 'Cash out here'), h('b', {}, x2(l.multBefore))),
        h('div', {}, h('small', {}, 'Crash chance'), h('b', {}, pc(l.risk))),
        h('div', {}, h('small', {}, 'Survive and it\'s worth'), h('b', {}, x2(l.multAfter)))),
      h('h3', {}, 'The two branches'),
      h('div', { class: 'branches' }, branchButton(l, 'escape'), branchButton(l, 'crash')),
      h('details', { open: true }, h('summary', {}, 'How this checkpoint works'),
        h('p', {}, `Both branches start from this exact moment. When the bet locks, the server draws: crash ${pc(l.risk)} of the time, escape otherwise. Nothing on screen says which is coming, so riding on here returns on average exactly what cashing out does: ${x2(l.multBefore)} = (1 − ${pc(l.risk)}) × ${x2(l.multAfter)}.`),
        h('p', { class: 'muted' }, [
          `To find them, ${l.log.length} candidates were simulated from here (${l.sims} leg simulations).`,
          rejected ? `${rejected} failed a selection rule (solo crash, stall, or touching at the seam).` : '',
          abandoned ? `${abandoned} escape${abandoned > 1 ? 's were' : ' was'} abandoned: the checkpoint it led to couldn't produce both a crash and an escape that could go on, so the search backed up to here.` : '',
          nudged.length ? `${nudged.join(' and ')} needed nudging (once only one branch was missing, after ${CONFIG.game.tiltAfter} plain tries the sim is pushed towards it).` : 'Neither branch needed nudging.',
        ].filter(Boolean).join(' '))),
      h('h3', {}, `Candidates from this checkpoint, in order`),
      candidateStrip(l.log),
      h('h3', {}, 'The spine'),
      spineList(),
      h('p', { class: 'muted small' }, `This run cost ${run.sims} leg simulations, with ${run.backtracks} backtrack${run.backtracks === 1 ? '' : 's'}.`)),
  );
  $('live').style.visibility = current && (phase === 'play' || phase === 'aftermath') ? 'visible' : 'hidden';
  if (current) { const b = l[current.which]; $('liveWhat').textContent = `Leg ${l.leg + 1} · the ${current.which} branch${b.tilt ? ` · ${tiltWords(b.tilt)}` : ''}`; }
  $('pause').textContent = paused ? '▶ Play' : '❚❚ Pause';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#speeds button')) b.classList.toggle('on', Number(b.dataset.speed) === speed);
}

// ------------------------------------------------------------------ start up

async function loadRun(seed: number) {
  phase = 'loading';
  $('panelBody').replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  cache.clear();
  run = await (await fetch(`${BASE}${seed}/run.json`, { cache: 'no-store' })).json() as RunFile;
  history.replaceState(null, '', `#${seed}`);
  showCheckpoint(0);
}

async function main() {
  await scene.init($('stage'));
  let last = performance.now();
  const frame = (now: number) => { // drawing starts now, so the road shows even while runs load, or if there are none
    tick(Math.min(0.05, (now - last) / 1000));
    last = now;
    scene.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  let index: IndexFile;
  try {
    const res = await fetch(`${BASE}index.json`, { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error(`index.json: ${res.status}`);
    index = await res.json() as IndexFile;
    if (!index.runs?.length || typeof index.runs[0] !== 'object') throw new Error('index.json lists no runs in the current format');
  } catch (e) {
    console.warn(e);
    $('seed').style.display = 'none';
    $('panelBody').replaceChildren(
      h('p', {}, 'No runs found.'),
      h('p', { class: 'muted' }, 'Record some in a terminal with  npm run export  (or  npm run tune ), then refresh this page.'));
    return;
  }
  const pickSeed = $('seed') as HTMLSelectElement;
  for (const r of index.runs) pickSeed.append(h('option', { value: String(r.seed) }, `Run ${r.seed} · ${r.sims} simulations${r.backtracks ? `, ${r.backtracks} backtrack${r.backtracks > 1 ? 's' : ''}` : ''}`));
  pickSeed.onchange = () => { void loadRun(Number(pickSeed.value)); pickSeed.blur(); };
  if (index.configKey !== simKey(CONFIG)) $('stale').style.display = 'block';
  $('pause').onclick = () => { paused = !paused; render(); };
  for (const b of document.querySelectorAll<HTMLButtonElement>('#speeds button')) b.onclick = () => { speed = Number(b.dataset.speed); render(); };
  $('backBtn').onclick = () => showCheckpoint(at);
  $('restart').onclick = () => showCheckpoint(0);
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); paused = !paused; render(); }
    if (e.code === 'KeyB' && run) showCheckpoint(at);
    if (e.code === 'KeyR' && current) void play(current.which);
    if (e.code === 'KeyE' && run) void play('escape');
    if (e.code === 'KeyC' && run) void play('crash');
  });
  const want = Number(location.hash.slice(1));
  const seed = index.runs.some((r) => r.seed === want) ? want : index.runs[0].seed;
  pickSeed.value = String(seed);
  await loadRun(seed);
}

void main();
