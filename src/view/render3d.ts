// Draws the road in 3D and plays recorded frames. Purely a viewer: nothing here can change an outcome.
// The sim is flat, so sim (x, y) becomes world (x, 0, -y): +x stays right, and north runs away from the camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import type { LegPlayback } from '../serve/localServer';
import type { Recording } from '../sim/world';

export const VIEW = { ...CONFIG.view, frameTime: CONFIG.sim.frameTicks * CONFIG.sim.dt };

const LANES = CONFIG.road.lanes, LANE_W = CONFIG.road.laneWidth, ON_COMING = CONFIG.road.oncomingLanes;
const ROAD_HALF = (LANES * LANE_W) / 2, BARRIER_W = 0.4, SIDEWALK = 3;
const CHUNK = 64, CHUNK_POOL = 10; // the street repeats every CHUNK * CHUNK_POOL metres
const MAX_PARTICLES = 200;
const K = CONFIG.kinds;
const CAR_SIZE: [number, number][] = [K.robber, K.car, K.truck, K.cop].map((k) => [k.length, k.width]); // by KINDS index

const MODELS = import.meta.env.BASE_URL + 'models/';
const ROBBER_MODEL = 'sedan-sports', COP_MODEL = 'police';
const TRAFFIC_MODELS = ['sedan', 'suv', 'taxi', 'van', 'hatchback-sports', 'suv-luxury'];
const TRUCK_MODELS = ['delivery', 'garbage-truck', 'delivery-flat'];
const DEBRIS_MODELS = ['debris-door', 'debris-bumper', 'debris-tire', 'debris-plate-a'];
const HOUSE_LETTERS = 'abcdefghijklmnopqrstu'.split('');

const RED = 0xff2233, BLUE = 0x2a6bff, GOLD = 0xffd60a;
const SKY = 0xbfd8e8;
const X_AXIS = new THREE.Vector3(1, 0, 0);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
/** A critically damped spring: eases away from rest and into the target, however the target moves. Returns [value, velocity]. */
function smoothDamp(value: number, target: number, velocity: number, smooth: number, dt: number): [number, number] {
  const omega = 2 / Math.max(0.01, smooth), x = omega * dt, decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = value - target, temp = (velocity + omega * change) * dt;
  return [target + (change + temp) * decay, (velocity - omega * temp) * decay];
}

interface Model { root: THREE.Group; size: THREE.Vector3; centre: THREE.Vector3 }
interface Wheel { node: THREE.Object3D; rest: THREE.Quaternion }
interface Car {
  root: THREE.Group; tilt: THREE.Group; wheels: Wheel[]; meshes: THREE.Mesh[];
  lightA?: THREE.Sprite; lightB?: THREE.Sprite; glow?: THREE.Mesh;
  kind: number; mode: number; seen: boolean; wreckShown: boolean; fade: number;
  lastX: number; lastZ: number; lastA: number; speed: number; spin: number; roll: number; pitch: number; smoke: number; moved: boolean;
}
interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; grow: number; gravity: number; colour: THREE.Color }
interface Debris { obj: THREE.Object3D; vx: number; vy: number; vz: number; spinX: number; spinZ: number; life: number }

type Shot = 'play' | 'arrest' | 'wreck';
/** Where the camera is and what it looks at, in sim terms: (x, height, y). */
interface Pose { x: number; h: number; y: number; lookX: number; lookH: number; lookY: number; fov: number; roll: number }

const SWOOP = 0.6;      // s the camera takes to move in on a bust or wreck
const FRAME_FADE = 8;   // m: the last stretch of the framing range, over which an object's pull on the camera fades in
const ROAD_VIEW_LIMIT = 300; // m: the furthest a corner of the picture is taken to reach, for a ray that barely meets the ground
const POSE_LERP: (keyof Pose)[] = ['x', 'h', 'y', 'lookX', 'lookH', 'lookY', 'fov', 'roll'];
const POSE_ROAD_Y: (keyof Pose)[] = ['y', 'lookY']; // these follow the road, so a swoop stays with the robber

/** A soft white disc, tinted by whatever uses it. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!, r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.45, 'rgba(255,255,255,.4)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** The cash: a solid dollar sign inside a ring, standing upright. */
function makeCash() {
  const gold = new THREE.MeshStandardMaterial({ color: GOLD, emissive: 0x7a5200, roughness: 0.35 });
  const S: [number, number][] = [[0.52, 0.48], [0.28, 0.72], [-0.2, 0.74], [-0.52, 0.46], [-0.3, 0.12], [0.3, -0.12], [0.52, -0.46], [0.2, -0.74], [-0.28, -0.72], [-0.52, -0.48]];
  const curve = new THREE.CatmullRomCurve3(S.map(([x, y]) => new THREE.Vector3(x, y, 0)));
  const cap = (at: [number, number]) => new THREE.SphereGeometry(0.17, 12, 8).translate(at[0], at[1], 0);
  const parts = [new THREE.TubeGeometry(curve, 48, 0.17, 10), cap(S[0]), cap(S[S.length - 1]), new THREE.CylinderGeometry(0.09, 0.09, 2.05, 10), new THREE.TorusGeometry(1.3, 0.15, 12, 40)];
  const cash = new THREE.Group();
  for (const geo of parts) {
    const m = new THREE.Mesh(geo, gold);
    m.castShadow = true;
    cash.add(m);
  }
  return cash;
}

