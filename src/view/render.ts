// Draws the road and plays recorded frames. Purely a viewer: nothing here can change an outcome.
import { Application, Container, Graphics, Text } from 'pixi.js';
import { CONFIG } from '../config';
import type { LegPlayback } from '../serve/localServer';
import type { Recording } from '../sim/world';

export const VIEW = { ...CONFIG.view, frameTime: CONFIG.sim.frameTicks * CONFIG.sim.dt };

const LANES = CONFIG.road.lanes, LANE_W = CONFIG.road.laneWidth, ON_COMING = CONFIG.road.oncomingLanes;
const ROAD_HALF = (LANES * LANE_W) / 2, CHUNK = 64, CHUNK_POOL = 16;
const K = CONFIG.kinds;
const CAR_SIZE: [number, number][] = [K.robber, K.car, K.truck, K.cop].map((k) => [k.length, k.width]); // by KINDS index
const TRAFFIC = [0x8d99ae, 0x457b9d, 0xa8dadc, 0xc9ada7, 0x6d6875, 0xb56576, 0x588157, 0xe0e1dd];

/** A plain strip of road. The dashes are the only thing that shows it moving past. */
function makeChunk() {
  const g = new Graphics();
  g.rect(-ROAD_HALF, -CHUNK, ROAD_HALF * 2, CHUNK).fill(0x24262e);
  const x = -ROAD_HALF + (ON_COMING || LANES / 2) * LANE_W;
  for (let y = 2; y < CHUNK; y += 8) g.rect(x - 0.1, -y - 3.6, 0.2, 3.6).fill(0x5a5d68);
  return g;
}

interface Sprite { root: Container; body: Graphics; lightA?: Graphics; lightB?: Graphics; glow?: Graphics; fade: number; kind: number; seen: boolean; wreckShown: boolean }
interface Particle { g: Graphics; x: number; y: number; vx: number; vy: number; life: number; max: number; grow: number }

function makeCar(id: number, kind: number): Sprite {
  const root = new Container(), body = new Graphics(), [L, W] = CAR_SIZE[kind];
  const colour = kind === 0 ? 0xffc400 : kind === 3 ? 0xf1f1f1 : kind === 2 ? 0x7a6a53 : TRAFFIC[id % TRAFFIC.length];
  body.roundRect(-L / 2, -W / 2, L, W, 0.3).fill(colour);
  if (kind === 2) {
    body.rect(-L / 2, -W / 2, L - 1.9, W).fill(0x9a8a70);
    body.rect(L / 2 - 1.3, -W / 2 + 0.2, 0.6, W - 0.4).fill(0x20252c);
  } else {
    body.rect(L * 0.08, -W / 2 + 0.14, L * 0.2, W - 0.28).fill(0x1b2530);
    body.rect(-L * 0.36, -W / 2 + 0.16, L * 0.16, W - 0.32).fill(0x1b2530);
  }
  if (kind === 3) { body.rect(-L * 0.18, -W / 2, L * 0.24, W).fill(0x15171f); }
  if (kind === 1 || kind === 2) for (const side of [-1, 1]) body.circle(L / 2 - 0.1, side * W * 0.32, 0.17).fill(0xfff4c2); // headlights, to read direction
  root.addChild(body);
  const s: Sprite = { root, body, fade: 0, kind, seen: false, wreckShown: false };
  if (kind === 3) {
    s.glow = new Graphics();
    for (const [r, a] of [[1, 0.25], [0.68, 0.35], [0.38, 0.55]]) s.glow.circle(0, 0, VIEW.copGlowRadius * r).fill({ color: 0xffffff, alpha: a });
    s.glow.blendMode = 'add';
    root.addChildAt(s.glow, 0);
    s.lightA = new Graphics().rect(-0.14, -W / 2 + 0.05, 0.28, W / 2 - 0.05).fill(0xff2233);
    s.lightB = new Graphics().rect(-0.14, 0, 0.28, W / 2 - 0.05).fill(0x2a6bff);
    root.addChild(s.lightA, s.lightB);
  }
  if (kind === 0) {
    const ring = new Graphics().circle(0, 0, 3).stroke({ width: 0.14, color: 0xffc400, alpha: 0.75 });
    root.addChild(ring);
  }
  return s;
}

