// Stands in for the real game server. The viewer only ever talks to this module, so a network version could replace it
// without changing the viewer.
//
// Each stored run has, for every leg, an escape branch and a crash branch from the same checkpoint. The outcome is drawn
// here, when the bet on a leg locks, against the leg's exact crash chance, and only then is that branch handed over.
// Both branches of the next leg are fetched ahead, so the draw costs no waiting. A network server would send them
// encrypted and padded to the same size, and send the key for the drawn one at the lock; here the whole run is in
// the browser anyway, so the secrecy is by convention only.
import type { Recording } from '../sim/world';

export interface Offer {
  leg: number;
  maxLegs: number;
  multBefore: number;   // what cashing out pays now
  multAfter: number;    // what surviving this leg is worth
  risk: number;         // exact crash chance of this leg
}

export interface LegPlayback {
  leg: number;
  outcome: 'reached' | 'crash';
  cause: string | null;
  bag: { x: number; y: number };
  recording: Recording;
}

interface StoredLeg { leg: number; risk: number; multBefore: number; multAfter: number; start: { frame: number[]; meta: Recording['meta'] } }
interface StoredRun { seed: number; maxLegs: number; legs: StoredLeg[] }
interface Index { runs: { seed: number }[] }

export interface RunStart { seed: number; maxLegs: number; firstFrame: number[]; meta: Recording['meta']; offer: Offer }

/** Debug only: let the draw happen, or override it to watch one track. The dev build alone offers this. */
export type Track = 'random' | 'escape';

const BASE = 'runs/';
const getJson = async <T>(path: string) => {
  const res = await fetch(BASE + path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return await res.json() as T;
};

export class LocalServer {
  private ids: number[] = [];
  private run: StoredRun | null = null;
  private at = 0;
  private ahead: { leg: number; escape: Promise<LegPlayback>; crash: Promise<LegPlayback> } | null = null;
  track: Track = 'random';
  crashNext = false; // debug: the next leg locked crashes, whatever the track

  private async nextId() {
    if (!this.ids.length) {
      this.ids = (await getJson<Index>('index.json')).runs.map((r) => r.seed);
      for (let i = this.ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.ids[i], this.ids[j]] = [this.ids[j], this.ids[i]];
      }
    }
    return this.ids.pop()!;
  }

  private offerFor(i: number): Offer | null {
    const run = this.run!, l = run.legs[i];
    return l ? { leg: l.leg, maxLegs: run.maxLegs, multBefore: l.multBefore, multAfter: l.multAfter, risk: l.risk } : null;
  }

  private prefetch(leg: number) {
    const seed = this.run!.seed;
    if (leg >= this.run!.legs.length) { this.ahead = null; return; }
    const escape = getJson<LegPlayback>(`${seed}/${leg}-escape.json`), crash = getJson<LegPlayback>(`${seed}/${leg}-crash.json`);
    escape.catch(() => {}); crash.catch(() => {}); // a failure surfaces at lock()
    this.ahead = { leg, escape, crash };
  }

  /** Begin a run. Gives only what is common to every branch: the opening frame and the first price. */
  async newRun(): Promise<RunStart> {
    const id = await this.nextId();
    this.run = await getJson<StoredRun>(`${id}/run.json`);
    this.at = 0;
    this.prefetch(0);
    await Promise.all([this.ahead!.escape, this.ahead!.crash]);
    const s = this.run.legs[0].start;
    return { seed: this.run.seed, maxLegs: this.run.maxLegs, firstFrame: s.frame, meta: s.meta, offer: this.offerFor(0)! };
  }

  /** The bet on the current leg is locked: draw what happens, and reveal it. */
  async lock(): Promise<LegPlayback> {
    const l = this.run!.legs[this.at];
    const crash = this.crashNext || (this.track === 'random' && Math.random() < l.risk);
    this.crashNext = false;
    const p = this.ahead!;
    const leg = await (crash ? p.crash : p.escape);
    this.at++;
    if (crash) this.ahead = null; else this.prefetch(this.at);
    return leg;
  }

  /** The price of the next leg, once the robber has reached this checkpoint. Null after the last leg. */
  nextOffer(): Offer | null { return this.offerFor(this.at); }
}
