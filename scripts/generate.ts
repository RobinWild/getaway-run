// Generates runs in parallel into a named dataset, for the report and the Analysis page.
//   npm run generate -- --count 200 [--name latest] [--from 1] [--workers 20] [--levers file.json] [--set cop.ramChance=0.5 ...]
// Writes out/datasets/<name>/runs.jsonl (one run per line, with every candidate's fate; seeds with no spine are kept, marked ok: false)
// and meta.json (what it was run with).
import { fork } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateRun, type RunRecord } from '../src/gen/generate';
import { args, friendly, leversFromArgs, num, str } from './cli';

const from = num('from', 1), count = num('count', 200), workers = num('workers', 20);
const name = str('name', 'latest').replace(/[^\w.=-]+/g, '_');
const { levers, set, cfg } = friendly(leversFromArgs);
const SAMPLE_RUNS = 5; // these keep every checkpoint state, as an example of what would be served

if (process.send) {
  process.on('message', (m: { seed: number } | 'done') => {
    if (m === 'done') process.exit(0);
    process.send!(generateRun(m.seed, cfg, m.seed < from + SAMPLE_RUNS));
  });
  process.send('ready');
} else {
  const dir = `out/datasets/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/runs.jsonl`, '');
  writeFileSync(`${dir}/samples.jsonl`, '');
  const sweep = str('sweep', '');
  const meta = {
    name, created: new Date().toISOString(), count, from, levers, set,
    ...(sweep ? { sweep: JSON.parse(sweep) } : {}),
    game: cfg.game,
  };
  let next = from, done = 0;
  const t0 = performance.now();
  const self = fileURLToPath(import.meta.url);
  for (let w = 0; w < Math.min(workers, count); w++) {
    const child = fork(self, args);
    child.on('exit', (code) => { if (code) { console.error(`a worker failed (exit ${code})`); process.exit(1); } });
    child.on('message', (m: RunRecord | 'ready') => {
      if (m !== 'ready') {
        if (m.seed < from + SAMPLE_RUNS) appendFileSync(`${dir}/samples.jsonl`, JSON.stringify(m) + '\n');
        const lean = { ...m, legs: m.legs.map(({ state: _state, ...l }) => l) };
        appendFileSync(`${dir}/runs.jsonl`, JSON.stringify(lean) + '\n');
        done++;
        if (done % 50 === 0) console.log(`${done}/${count} runs, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
        if (done === count) {
          writeFileSync(`${dir}/meta.json`, JSON.stringify({ ...meta, seconds: Math.round((performance.now() - t0) / 1000) }, null, 2));
          console.log(`done: ${count} runs in ${((performance.now() - t0) / 1000).toFixed(1)} s wall, saved as dataset "${name}"`);
        }
      }
      if (next < from + count) child.send({ seed: next++ });
      else child.send('done');
    });
  }
}