export class Scene {
  app = new Application();
  private world = new Container();
  private ground = new Container();
  private bagLayer = new Container();
  private carLayer = new Container();
  private fx = new Container();
  private chunks: Container[] = [];
  private sprites = new Map<number, Sprite>();
  private meta: Recording['meta'] = {};
  private particles: Particle[] = [];
  private bag: Container | null = null;
  private camY = 0;
  private shake = 0;
  private clock = 0;
  private lastFrame = -1;
  private wash = new Graphics();    // red/blue flash over the whole screen when police are close
  private arrows = new Graphics();  // screen-edge markers for police out of view
  private cops: { x: number; y: number }[] = [];
  copsNear = 0;
  robberX = 0; robberY = 0;
  origin = 0;              // world y of the current leg's y = 0

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, background: 0x0d0e14, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) });
    host.appendChild(this.app.canvas);
    this.wash.rect(0, 0, 1, 1).fill(0xffffff);
    this.wash.blendMode = 'add';
    this.app.stage.addChild(this.world, this.wash, this.arrows);
    this.world.addChild(this.ground, this.bagLayer, this.carLayer, this.fx);
    for (let v = 0; v < CHUNK_POOL; v++) { const c = makeChunk(); c.visible = false; this.chunks.push(c); this.ground.addChild(c); }
  }

  reset() {
    for (const s of this.sprites.values()) s.root.destroy({ children: true });
    this.sprites.clear();
    this.meta = {};
    for (const p of this.particles) p.g.destroy();
    this.particles = [];
    this.clearBag();
    this.origin = 0; this.camY = 0; this.shake = 0; this.lastFrame = -1; this.cops = []; this.copsNear = 0;
  }

  private clearBag() {
    if (this.bag) { this.bag.destroy({ children: true }); this.bag = null; }
  }

  /** The robber has driven into this leg's bag. */
  collectBag() {
    this.burst(this.robberX, this.robberY, 22, 0xffd60a, 12, 0.6);
    this.clearBag();
  }

  private sprite(id: number) {
    let s = this.sprites.get(id);
    if (!s) {
      s = makeCar(id, this.meta[id]?.[0] ?? 1);
      this.sprites.set(id, s);
      this.carLayer.addChild(s.root);
    }
    return s;
  }

  addMeta(meta: Recording['meta']) { Object.assign(this.meta, meta); }

  /** Prepare a leg: its bag. */
  beginLeg(p: LegPlayback) {
    this.addMeta(p.recording.meta);
    this.lastFrame = -1;
    this.clearBag();
    const bag = new Container(), g = new Graphics();
    g.circle(0, 0, 2.6).fill({ color: 0xffd60a, alpha: 0.2 });
    g.circle(0, 0, 1.25).fill(0xffd60a).stroke({ width: 0.14, color: 0x7a5a00 });
    const t = new Text({ text: '$', style: { fontFamily: 'Arial Black, Arial', fontSize: 40, fill: 0x4a3600 } });
    t.anchor.set(0.5); t.scale.set(0.05);
    bag.addChild(g, t);
    bag.position.set(p.bag.x, -(this.origin + p.bag.y));
    this.bagLayer.addChild(bag);
    this.bag = bag;
  }

  /** Move this leg's frame of reference on to the robber's final position. */
  endLeg(p: LegPlayback) {
    const f = p.recording.frames[p.recording.endFrame];
    for (let i = 0; i < f.length; i += 5) if (f[i] === 0) { this.origin += f[i + 2]; break; }
  }

  /** Draw one recorded frame alone (used for the opening view and the frozen decision beat). */
  showFrame(f: number[]) { this.drawCars(f, f, 0); }

  /** Draw time `t` of a leg, firing any impact effects passed since the last call. */
  play(p: LegPlayback, t: number) {
    const R = p.recording, last = R.frames.length - 1;
    const pos = Math.min(t / VIEW.frameTime, last), i = Math.min(Math.floor(pos), last), j = Math.min(i + 1, last);
    for (const [frame, x, y, dv] of R.impacts) {
      if (frame > this.lastFrame && frame <= i) this.spark(x, this.origin + y, dv);
    }
    if (i !== this.lastFrame) this.lastFrame = i;
    this.drawCars(R.frames[i], R.frames[j], pos - i);
  }

  private drawCars(a: number[], b: number[], k: number) {
    const later = new Map<number, number>();
    for (let i = 0; i < b.length; i += 5) later.set(b[i], i);
    for (const s of this.sprites.values()) s.seen = false;
    this.cops = [];
    for (let i = 0; i < a.length; i += 5) {
      const id = a[i], s = this.sprite(id), n = later.get(id);
      let x = a[i + 1], y = a[i + 2], ang = a[i + 3];
      if (n !== undefined) {
        x += (b[n + 1] - x) * k; y += (b[n + 2] - y) * k;
        let d = b[n + 3] - ang;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        ang += d * k;
      }
      const wy = this.origin + y;
      s.root.position.set(x, -wy);
      s.root.rotation = -ang;
      s.seen = true;
      s.root.visible = true;
      if (a[i + 4] === 2 && !s.wreckShown) {
        s.wreckShown = true;
        s.body.tint = 0x555555;
        if (id !== 0) this.burst(x, wy, 10, 0x777777, 6, 1.4);
      }
      if (id === 0) { this.robberX = x; this.robberY = wy; }
      if (s.kind === 3 && a[i + 4] !== 2) this.cops.push({ x, y: wy });
    }
    for (const [id, s] of this.sprites) if (!s.seen) { s.root.destroy({ children: true }); this.sprites.delete(id); }
  }

  private spark(x: number, y: number, dv: number) {
    this.burst(x, y, Math.min(26, 4 + dv * 1.4), 0xffb347, 7 + dv, 0.5);
    this.shake = Math.min(1.8, this.shake + dv * 0.06);
  }

  private burst(x: number, y: number, n: number, color: number, speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random());
      const g = new Graphics().circle(0, 0, 0.32).fill(color);
      this.fx.addChild(g);
      this.particles.push({ g, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, grow: 0 });
    }
  }

  /** The robber is finished. */
  explode(busted: boolean) {
    if (busted) { this.burst(this.robberX, this.robberY, 24, 0x2a6bff, 12, 0.9); this.burst(this.robberX, this.robberY, 24, 0xff2233, 12, 0.9); this.shake = 0.5; return; }
    this.burst(this.robberX, this.robberY, 60, 0xff7a00, 22, 0.9);
    this.burst(this.robberX, this.robberY, 40, 0xffe066, 14, 0.7);
    for (let i = 0; i < 16; i++) {
      const g = new Graphics().circle(0, 0, 1).fill({ color: 0x333333, alpha: 0.7 });
      this.fx.addChild(g);
      this.particles.push({ g, x: this.robberX + (Math.random() - 0.5) * 3, y: this.robberY + (Math.random() - 0.5) * 3, vx: (Math.random() - 0.5) * 4, vy: 1 + Math.random() * 3, life: 2.4, max: 2.4, grow: 1.6 });
    }
    this.shake = 2.4;
  }

  /** The police presence: flashing glows, the screen wash, and arrows towards anyone out of view. */
  private drawPolice(W: number, H: number, scale: number, screenY: number) {
    const flash = Math.floor(this.clock * VIEW.copFlashHz) % 2 === 0, colour = flash ? 0xff2233 : 0x2a6bff;
    for (const s of this.sprites.values()) {
      if (!s.lightA || !s.lightB || !s.glow) continue;
      s.lightA.alpha = s.wreckShown ? 0.15 : flash ? 1 : 0.15;
      s.lightB.alpha = s.wreckShown ? 0.15 : flash ? 0.15 : 1;
      s.glow.tint = colour;
      s.glow.alpha = s.wreckShown ? 0 : VIEW.copGlowAlpha;
    }
    let nearest = Infinity, near = 0;
    this.arrows.clear();
    for (const c of this.cops) {
      const d = Math.sqrt((c.x - this.robberX) ** 2 + (c.y - this.robberY) ** 2);
      if (d < nearest) nearest = d;
      if (d < VIEW.pursuitRange) near++;
      if (d > VIEW.arrowRange) continue;
      const sy = H * screenY + (this.camY - c.y) * scale;
      if (sy >= 0 && sy <= H) continue;
      const sx = Math.max(16, Math.min(W - 16, W / 2 + c.x * scale)), up = sy > H, y = up ? H - 8 : 8, tip = up ? -14 : 14;
      this.arrows.moveTo(sx, y + tip).lineTo(sx - 9, y).lineTo(sx + 9, y).closePath().fill({ color: colour, alpha: 0.9 });
    }
    this.copsNear = near;
    this.wash.scale.set(W, H);
    this.wash.tint = colour;
    this.wash.alpha = VIEW.washMaxAlpha * Math.max(0, 1 - nearest / VIEW.washRange);
  }

  /** Per-frame upkeep and camera. */
  update(dt: number) {
    this.clock += dt;
    const W = this.app.screen.width, H = this.app.screen.height;
    const scale = Math.min(H / VIEW.metresTall, W / VIEW.minMetresWide);
    // on narrow screens the controls sit at the bottom, so the robber rides higher to stay clear of them
    const screenY = W < 900 ? VIEW.robberScreenYNarrow : VIEW.robberScreenY;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96;
      if (p.life <= 0) { p.g.destroy(); this.particles.splice(i, 1); continue; }
      p.g.position.set(p.x, -p.y);
      p.g.alpha = Math.min(1, p.life / p.max * 1.4);
      if (p.grow) p.g.scale.set(1 + (1 - p.life / p.max) * p.grow * 2);
    }
    this.shake *= Math.max(0, 1 - dt * 5);
    for (const s of this.sprites.values()) {
      if (s.fade < 1) s.fade = Math.min(1, s.fade + dt * 5);
      s.root.alpha = Math.max(s.fade, 0.05);
    }
    if (this.bag) this.bag.scale.set(1 + Math.sin(this.clock * 6) * VIEW.bagPulse);
    this.camY += (this.robberY - this.camY) * Math.min(1, dt * 14);
    if (this.camY === 0 || Math.abs(this.robberY - this.camY) > 60) this.camY = this.robberY;
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    this.world.scale.set(scale);
    this.world.position.set(W / 2 + sx * scale, H * screenY + (this.camY + sy) * scale);
    this.drawPolice(W, H, scale, screenY);
    // only the chunks on screen
    const topY = this.camY + (H * screenY) / scale, botY = this.camY - (H * (1 - screenY)) / scale;
    for (const c of this.chunks) c.visible = false;
    for (let n = Math.floor(botY / CHUNK) - 1; n <= Math.floor(topY / CHUNK); n++) {
      const c = this.chunks[((n % CHUNK_POOL) + CHUNK_POOL) % CHUNK_POOL];
      c.visible = true; c.position.y = -n * CHUNK;
    }
  }
}
