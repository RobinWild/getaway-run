// One leg of a run: a brand-new physics world built from a plain-number Snapshot, advanced until the robber reaches
// the bag or is taken out. A leg is a pure function of (config, snapshot, seed, leg index).
//
// The rebuild is deliberate. Branches and the eventual replay all start the leg from the same fresh world, so nothing
// has to restore planck's internals, and all of a leg's new randomness comes from its seed and starts at tick 0.
// Runs in Node. No DOM, no Math.random, no pow/exp/log/tan/asin/acos (see detmath.ts).
import './detmath'; // must come before planck
import * as planck from 'planck';
import type { Config, KindName } from '../config';
import { makeRng, type Rng } from './rng';

export type Mode = 'drive' | 'spun' | 'wreck';
export type Cause = 'traffic' | 'truck' | 'cop' | 'wall' | 'busted' | 'stalled';
export type Role = 'none' | 'tail' | 'flank' | 'block' | 'intercept';

/** A vehicle, as plain numbers: this is everything that crosses a checkpoint. */
export interface Car {
  id: number; kind: KindName;
  x: number; y: number; a: number; vx: number; vy: number; w: number;
  hp: number; mode: Mode; spin: number; spinImmune: number; regenWait: number;
  steer: number; throttle: number; brake: number; nextDecide: number;
  lane: number; laneHold: number; wish: number;
  cross: number;    // traffic: 0, or the x direction it is crossing the road in
  parked: boolean;  // roadblock or stopped truck
  panic: number;    // traffic: s of emergency braking left
  ram: number; ramCd: number; // cop: ram time left, and time until it may ram again
  dir: number;      // 1 drives up the road, -1 drives down it
  role: Role;       // cop: its job in the pursuit
  side: number;     // cop: which of the robber's rear quarters it is going for (-1 left, 1 right), 0 if none
}

export interface Snapshot { cars: Car[]; nextSpawn: number[]; nextId: number; bustTimer: number; lockTimer: number; stallTimer: number }

export interface LegResult {
  outcome: 'reached' | 'crash';
  cause: Cause | null;
  ugly: string | null;     // why this branch should not be shown, if it should not
  time: number;
  end: Snapshot;
  calmForced: boolean;     // the leg ended on the wait limit, not a calm moment
  touching: boolean;       // the robber was in contact with something as the leg ended
  bag: { x: number; y: number }; // reached: exactly where the robber's nose is as the leg ends, so the car always hits it
  recording?: Recording;
}

/** The picked branch, as positions for the viewer. Rounded: the viewer only draws it, the sim stays authoritative. */
export interface Recording {
  frames: number[][];      // one per FRAME_TICKS: flat [id, x, y, angle, mode (0 drive, 1 spun, 2 wreck), ...]
  hp: number[];            // the robber's hull, per frame
  impacts: [number, number, number, number][]; // [frame, x, y, velocity change]
  meta: Record<number, [number, number, number]>; // id -> [index into KINDS, crossing direction, parked 0/1]
  endFrame: number;        // last frame of the leg itself; anything after it is the aftermath of a crash
}

export const KINDS: KindName[] = ['robber', 'car', 'truck', 'cop'];
const MODE_CODE: Record<Mode, number> = { drive: 0, spun: 1, wreck: 2 };
const round = (v: number, places: number) => Math.round(v * places) / places;

type Tag = { kind: 'wall' } | { kind: 'car'; c: Car };
interface Hit { a: Tag; b: Tag; j: number }

const HALF_PI = Math.PI / 2, TWO_PI = Math.PI * 2;
const ARREST_LIMIT = 8, ARREST_STOPPED = 0.3; // after a bust: the most seconds braking can run for, and the m/s that counts as stopped
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (p: readonly number[], h: number) => p[0] + (p[1] - p[0]) * h;
const wrap = (a: number) => { while (a > Math.PI) a -= TWO_PI; while (a < -Math.PI) a += TWO_PI; return a; };

const onComing = (cfg: Config, lane: number) => lane < cfg.road.oncomingLanes;
export const laneX = (cfg: Config, lane: number) => (lane - (cfg.road.lanes - 1) / 2) * cfg.road.laneWidth;
const roadHalf = (cfg: Config) => cfg.road.lanes * cfg.road.laneWidth * 0.5;
export const heatOf = (cfg: Config, leg: number) => (cfg.game.maxLegs > 1 ? clamp(leg / (cfg.game.maxLegs - 1), 0, 1) : 0);

function blankCar(cfg: Config, id: number, kind: KindName, x: number, y: number, a: number, speed: number, lane: number, wish: number): Car {
  return {
    id, kind, x, y, a, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, w: 0,
    hp: cfg.kinds[kind].hp, mode: 'drive', spin: 0, spinImmune: 0, regenWait: 0,
    steer: 0, throttle: 0, brake: 0, nextDecide: 0, lane, laneHold: 0, wish,
    cross: 0, parked: false, panic: 0, ram: 0, ramCd: 0, dir: Math.sin(a) < 0 ? -1 : 1, role: 'none', side: 0,
  };
}

function trafficGap(cfg: Config, heat: number, rng: Rng, lane: number) {
  const lo = lerp(cfg.heat.trafficGapMin, heat), hi = lerp(cfg.heat.trafficGapMax, heat);
  return (lo + (hi - lo) * rng()) * (onComing(cfg, lane) ? cfg.traffic.oncomingGap : 1);
}

/** Slowest at the kerb, fastest beside the centre line, on both sides of the road. */
function laneSpeed(cfg: Config, lane: number) {
  const T = cfg.traffic, on = cfg.road.oncomingLanes, n = cfg.road.lanes;
  const count = onComing(cfg, lane) ? on : n - on, fromKerb = onComing(cfg, lane) ? lane : n - 1 - lane;
  return count > 1 ? T.speedKerb + ((T.speedCentre - T.speedKerb) * fromKerb) / (count - 1) : T.speedCentre;
}

function newTraffic(cfg: Config, id: number, lane: number, y: number, rng: Rng): Car {
  const T = cfg.traffic, truck = rng() < T.truckShare;
  const wish = laneSpeed(cfg, lane) + (rng() * 2 - 1) * T.speedJitter - (truck ? 3 : 0);
  return blankCar(cfg, id, truck ? 'truck' : 'car', laneX(cfg, lane), y, onComing(cfg, lane) ? -HALF_PI : HALF_PI, wish, lane, wish);
}

