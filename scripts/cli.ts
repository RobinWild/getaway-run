// Argument helpers shared by the scripts, and the one way they all turn  --levers file  and  --set path=value  into a config.
import { readFileSync } from 'node:fs';
import { DEFAULTS, applyLevers, type Config } from '../src/config';
import saved from '../src/levers.json';

export const args = process.argv.slice(2);
export const has = (name: string) => args.includes('--' + name);
export const str = (name: string, def: string) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
export const num = (name: string, def: number) => Number(str(name, String(def)));
export const all = (name: string) => args.flatMap((a, i) => (a === '--' + name && i + 1 < args.length ? [args[i + 1]] : []));

const at = (path: string) => path.split('.').reduce((n: any, k) => (n && typeof n === 'object' ? n[k] : undefined), DEFAULTS);

/** A lever value from the command line: JSON if it parses (numbers, true, [2,8]), else an error. */
export function parseValue(path: string, text: string): unknown {
  const cur = at(path);
  if (cur === undefined || (typeof cur === 'object' && !Array.isArray(cur))) throw new Error(`There is no lever called "${path}". Lever names look like cop.ramChance (see src/config.ts).`);
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error(`"${text}" is not a value for ${path}. Use a number, true/false, or [first,last] for heat levers.`); }
  const ok = Array.isArray(cur) ? Array.isArray(v) && v.length === cur.length && v.every((x) => Number.isFinite(x)) : typeof v === typeof cur;
  if (!ok) throw new Error(`${path} takes ${Array.isArray(cur) ? `a list of ${cur.length} numbers, like ${JSON.stringify(cur)}` : `a ${typeof cur}, like ${JSON.stringify(cur)}`}, not ${text}.`);
  return v;
}

/**
 * The levers a script runs with, as overrides of the defaults in config.ts:
 * src/levers.json (or --levers file.json instead), then each --set path=value on top.
 */
export function leversFromArgs(): { levers: Record<string, unknown>; set: Record<string, unknown>; cfg: Config } {
  const file = str('levers', '');
  const base = file ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : { ...(saved as Record<string, unknown>) };
  const set: Record<string, unknown> = {};
  for (const s of all('set')) {
    const eq = s.indexOf('=');
    if (eq < 0) throw new Error(`--set needs path=value, like --set cop.ramChance=0.5 (got "${s}")`);
    const path = s.slice(0, eq).trim();
    set[path] = parseValue(path, s.slice(eq + 1).trim());
  }
  const levers = { ...base, ...set };
  return { levers, set, cfg: applyLevers(DEFAULTS, levers) };
}

/** Run `fn`, printing a thrown error as a plain message rather than a stack trace. */
export function friendly<T>(fn: () => T): T {
  try { return fn(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
