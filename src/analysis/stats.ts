// Everything the report and the Analysis page say about a set of runs, worked out once, here. No Node or DOM: both use it.
import type { BranchInfo, Candidate, Fate, LegRecord, RunRecord } from '../gen/generate';
import { legRisk } from '../config';

export interface GameMeta { legRisk: number[]; maxLegs: number; rtp: number }
export interface DatasetMeta {
  name: string; created: string; count: number; from: number; seconds?: number;
  levers: Record<string, unknown>; set: Record<string, unknown>;
  sweep?: { group: string; lever: string; value: unknown; index: number };
  game: GameMeta;
}

export const CAUSES = ['cop', 'busted', 'traffic', 'truck', 'wall'] as const;
export const FATES: { key: string; fates: Fate[]; label: string; note: string }[] = [
  { key: 'crash', fates: ['c'], label: 'Crash used', note: 'became the checkpoint\'s crash branch' },
  { key: 'escape', fates: ['r'], label: 'Escape used', note: 'became the checkpoint\'s escape branch' },
  { key: 'abandoned', fates: ['b'], label: 'Escape abandoned', note: 'escaped, but the checkpoint it led to was a dead end, so another was tried' },
  { key: 'wrong-crash', fates: ['C'], label: 'Spare crash', note: 'crashed when a crash was already in hand' },
  { key: 'wrong-escape', fates: ['R'], label: 'Spare escape', note: 'escaped, kept in case of backtracking, never needed' },
  { key: 'rejected', fates: ['s', 'x', 't'], label: 'Rejected', note: 'failed a selection rule: solo crash, stall, or touching at the seam' },
];

export interface Rate { k: number; n: number; p: number; lo: number; hi: number }

/** Share with a 95% Wilson interval: honest even for small or lopsided counts. */
export function rate(k: number, n: number): Rate {
  if (!n) return { k, n, p: NaN, lo: NaN, hi: NaN };
  const z = 1.96, p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { k, n, p, lo: Math.max(0, (c - w) / d), hi: Math.min(1, (c + w) / d) };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sorted = (xs: number[]) => xs.slice().sort((a, b) => a - b);
const quantile = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);

export const plannedRisk = (g: GameMeta, leg: number) => legRisk(g, leg);

const isCrash = (f: Fate) => f === 'c' || f === 'C';
const isEscape = (f: Fate) => f === 'r' || f === 'R' || f === 'b';

export interface LegStats {
  leg: number;
  planned: number;        // the crash chance the server draws against
  reached: number;        // share of players who never cash out that get to this checkpoint
  natural: Rate;          // crash share of untilted candidates: how dangerous this leg really is from where spines get to
  crashTries: number;     // mean candidates to find the crash branch
  escapeTries: number;    // mean candidates to find the escape branch that was kept
  crashTilted: Rate;      // crash branches that needed nudging
  escapeTilted: Rate;     // escape branches that needed nudging
  crashTilt: number;      // mean nudge on crash branches (0..tiltMax)
  escapeTilt: number;     // mean nudge on escape branches, as a positive number
  abandoned: number;      // mean escapes abandoned per checkpoint
  sims: number;           // mean leg simulations at the checkpoint
  causes: Record<string, number>;      // crash branch causes
  fates: Record<string, number>;       // candidate fates, by FATES key
  duration: number;       // mean seconds of the escape branch
  crashTime: number;      // mean seconds into the leg the crash branch crashes
  cops: number;           // mean chasing cops at the checkpoint
  hull: number;           // mean robber hull at the checkpoint
}

export interface Strategy { name: string; mean: number; min: number; max: number; paying: number } // exact expectation across runs; paying: mean chance of any return
export interface Summary {
  seeds: number; runs: number;  // seeds tried; of those, the ones a spine was found for
  failed: Rate;                 // seeds dropped
  failedAt: Record<number, number>; // leg the search got to, for dropped seeds
  getawayChance: number; getawayMult: number; meanLegs: number;
  fairness: { worst: number };  // largest |multAfter (1 - risk) / multBefore - 1| over every leg: pricing should make it 0
  natural: Rate;          // all legs pooled
  perLeg: LegStats[];
  causes: Record<string, number>;
  crashTimes: number[];   // seconds into the leg that crash branches crash
  escapeTimes: number[];  // seconds escape branches take to reach the bag
  escapeHull: number[];   // robber hull at the end of escape branches
  tilted: { crash: Rate; escape: Rate };
  quality: { calmForced: Rate; deterministic: Rate };
  strategies: Strategy[];
  cost: { cpuMean: number; cpuMedian: number; cpuMax: number; simsPerRun: number; simsPerLeg: number; backtracks: number; deadEnds: number };
}

type Strat = (l: LegRecord, i: number) => boolean; // true = cash out before playing this leg
export const STRATEGIES: [string, Strat][] = [
  ['never cash out', () => false],
  ['after 1 leg', (_, i) => i >= 1],
  ['after 2 legs', (_, i) => i >= 2],
  ['after 3 legs', (_, i) => i >= 3],
  ['after 5 legs', (_, i) => i >= 5],
  ['at 1.5x', (l) => l.multBefore >= 1.5],
  ['at 2x', (l) => l.multBefore >= 2],
  ['at 5x', (l) => l.multBefore >= 5],
  ['when next leg risk is over 30%', (l) => l.risk > 0.3],
  ['when a cop is within 15 m', (l) => l.features.nearestCop < 15],
  ['when hull is under 60', (l) => l.features.hp < 60],
  ['when a car is within 20 m ahead', (l) => l.features.nearestAhead < 20],
];