/** The state at the start of a run. */
export function initialSnapshot(cfg: Config, seed: number): Snapshot {
  const rng = makeRng(seed);
  const on = cfg.road.oncomingLanes, start = on + Math.floor((cfg.road.lanes - on) / 2);
  const cars: Car[] = [blankCar(cfg, 0, 'robber', laneX(cfg, start), 0, HALF_PI, 28, start, cfg.robber.cruise)];
  let nextId = 1;
  const nextSpawn: number[] = [];
  for (let lane = 0; lane < cfg.road.lanes; lane++) {
    let y = cfg.traffic.firstGap + rng() * 20;
    while (y < cfg.traffic.spawnAhead) { cars.push(newTraffic(cfg, nextId++, lane, y, rng)); y += trafficGap(cfg, 0, rng, lane); }
    nextSpawn.push(y);
  }
  // the chase is already on: police cars close behind, so even the first leg can go wrong. After the traffic, so it keeps its layout
  const P = cfg.cop, M = P.roleMix;
  for (let i = 0; i < P.startCops; i++) {
    const lane = on + Math.floor(rng() * (cfg.road.lanes - on)), y = -(P.startGap + i * 7 + rng() * 4);
    const c = blankCar(cfg, nextId++, 'cop', laneX(cfg, lane), y, HALF_PI, 28 + P.catchUp * 0.25, lane, cfg.kinds.cop.topSpeed);
    const v = rng() * (M.tail + M.flank + M.block);
    c.role = v < M.tail ? 'tail' : v < M.tail + M.flank ? 'flank' : 'block';
    cars.push(c);
  }
  // and police cars coming head-on from up the road, timed to meet the robber in the first leg. They pass and are gone, not left on its tail
  for (let i = 0; i < P.startAhead; i++) {
    const lane = Math.floor(rng() * Math.max(1, on)), y = P.startAheadGap + i * 25 + rng() * 15;
    const c = blankCar(cfg, nextId++, 'cop', laneX(cfg, lane), y, -HALF_PI, P.intercept.speed, lane, P.intercept.speed);
    c.role = 'intercept';
    cars.push(c);
  }
  return { cars, nextSpawn, nextId, bustTimer: 0, lockTimer: 0, stallTimer: 0 };
}

export class LegSim {
  readonly cars: Car[];
  readonly nextSpawn: number[];
  readonly rng: Rng;
  readonly heat: number;
  readonly world: planck.World;
  readonly robber: Car;
  readonly bag: { x: number; y: number; lane: number };
  private readonly bodies = new Map<number, planck.Body>();
  private readonly hits: Hit[] = [];
  private nextId: number;
  private bustTimer: number;
  private lockTimer: number;
  private stallTimer: number;
  private arresting = false; // after a bust, for the viewer only: the robber and the police are braking to a stop
  private tick = 0;
  private time = 0;
  private passedAt = -1;
  private lastHit: { cause: Cause; time: number; solo: boolean } | null = null;
  private copSpawns: number[] = [];
  private touchingNow = false;
  private rec: Recording | undefined;
  private lastCaptureTick = -1;

  /** `tilt` (-1 to 1) makes this one branch calmer or nastier; the generator uses it to find outcomes a state rarely produces. */
  constructor(readonly cfg: Config, snap: Snapshot, seed: number, readonly leg: number, record = false, readonly tilt = 0) {
    this.cars = snap.cars.map((c) => ({ ...c }));
    this.nextSpawn = snap.nextSpawn.slice();
    this.nextId = snap.nextId;
    this.bustTimer = snap.bustTimer;
    this.lockTimer = snap.lockTimer;
    this.stallTimer = snap.stallTimer;
    this.rng = makeRng(seed);
    this.heat = clamp(heatOf(cfg, leg) + tilt * cfg.game.tiltHeat, 0, 1);
    this.robber = this.cars.find((c) => c.kind === 'robber')!;
    if (record) this.rec = { frames: [], hp: [], impacts: [], meta: {}, endFrame: 0 };

    this.world = new planck.World({ gravity: planck.Vec2(0, 0), allowSleep: false });
    const half = roadHalf(cfg), L = cfg.road.wallLength;
    for (const side of [-1, 1]) {
      const wall = this.world.createBody({ type: 'static' });
      wall.createFixture({ shape: planck.Edge(planck.Vec2(side * half, -L), planck.Vec2(side * half, L)), friction: cfg.road.wallFriction, restitution: cfg.road.wallRestitution });
      wall.setUserData({ kind: 'wall' } as Tag);
    }
    this.world.on('post-solve', (c, imp) => {
      let j = 0;
      for (const n of imp.normalImpulses) j += n;
      if (j > 0) this.hits.push({ a: c.getFixtureA().getBody().getUserData() as Tag, b: c.getFixtureB().getBody().getUserData() as Tag, j });
    });
    for (const c of this.cars) this.addBody(c);

    // what this leg holds, all drawn from its own seed
    const E = cfg.events, G = cfg.leg, H = cfg.heat, rng = this.rng;
    const [lo, hi] = leg === 0 && G.firstBagDistanceMax > 0 ? [G.firstBagDistanceMin, G.firstBagDistanceMax] : [G.bagDistanceMin, G.bagDistanceMax];
    const dist = lo + (hi - lo) * rng();
    const lane = Math.floor(rng() * cfg.road.lanes);
    this.bag = { x: laneX(cfg, lane), y: this.robber.y + dist, lane };
    const spot = () => this.robber.y + E.obstacleAheadMin + Math.max(0, dist - E.obstacleAheadMin - E.obstacleBeforeBag) * rng();
    if (rng() < lerp(H.blockChance, this.heat)) this.addRoadblock(spot());
    if (rng() < lerp(H.stoppedChance, this.heat)) this.addStopped(spot());
    this.capture();
  }

  private capture() {
    const rec = this.rec;
    if (!rec || this.lastCaptureTick === this.tick) return;
    this.lastCaptureTick = this.tick;
    const f: number[] = [];
    for (const c of this.cars) {
      f.push(c.id, round(c.x, 100), round(c.y, 100), round(c.a, 1000), MODE_CODE[c.mode]);
      rec.meta[c.id] ??= [KINDS.indexOf(c.kind), c.cross, c.parked ? 1 : 0];
    }
    rec.frames.push(f);
    rec.hp.push(round(Math.max(0, this.robber.hp), 10));
  }

  private addBody(c: Car) {
    const k = this.cfg.kinds[c.kind], B = this.cfg.body;
    const wrecked = c.mode === 'wreck';
    const body = this.world.createBody({
      type: 'dynamic', position: planck.Vec2(c.x, c.y), angle: c.a, bullet: c.kind === 'robber',
      linearVelocity: planck.Vec2(c.vx, c.vy), angularVelocity: c.w,
      linearDamping: wrecked ? B.wreckLinearDamping : 0, angularDamping: wrecked ? B.wreckAngularDamping : B.angularDamping,
    });
    body.createFixture({ shape: planck.Box(k.length * 0.5, k.width * 0.5), density: k.mass / (k.length * k.width), friction: B.friction, restitution: B.restitution });
    body.setUserData({ kind: 'car', c } as Tag);
    this.bodies.set(c.id, body);
  }

