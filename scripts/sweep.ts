// Tries one lever at several values: one dataset per value, grouped so the Analysis page can plot the results against the value.
//   npm run sweep -- --lever cop.ramChance --values 0.2,0.35,0.5 [--count 120] [--from 1] [--group name] [--set other.lever=1 ...]
//   array levers take ; between values:   --lever heat.cops --values "[2,6];[3,8];[4,10]"
// Every value uses the same seeds, so differences come from the lever, not from luck of the draw.
// Each value becomes out/datasets/<group>=<value>/. Extra --set and --levers flags apply to every value.
import { spawnSync } from 'node:child_process';
import { args, friendly, num, parseValue, str } from './cli';

const lever = str('lever', '');
const text = str('values', '');
if (!lever || !text) { console.error('Usage: npm run sweep -- --lever cop.ramChance --values 0.2,0.35,0.5 [--count 120]'); process.exit(1); }
const values = friendly(() => (text.includes(';') || !text.includes('[') ? text.split(text.includes(';') ? ';' : ',') : [text]).map((v) => parseValue(lever, v.trim())));
const group = str('group', `sweep-${lever}`);
const count = num('count', 120);

// pass everything else through to generate, except what the sweep sets itself
const own = new Set(['--lever', '--values', '--group', '--name', '--count', '--sweep']);
const passed: string[] = [];
for (let i = 0; i < args.length; i++) { if (own.has(args[i])) { i++; continue; } passed.push(args[i]); }

const t0 = performance.now();
values.forEach((value, index) => {
  const label = JSON.stringify(value);
  const name = `${group}=${label}`;
  console.log(`\n[${index + 1}/${values.length}] ${lever} = ${label}`);
  const r = spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/generate.ts', ...passed, '--count', String(count), '--name', name,
    '--set', `${lever}=${label}`, '--sweep', JSON.stringify({ group, lever, value, index }),
  ], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`generating ${name} failed`); process.exit(1); }
});
console.log(`\nsweep "${group}" done in ${((performance.now() - t0) / 60000).toFixed(1)} min. Open the Analysis page (npm run dev, then /analysis.html) and pick the sweep.`);
