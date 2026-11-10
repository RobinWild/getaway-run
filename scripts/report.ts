// Reads a dataset and reports whether the game could work.   npm run report [-- --name latest]
// The same numbers, with charts and comparisons between datasets, are on the Analysis page (npm run dev, then /analysis.html).
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG } from '../src/config';
import { CAUSES, FATES, histogram, parseJsonl, summarise, type DatasetMeta, type GameMeta } from '../src/analysis/stats';
import { str } from './cli';

const name = str('name', 'latest');
const dir = `out/datasets/${name}`;
if (!existsSync(`${dir}/runs.jsonl`)) { console.error(`No dataset "${name}". Make one with:  npm run generate -- --count 200 --name ${name}`); process.exit(1); }
const meta: DatasetMeta | null = existsSync(`${dir}/meta.json`) ? JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8')) : null;
const game: GameMeta = meta?.game ?? CONFIG.game;
const runs = parseJsonl(readFileSync(`${dir}/runs.jsonl`, 'utf8'));
if (runs.length && !('ok' in runs[0])) { console.error(`Dataset "${name}" was made by the old pool generator. Generate it again.`); process.exit(1); }
const S = summarise(runs, game);

const pct = (p: number) => (Number.isFinite(p) ? (100 * p).toFixed(1) + '%' : '-');
const pad = (s: string, n: number) => s.padStart(n);

console.log(`dataset "${name}": ${S.runs} runs built from ${S.seeds} seeds, ${game.maxLegs} legs, return ${game.rtp}`);
if (meta && Object.keys(meta.set).length) console.log(`  run with ${Object.entries(meta.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);

console.log('\nTHE ODDS (exact: the server draws them)');
console.log(`  a player who never cashes out plays ${S.meanLegs.toFixed(2)} legs on average, and gets away with ${S.getawayMult.toFixed(1)}x ${S.getawayChance < 0.001 ? S.getawayChance.toExponential(1) : pct(S.getawayChance)} of the time`);
console.log(`  pricing check, worst leg: ${S.fairness.worst.toExponential(1)} off fair (should be ~0)`);

console.log('\nLEG BY LEG');
console.log('  "natural" is how often untilted candidates crash from where the spine gets to. Far from 50/50 and one side');
console.log('  takes many tries, then nudging (tilted) to find. It is the number to steer the danger levers by.\n');
console.log('  leg  target  natural (95% range)   tries c/e   nudged c/e    abandoned  sims  escape  crash at  cops  hull');
for (const l of S.perLeg) {
  const nat = Number.isFinite(l.natural.p) ? `${pct(l.natural.p)} (${pct(l.natural.lo)}-${pct(l.natural.hi)})` : '-';
  console.log(`  ${pad(String(l.leg + 1), 3)}  ${pad(pct(l.planned), 6)}  ${nat.padEnd(19)}  ${pad(l.crashTries.toFixed(1), 4)}/${l.escapeTries.toFixed(1).padEnd(5)}  ${pad(pct(l.crashTilted.p), 5)}/${pct(l.escapeTilted.p).padEnd(6)}  ${pad(l.abandoned.toFixed(2), 9)}  ${pad(l.sims.toFixed(0), 4)}  ${pad(l.duration.toFixed(1), 4)} s  ${pad(l.crashTime.toFixed(1), 6)} s  ${pad(l.cops.toFixed(1), 4)}  ${pad(l.hull.toFixed(0), 4)}`);
}

console.log('\nWHAT TAKES THE ROBBER OUT (crash branches)');
const totalC = Object.values(S.causes).reduce((a, b) => a + b, 0);
for (const k of [...CAUSES, ...Object.keys(S.causes).filter((k) => !(CAUSES as readonly string[]).includes(k))]) if (S.causes[k]) console.log(`  ${k.padEnd(8)} ${pct(S.causes[k] / totalC)}`);
const ct = histogram(S.crashTimes, 1, 8);
console.log(`  seconds into the leg:  ${ct.map((v, i) => `${i}${i === 7 ? '+' : `-${i + 1}`}s ${pct(v)}`).join('  ')}`);

console.log('\nWHAT BECAME OF THE CANDIDATES');
const tot: Record<string, number> = {};
for (const l of S.perLeg) for (const [k, v] of Object.entries(l.fates)) tot[k] = (tot[k] ?? 0) + v;
const sum = Object.values(tot).reduce((a, b) => a + b, 0);
for (const f of FATES) console.log(`  ${f.label.padEnd(17)} ${pad(pct(tot[f.key] / sum), 6)}  ${f.note}`);

console.log('\nBRANCH QUALITY');
console.log(`  crash branches that needed nudging  ${pct(S.tilted.crash.p)}`);
console.log(`  escape branches that needed nudging ${pct(S.tilted.escape.p)}`);
console.log(`  escapes ending on the wait limit rather than a calm moment ${pct(S.quality.calmForced.p)}`);
console.log(`  re-simulating a branch matched exactly ${pct(S.quality.deterministic.p)}`);

console.log('\nCASH-OUT STRATEGIES (exact expected return per unit staked; every line should be ' + game.rtp + ')');
for (const s of S.strategies) console.log(`  ${s.name.padEnd(34)} ${s.mean.toFixed(4)}  (runs ${s.min.toFixed(4)} to ${s.max.toFixed(4)}), pays out ${pct(s.paying)} of the time`);

console.log('\nCOST');
console.log(`  CPU per run: mean ${S.cost.cpuMean.toFixed(1)} s, median ${S.cost.cpuMedian.toFixed(1)} s, slowest ${S.cost.cpuMax.toFixed(1)} s`);
console.log(`  ${S.cost.simsPerRun.toFixed(0)} leg simulations per run (${S.cost.simsPerLeg.toFixed(1)} per checkpoint on the spine), ${S.cost.backtracks.toFixed(2)} backtracks and ${S.cost.deadEnds.toFixed(2)} dead ends per run`);
console.log(`  seeds dropped (no spine within game.runBudget): ${pct(S.failed.p)}${S.failed.k ? `, got as far as leg ${Object.entries(S.failedAt).map(([l, n]) => `${Number(l) + 1} (${n})`).join(', ')}` : ''}`);