  private spawn(c: Car) { this.cars.push(c); this.addBody(c); return c; }
  private remove(i: number) {
    const c = this.cars[i];
    this.world.destroyBody(this.bodies.get(c.id)!);
    this.bodies.delete(c.id);
    this.cars.splice(i, 1);
  }

  private clearAt(x: number, y: number, r: number) {
    for (const o of this.cars) if ((o.x - x) * (o.x - x) + (o.y - y) * (o.y - y) < r * r) return false;
    return true;
  }

  /** Whether a side-street car pulling out at (x, y) would get across without meeting the traffic. The robber and the police aren't
   *  looked for: the crossing is there to be their problem, on screen, not a pile-up out of view ahead. */
  private crossingClear(x: number, y: number, dir: number) {
    const look = this.cfg.events.crossLook, speed = this.cfg.traffic.crossSpeed, far = roadHalf(this.cfg) - this.cfg.kinds.car.length / 2;
    if (look <= 0) return true;
    for (const o of this.cars) {
      if (o === this.robber || o.kind === 'cop') continue;
      const reach = this.cfg.kinds[o.kind].length / 2 + 2.6;
      for (let t = 0; t <= look; t += 0.1) {
        const cx = x + dir * speed * t;
        if (cx * dir > far) break;
        if (Math.abs(o.x + o.vx * t - cx) < 2.6 && Math.abs(o.y + o.vy * t - y) < reach) return false;
      }
    }
    return true;
  }

  private addRoadblock(y: number) {
    const n = this.cfg.road.lanes, P = this.cfg.cop;
    const count = Math.min(n - 1, P.blockCarsMin + Math.floor(this.rng() * (P.blockCarsMax - P.blockCarsMin + 1)));
    const start = Math.floor(this.rng() * (n - count + 1));
    for (let l = start; l < start + count; l++) {
      const x = laneX(this.cfg, l);
      if (!this.clearAt(x, y, 5)) continue;
      const c = blankCar(this.cfg, this.nextId++, 'cop', x, y, 0, 0, l, 0);
      c.parked = true;
      this.spawn(c);
    }
  }

  private addStopped(y: number) {
    const lane = Math.floor(this.rng() * this.cfg.road.lanes), x = laneX(this.cfg, lane);
    if (!this.clearAt(x, y, 8)) return;
    const c = blankCar(this.cfg, this.nextId++, 'truck', x, y, onComing(this.cfg, lane) ? -HALF_PI : HALF_PI, 0, lane, 0);
    c.parked = true;
    this.spawn(c);
  }

  // ------------------------------------------------------------------ the step

  /** Advance one tick. Returns a result once the leg is over. */
  step(): LegResult | null {
    this.advance();
    return this.checkEnd(this.cfg.sim.dt);
  }

  /** Keep the world running after a crash, for the viewer only. The leg's result has already been fixed. */
  recordTail(seconds: number) {
    const ticks = Math.floor(seconds / this.cfg.sim.dt);
    for (let i = 0; i < ticks; i++) this.advance();
  }

  /** Keep the world running after a bust, for the viewer only: everyone involved brakes to a stop and stays there a moment. */
  recordArrest() {
    const dt = this.cfg.sim.dt, limit = Math.floor(ARREST_LIMIT / dt);
    this.arresting = true;
    for (const c of this.cars) {
      if (!this.isArrested(c)) continue;
      c.ram = 0;
      if (c.mode === 'spun') { c.mode = 'drive'; c.spin = 0; }
    }
    for (let i = 0; i < limit && this.cars.some((c) => this.isArrested(c) && c.vx * c.vx + c.vy * c.vy > ARREST_STOPPED * ARREST_STOPPED); i++) this.advance();
    this.recordTail(this.cfg.bust.holdSeconds);
    this.capture(); // the last frame is the stop itself, even between regular frames
  }

  private isArrested(c: Car) { return this.arresting && c.mode !== 'wreck' && (c === this.robber || c.kind === 'cop'); }

  private advance() {
    const cfg = this.cfg, dt = cfg.sim.dt;
    this.syncFromBodies();
    this.runSpawns(dt);
    for (const c of this.cars) {
      if (this.isArrested(c)) { c.steer = 0; c.throttle = 0; c.brake = 1; }
      else if (c.mode === 'drive') {
        if (--c.nextDecide <= 0) this.decide(c, dt);
      } else { c.steer = 0; c.throttle = 0; c.brake = 0; }
      this.applyForces(c, dt);
    }
    this.hits.length = 0;
    this.world.step(dt, cfg.sim.velocityIterations, cfg.sim.positionIterations);
    this.tick++;
    this.time = this.tick * dt;
    this.syncFromBodies();
    this.touchingNow = false;
    this.processHits();
    this.updateTimers(dt);
    if (this.tick % cfg.sim.frameTicks === 0) this.capture();
  }

  /** Run the leg to its end. */
  run(): LegResult {
    for (;;) { const r = this.step(); if (r) return r; }
  }

  private syncFromBodies() {
    for (const c of this.cars) {
      const b = this.bodies.get(c.id)!, p = b.getPosition(), v = b.getLinearVelocity();
      c.x = p.x; c.y = p.y; c.a = b.getAngle(); c.vx = v.x; c.vy = v.y; c.w = b.getAngularVelocity();
    }
  }

