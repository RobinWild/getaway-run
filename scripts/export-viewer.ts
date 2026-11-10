// Generates runs for the browser viewer (and the Branch explorer) and writes them to public/runs/, replacing what is
// there only once all succeed.
//   npm run export -- --count 60 --from 5000 --workers 22 [--levers file.json] [--set path=value]
//
// Each run is a folder:
//   run.json             prices, each checkpoint's start frame, and what was found there (for the explorer)
//   <leg>-escape.json    the leg played to the bag: its recording ends where the next leg's two branches begin
//   <leg>-crash.json     the leg played to a crash
// The game's server reveals one of a leg's two branch files when the bet locks.
import { fork } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simKey } from '../src/config';
import { generateRun, type BranchInfo, type RunRecord } from '../src/gen/generate';
import { args, friendly, leversFromArgs, num } from './cli';

const from = num('from', 5000), count = num('count', 60), workers = num('workers', 22);
const { cfg } = friendly(leversFromArgs);
const STAGING = 'out/runs-next';

if (process.send) {
  process.on('message', (m: { seed: number } | 'done') => {
    if (m === 'done') process.exit(0);
    process.send!(generateRun(m.seed, cfg, false, true));
  });
  process.send('ready');
} else {
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  // a seed with no spine within game.runBudget is skipped and another is tried
  const failLimit = Math.max(40, count * 4);
  let next = from, done = 0, failed = 0, inFlight = 0;
  const runs: { seed: number; sims: number; backtracks: number }[] = [];
  const self = fileURLToPath(import.meta.url);
  const t0 = performance.now();
  const lean = ({ recording: _r, ...b }: BranchInfo) => b;
  for (let w = 0; w < Math.min(workers, count); w++) {
    const child = fork(self, args);
    child.on('exit', (code) => { if (code) { console.error(`a worker failed (exit ${code})`); process.exit(1); } });
    child.on('message', (m: RunRecord | 'ready') => {
      if (m !== 'ready') {
        inFlight--;
        if (!m.ok) failed++;
        else if (done < count) {
          const dir = `${STAGING}/${m.seed}`;
          mkdirSync(dir, { recursive: true });
          for (const l of m.legs) {
            for (const [name, b, outcome] of [['escape', l.escape, 'reached'], ['crash', l.crash, 'crash']] as const) {
              writeFileSync(`${dir}/${l.leg}-${name}.json`, JSON.stringify({ leg: l.leg, outcome, cause: b.cause, bag: b.bag, recording: b.recording }));
            }
          }
          const legs = m.legs.map((l) => ({ ...l, escape: lean(l.escape), crash: lean(l.crash) }));
          writeFileSync(`${dir}/run.json`, JSON.stringify({ seed: m.seed, maxLegs: cfg.game.maxLegs, configKey: simKey(cfg), sims: m.sims, backtracks: m.backtracks, deadEnds: m.deadEnds, legs }));
          runs.push({ seed: m.seed, sims: m.sims, backtracks: m.backtracks });
          if (++done === count) {
            writeFileSync(`${STAGING}/index.json`, JSON.stringify({ configKey: simKey(cfg), maxLegs: cfg.game.maxLegs, runs: runs.sort((a, b) => a.seed - b.seed) }));
            rmSync('public/runs', { recursive: true, force: true });
            cpSync(STAGING, 'public/runs', { recursive: true });
            console.log(`exported ${count} runs to public/runs in ${((performance.now() - t0) / 1000).toFixed(0)} s (${failed} seeds dropped: no spine within game.runBudget)`);
          }
        }
      }
      if (done + inFlight < count && failed < failLimit) {
        inFlight++;
        child.send({ seed: next++ });
      } else {
        child.send('done');
        if (done < count && inFlight === 0) {
          console.error(`Only ${done} of ${count} runs could be built: ${failed} seeds found no spine within game.runBudget (${cfg.game.runBudget} simulations). Some legs are too dangerous, or too safe, to find a crash and an escape from. Change the danger, or raise game.legTries, game.tiltMax or game.runBudget.`);
          process.exit(1);
        }
      }
    });
  }
}