/** Exact expected return of a strategy on one run: what it sees at a checkpoint doesn't depend on the draws, only the odds do. */
function expect(run: RunRecord, s: Strat) {
  let alive = 1;
  for (let i = 0; i < run.legs.length; i++) {
    const l = run.legs[i];
    if (i > 0 && s(l, i)) return { value: alive * l.multBefore, paying: alive };
    alive *= 1 - l.risk;
  }
  const last = run.legs[run.legs.length - 1];
  return { value: alive * last.multAfter, paying: alive };
}

export function summarise(all: RunRecord[], game: GameMeta): Summary {
  const runs = all.filter((r) => r.ok), legs = runs.flatMap((r) => r.legs);
  const escapes = legs.map((l) => l.escape), crashes = legs.map((l) => l.crash);
  const tiltedRate = (bs: BranchInfo[]) => rate(bs.filter((b) => b.tilt !== 0).length, bs.length);
  const count = (ls: LegRecord[], pred: (c: Candidate) => boolean) => ls.reduce((a, l) => a + l.log.filter(pred).length, 0);
  const natural = (ls: LegRecord[]) => {
    // Untilted candidates are independent draws of the leg, whatever search they were in, so their pooled crash share is fair
    let k = 0, n = 0;
    for (const l of ls) for (const c of l.log) if (c[3] === 0 && (isCrash(c[0]) || isEscape(c[0]))) { n++; if (isCrash(c[0])) k++; }
    return rate(k, n);
  };
  const tally = (bs: BranchInfo[]) => { const o: Record<string, number> = {}; for (const b of bs) if (b.cause) o[b.cause] = (o[b.cause] ?? 0) + 1; return o; };

  const perLeg: LegStats[] = [];
  let reach = 1;
  for (let i = 0; i < game.maxLegs; i++) {
    const ls = legs.filter((l) => l.leg === i);
    const risk = plannedRisk(game, i);
    if (ls.length) {
      const fates: Record<string, number> = {};
      for (const f of FATES) fates[f.key] = count(ls, (c) => f.fates.includes(c[0]));
      perLeg.push({
        leg: i, planned: risk, reached: reach, natural: natural(ls),
        crashTries: mean(ls.map((l) => l.crash.tries)), escapeTries: mean(ls.map((l) => l.escape.tries)),
        crashTilted: tiltedRate(ls.map((l) => l.crash)), escapeTilted: tiltedRate(ls.map((l) => l.escape)),
        crashTilt: mean(ls.map((l) => l.crash.tilt)), escapeTilt: mean(ls.map((l) => -l.escape.tilt)),
        abandoned: mean(ls.map((l) => l.log.filter((c) => c[0] === 'b').length)),
        sims: mean(ls.map((l) => l.sims)),
        causes: tally(ls.map((l) => l.crash)), fates,
        duration: mean(ls.map((l) => l.escape.time)), crashTime: mean(ls.map((l) => l.crash.time)),
        cops: mean(ls.map((l) => l.features.cops)), hull: mean(ls.map((l) => l.features.hp)),
      });
    }
    reach *= 1 - risk;
  }

  const failedAt: Record<number, number> = {};
  for (const r of all) if (!r.ok) failedAt[r.failedAt] = (failedAt[r.failedAt] ?? 0) + 1;
  const ms = sorted(runs.map((r) => r.ms / 1000));
  let meanLegs = 0, alive = 1, mult = game.rtp;
  for (let i = 0; i < game.maxLegs; i++) { meanLegs += alive; const r = plannedRisk(game, i); alive *= 1 - r; mult /= 1 - r; }
  return {
    seeds: all.length, runs: runs.length, failed: rate(all.length - runs.length, all.length), failedAt,
    getawayChance: alive, getawayMult: mult, meanLegs,
    fairness: { worst: legs.reduce((w, l) => Math.max(w, Math.abs((l.multAfter * (1 - l.risk)) / l.multBefore - 1)), 0) },
    natural: natural(legs),
    perLeg, causes: tally(crashes),
    crashTimes: crashes.map((b) => b.time), escapeTimes: escapes.map((b) => b.time), escapeHull: escapes.map((b) => b.hull),
    tilted: { crash: tiltedRate(crashes), escape: tiltedRate(escapes) },
    quality: {
      calmForced: rate(escapes.filter((b) => b.calmForced).length, escapes.length),
      deterministic: rate([...escapes, ...crashes].filter((b) => b.deterministic).length, escapes.length + crashes.length),
    },
    strategies: STRATEGIES.map(([name, s]) => {
      const xs = runs.map((r) => expect(r, s)), vs = xs.map((x) => x.value);
      return { name, mean: mean(vs), min: Math.min(...vs), max: Math.max(...vs), paying: mean(xs.map((x) => x.paying)) };
    }),
    cost: {
      cpuMean: mean(ms), cpuMedian: quantile(ms, 0.5), cpuMax: ms[ms.length - 1] ?? NaN,
      simsPerRun: mean(runs.map((r) => r.sims)), simsPerLeg: mean(legs.map((l) => l.sims)),
      backtracks: mean(runs.map((r) => r.backtracks)), deadEnds: mean(runs.map((r) => r.deadEnds)),
    },
  };
}

/** Share of `xs` falling in each bin of width `w` from 0, the last bin catching everything above. */
export function histogram(xs: number[], w: number, bins: number) {
  const out = new Array(bins).fill(0);
  for (const x of xs) out[Math.min(bins - 1, Math.max(0, Math.floor(x / w)))]++;
  return out.map((v) => (xs.length ? v / xs.length : 0));
}

export function parseJsonl(text: string): RunRecord[] {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