  private runSpawns(dt: number) {
    const cfg = this.cfg, T = cfg.traffic, rng = this.rng, r = this.robber;
    // traffic ahead
    for (let lane = 0; lane < cfg.road.lanes; lane++) {
      if (this.nextSpawn[lane] < r.y + T.spawnAhead - 40) this.nextSpawn[lane] = r.y + T.spawnAhead - 40 + rng() * 15;
      if (this.nextSpawn[lane] < r.y + T.spawnAhead) {
        const y = this.nextSpawn[lane];
        if (this.clearAt(laneX(cfg, lane), y, 10)) this.spawn(newTraffic(cfg, this.nextId++, lane, y, rng));
        this.nextSpawn[lane] = y + trafficGap(cfg, this.heat, rng, lane);
      }
    }
    if (!this.arresting) this.runPursuitSpawns(dt);
    // tidy up behind, and side-street cars that have made it across
    const edge = roadHalf(cfg) - cfg.kinds.car.length / 2 - 0.3; // gone before its nose reaches the barrier, not stuck nudging it
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c === r) continue;
      const crossed = c.cross !== 0 && c.mode === 'drive' && c.cross * c.x > edge;
      if (crossed || c.y < r.y - T.despawnBehind) this.remove(i);
    }
  }

  /** Whatever joins the chase: none of it is wanted once the robber has been caught. */
  private runPursuitSpawns(dt: number) {
    const cfg = this.cfg, T = cfg.traffic, rng = this.rng, r = this.robber;
    // the pursuit: wrecked or lost cops are replaced, arriving from out of view
    const P = cfg.cop, on = cfg.road.oncomingLanes;
    const chasing = this.cars.filter((c) => c.kind === 'cop' && c.mode !== 'wreck' && !c.parked && c.role !== 'intercept').length;
    const want = Math.round(lerp(cfg.heat.cops, this.heat));
    for (let i = chasing + this.copSpawns.length; i < want; i++) this.copSpawns.push(this.time + rng() * P.spawnWindow);
    for (let i = this.copSpawns.length - 1; i >= 0; i--) {
      if (this.time < this.copSpawns[i]) continue;
      this.copSpawns.splice(i, 1);
      const lane = on + Math.floor(rng() * (cfg.road.lanes - on)), x = laneX(cfg, lane);
      const y = r.y - P.spawnBack - rng() * P.spawnBackJitter;
      if (this.clearAt(x, y, 6)) {
        const c = blankCar(cfg, this.nextId++, 'cop', x, y, HALF_PI, r.vy + P.catchUp, lane, cfg.kinds.cop.topSpeed);
        c.role = this.pickRole();
        this.spawn(c);
      }
    }
    // a police car coming the other way, straight at the robber
    if (rng() < lerp(cfg.heat.interceptRate, this.heat) * dt) {
      const I = P.intercept, lane = Math.floor(rng() * Math.max(1, on)), x = laneX(cfg, lane);
      const y = r.y + I.aheadMin + (I.aheadMax - I.aheadMin) * rng();
      if (this.clearAt(x, y, 8)) {
        const c = blankCar(cfg, this.nextId++, 'cop', x, y, -HALF_PI, I.speed, lane, I.speed);
        c.role = 'intercept';
        this.spawn(c);
      }
    }
    // side-street cars pulling out across the road ahead
    if (rng() < lerp(cfg.heat.crossRate, this.heat) * dt) {
      const E = cfg.events, dir = rng() < 0.5 ? 1 : -1, x = -dir * (roadHalf(cfg) - 1.4);
      const y = r.y + E.crossAheadMin + (E.crossAheadMax - E.crossAheadMin) * rng();
      if (this.clearAt(x, y, 5) && this.crossingClear(x, y, dir)) {
        const c = blankCar(cfg, this.nextId++, 'car', x, y, dir > 0 ? 0 : Math.PI, T.crossSpeed, 0, T.crossSpeed);
        c.cross = dir;
        this.spawn(c);
      }
    }
  }

  // ------------------------------------------------------------------ AI

  private decide(c: Car, dt: number) {
    if (c.kind === 'robber') this.decideRobber(c);
    else if (c.kind === 'cop') this.decideCop(c, dt);
    else this.decideTraffic(c, dt);
  }

  private speedOf(c: Car) { return c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a); }

  /** How unattractive a lane looks over the next `horizon` seconds. `noise` is how wrong this driver can be. */
  private laneCost(me: Car, lane: number, horizon: number, weight: number, adjacent: number, noise: number, shy: number) {
    const x = laneX(this.cfg, lane), mine = this.cfg.kinds[me.kind];
    const sp = Math.max(me.vy, 8);
    let cost = 0;
    for (const o of this.cars) {
      if (o === me) continue;
      const k = this.cfg.kinds[o.kind], dy = o.y - me.y;
      if (dy < -9 || dy > horizon * sp + 12) continue;
      if (Math.abs(o.x - x) > this.cfg.road.laneWidth * 0.5 + k.width * 0.5) continue;
      const reach = (k.length + mine.length) * 0.5;
      if (Math.abs(dy) < reach + 3) {
        if (lane !== this.nearestLane(me)) cost += adjacent;
        if (o.kind === 'cop' && !o.parked) cost += shy;
      }
      if (dy > 0) {
        const closing = me.vy - o.vy, gap = dy - reach;
        let ttc = closing > 0.5 ? gap / closing : horizon * 2;
        if (noise > 0) ttc *= 1 + (this.rng() * 2 - 1) * noise;
        if (ttc < horizon) cost += (horizon - ttc) * weight * (1 + (o.parked ? 0.5 : 0));
      }
    }
    return cost;
  }

  private nearestLane(c: Car) {
    return clamp(Math.floor(c.x / this.cfg.road.laneWidth + this.cfg.road.lanes / 2), 0, this.cfg.road.lanes - 1);
  }

  /** The speed that still lets `me` stop behind whatever is in its path. */
  private followSpeed(me: Car, wish: number, aBrake: number, margin: number, ignoreRobber = false) {
    const mine = this.cfg.kinds[me.kind];
    let v = wish;
    for (const o of this.cars) {
      if (o === me || (ignoreRobber && o === this.robber)) continue;
      const k = this.cfg.kinds[o.kind], ahead = (o.y - me.y) * me.dir;
      if (ahead <= 0 || ahead > 130) continue;
      if (Math.abs(o.x - me.x) > (k.width + mine.width) * 0.5 + 0.5) continue;
      const gap = Math.max(0, ahead - (k.length + mine.length) * 0.5 - margin);
      const lead = o.vy * me.dir;
      // only cops allow for a car coming the other way, which eats into the stopping distance
      const allowed = ignoreRobber && lead < 0
        ? lead + Math.sqrt(lead * lead + 2 * aBrake * gap)
        : Math.sqrt(Math.max(0, lead) * Math.max(0, lead) + 2 * aBrake * gap);
      if (allowed < v) v = allowed;
    }
    return v;
  }

  private steerAt(c: Car, tx: number, ty: number, gain: number) {
    const err = wrap(Math.atan2(ty - c.y, tx - c.x) - c.a);
    c.steer = clamp(err * gain, -1, 1);
    return err;
  }

  private setSpeed(c: Car, target: number) {
    const sp = this.speedOf(c);
    c.throttle = 1; c.brake = 0;
    if (sp > target + 1) { c.throttle = 0; c.brake = clamp((sp - target) / 5, 0, 1); }
    else if (sp > target) c.throttle = 0.3;
  }

  /** Police cars hunting the robber from behind or beside it, within `range` m: what it dodges. */
  private threats(r: Car, range: number) {
    return this.cars.filter((o) => o.kind === 'cop' && o.mode === 'drive' && !o.parked && o.role !== 'intercept' && o.y - r.y > -range && o.y - r.y < 4);
  }

  private decideRobber(c: Car) {
    const cfg = this.cfg, R = cfg.robber, k = cfg.kinds.robber, W = cfg.road.laneWidth;
    const threats = this.threats(c, R.dodgeRange);
    c.nextDecide = threats.length ? Math.min(R.decideTicks, R.alertTicks) : R.decideTicks;
    c.laneHold -= c.nextDecide * cfg.sim.dt;
    const noise = lerp(cfg.heat.misjudge, this.heat) * (1 + this.tilt), cur = this.nearestLane(c);
    const costs: number[] = [];
    for (let l = 0; l < cfg.road.lanes; l++) {
      let v = this.laneCost(c, l, R.horizon, R.costWeight, R.adjacentCost, noise, R.copShy) + Math.abs(l - cur) * R.switchCost;
      if (onComing(cfg, l)) v += R.wrongWayCost;
      costs.push(v);
    }
    let best = c.lane;
    for (let l = 0; l < costs.length; l++) if (costs[l] < costs[best] - 1e-9) best = l;
    if (best !== c.lane && costs[best] < costs[c.lane] - R.hysteresis && c.laneHold <= 0) {
      c.lane = clamp(best, cur - 1, cur + 1); // one lane at a time
      c.laneHold = R.laneHold;
    }
    // a cop going in for the rear quarter: jink a lane away from it, if that lane is not about to be a crash of its own
    for (const o of threats) {
      if (o.ram <= 0 || Math.abs(o.x - c.x) > W * 1.6) continue;
      const to = cur + (o.x >= c.x ? -1 : 1);
      if (to >= 0 && to < cfg.road.lanes && costs[to] < costs[cur] + R.dodgeRisk) { c.lane = to; c.laneHold = R.laneHold; break; }
    }
    const sp = Math.max(this.speedOf(c), 6);
    const err = this.steerAt(c, laneX(cfg, c.lane), c.y + R.lookBase + R.lookSpeed * sp, R.steerGain);
    this.setSpeed(c, this.followSpeed(c, R.cruise, (k.brakes / k.mass) * R.brakeUse, R.margin));
    if (Math.abs(err) > 0.9 && sp > 12) c.throttle *= 0.4;
  }

  private pickRole(): Role {
    const M = this.cfg.cop.roleMix;
    let v = this.rng() * (M.tail + M.flank + M.block);
    if ((v -= M.tail) < 0) return 'tail';
    return v < M.flank ? 'flank' : 'block';
  }

  /** How unattractive a lane looks to a cop. Unlike the robber's estimate, this one takes oncoming cars seriously. */
  private copLaneCost(me: Car, lane: number, cur: number) {
    const P = this.cfg.cop, x = laneX(this.cfg, lane), mine = this.cfg.kinds.cop;
    let cost = 0;
    for (const o of this.cars) {
      if (o === me || o === this.robber) continue;
      const k = this.cfg.kinds[o.kind], dy = o.y - me.y;
      if (Math.abs(o.x - x) > this.cfg.road.laneWidth * 0.5 + k.width * 0.5) continue;
      const reach = (k.length + mine.length) * 0.5;
      if (lane !== cur && Math.abs(dy) < reach + 3) cost += P.alongsideCost;
      if (dy <= 0) continue;
      const closing = me.vy - o.vy, oncoming = o.vy * me.vy < 0;
      if (closing <= 0.5) continue;
      const ttc = (dy - reach) / closing, horizon = P.horizon * (oncoming ? P.oncomingHorizon : 1);
      if (ttc < horizon) cost += (horizon - ttc) * 3 * (oncoming ? P.oncomingWeight : 1);
    }
    return cost;
  }

  /** Is anything other than the robber in the strip of road between this cop and column `tx`, within `seconds`? */
  private copPathClear(c: Car, tx: number, seconds: number, beyond = Infinity) {
    const k = this.cfg.kinds.cop, half = k.width * 0.5 + 0.2, lo = Math.min(c.x, tx) - half, hi = Math.max(c.x, tx) + half;
    for (const o of this.cars) {
      if (o === c || o === this.robber || o.y > beyond) continue;
      const other = this.cfg.kinds[o.kind];
      if (o.x + other.width * 0.5 < lo || o.x - other.width * 0.5 > hi) continue;
      const reach = (other.length + k.length) * 0.5, dy = o.y - c.y;
      if (Math.abs(dy) < reach + 0.5) return false;
      const closing = c.vy - o.vy;
      if (dy > 0 && closing > 0.5 && (dy - reach) / closing < seconds) return false;
    }
    return true;
  }

  /** The nearest a lateral speed can get to `want` while still being able to straighten up before the wall. */
  private copWallLimit(c: Car, want: number) {
    const P = this.cfg.cop, k = this.cfg.kinds.cop, edge = roadHalf(this.cfg) - k.width * 0.5 - P.wallMargin, a = k.grip * P.wallGrip;
    const limit = (room: number) => (room > 0 ? Math.sqrt(2 * a * room) : room * 3); // past the edge, it is a demand to come back
    return clamp(want, -limit(edge + c.x), limit(edge - c.x));
  }

  /** Steer to reach a sideways speed: the wall limit applies to everything a cop does, and the nose stays near the road's line. */
  private copSteer(c: Car, vxWant: number, maxSlope: number) {
    const P = this.cfg.cop, sp = Math.max(this.speedOf(c), 6), look = P.lookBase + P.lookSpeed * sp;
    const vx = this.copWallLimit(c, vxWant);
    const slope = clamp((vx + (vx - c.vx) * P.lateralCorrect) / sp, -maxSlope, maxSlope);
    this.steerAt(c, c.x + slope * look, c.y + c.dir * look, P.steerGain);
  }

  /** Full power only with the nose near the road's line, so a cop pulling out of a slide doesn't power into the wall. */
  private copSpeed(c: Car, target: number) {
    const P = this.cfg.cop, off = Math.abs(wrap((c.dir > 0 ? HALF_PI : -HALF_PI) - c.a));
    this.setSpeed(c, target);
    c.throttle *= clamp(1 - (off - P.fullThrottleAngle) / (P.recoverAngle - P.fullThrottleAngle), 0, 1);
  }

  /** Pointing well off the road (out of a spin, or a roadblock car setting off): turn first, go afterwards. */
  private copRecover(c: Car) {
    const P = this.cfg.cop, err = wrap((c.dir > 0 ? HALF_PI : -HALF_PI) - c.a);
    if (Math.abs(err) < P.recoverAngle) return false;
    c.steer = clamp(err * P.steerGain, -1, 1);
    c.throttle = 0;
    c.brake = clamp(Math.abs(this.speedOf(c)) / 5, 0, 1);
    c.ram = 0; c.side = 0;
    return true;
  }

  /** Which rear quarter to go for: the road side if the robber is near a wall, else whichever side is free, nearest first. */
  private copPickSide(c: Car) {
    const P = this.cfg.cop, r = this.robber, k = this.cfg.kinds.cop, rk = this.cfg.kinds.robber;
    const beside = (rk.width + k.width) * 0.5 + P.stalkGap, edge = roadHalf(this.cfg) - k.width * 0.5 - P.wallMargin;
    const taken = (s: number) => this.cars.some((o) => o !== c && o.kind === 'cop' && o.mode === 'drive' && o.side === s && o.y > c.y); // the nearest cop to the robber gets the slot
    const fits = (s: number) => Math.abs(r.x + s * beside) <= edge && !taken(s);
    const near = c.x >= r.x ? 1 : -1;
    if (c.side !== 0 && fits(c.side)) return c.side;
    return fits(near) ? near : fits(-near) ? -near : 0;
  }

  private decideCop(c: Car, dt: number) {
    const cfg = this.cfg, P = cfg.cop, k = cfg.kinds.cop, r = this.robber, rk = cfg.kinds.robber;
    c.nextDecide = P.decideTicks;
    const step = P.decideTicks * dt;
    c.ramCd -= step;
    if (c.parked) {
      if (!P.blockJoinsChase || r.y < c.y + P.blockJoinDistance) { c.throttle = 0; c.brake = 1; c.steer = 0; return; }
      c.parked = false;
      c.role = this.pickRole();
    }
    if (this.copRecover(c)) return;
    if (c.role === 'intercept') { // head-on: tracks the robber's lane, then commits, and stops for nothing
      if (c.y - r.y > P.intercept.commitDistance) c.lane = this.nearestLane(r);
      const sp = Math.max(this.speedOf(c), 6);
      this.steerAt(c, laneX(cfg, c.lane), c.y - P.lookBase - P.lookSpeed * sp, P.steerGain);
      this.copSpeed(c, P.intercept.speed);
      return;
    }

    // Where the rear quarter is. toGo > 0: this cop's nose is still short of it.
    const toGo = r.y - rk.length * 0.25 - (c.y + k.length * 0.5);
    const overlapped = (rk.width + k.width) * 0.5 - P.strikeOverlap;
    const brake = (k.brakes / k.mass) * 0.8;
    const huntable = r.mode === 'drive' && Math.abs(wrap(HALF_PI - r.a)) < P.recoverAngle && toGo > -P.strikeOverrun;

    // The robber is spun out or crawling: every cop in reach goes straight in, hard, rather than politely lining up
    const robberSpeed = Math.sqrt(r.vx * r.vx + r.vy * r.vy);
    if ((r.mode !== 'drive' || robberSpeed < P.pounceSpeed) && toGo > -P.strikeOverrun && toGo < P.pounceRange) {
      if (c.ram <= 0 && c.ramCd <= 0 && this.rng() < P.ramChance * (1 + this.tilt)) { c.ram = P.pounceTime; c.ramCd = P.pounceCooldown; }
      if (c.ram > 0) {
        c.ram -= step;
        const nearWall = Math.abs(r.x) > roadHalf(cfg) - 3; // on the road side, so the wall limit doesn't stop it arriving
        c.side = nearWall ? (r.x > 0 ? -1 : 1) : c.side !== 0 ? c.side : c.x >= r.x ? 1 : -1;
        const tx = r.x + c.side * rk.width * 0.5;
        if (this.copPathClear(c, tx, P.strikeLook, r.y)) { // what the robber has crashed into, beyond it, is no reason to hold back
          c.lane = this.nearestLane(c);
          this.copSteer(c, r.vx + clamp((tx - c.x) * P.laneGain, -P.strikeLateral, P.strikeLateral), P.pounceSlope);
          const wish = toGo > 0 ? r.vy + Math.max(P.pounceHit, Math.min(P.pounceClose, toGo * P.approachGain)) : r.vy;
          this.copSpeed(c, this.followSpeed(c, clamp(wish, 0, k.topSpeed), brake, 2, true));
          return;
        }
        c.ram = 0;
      }
    }

    if (c.ram > 0) { // going in: a shallow cut across the rear quarter, called off if it stops making sense
      c.ram -= step;
      const tx = r.x + r.vx * P.ramLead + c.side * overlapped;
      if (c.side !== 0 && huntable && Math.abs(c.x - tx) < P.stalkWidth && this.copPathClear(c, tx, P.strikeLook)) {
        // no easing off on the way in, the hit is only worth anything if it arrives with sideways speed on. Past the robber's flank, just hold there
        const stillOutside = c.side * (c.x - r.x) > overlapped;
        this.copSteer(c, r.vx + (stillOutside ? -c.side * P.strikeLateral : clamp((tx - c.x) * P.laneGain, -P.laneRate, P.laneRate)), P.strikeSlope);
        this.copSpeed(c, clamp(r.vy + clamp(toGo * 2.5, -2, P.strikeClose), 0, k.topSpeed));
        return;
      }
      c.ram = 0;
    }

    // Close behind: take up station just off the robber's rear quarter, and from there, go in.
    const dxToRobber = r.x - c.x;
    if (c.role !== 'block' && huntable && toGo < P.stalkRange && Math.abs(dxToRobber) < P.stalkWidth) {
      const side = this.copPickSide(c);
      const boxedIn = Math.sqrt(r.vx * r.vx + r.vy * r.vy) < P.arrestSpeed; // nearly stopped: close right up for the arrest instead of waiting for a strike
      const tx = r.x + side * ((rk.width + k.width) * 0.5 + (boxedIn ? P.arrestGap : P.stalkGap));
      if (side !== 0 && this.copPathClear(c, tx, P.stalkLook)) {
        c.side = side;
        c.lane = this.nearestLane(c);
        this.copSteer(c, r.vx + clamp((tx - c.x) * P.laneGain, -P.laneRate, P.laneRate), P.laneSlope);
        const wish = r.vy + clamp((toGo - P.stalkHold) * 1.5, -P.aheadEase, P.catchUp);
        this.copSpeed(c, this.followSpeed(c, clamp(wish, 0, k.topSpeed), brake, 2, true));
        if (toGo < P.ramRange && Math.abs(c.x - tx) < P.strikeAlign && c.ramCd <= 0 && this.rng() < P.ramChance * (1 + this.tilt)) {
          c.ram = P.ramTime; c.ramCd = P.ramCooldown;
        }
        return;
      }
    }
    c.side = 0;

    // Otherwise, drive by lanes: a tail cop heads for the robber's lane; flankers, and blockers still overtaking, for the lane beside it
    const lanes = cfg.road.lanes, cur = this.nearestLane(c), robberLane = this.nearestLane(r);
    const inFront = toGo < -P.strikeOverrun, droppingBack = c.y > r.y && c.vy < r.vy, blockHalfway = r.y + P.blockLead * 0.5;
    if (c.role === 'block' && inFront && droppingBack && c.y < r.y + 4) c.role = 'flank'; // the robber has caught its brake-check: from here it hunts like the others
    const yielding = c.role !== 'block' && inFront; // out of the robber's way, and back to its rear quarter
    let want = robberLane;
    if (c.role === 'flank' || yielding || (c.role === 'block' && c.y < blockHalfway && !droppingBack)) {
      const side = c.x >= r.x ? 1 : -1;
      want = robberLane + side >= 0 && robberLane + side < lanes ? robberLane + side : robberLane - side;
    }
    let best = cur, bestCost = Infinity;
    for (let l = Math.max(0, cur - 1); l <= Math.min(lanes - 1, cur + 1); l++) {
      const v = this.copLaneCost(c, l, cur) + Math.abs(l - want) * P.lanePull + (l === c.lane ? 0 : P.laneStick);
      if (v < bestCost) { bestCost = v; best = l; }
    }
    c.lane = best;
    this.copSteer(c, clamp((laneX(cfg, c.lane) - c.x) * P.laneGain, -P.laneRate, P.laneRate), P.laneSlope);
    const offset = c.role === 'flank' ? P.flankOffset : c.role === 'block' ? P.blockLead : -P.followGap;
    const gap = r.y + offset - c.y;
    const brakeCheck = c.role === 'block' && c.y > r.y + 4 && (cur === robberLane || c.y >= blockHalfway || droppingBack);
    const closing = c.role === 'block' ? P.catchUp : Math.min(P.catchUp, gap * P.approachGain); // only a blocker means to go past
    const wish = yielding ? r.vy - clamp(-toGo * P.approachGain, P.aheadEaseMin, P.aheadEase)
      : brakeCheck ? r.vy - P.blockBrake : gap > 0 ? r.vy + closing : r.vy + Math.max(gap, -P.aheadEase);
    this.copSpeed(c, this.followSpeed(c, clamp(wish, 0, k.topSpeed), brake, 2, true));
  }

  private decideTraffic(c: Car, dt: number) {
    const cfg = this.cfg, T = cfg.traffic, k = cfg.kinds[c.kind], rng = this.rng, r = this.robber;
    c.nextDecide = T.decideTicks;
    const step = T.decideTicks * dt;
    if (c.parked) { c.throttle = 0; c.brake = 1; c.steer = 0; return; }
    if (c.cross !== 0) { // side-street car: straight across, not looking
      this.steerAt(c, c.x + c.cross * 20, c.y, T.steerGain);
      this.setSpeed(c, c.wish);
      return;
    }
    if (c.panic > 0) c.panic -= step;
    if (Math.abs(c.y - r.y) < T.nearRange && c.panic <= 0) {
      if (rng() < lerp(cfg.heat.panicRate, this.heat) * step) c.panic = T.panicTime;
      else if (rng() < lerp(cfg.heat.swerveRate, this.heat) * step) {
        const to = c.lane + (rng() < 0.5 ? -1 : 1);
        if (to >= 0 && to < cfg.road.lanes && onComing(cfg, to) === onComing(cfg, c.lane)) {
          const blind = rng() < T.blindChance, x = laneX(cfg, to);
          if (blind || this.cars.every((o) => o === c || Math.abs(o.x - x) > 2.4 || Math.abs(o.y - c.y) > 10)) c.lane = to;
        }
      }
    }
    const sp = Math.max(this.speedOf(c), 5);
    this.steerAt(c, laneX(cfg, c.lane), c.y + c.dir * (T.lookBase + T.lookSpeed * sp), T.steerGain);
    this.setSpeed(c, c.panic > 0 ? 0 : this.followSpeed(c, c.wish, (k.brakes / k.mass) * 0.6, T.margin));
  }

  // ------------------------------------------------------------------ forces (carried over from the racer)

  private applyForces(c: Car, dt: number) {
    const body = this.bodies.get(c.id)!, B = this.cfg.body, st = this.cfg.kinds[c.kind];
    const vx = c.vx, vy = c.vy, fx = Math.cos(c.a), fy = Math.sin(c.a);
    const vf = vx * fx + vy * fy, vl = -vx * fy + vy * fx, speed = Math.sqrt(vx * vx + vy * vy), m = st.mass;
    const boost = c.ram > 0 ? 1 + this.cfg.cop.ramThrust : 1;
    let Fx = fx * st.thrust * c.throttle * boost, Fy = fy * st.thrust * c.throttle * boost;
    const dragK = st.thrust / (st.topSpeed * st.topSpeed);
    Fx -= dragK * speed * vx; Fy -= dragK * speed * vy;
    if (c.brake > 0 && vf !== 0) {
      const brakes = this.isArrested(c) ? m * this.cfg.bust.stopDecel : st.brakes * c.brake;
      const f = Math.min(brakes, (m * Math.abs(vf)) / dt) * (vf > 0 ? 1 : -1);
      Fx -= fx * f; Fy -= fy * f;
    }
    const gripLimit = st.grip * (c.mode === 'spun' ? B.spinGripFactor : 1);
    const avl = Math.abs(vl);
    let a = B.gripRate * avl;
    if (a > gripLimit) a = gripLimit;
    if (a * dt > avl) a = avl / dt;
    const g = vl > 0 ? -a * m : a * m;
    Fx += -fy * g; Fy += fx * g;
    body.applyForceToCenter(planck.Vec2(Fx, Fy), true);
    if (c.mode === 'drive') {
      const factor = Math.min(1, B.turnAtRest + Math.abs(vf) / 10);
      const k = Math.min(1, B.steerResponse * dt);
      body.setAngularVelocity(c.w + (c.steer * st.turnRate * factor - c.w) * k);
    }
  }

  // ------------------------------------------------------------------ damage

  private causeFrom(other: Tag): Cause {
    if (other.kind === 'wall') return 'wall';
    return other.c.kind === 'cop' ? 'cop' : other.c.kind === 'truck' ? 'truck' : 'traffic';
  }

  private processHits() {
    const D = this.cfg.damage, B = this.cfg.body;
    for (const h of this.hits) {
      for (const [me, other] of [[h.a, h.b], [h.b, h.a]] as [Tag, Tag][]) {
        if (me.kind !== 'car') continue;
        const c = me.c;
        if (c === this.robber) this.touchingNow = true;
        if (c.mode === 'wreck' || this.isArrested(c)) continue; // the bust is settled: braking cars nudging each other changes nothing
        // A hit on the rear quarter goes mostly into yaw, which steering then cancels, so its raw impulse badly undersells it
        const struck = c === this.robber && other.kind === 'car' && other.c.kind === 'cop' && other.c.ram > 0;
        const k = this.cfg.kinds[c.kind], raw = h.j / k.mass;
        const dv = struck ? Math.max(raw, Math.min(raw * this.cfg.cop.strikeBite, this.cfg.cop.strikeMaxDv)) : raw;
        if (dv < D.threshold) continue;
        if (struck) other.c.ram = 0; // landed it: back off and set up again
        if (this.rec && (c === this.robber || dv > 6)) this.rec.impacts.push([this.rec.frames.length, round(c.x, 100), round(c.y, 100), round(dv, 10)]);
        c.hp -= D.perDv * (dv - D.threshold) * (other.kind === 'wall' ? D.wallFactor : 1);
        c.regenWait = D.regenDelay;
        if (c === this.robber) this.lastHit = { cause: this.causeFrom(other), time: this.time, solo: other.kind === 'wall' };
        if (c.hp <= 0) {
          c.mode = 'wreck'; c.ram = 0;
          const b = this.bodies.get(c.id)!;
          b.setLinearDamping(B.wreckLinearDamping); b.setAngularDamping(B.wreckAngularDamping);
        } else if (dv >= D.spinDv && c.mode === 'drive' && c.spinImmune <= 0) {
          c.mode = 'spun'; c.spin = D.spinTime; c.spinImmune = D.spinTime + D.spinImmunity; c.ram = 0;
        }
      }
    }
  }

  private updateTimers(dt: number) {
    const D = this.cfg.damage, r = this.robber;
    for (const c of this.cars) {
      if (c.spinImmune > 0) c.spinImmune -= dt;
      if (c.mode === 'spun') { c.spin -= dt; if (c.spin <= 0) { c.mode = 'drive'; c.nextDecide = 0; } }
    }
    if (r.mode !== 'wreck') {
      if (r.regenWait > 0) r.regenWait -= dt;
      else if (r.hp < this.cfg.kinds.robber.hp) r.hp = Math.min(this.cfg.kinds.robber.hp, r.hp + D.regenRate * dt);
    }
  }

  // ------------------------------------------------------------------ ending the leg

  /** Is the robber physically against a police car right now? */
  private touchingCop() {
    for (let e = this.bodies.get(this.robber.id)!.getContactList(); e; e = e.next ?? null) {
      if (!e.contact.isTouching()) continue;
      const other = e.other?.getUserData() as Tag | undefined;
      if (other?.kind === 'car' && other.c.kind === 'cop' && other.c.mode !== 'wreck') return true;
    }
    return false;
  }

  private calm() {
    const r = this.robber, L = this.cfg.leg;
    if (r.mode !== 'drive' || this.touchingNow) return false;
    if (Math.abs(r.x - laneX(this.cfg, this.nearestLane(r))) > L.calmLaneTolerance) return false;
    for (const o of this.cars) {
      if (o === r) continue;
      const dx = o.x - r.x, dy = o.y - r.y, dvx = o.vx - r.vx, dvy = o.vy - r.vy;
      const vv = dvx * dvx + dvy * dvy;
      if (vv < 1e-6) continue;
      const t = clamp(-(dx * dvx + dy * dvy) / vv, 0, L.calmTtc);
      const mx = dx + dvx * t, my = dy + dvy * t;
      if (mx * mx + my * my < L.calmMissDistance * L.calmMissDistance) return false;
    }
    return true;
  }

  private snapshot(): Snapshot {
    const dy = this.robber.y; // each leg starts with the robber at y = 0, so an endless road keeps full precision
    return {
      cars: this.cars.map((c) => ({ ...c, y: c.y - dy })),
      nextSpawn: this.nextSpawn.map((y) => y - dy),
      nextId: this.nextId, bustTimer: this.bustTimer, lockTimer: this.lockTimer, stallTimer: this.stallTimer,
    };
  }

  /** Where the viewer draws this leg's bag. The sim has no bag to miss: reaching one is the same event as the leg ending. */
  private finalBag(outcome: 'reached' | 'crash') {
    const r = this.robber, L = this.cfg.leg;
    if (outcome === 'crash') return { x: this.bag.x, y: Math.max(this.bag.y, r.y + L.crashBagAhead) };
    const centre = laneX(this.cfg, this.nearestLane(r));
    return { x: Math.abs(r.x - centre) <= L.calmLaneTolerance ? centre : r.x, y: r.y + this.cfg.kinds.robber.length * 0.5 };
  }

  private result(outcome: 'reached' | 'crash', cause: Cause | null, ugly: string | null, calmForced: boolean): LegResult {
    this.capture(); // the exact end of the leg, even between regular frames
    if (this.rec) this.rec.endFrame = this.rec.frames.length - 1;
    return {
      outcome, cause, ugly, time: this.time, end: this.snapshot(), calmForced, touching: this.touchingNow,
      bag: this.finalBag(outcome), recording: this.rec,
    };
  }

  private checkEnd(dt: number): LegResult | null {
    const cfg = this.cfg, r = this.robber, L = cfg.leg;
    if (r.mode === 'wreck') {
      const hit = this.lastHit!;
      const solo = hit.solo && !this.cars.some((o) => o !== r && (o.x - r.x) * (o.x - r.x) + (o.y - r.y) * (o.y - r.y) < 64);
      return this.result('crash', hit.cause, cfg.game.rejectSoloCrashes && solo ? 'solo' : null, false);
    }
    const sp = Math.sqrt(r.vx * r.vx + r.vy * r.vy);
    const copNear = this.cars.some((c) => c.kind === 'cop' && c.mode !== 'wreck' && (c.x - r.x) * (c.x - r.x) + (c.y - r.y) * (c.y - r.y) < cfg.bust.range * cfg.bust.range);
    this.bustTimer = sp < cfg.bust.speed && copNear ? this.bustTimer + dt : 0;
    // Locked against police cars, at any speed. Contacts flicker as the cars jostle, so a brief parting drains it rather than clearing it
    this.lockTimer = this.touchingCop() ? this.lockTimer + dt : Math.max(0, this.lockTimer - dt * cfg.bust.lockDecay);
    if (this.bustTimer >= cfg.bust.time || this.lockTimer >= cfg.bust.lockTime) return this.result('crash', 'busted', null, false);
    this.stallTimer = sp < cfg.stall.speed && !copNear ? this.stallTimer + dt : 0;
    if (this.stallTimer >= cfg.stall.time || this.time >= L.timeLimit) return this.result('crash', 'stalled', 'stalled', false);

    if (this.passedAt < 0 && r.y >= this.bag.y) this.passedAt = this.time;
    if (this.passedAt >= 0 && this.tick % cfg.sim.frameTicks === 0) { // on a recorded frame, so legs join without a stutter
      if (this.calm()) return this.result('reached', null, null, false);
      if (this.time - this.passedAt >= L.calmMaxWait) return this.result('reached', null, null, true);
    }
    return null;
  }
}
