// Builds a run as a spine: one escape through every leg, and from every checkpoint along it, one crash.
//
// The outcome of a leg is not decided here. The server draws it when the bet locks, against the exact odds in
// game.legRisk, and plays the crash branch or the escape branch. Both start from the same checkpoint state, so nothing
// the player has seen says which is coming, and any cash-out strategy returns game.rtp.
//
// The search is depth-first. From a checkpoint it needs one valid crash and one valid escape, and the escape's end state
// must itself be a checkpoint that can go on. One stream of candidates looks for both at once: each candidate is kept as
// whichever branch it turned out to be, the first crash as the crash branch and every valid escape as a spare. When the
// next checkpoint is a dead end, the next spare is tried, and only once the spares run out are more candidates simulated.
// This is safe for fairness because the search only finds the branches. Which one plays is the server's draw.
import { CONFIG, legPrices, type Config } from '../config';
import { mix } from '../sim/seed';
import { KINDS, LegSim, initialSnapshot, type Cause, type LegResult, type Recording, type Snapshot } from '../sim/world';

/** What a player can see at a checkpoint. Used only to test cash-out strategies. */
export interface Features { hp: number; cops: number; nearestCop: number; nearestAhead: number; speed: number }

/**
 * What became of one candidate, in the order they were tried at a checkpoint.
 *   c crash used     r escape used     b escape used, then given up on because the next checkpoint was a dead end
 *   C spare crash: a crash was already in hand     R spare escape: kept for backtracking, never needed
 *   s solo crash rejected     x stall rejected     t escape rejected: touching another car at the seam
 */
export type Fate = 'c' | 'r' | 'b' | 'C' | 'R' | 's' | 'x' | 't';
/** [fate, crash cause or null, seconds the leg lasted, tilt (-1 calmer .. 1 nastier), robber hull at the end] */
export type Candidate = [Fate, Cause | null, number, number, number];

export interface BranchInfo {
  seed: number;
  tilt: number;
  tries: number;           // which candidate from its checkpoint this branch was (1 = the first tried)
  cause: Cause | null;
  time: number;
  hull: number;            // robber hull at the end
  calmForced: boolean;     // escape ended on the wait limit rather than a calm moment
  deterministic: boolean;  // re-simulating it gave an identical end state
  bag: { x: number; y: number };
  endY: number;            // the robber's y as the leg ends, in the leg's own coordinates: where the next leg's origin moves to
  recording?: Recording;   // only when exporting for the viewer
}

export interface LegRecord {
  leg: number;
  risk: number;            // the exact crash chance the server draws against
  multBefore: number;      // cash-out value when this leg is offered
  multAfter: number;       // value if it is survived
  escape: BranchInfo;
  crash: BranchInfo;
  sims: number;            // leg simulations spent at this checkpoint, abandoned escapes included
  features: Features;      // at the checkpoint
  log: Candidate[];        // every candidate tried from this checkpoint, in order
  start?: { frame: number[]; meta: Recording['meta'] }; // the checkpoint as the viewer draws it, only when exporting
  state?: Snapshot;        // the checkpoint state, only kept in sample runs
}

export interface RunRecord {
  seed: number;
  ok: boolean;             // false: no spine was found within game.runBudget, and the seed is not used
  failedAt: number;        // deepest leg the search reached, when not ok
  legs: LegRecord[];       // the spine, every leg; empty when not ok
  sims: number;            // leg simulations for the whole run, dead ends and determinism checks included
  backtracks: number;      // escapes given up on because what followed was a dead end
  deadEnds: number;        // checkpoints given up on (no crash, or no escape that could go on)
  ms: number;
}

function featuresOf(s: Snapshot): Features {
  const r = s.cars.find((c) => c.kind === 'robber')!;
  let cops = 0, nearestCop = 999, nearestAhead = 999;
  for (const c of s.cars) {
    if (c === r) continue;
    const dx = c.x - r.x, dy = c.y - r.y, d = Math.sqrt(dx * dx + dy * dy);
    if (c.kind === 'cop' && c.mode !== 'wreck' && !c.parked) { cops++; if (d < nearestCop) nearestCop = d; }
    if (dy > 0 && Math.abs(dx) < 2.5 && dy < nearestAhead) nearestAhead = dy;
  }
  return { hp: r.hp, cops, nearestCop, nearestAhead, speed: r.vy };
}