/** A small seeded generator, so each slot of the street always looks the same. */
function layoutRng(seed: number) {
  let s = seed * 2654435761 >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class Scene {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(VIEW.cameraFov, 1, 0.4, 900);
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  private host!: HTMLElement;
  private arrowCanvas = document.createElement('canvas');   // screen-edge markers for police out of view
  private arrows!: CanvasRenderingContext2D;
  private wash = document.createElement('div');             // red/blue flash over the whole screen when police are close
  private width = 1;
  private height = 1;

  private models = new Map<string, Model>();
  private chunks: THREE.Group[] = [];
  private cars = new Map<number, Car>();
  private meta: Recording['meta'] = {};
  private bag: THREE.Group | null = null;
  private cash = makeCash();
  private glowTex!: THREE.Texture;
  private redGlow!: THREE.MeshBasicMaterial;
  private blueGlow!: THREE.MeshBasicMaterial;
  private redLight!: THREE.SpriteMaterial;
  private blueLight!: THREE.SpriteMaterial;

  private particles: Particle[] = [];
  private particleMesh!: THREE.InstancedMesh;
  private debris: Debris[] = [];
  private cops: { x: number; y: number }[] = [];
  private camY = 0;
  private camX = 0;
  private focusX = 0;      // the robber, smoothed: what the close shots are built around (camY is its partner)
  private lateral = 0;     // m/s the robber is moving sideways, smoothed
  private shot: Shot = 'play';
  private shotAge = 0;
  private frameTall = 0;   // m of road the camera is currently fitting top to bottom
  private frameY = 0;      // where on screen the robber currently sits, as a share of its height
  private leanSide = 1;    // which side of the road's line the camera sits on
  private yaw = 0;         // radians it is currently swung round by
  private orbit = 0;       // arrest and wreck shots: where around the robber the camera starts
  private blendLeft = 0; private blendTime = 0;
  private blendFrom: Pose | null = null;     // road-following fields held relative to the robber
  private lastPose: Pose | null = null;
  private tallV = 0; private frameYV = 0; private camXV = 0; private yawV = 0; // how fast each of those is currently easing
  private tiltShare = 0; private tiltV = 0;  // how far the speed tilt has got, 0 to 1
  private viewRay = new THREE.Vector3();
  private probe = new THREE.Vector3();
  private bagAge = 0;
  private shake = 0;
  private clock = 0;
  private lastFrame = -1;
  copsNear = 0;
  robberX = 0; robberY = 0;
  origin = 0;              // world y of the current leg's y = 0

  async init(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(this.renderer.domElement);

    this.arrows = this.arrowCanvas.getContext('2d')!;
    this.arrowCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.wash.style.cssText = 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;opacity:0';
    host.append(this.wash, this.arrowCanvas);

    this.scene.background = new THREE.Color(SKY);
    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x7f8a70, 1.5));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 260;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.14;
    this.scene.add(this.sun, this.sun.target);

    this.glowTex = glowTexture();
    const glow = (color: number) => new THREE.MeshBasicMaterial({ map: this.glowTex, color, transparent: true, opacity: VIEW.copGlowAlpha, blending: THREE.AdditiveBlending, depthWrite: false });
    this.redGlow = glow(RED); this.blueGlow = glow(BLUE);
    const light = (color: number) => new THREE.SpriteMaterial({ map: this.glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false });
    this.redLight = light(RED); this.blueLight = light(BLUE);

    this.particleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), MAX_PARTICLES);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.count = 0;
    this.scene.add(this.particleMesh);

    await this.loadModels();
    this.buildStreet();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private async loadModels() {
    const loader = new GLTFLoader();
    const cars = [ROBBER_MODEL, COP_MODEL, ...TRAFFIC_MODELS, ...TRUCK_MODELS, ...DEBRIS_MODELS];
    const city = [...HOUSE_LETTERS.map((l) => `building-type-${l}`), 'tree-large', 'tree-small'];
    const load = async (folder: string, name: string) => {
      const root = (await loader.loadAsync(`${MODELS}${folder}/${name}.glb`)).scene;
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        const m = mesh.material as THREE.MeshStandardMaterial;
        m.metalness = 0; m.roughness = 0.9;
        if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.minFilter = THREE.NearestFilter; m.map.generateMipmaps = false; } // a palette: blending between its colours would be wrong
      });
      const box = new THREE.Box3().setFromObject(root);
      this.models.set(name, { root, size: box.getSize(new THREE.Vector3()), centre: box.getCenter(new THREE.Vector3()) });
    };
    await Promise.all([...cars.map((n) => load('cars', n)), ...city.map((n) => load('city', n))]);
  }

  // ------------------------------------------------------------------ the street

  /** One slot of street: road, markings, barriers and a merged block of houses and trees, so it draws in very few calls. */
  private makeChunk(slot: number) {
    const group = new THREE.Group();
    const flat = (w: number, x: number, y: number, color: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, CHUNK), new THREE.MeshLambertMaterial({ color }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, y, -CHUNK / 2); m.receiveShadow = true;
      group.add(m);
    };
    flat(420, 0, -0.06, 0x6f9a55);
    flat(ROAD_HALF * 2, 0, 0, 0x34363f);
    const box = (w: number, h: number, x: number, color: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, CHUNK), new THREE.MeshLambertMaterial({ color }));
      m.position.set(x, h / 2, -CHUNK / 2); m.receiveShadow = true; m.castShadow = h > 0.3;
      group.add(m);
    };
    for (const side of [-1, 1]) {
      box(BARRIER_W, 0.6, side * (ROAD_HALF + BARRIER_W / 2), 0xb9bcc2); // its inner face is the sim's wall
      box(SIDEWALK, 0.14, side * (ROAD_HALF + BARRIER_W + SIDEWALK / 2), 0xa7a59c);
    }
    this.paint(group);
    group.add(this.scenery(slot));
    group.visible = false;
    return group;
  }

  private paint(group: THREE.Group) {
    const stripe = (x: number, w: number, color: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, CHUNK), new THREE.MeshBasicMaterial({ color }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, -CHUNK / 2);
      group.add(m);
    };
    const DASH = 3.2, PERIOD = 8, dashes: THREE.Matrix4[] = [];
    for (let lane = 1; lane < LANES; lane++) {
      const x = -ROAD_HALF + lane * LANE_W;
      if (lane === ON_COMING) { stripe(x - 0.16, 0.14, 0xf2c230); stripe(x + 0.16, 0.14, 0xf2c230); continue; }
      for (let z = PERIOD / 2; z < CHUNK; z += PERIOD) dashes.push(new THREE.Matrix4().makeTranslation(x, 0.02, -z));
    }
    if (dashes.length) {
      const geo = new THREE.PlaneGeometry(0.16, DASH);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xd9dade }), dashes.length);
      dashes.forEach((d, i) => m.setMatrixAt(i, d));
      group.add(m);
    }
  }

  private scenery(slot: number) {
    const rng = layoutRng(slot + 1), parts: THREE.BufferGeometry[] = [];
    const place = (name: string, x: number, z: number, yaw: number, scale: number) => {
      const model = this.models.get(name)!;
      const at = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(scale, scale, scale));
      model.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry.clone();
        for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a);
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(at, mesh.matrixWorld));
        parts.push(g);
      });
    };
    const edge = ROAD_HALF + BARRIER_W + SIDEWALK;
    const tree = (x: number, z: number) => place(rng() < 0.5 ? 'tree-large' : 'tree-small', x, z, rng() * Math.PI * 2, 9 + rng() * 6);
    for (const side of [-1, 1]) {
      for (const row of [0, 1]) {
        let t = 1 + rng() * 3;
        while (t < CHUNK - 8) {
          const name = `building-type-${HOUSE_LETTERS[Math.floor(rng() * HOUSE_LETTERS.length)]}`, size = this.models.get(name)!.size, scale = 7 + rng() * 1.5;
          const along = size.x * scale, deep = size.z * scale;
          if (t + along > CHUNK - 1) break;
          place(name, side * (edge + 4 + row * 24 + deep / 2), -(t + along / 2), -side * Math.PI / 2, scale);
          const gap = 2 + rng() * 5;
          if (rng() < 0.6) tree(side * (edge + 3 + row * 24 + rng() * 8), -(t + along + gap / 2));
          t += along + gap;
        }
      }
      for (let i = 0; i < 12; i++) tree(side * (edge + 50 + rng() * 45), -rng() * CHUNK);
    }
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error('The scenery models could not be merged');
    const house = this.models.get('building-type-a')!.root;
    let material: THREE.Material | undefined;
    house.traverse((o) => { if ((o as THREE.Mesh).isMesh) material = (o as THREE.Mesh).material as THREE.Material; });
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  }

  private buildStreet() {
    for (let s = 0; s < CHUNK_POOL; s++) { const c = this.makeChunk(s); this.chunks.push(c); this.scene.add(c); }
  }

  // ------------------------------------------------------------------ cars

  private makeCar(id: number, kind: number): Car {
    const name = kind === 0 ? ROBBER_MODEL : kind === 3 ? COP_MODEL : kind === 2 ? TRUCK_MODELS[id % TRUCK_MODELS.length] : TRAFFIC_MODELS[id % TRAFFIC_MODELS.length];
    const model = this.models.get(name)!, [L, W] = CAR_SIZE[kind];
    const root = new THREE.Group(), body = model.root.clone(true), tilt = new THREE.Group();
    // fit the model to its physics box exactly, so what touches on screen is what touched in the sim
    const sx = W / model.size.x, sz = L / model.size.z;
    body.scale.set(sx, (sx + sz) / 2, sz);
    body.position.set(-model.centre.x * sx, 0, -model.centre.z * sz);
    const wheels: Wheel[] = [], meshes: THREE.Mesh[] = [];
    for (const child of [...body.children]) {
      if (child.name.startsWith('wheel')) wheels.push({ node: child, rest: child.quaternion.clone() });
      else tilt.add(child);
    }
    body.add(tilt);
    body.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    root.add(body);
    const car: Car = { root, tilt, wheels, meshes, kind, mode: 0, seen: false, wreckShown: false, fade: 0, lastX: NaN, lastZ: 0, lastA: 0, speed: 0, spin: 0, roll: 0, pitch: 0, smoke: 0, moved: false };
    if (kind === 3) {
      const r = VIEW.copGlowRadius;
      car.glow = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), this.redGlow);
      car.glow.rotation.x = -Math.PI / 2; car.glow.position.y = 0.05;
      const bar = model.size.y * (sx + sz) / 2 + 0.08;
      car.lightA = new THREE.Sprite(this.redLight); car.lightA.position.set(0.32, bar, 0); car.lightA.scale.setScalar(2.2);
      car.lightB = new THREE.Sprite(this.blueLight); car.lightB.position.set(-0.32, bar, 0); car.lightB.scale.setScalar(2.2);
      root.add(car.glow, car.lightA, car.lightB);
    }
    if (kind === 0) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(2.55, 2.75, 48), new THREE.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.75, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04;
      root.add(ring);
    }
    return car;
  }

  private car(id: number) {
    let c = this.cars.get(id);
    if (!c) {
      c = this.makeCar(id, this.meta[id]?.[0] ?? 1);
      this.cars.set(id, c);
      this.scene.add(c.root);
    }
    return c;
  }

  private dropCar(c: Car) {
    this.scene.remove(c.root);
    c.glow?.geometry.dispose();
    if (c.wreckShown) for (const m of c.meshes) (m.material as THREE.Material).dispose(); // only wrecks own their materials
  }

  private clearBag() {
    if (this.bag) { this.scene.remove(this.bag); this.bag = null; }
  }

  reset() {
    for (const c of this.cars.values()) this.dropCar(c);
    this.cars.clear();
    this.meta = {};
    this.particles = [];
    for (const d of this.debris) this.scene.remove(d.obj);
    this.debris = [];
    this.clearBag();
    this.origin = 0; this.camY = 0; this.camX = 0; this.shake = 0; this.lastFrame = -1; this.cops = []; this.copsNear = 0;
    this.focusX = 0; this.lateral = 0; this.frameTall = 0; this.yaw = 0; this.tiltShare = 0;
    this.tallV = 0; this.frameYV = 0; this.camXV = 0; this.yawV = 0; this.tiltV = 0;
    this.shot = 'play'; this.shotAge = 0; this.blendLeft = 0; this.blendFrom = null; this.lastPose = null;
  }

  /** The robber has driven into this leg's bag. */
  collectBag() {
    this.burst(this.robberX, this.robberY, 8, GOLD, 9, 0.5);
    this.clearBag();
  }

  addMeta(meta: Recording['meta']) { Object.assign(this.meta, meta); }

  /** Prepare a leg: its bag. */
  beginLeg(p: LegPlayback) {
    this.addMeta(p.recording.meta);
    this.lastFrame = -1;
    this.clearBag();
    const bag = new THREE.Group(), halo = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), new THREE.MeshBasicMaterial({ map: this.glowTex, color: GOLD, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.05;
    this.cash.position.y = 1.9;
    bag.add(halo, this.cash);
    bag.position.set(p.bag.x, 0, -(this.origin + p.bag.y));
    this.scene.add(bag);
    this.bag = bag;
    bag.scale.setScalar(0.001); // the low shots can see up the road to where it appears, so it grows in rather than popping
    this.bagAge = 0;
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
    for (const c of this.cars.values()) c.seen = false;
    this.cops = [];
    for (let i = 0; i < a.length; i += 5) {
      const id = a[i], c = this.car(id), n = later.get(id);
      let x = a[i + 1], y = a[i + 2], ang = a[i + 3];
      if (n !== undefined) {
        x += (b[n + 1] - x) * k; y += (b[n + 2] - y) * k;
        ang += wrap(b[n + 3] - ang) * k;
      }
      const wy = this.origin + y;
      c.root.position.set(x, 0, -wy);
      c.root.rotation.y = ang + Math.PI / 2; // the models face +z
      c.seen = true;
      c.mode = a[i + 4];
      if (c.mode === 2 && !c.wreckShown) {
        c.wreckShown = true;
        for (const m of c.meshes) { const w = (m.material as THREE.MeshStandardMaterial).clone(); w.color.multiplyScalar(0.3); m.material = w; }
        if (id !== 0) this.burst(x, wy, 3, 0x777777, 5, 0.8);
      }
      if (id === 0) { this.robberX = x; this.robberY = wy; }
      if (c.kind === 3 && c.mode !== 2) this.cops.push({ x, y: wy });
    }
    for (const [id, c] of this.cars) if (!c.seen) { this.dropCar(c); this.cars.delete(id); }
  }

  // ------------------------------------------------------------------ effects

  private spark(x: number, y: number, dv: number) {
    this.burst(x, y, Math.min(6, 1 + dv * 0.3), 0xffb347, 6 + dv * 0.5, 0.35);
    if (this.onScreen(x, y)) this.shake = Math.min(VIEW.shakeMax, this.shake + dv * VIEW.shakePerDv); // a bang nobody can see shakes nothing
  }

  /** Whether a point on the road is inside the picture, as the camera last framed it. */
  private onScreen(x: number, y: number) {
    const p = this.probe.set(x, 0.7, -y).project(this.camera);
    return p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
  }

  private addParticle(p: Particle) { if (this.particles.length < MAX_PARTICLES) this.particles.push(p); }

  private burst(x: number, y: number, n: number, color: number, speed: number, life: number) {
    const colour = new THREE.Color(color), count = Math.round(n * VIEW.particleAmount);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random());
      this.addParticle({ x, y: 0.7, z: -y, vx: Math.cos(a) * s, vy: 2 + Math.random() * speed * 0.6, vz: Math.sin(a) * s, life, max: life, size: 0.1 + Math.random() * 0.12, grow: 0, gravity: 18, colour });
    }
  }

  private smoke(x: number, y: number, z: number, n: number, shade: number, life: number, size = 0.3) {
    const count = Math.round(n * VIEW.particleAmount);
    for (let i = 0; i < count; i++) {
      this.addParticle({ x: x + (Math.random() - 0.5) * 1.6, y, z: z + (Math.random() - 0.5) * 1.6, vx: (Math.random() - 0.5) * 2, vy: 1.5 + Math.random() * 2, vz: (Math.random() - 0.5) * 2, life, max: life, size: size * (0.7 + Math.random() * 0.6), grow: 0.6, gravity: 0, colour: new THREE.Color(shade) });
    }
  }

  private throwDebris(x: number, y: number) {
    for (let i = 0; i < 4; i++) {
      const obj = this.models.get(DEBRIS_MODELS[i % DEBRIS_MODELS.length])!.root.clone(true), a = Math.random() * Math.PI * 2, s = 5 + Math.random() * 11;
      obj.position.set(x, 0.8, -y);
      this.scene.add(obj);
      this.debris.push({ obj, vx: Math.cos(a) * s, vy: 7 + Math.random() * 9, vz: Math.sin(a) * s, spinX: (Math.random() - 0.5) * 16, spinZ: (Math.random() - 0.5) * 16, life: 3.5 });
    }
  }

  /** The robber is finished. */
  explode(busted: boolean) {
    const cop = this.nearestCop();
    this.orbit = cop ? Math.atan2(cop.y - this.robberY, cop.x - this.robberX) + Math.PI : Math.random() * Math.PI * 2; // from the far side, so the cop is in the frame too
    this.cut(busted ? 'arrest' : 'wreck');
    if (busted) { this.burst(this.robberX, this.robberY, 5, BLUE, 9, 0.6); this.burst(this.robberX, this.robberY, 5, RED, 9, 0.6); this.shake = VIEW.shakeBust; return; }
    this.burst(this.robberX, this.robberY, 14, 0xff7a00, 14, 0.6);
    this.burst(this.robberX, this.robberY, 8, 0xffe066, 10, 0.5);
    this.smoke(this.robberX, 1, -this.robberY, 5, 0x2c2c2c, 1.3, 0.34);
    this.throwDebris(this.robberX, this.robberY);
    this.shake = VIEW.shakeWreck;
  }

  /** The police presence: flashing lights, the screen wash, and arrows towards anyone out of view. */
  private drawPolice() {
    const W = this.width, H = this.height;
    const flash = Math.floor(this.clock * VIEW.copFlashHz) % 2 === 0, colour = flash ? RED : BLUE;
    const css = `#${colour.toString(16).padStart(6, '0')}`;
    for (const c of this.cars.values()) {
      if (!c.lightA || !c.lightB || !c.glow) continue;
      const live = !c.wreckShown;
      c.lightA.visible = live && flash;
      c.lightB.visible = live && !flash;
      c.glow.visible = live;
      c.glow.material = flash ? this.redGlow : this.blueGlow;
    }
    let nearest = Infinity, near = 0;
    const g = this.arrows, v = new THREE.Vector3();
    g.clearRect(0, 0, W, H);
    g.fillStyle = css;
    g.globalAlpha = 0.9;
    const arrows = this.shot === 'play'; // the close shots circle the robber, where "up the screen" means nothing
    for (const c of this.cops) {
      const d = Math.sqrt((c.x - this.robberX) ** 2 + (c.y - this.robberY) ** 2);
      if (d < nearest) nearest = d;
      if (d < VIEW.pursuitRange) near++;
      if (d > VIEW.arrowRange || !arrows) continue;
      v.set(c.x, 0, -c.y).applyMatrix4(this.camera.matrixWorldInverse);
      const behindCamera = v.z > -0.5;
      let sx: number, sy: number;
      if (behindCamera) { sx = W / 2 + (c.x - this.camera.position.x) * 12; sy = H + 1; }
      else {
        v.applyMatrix4(this.camera.projectionMatrix);
        sx = (v.x + 1) * 0.5 * W; sy = (1 - v.y) * 0.5 * H;
      }
      if (sy >= 0 && sy <= H) continue;
      const ex = clamp(sx, 16, W - 16), up = sy > H, y = up ? H - 8 : 8, tip = up ? -14 : 14;
      g.beginPath(); g.moveTo(ex, y + tip); g.lineTo(ex - 9, y); g.lineTo(ex + 9, y); g.closePath(); g.fill();
    }
    this.copsNear = near;
    this.wash.style.background = css;
    this.wash.style.opacity = String(VIEW.washMaxAlpha * Math.max(0, 1 - nearest / VIEW.washRange));
  }

  private updateParticles(dt: number) {
    const m = new THREE.Matrix4();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.1 && p.vy < 0) { p.y = 0.1; p.vy *= -0.35; p.vx *= 0.6; p.vz *= 0.6; }
      p.vx *= 0.97; p.vz *= 0.97;
    }
    this.particleMesh.count = this.particles.length;
    this.particles.forEach((p, i) => {
      const age = 1 - p.life / p.max, s = p.size * (1 + age * p.grow * 2) * Math.min(1, (p.life / p.max) * 2.2); // shrinks away, as instances can't fade
      m.makeScale(s, s, s).setPosition(p.x, p.y, p.z);
      this.particleMesh.setMatrixAt(i, m);
      this.particleMesh.setColorAt(i, p.colour);
    });
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
  }

  private updateDebris(dt: number) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) { this.scene.remove(d.obj); this.debris.splice(i, 1); continue; }
      d.vy -= 24 * dt;
      d.obj.position.x += d.vx * dt; d.obj.position.y += d.vy * dt; d.obj.position.z += d.vz * dt;
      d.obj.rotation.x += d.spinX * dt; d.obj.rotation.z += d.spinZ * dt;
      if (d.obj.position.y < 0.12 && d.vy < 0) { d.obj.position.y = 0.12; d.vy *= -0.4; d.vx *= 0.6; d.vz *= 0.6; d.spinX *= 0.5; d.spinZ *= 0.5; }
    }
  }

  /** What the recording doesn't hold but a car in 3D needs: wheels turning, the body leaning, and smoke when it is in trouble. */
  private updateCars(dt: number) {
    const spin = new THREE.Quaternion();
    for (const c of this.cars.values()) {
      if (c.fade < 1) c.fade = Math.min(1, c.fade + dt * 6);
      c.root.scale.setScalar(0.6 + 0.4 * c.fade); // eases in, so a new car never pops
      const x = c.root.position.x, z = c.root.position.z, a = c.root.rotation.y;
      if (dt > 0 && !Number.isNaN(c.lastX)) {
        const speed = Math.min(70, Math.hypot(x - c.lastX, z - c.lastZ) / dt);
        const yaw = wrap(a - c.lastA) / dt, accel = (speed - c.speed) / dt;
        const ease = Math.min(1, dt * 7);
        c.roll += (clamp(yaw * speed * 0.0022, -0.075, 0.075) - c.roll) * ease;
        c.pitch += (clamp(-accel * 0.0028, -0.06, 0.06) - c.pitch) * ease;
        c.speed += (speed - c.speed) * Math.min(1, dt * 20);
        c.spin += (c.speed * dt) / 0.3;
      }
      c.lastX = x; c.lastZ = z; c.lastA = a;
      c.tilt.rotation.set(c.pitch, 0, c.roll);
      spin.setFromAxisAngle(X_AXIS, c.spin);
      for (const w of c.wheels) w.node.quaternion.copy(spin).multiply(w.rest);
      if (c.mode === 2 && (c.smoke -= dt) <= 0) { // a thin thread of smoke from wrecks; spin-outs make none
        c.smoke = 0.45;
        this.smoke(x, 1.2, z, 1, 0x303030, 1.2, 0.26);
      }
    }
  }

  private resize() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    this.width = W; this.height = H;
    this.renderer.setSize(W, H);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.arrowCanvas.width = W; this.arrowCanvas.height = H;
  }

  // ------------------------------------------------------------------ the camera
  // It reacts only to what is happening now, never to what the recording is about to do: its moves must not give an ending away.

  private nearestCop() {
    let best: { x: number; y: number } | null = null, bestD = Infinity;
    for (const c of this.cops) {
      const d = Math.hypot(c.x - this.robberX, c.y - this.robberY);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best ? { x: best.x, y: best.y, d: bestD } : null;
  }

  private speedShare() { return clamp(((this.cars.get(0)?.speed ?? 0) - 15) / 30, 0, 1); }

  /** Swoop in on the robber: the run is over. */
  private cut(to: Shot) {
    if (!VIEW.dynamicCamera) return;
    this.blendTime = this.blendLeft = SWOOP;
    this.blendFrom = null;
    if (this.lastPose) {
      const from = { ...this.lastPose };
      for (const k of POSE_ROAD_Y) from[k] -= this.camY;
      this.blendFrom = from;
    }
    this.shot = to; this.shotAge = 0;
  }

  /** Work out how much road to show, and where the robber sits in it, so that whatever matters nearby is in the picture. */
  private frameAction(dt: number) {
    const base = VIEW.metresTall, screenY = this.width < 900 ? VIEW.robberScreenYNarrow : VIEW.robberScreenY;
    const restAhead = base * screenY, restBehind = base * (1 - screenY);
    let ahead = restAhead, behind = restBehind, xLo = this.robberX, xHi = this.robberX;
    if (VIEW.dynamicCamera) {
      const include = (x: number, y: number) => {
        const dy = y - this.robberY;
        const pull = clamp((dy >= 0 ? VIEW.frameAhead - dy : VIEW.frameBehind + dy) / FRAME_FADE, 0, 1); // so nothing jolts the camera by crossing the line
        if (pull === 0) return;
        ahead = Math.max(ahead, restAhead + (Math.min(VIEW.frameAhead, dy + VIEW.frameMargin) - restAhead) * pull);
        behind = Math.max(behind, restBehind + (Math.min(VIEW.frameBehind, -dy + VIEW.frameMargin) - restBehind) * pull);
        xLo = Math.min(xLo, this.robberX + (x - this.robberX) * pull); xHi = Math.max(xHi, this.robberX + (x - this.robberX) * pull);
      };
      for (const c of this.cops) include(c.x, c.y);
      for (const [id, c] of this.cars) if (this.meta[id]?.[2] === 1) include(c.root.position.x, -c.root.position.z);
      if (this.bag) include(this.bag.position.x, -this.bag.position.z);
      const room = base * VIEW.zoomOutMax;
      if (ahead + behind > room) ahead = Math.max(room - behind, base * 0.4); // the chase behind matters more than the road ahead
      const scale = 1 + VIEW.speedZoom * this.speedShare();
      ahead *= scale; behind *= scale;
    }
    const tall = ahead + behind, y = clamp(ahead / tall, 0.35, 0.78);
    const smooth = VIEW.frameSmooth;
    if (this.frameTall === 0) { this.frameTall = tall; this.frameY = y; } // the first frame of a run
    else {
      [this.frameTall, this.tallV] = smoothDamp(this.frameTall, tall, this.tallV, smooth, dt);
      [this.frameY, this.frameYV] = smoothDamp(this.frameY, y, this.frameYV, smooth, dt);
    }

    if (!VIEW.dynamicCamera) { this.camX += (this.robberX * 0.4 - this.camX) * Math.min(1, dt * 5); return; }
    const mid = (xLo + xHi) / 2;
    [this.camX, this.camXV] = smoothDamp(this.camX, clamp(mid * 0.6, -ROAD_HALF * 0.6, ROAD_HALF * 0.6), this.camXV, smooth * 0.6, dt);
    [this.tiltShare, this.tiltV] = smoothDamp(this.tiltShare, this.speedShare(), this.tiltV, smooth, dt);
    if (this.focusX > 3) this.leanSide = -1; else if (this.focusX < -3) this.leanSide = 1; // from the middle of the road, looking out at the robber's side of it
    const rad = THREE.MathUtils.degToRad, limit = rad(VIEW.cameraLeanMax);
    const want = clamp(rad(VIEW.cameraLean) * this.leanSide - this.lateral * rad(VIEW.cameraSwing), -limit, limit);
    [this.yaw, this.yawV] = smoothDamp(this.yaw, want, this.yawV, smooth * 0.8, dt);
  }

  private poseOf(shot: Shot): Pose {
    const fx = this.focusX, fy = this.camY, age = this.shotAge;
    const fit = clamp(1.3 / this.camera.aspect, 1, 1.7); // a phone's narrow frame needs the camera further back
    const edge = ROAD_HALF + BARRIER_W + SIDEWALK;
    // high enough, for its field of view, to be looking down at the road even at the top of the frame: there is no horizon to see
    const orbit = (angle: number, radius: number, h: number): Pose =>
      ({ x: clamp(fx + Math.cos(angle) * radius, -edge, edge), h, y: fy + Math.sin(angle) * radius, lookX: fx, lookH: 0.9, lookY: fy, fov: 42, roll: 0 });
    if (shot === 'arrest') return orbit(this.orbit + age * 0.3, 10 * fit, 6.5 * fit); // a slow circle while everyone brakes to a stop
    if (shot === 'wreck') { // starts in the wreckage and pulls away from it
      const out = clamp(age / 2, 0, 1);
      return orbit(this.orbit + age * 0.55, (9 + 7 * out) * fit, (6 + 5 * out) * fit);
    }
    return this.posePlay();
  }

  /** The view during play: `frameTall` of road fills the screen height at the robber, and `frameY` is where on screen it sits. */
  private posePlay(): Pose {
    const W = this.width, H = this.height, share = VIEW.dynamicCamera ? this.tiltShare : 0;
    const pitch = THREE.MathUtils.degToRad(VIEW.cameraPitch - VIEW.speedTilt * share), halfFov = THREE.MathUtils.degToRad(VIEW.cameraFov / 2), tan = Math.tan(halfFov);
    const dist = Math.max((this.frameTall * Math.sin(pitch)) / (2 * tan), VIEW.minMetresWide / (2 * tan * (W / H)));
    const targetY = this.camY + (this.frameY - 0.5) * ((2 * dist * tan) / Math.sin(pitch));
    const height = dist * Math.sin(pitch), back = dist * Math.cos(pitch);
    return {
      x: this.camX + Math.sin(this.yaw) * back, h: height, y: targetY - Math.cos(this.yaw) * back, lookX: this.camX, lookH: 0, lookY: targetY, fov: VIEW.cameraFov,
      roll: VIEW.dynamicCamera ? clamp(-this.lateral * 0.008, -VIEW.cameraRoll, VIEW.cameraRoll) : 0,
    };
  }

  /** The stretch of road the picture reaches, from where its four corners actually land on the ground. */
  private roadInView(): [number, number] {
    const cam = this.camera.position, ray = this.viewRay;
    let lo = -cam.z, hi = -cam.z;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      ray.set(sx, sy, 0.5).unproject(this.camera).sub(cam).normalize();
      const y = -(cam.z + ray.z * (ray.y < -0.02 ? Math.min(cam.y / -ray.y, ROAD_VIEW_LIMIT) : ROAD_VIEW_LIMIT));
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    return [lo - 10, hi + 1]; // the extra behind is for tall scenery near the bottom of the frame
  }

  private currentPose(dt: number): Pose {
    const pose = this.poseOf(this.shot);
    if (this.blendLeft > 0 && this.blendFrom) {
      this.blendLeft = Math.max(0, this.blendLeft - dt);
      const t = 1 - this.blendLeft / this.blendTime, k = t * t * (3 - 2 * t);
      for (const f of POSE_LERP) {
        const from = this.blendFrom[f] + (POSE_ROAD_Y.includes(f) ? this.camY : 0);
        pose[f] = from + (pose[f] - from) * k;
      }
    }
    this.lastPose = pose;
    return pose;
  }

  private aim(p: Pose) {
    const reach = Math.hypot(p.x - p.lookX, p.h - p.lookH, p.y - p.lookY);
    const amp = this.shake * clamp(reach / 40, 0.2, 1); // close up, the same shake would be violent
    const jx = (Math.random() - 0.5) * amp, jz = (Math.random() - 0.5) * amp;
    this.camera.position.set(p.x + jx, p.h, -p.y + jz);
    this.camera.lookAt(p.lookX + jx, p.lookH, -p.lookY + jz);
    if (p.roll) this.camera.rotateZ(p.roll);
    if (Math.abs(this.camera.fov - p.fov) > 0.01) { this.camera.fov = p.fov; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld();
  }

  /** Per-frame upkeep and camera. */
  update(dt: number) {
    this.clock += dt;
    this.updateCars(dt);
    this.updateParticles(dt);
    this.updateDebris(dt);
    if (this.bag) {
      this.bagAge += dt;
      this.bag.scale.setScalar(Math.min(1, this.bagAge / 0.35) || 0.001);
      this.cash.rotation.y += dt * 3; this.cash.scale.setScalar(1 + Math.sin(this.clock * 6) * VIEW.bagPulse);
    }

    this.shake *= Math.max(0, 1 - dt * 5);
    this.camY += (this.robberY - this.camY) * Math.min(1, dt * 14);
    const lastFocusX = this.focusX;
    this.focusX += (this.robberX - this.focusX) * Math.min(1, dt * 10);
    if (this.camY === 0 || Math.abs(this.robberY - this.camY) > 60) { this.camY = this.robberY; this.focusX = this.robberX; this.lateral = 0; }
    else if (dt > 0) this.lateral += ((this.focusX - lastFocusX) / dt - this.lateral) * Math.min(1, dt * 6);

    this.shotAge += dt;
    this.frameAction(dt);
    const pose = this.currentPose(dt);
    this.aim(pose);
    this.sun.target.position.set(this.focusX, 0, -(this.camY + 10));
    this.sun.position.set(this.focusX - 45, 90, -(this.camY + 10) + 50);

    // only the chunks the camera can reach
    for (const c of this.chunks) c.visible = false;
    const [near, far] = this.roadInView();
    const first = Math.floor(near / CHUNK), last = Math.min(Math.floor(far / CHUNK), first + CHUNK_POOL - 1);
    for (let n = first; n <= last; n++) {
      const c = this.chunks[((n % CHUNK_POOL) + CHUNK_POOL) % CHUNK_POOL];
      c.visible = true; c.position.z = -n * CHUNK;
    }
    this.drawPolice();
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