/** A checkpoint as the viewer draws it: one frame, and what each car is. */
export function frameOf(s: Snapshot) {
  const frame: number[] = [], meta: Recording['meta'] = {};
  const r = (v: number, p: number) => Math.round(v * p) / p;
  for (const c of s.cars) {
    frame.push(c.id, r(c.x, 100), r(c.y, 100), r(c.a, 1000), c.mode === 'drive' ? 0 : c.mode === 'spun' ? 1 : 2);
    meta[c.id] = [KINDS.indexOf(c.kind), c.cross, c.parked ? 1 : 0];
  }
  return { frame, meta };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const hullOf = (r: LegResult) => Math.round(Math.max(0, r.end.cars.find((c) => c.kind === 'robber')!.hp));

/**
 * The selection criteria: why a finished leg can't be used as either branch, or null if it can.
 * Add new rules here. A candidate that fails one is dropped at once.
 */
function rejection(cfg: Config, r: LegResult): Fate | null {
  if (r.ugly === 'solo') return 's';
  if (r.ugly === 'stalled') return 'x';
  if (r.outcome === 'reached' && cfg.game.rejectTouchingSeam && r.touching) return 't';
  return null;
}

export interface Found { seed: number; tilt: number; tries: number; r: LegResult; at: number /* index in the log */; clean: boolean }

/**
 * Does this escape hand the next checkpoint a fair chance? Not when it ends with a police car already within
 * game.seamCopClear of the robber: from there nearly every candidate crashes, and the search learns that only by
 * spending game.legTries on it. Such an escape is kept as a fallback while a few more candidates look for a clean one.
 */
function cleanSeam(cfg: Config, r: LegResult) {
  const cars = r.end.cars, me = cars.find((c) => c.kind === 'robber')!, d2 = cfg.game.seamCopClear * cfg.game.seamCopClear;
  return !cars.some((c) => c.kind === 'cop' && c.mode === 'drive' && !c.parked && c.role !== 'intercept' && (c.x - me.x) ** 2 + (c.y - me.y) ** 2 < d2);
}

// stream 0 is the one candidate stream a checkpoint has
const seedFor = (run: number, leg: number, stream: number, n: number) =>
  mix((Math.imul(mix(run ^ 0x5bd1e995), 31) + Math.imul(leg + 1, 0x9e3779b1) + Math.imul(stream + 1, 0x27d4eb2f) + Math.imul(n + 1, 0x85ebca6b)) >>> 0);

/**
 * All the candidates simulated from one checkpoint. It keeps the first crash, and every valid escape as a spare.
 * While both are missing, candidates run plain. Once only one is missing, they are nudged towards it after game.tiltAfter tries.
 */
export class CheckpointSearch {
  crash: Found | null = null;
  readonly spares: Found[] = [];  // valid escapes not used yet, in the order found
  readonly log: Candidate[] = [];
  private n = 0;

  constructor(readonly cfg: Config, readonly state: Snapshot, readonly run: number, readonly leg: number) {}

  /**
   * Simulate candidates until there is a crash and an unused escape, or game.legTries have been tried. An escape that
   * leaves a cop on the robber only settles it after game.seamTries more candidates have failed to find a clean one.
   * Returns the sims spent.
   */
  fill(): number {
    const G = this.cfg.game;
    let tried = 0, hunting = 0; // hunting: candidates spent looking for a clean escape with only a dirty one in hand
    const escapeReady = () => this.spares.some((e) => e.clean) || (this.spares.length > 0 && hunting >= G.seamTries);
    while ((!this.crash || !escapeReady()) && tried < G.legTries) {
      if (this.crash && this.spares.length) hunting++;
      const want = !this.crash && !this.spares.length ? null : !this.crash ? 'crash' : 'reached';
      const push = want ? G.tiltMax * Math.max(0, Math.min(1, (tried - G.tiltAfter) / Math.max(1, G.tiltRamp))) : 0;
      const tilt = r2(want === 'crash' ? push : -push);
      const seed = seedFor(this.run, this.leg, 0, this.n++);
      tried++;
      const r = new LegSim(this.cfg, this.state, seed, this.leg, false, tilt).run();
      let fate = rejection(this.cfg, r);
      if (!fate) {
        const found: Found = { seed, tilt, tries: this.n, r, at: this.log.length, clean: r.outcome === 'crash' || cleanSeam(this.cfg, r) };
        if (r.outcome === 'crash') { if (this.crash) fate = 'C'; else { this.crash = found; fate = 'c'; } }
        else { this.spares.push(found); fate = 'R'; }
      }
      this.log.push([fate, r.cause, r2(r.time), tilt, hullOf(r)]);
    }
    return tried;
  }

  /** Take the next spare escape as this checkpoint's escape branch. */
  takeEscape(): Found {
    const i = Math.max(0, this.spares.findIndex((e) => e.clean)); // a clean one if there is one, else the first
    const e = this.spares.splice(i, 1)[0];
    this.log[e.at][0] = 'r';
    return e;
  }
  /** The escape taken led to a dead end. */
  abandon(e: Found) { this.log[e.at][0] = 'b'; }
}

/** Re-run a branch, recording it if asked, and letting a crash play out past its end for the viewer. */
export function replayBranch(cfg: Config, state: Snapshot, leg: number, b: Found, record: boolean) {
  const sim = new LegSim(cfg, state, b.seed, leg, record, b.tilt);
  const again = sim.run();
  if (record && again.outcome === 'crash') { if (again.cause === 'busted') sim.recordArrest(); else sim.recordTail(3); }
  return again;
}

/** Where the robber is as a leg ends: from the recording's last leg frame if there is one (as the viewer sees it), else the sim. */
function endYOf(r: LegResult) {
  const f = r.recording?.frames[r.recording.endFrame];
  if (f) for (let i = 0; i < f.length; i += 5) if (f[i] === 0) return f[i + 2];
  return r2(r.end.cars.find((c) => c.kind === 'robber')!.y);
}

export const startState = (cfg: Config, seed: number) => initialSnapshot(cfg, mix(seed ^ 0x1234567));

interface Step { state: Snapshot; crash: Found; escape: Found; log: Candidate[]; sims: number }

/** Build one run's spine. `record` adds every branch's recording and each checkpoint's start frame, for the viewer. */
export function generateRun(seed: number, cfg: Config = CONFIG, keepStates = false, record = false): RunRecord {
  const t0 = performance.now();
  const G = cfg.game;
  const steps: Step[] = [];
  let sims = 0, backtracks = 0, deadEnds = 0, deepest = 0;

  // true once legs leg..maxLegs-1 are all in `steps`
  const extend = (leg: number, state: Snapshot): boolean => {
    deepest = Math.max(deepest, leg);
    const search = new CheckpointSearch(cfg, state, seed, leg);
    let here = 0;
    for (let k = 0; k < G.escapeRetries && sims < G.runBudget; k++) {
      const spent = search.fill();
      here += spent; sims += spent;
      if (!search.crash || !search.spares.length) break;
      const escape = search.takeEscape();
      steps[leg] = { state, crash: search.crash, escape, log: search.log, sims: here };
      if (leg === G.maxLegs - 1) return true;
      // what deeper checkpoints spend is counted there (and in the run's total), not here
      if (extend(leg + 1, escape.r.end)) { steps[leg].sims = here; return true; }
      backtracks++;
      search.abandon(escape);
    }
    steps.length = leg;
    deadEnds++;
    return false;
  };

  const start = startState(cfg, seed);
  const ok = extend(0, start);
  const prices = legPrices(G);
  const legs: LegRecord[] = [];
  if (ok) {
    for (let leg = 0; leg < G.maxLegs; leg++) {
      const s = steps[leg];
      const info = (b: Found): BranchInfo => {
        const again = replayBranch(cfg, s.state, leg, b, record);
        sims++;
        return {
          seed: b.seed, tilt: b.tilt, tries: b.tries, cause: b.r.cause, time: r2(b.r.time), hull: hullOf(b.r), calmForced: b.r.calmForced,
          deterministic: JSON.stringify(again.end) === JSON.stringify(b.r.end), bag: again.bag, endY: endYOf(again),
          ...(record ? { recording: again.recording } : {}),
        };
      };
      legs.push({
        leg, risk: prices[leg].risk, multBefore: prices[leg].before, multAfter: prices[leg].after,
        escape: info(s.escape), crash: info(s.crash), sims: s.sims, features: featuresOf(s.state), log: s.log,
        ...(record ? { start: frameOf(s.state) } : {}), ...(keepStates ? { state: s.state } : {}),
      });
    }
  }
  return { seed, ok, failedAt: ok ? -1 : deepest, legs, sims, backtracks, deadEnds, ms: performance.now() - t0 };
}
