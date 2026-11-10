// Every lever's default. Units: metres, seconds, kilograms, newtons, radians.
//
// The easy way to change them: `npm run dev`, then the Levers button on the page. Your changes are saved in
// src/levers.json, on top of these defaults. Delete that file's contents (leave {}) to go back to them.
//
// Two kinds of lever:
//   `play` and `view`   just refresh the browser.
//   everything else     changes the simulation, so the runs must be re-recorded. The page does this for you;
//                       from a terminal it is  npm run tune  (16 runs)  or  npm run export  (60 runs).
//   To see the numbers:  npm run generate -- --count 200  then  npm run report,  or the Analysis page (/analysis.html)
//   To try a lever at several values:  npm run sweep -- --lever cop.ramChance --values 0.2,0.35,0.5
//   Either takes  --set path=value  to change levers for that dataset only, without touching levers.json.
//   To walk a run's checkpoints and watch both branches of each:  the Branch explorer (/explain.html), on the exported runs
//
// Anything in `heat` is a [first leg, last leg] pair, interpolated across the legs of a run.
import saved from './levers.json';

export const DEFAULTS = {
  sim: { dt: 1 / 60, frameTicks: 3, velocityIterations: 8, positionIterations: 3 },

  // ================================================================== no re-record needed
  play: {
    startCredit: 100000,    // cents
    chips: [10, 25, 50, 100],
    topUp: 50000,
    aftermathSeconds: 2.2,  // how long a crash plays before the result appears
    cashBannerSeconds: 1.8, // how long "You got out" stays up while the run carries on
    autoPause: 1.5,         // autoplay: seconds the result stays up before the next run starts
  },

  view: {
    dynamicCamera: true,    // the camera leans, swings and reframes with the action, and closes in on a bust or wreck. Off: a fixed view straight up the road
    cameraLean: 14,         // degrees the camera sits off to one side of the road's line. It changes sides as the robber crosses the road
    cameraLeanMax: 26,      // degrees it can swing to, at most, once the robber's movement is added
    cameraSwing: 1.2,       // degrees of swing per m/s the robber is moving sideways. 0 = doesn't react
    cameraRoll: 0.05,       // radians the view can bank into the robber's swerves, at most. 0 = stays level
    speedTilt: 6,           // degrees flatter the camera gets at full speed
    speedZoom: 0.12,        // how much further out it pulls at full speed, as a share of metresTall
    zoomOutMax: 1.5,        // how far it may pull out to fit things in, as a multiple of metresTall
    frameBehind: 22,        // m behind the robber it will reach to keep a cop in view. Keep below cop.spawnBack, so new cops arrive from out of view
    frameAhead: 50,         // m ahead of the robber it will reach for a bag or roadblock
    frameMargin: 7,         // m of road kept beyond whatever it is framing
    frameSmooth: 1.8,       // s the camera takes to settle after what it is framing changes. Higher: slower, gentler zooms
    cameraPitch: 50,        // degrees the camera looks down from level. Lower: more tilted, sees further ahead. 90 = straight down
    cameraFov: 36,          // degrees of vertical field of view. Lower: flatter, more like a long lens
    particleAmount: 1,      // multiplies every spark, flame and puff of smoke. 0 = none
    shakePerDv: 0.025,      // camera shake per m/s of velocity change in an on-screen impact. Impacts out of view never shake. 0 = none
    shakeMax: 0.7,          // the most that impacts can pile up to
    shakeWreck: 1.1,        // the robber wrecking
    shakeBust: 0.25,        // the robber being boxed in and arrested
    metresTall: 90,         // how much road fits top to bottom, before any zooming out. Lower: closer camera
    minMetresWide: 25,      // always at least this much width, for phones
    robberScreenY: 0.68,    // where the robber sits, as a share of screen height. Lower: see more of the chase behind
    robberScreenYNarrow: 0.5, // the same on phones, where the controls take the bottom of the screen
    copFlashHz: 7,          // how fast police lights alternate
    copGlowRadius: 7,       // m: size of the red/blue glow around each police car
    copGlowAlpha: 0.32,
    pursuitRange: 45,       // m: cops within this count as "on you" in the HUD
    washRange: 28,          // m: the screen starts flashing red/blue when a cop is this close
    washMaxAlpha: 0.14,     // how strong that flash gets at point blank. 0 = off
    arrowRange: 150,        // m: off-screen cops within this get an arrow at the screen edge
    bagPulse: 0.1,          // how much a bag throbs, as a share of its size
  },

  // ================================================================== everything below needs a re-record

  // ------------------------------------------------------------------ the betting round
  game: {
    legRisk: [0.25, 0.25],// crash chance of a leg, [first leg, last leg]. Exact: the server draws it when the bet locks. Below 1
    maxLegs: 15,          // a run that survives this many legs is a clean getaway, paid automatically
    rtp: 0.96,            // share of stakes returned on average, under every cash-out strategy
    // How a run is built: one escape through every leg (the spine), plus one crash branch from every checkpoint.
    legTries: 150,        // candidates tried from one checkpoint to find a crash, or an escape, before giving up on it
    escapeRetries: 3,     // escapes tried from a checkpoint whose next checkpoint turned out to be a dead end, before backing up a leg
    runBudget: 6000,      // leg simulations one run may spend, backtracking included. Past it the seed is dropped
    tiltAfter: 30,        // candidates tried before the sim is nudged towards the outcome being looked for
    tiltRamp: 60,         // further candidates over which that nudge reaches tiltMax
    tiltMax: 1,           // strongest nudge allowed (0..1). Lower: fewer contrived crashes and escapes, more dropped seeds
    tiltHeat: 0.5,        // how much heat a full nudge adds or removes. A full nudge also doubles or removes ramming and misjudgement
    // What a branch must pass to be used
    rejectSoloCrashes: true, // discard crashes with no other car involved, which look like the robber's stupidity
    rejectTouchingSeam: true,// discard escapes that reach the bag in contact with another car, which make a bad seam into the next leg
    seamCopClear: 0,      // m: an escape ending with a chasing cop this close to the robber is only a fallback, since the next leg rarely survives it. 0: off
    seamTries: 6,         // further candidates spent looking for a clean escape before settling for such a fallback
  },

  // ------------------------------------------------------------------ the road (north is +y)
  road: {
    lanes: 6,
    oncomingLanes: 3,     // how many of those, counted from the left, carry traffic towards the robber. 0 = one-way road
    laneWidth: 3.4, wallFriction: 0.2, wallRestitution: 0.25, wallLength: 1500,
  },

  // ------------------------------------------------------------------ a leg
  leg: {
    bagDistanceMin: 90,   // m from the checkpoint before a bag can appear. Keep above what the camera shows ahead
    bagDistanceMax: 150,
    firstBagDistanceMin: 0, // m: the first leg's bag distance instead, so the opening stretch can be longer than the rest. Max 0: same as the others
    firstBagDistanceMax: 0,
    calmTtc: 1.0,         // s: a bag is placed at the first moment past that distance when nothing would hit the robber within this
    calmMissDistance: 2.6,// m: passing closer than this counts as "would hit"
    calmLaneTolerance: 0.9, // m: the robber must also be this close to a lane centre, so bags sit neatly in lanes
    calmMaxWait: 3,       // s: after this long the bag is placed anyway
    crashBagAhead: 30,    // m: on a crash, the bag the robber never reached is at least this far past the wreck
    timeLimit: 30,        // s: a leg that runs this long counts as a stall
  },

  // ------------------------------------------------------------------ vehicles
  kinds: {
    robber: { mass: 100, thrust: 2300, topSpeed: 40, grip: 34, turnRate: 3.2, brakes: 3400, length: 2.6, width: 1.3, hp: 100 },
    car:    { mass: 110, thrust: 1500, topSpeed: 28, grip: 26, turnRate: 2.4, brakes: 2200, length: 2.6, width: 1.4, hp: 60 },
    truck:  { mass: 420, thrust: 4500, topSpeed: 22, grip: 20, turnRate: 1.4, brakes: 6500, length: 7.0, width: 2.2, hp: 400 },
    cop:    { mass: 120, thrust: 3000, topSpeed: 46, grip: 34, turnRate: 3.0, brakes: 3800, length: 2.8, width: 1.4, hp: 110 },
  },

  body: {
    restitution: 0.35, friction: 0.25, angularDamping: 1.2, steerResponse: 14, gripRate: 12,
    turnAtRest: 0.8, spinGripFactor: 0.25,
    wreckLinearDamping: 1.6, wreckAngularDamping: 3.0,
  },

  damage: {
    threshold: 3.5,       // m/s of velocity change before a hit hurts
    perDv: 9,             // hp per m/s above threshold. Raise: robber dies in fewer hits
    wallFactor: 0.6,
    spinDv: 5.7,          // velocity change that spins a car out
    spinTime: 0.9,
    spinImmunity: 1.5,
    regenRate: 2,         // hp/s the robber recovers between hits. 0 = damage is permanent
    regenDelay: 2,
  },

  // ------------------------------------------------------------------ escalation over the run: [first leg, last leg]
  heat: {
    cops: [3, 8],              // pursuing cops kept alive. Wrecked ones are replaced
    interceptRate: [0.1, 0.35],// per second: chance a police car comes head-on at the robber from up the road
    blockChance: [0.3, 0.65],  // chance a leg contains a police roadblock
    trafficGapMin: [24, 14],   // m between cars in a lane, low end
    trafficGapMax: [46, 30],   // high end
    crossRate: [0.12, 0.25],   // side-street cars per second entering ahead of the robber
    stoppedChance: [0.25, 0.45],// chance a leg contains a stopped truck
    misjudge: [0.3, 0.45],     // how wrong the robber can be about a gap, as a fraction of the time to reach it
    swerveRate: [0.06, 0.1],   // per second, per nearby car: chance of a sudden lane change
    panicRate: [0.03, 0.06],   // per second, per nearby car: chance of slamming on the brakes
  },

  // ------------------------------------------------------------------ police
  cop: {
    // how pursuing cops split between jobs. Only the proportions matter
    roleMix: {
      tail: 0.4,          // comes up from behind and rams the robber's rear quarter, queueing behind it if both sides are taken
      flank: 0.35,        // the same, but waits in the lane beside the robber rather than behind it
      block: 0.25,        // overtakes, cuts in front and brakes, then drops back and hunts like a flanker once the robber has caught it
    },
    catchUp: 12,          // m/s faster than the robber while closing in
    approachGain: 1.2,    // m/s of closing speed per metre still to cover, so cops arrive instead of overshooting. Lower: gentler arrival
    spawnBack: 24,        // m behind the robber new cops appear. Keep just beyond what the camera shows behind
    spawnBackJitter: 6,
    startCops: 0,         // police cars already on the robber's tail as a run starts. Tried 1 (14 m back): it stays on the bumper, so later checkpoints turn hopeless and generation costs ~1.6x. 0: the run opens quiet
    startGap: 14,         // m behind the robber the first of them starts
    startAhead: 0,        // police cars coming head-on as a run starts, from up the road: a first leg to dodge through
    startAheadGap: 95,    // m ahead the first of them starts. Keep beyond what the camera shows ahead
    spawnWindow: 1,       // s: replacements arrive at a random moment within this
    followGap: 6,         // m: where a tail cop sits behind the robber
    flankOffset: -2.5,    // m ahead of the robber a flanking cop aims to sit. 0 = door to door, negative = off its rear quarter
    blockLead: 16,        // m ahead of the robber a blocking cop aims to sit
    blockBrake: 5,        // m/s slower than the robber a blocking cop drives once in front. Raise: nastier brake-checks
    lanePull: 0.6,        // how hard cops favour their target lane over a clear one
    stalkRange: 34,       // m behind the robber a tail or flank cop starts lining up on its rear quarter
    stalkWidth: 11,       // m: and how far off to the side it can be
    stalkGap: 1.8,        // m of daylight kept between cop and robber while lining up. This is its run-up, so it needs room to get sideways speed on
    stalkHold: 0,         // m short of the rear quarter it holds, waiting for its moment. 0: nose level with it
    stalkLook: 0.8,       // s ahead it checks its path is clear of traffic before lining up
    arrestSpeed: 8,       // m/s: a robber slower than this gets boxed in rather than rammed
    arrestGap: 0.25,      // m of daylight cops close to around a boxed-in robber
    ramRange: 1.2,        // m: how far short of the rear quarter a lined-up cop's nose can be when it goes in
    strikeAlign: 2.2,     // m: how close to its lined-up position it must be to go in
    strikeOverlap: 0.5,   // m the cop aims to overlap the robber sideways. Raise: a firmer shove
    strikeLateral: 10,    // m/s: the sideways speed it hits with. Raise: harder hits, more spin-outs
    strikeBite: 10,       // how much a ramming cop's rear-quarter hit counts for in damage and spin-outs. Raise: deadlier strikes
    strikeMaxDv: 17,      // m/s: the most that multiplier can make a hit count for, so a head-on pounce isn't an instant kill
    pounceSpeed: 12,      // m/s: a robber slower than this, or spun out, gets every cop in reach coming straight at it. Raise: pounces more often
    pounceRange: 40,      // m behind the robber a cop will pounce from
    pounceClose: 16,      // m/s faster than the robber a pouncing cop drives on the way in
    pounceHit: 9,         // m/s faster than the robber it is still going when it arrives. Raise: harder hits on a helpless robber
    pounceSlope: 0.7,     // how sharply it may turn in, sideways per metre forwards
    pounceTime: 1.4,      // s a pounce lasts if it doesn't land
    pounceCooldown: 1,    // s before a cop that has pounced can do so again. Lower: relentless
    strikeClose: 7,       // m/s faster than the robber it drives while going in
    strikeSlope: 0.32,    // how sharply it may cut in, sideways per metre forwards
    strikeOverrun: 1.5,   // m its nose may pass the rear quarter before it gives up on it
    strikeLook: 0.55,     // s ahead it checks its path is clear while going in
    ramChance: 0.25,      // chance per decision (about 7 a second) of ramming once in range and off cooldown
    ramTime: 1.1,
    ramCooldown: 2.0,     // s between one cop's rams. Lower: relentless
    ramThrust: 0.6,       // extra thrust while ramming, as a share of normal
    ramLead: 0.25,        // s: how far ahead of the robber it aims
    intercept: {
      speed: 30,          // m/s of a head-on police car
      aheadMin: 120,      // m ahead it appears
      aheadMax: 150,
      commitDistance: 70, // m: it tracks the robber's lane until this close, then holds its line. Lower: harder to dodge
    },
    blockCarsMin: 2,      // police cars in a roadblock
    blockCarsMax: 4,
    blockJoinsChase: true,// roadblock cars join the pursuit once the robber is past
    blockJoinDistance: -50, // m the robber must be past the roadblock before they set off. Negative: they set off while it is still this far short
    wallMargin: 0.7,      // m cops keep from the wall. Applies to everything they do
    wallGrip: 0.35,       // share of grip they count on to straighten up before a wall. Lower: more careful
    recoverAngle: 0.75,   // rad off the road's line at which a cop stops and turns before driving on
    fullThrottleAngle: 0.25, // rad off the road's line above which power is progressively cut
    laneSlope: 0.26,      // how sharply cops change position, sideways per metre forwards
    laneRate: 9,          // m/s: fastest sideways speed outside of a strike
    laneGain: 2.2,        // how hard cops correct towards where they want to be
    laneStick: 0.35,      // cost of changing a lane decision. Raise: less dithering between lanes
    lateralCorrect: 0.5,  // extra steering to match the sideways speed it wants
    alongsideCost: 4,     // cost of moving into a lane with a car alongside
    oncomingHorizon: 1.5, // how much further ahead cops look for oncoming cars, as a multiple of horizon
    oncomingWeight: 3,    // how much more cops fear an oncoming car than a same-way one
    aheadEase: 10,        // m/s: the most a cop ahead of the robber slows down to let it catch up. Lower: cops take longer to drop back
    aheadEaseMin: 6,      // m/s: the least it slows down, however little it has overshot. Raise: cops drop back to the rear quarter more sharply
    decideTicks: 8, lookBase: 6, lookSpeed: 0.35, steerGain: 3.2, horizon: 1.8,
  },
  bust: {
    speed: 5,             // m/s: slower than this with a cop within range counts towards an arrest
    range: 11,            // m: how close that cop must be
    time: 1.3,            // s of being stopped like that before the arrest
    lockTime: 0.8,        // s of contact with police cars, at any speed, before the robber is busted. Lower: busted more easily
    lockDecay: 3,         // how fast that contact drains once the cars part, as a multiple of the rate it builds. Lower: separate brushes add up
    stopDecel: 16,        // m/s^2 the robber and every police car brake at once busted
    holdSeconds: 0.9,     // s everything stays stopped before the result appears
  },

  // ------------------------------------------------------------------ AI
  robber: {
    cruise: 36, decideTicks: 6,
    horizon: 2.6,         // s of road ahead it weighs when picking a lane
    costWeight: 3,        // how strongly a closing car makes a lane unattractive
    adjacentCost: 6,      // cost of moving into a lane with a car alongside
    wrongWayCost: 0.4,    // cost of being on the oncoming side. Lower or negative: drives against traffic more
    switchCost: 0.3, hysteresis: 0.5, laneHold: 0.35,
    copShy: 2.5,          // cost of a lane with a cop alongside
    lookBase: 6, lookSpeed: 0.35, steerGain: 3.2,
    brakeUse: 0.75,       // share of real braking the robber assumes it has. Lower: brakes earlier
    margin: 3,
    // dodging the police
    dodgeRange: 9,        // m behind it a cop is watched from: a ramming one sets off a jink, and the robber decides every alertTicks
    dodgeRisk: 2,         // how much worse a lane may look and still be jinked into. Very negative: never jinks
    alertTicks: 4,        // decision interval with a cop that close. Raise to decideTicks: no quicker reactions
  },
  traffic: {
    speedKerb: 13,        // m/s in the outermost lane of each direction
    speedCentre: 21,      // m/s in the lane next to the centre line
    speedJitter: 2, truckShare: 0.12, decideTicks: 14,
    oncomingGap: 1,       // multiplies the gaps between oncoming cars. Raise: thinner oncoming traffic
    margin: 7, nearRange: 110,
    blindChance: 0.5,     // share of lane changes made without checking the mirrors
    panicTime: 1.1, crossSpeed: 11, lookBase: 8, lookSpeed: 0.4, steerGain: 2.5,
    spawnAhead: 210, despawnBehind: 130, firstGap: 34,
  },
  stall: { speed: 3, time: 3.5 },             // stopped this long with no cop around: counts as a stall
  events: {
    obstacleAheadMin: 75, // m: roadblocks and stopped trucks appear at least this far ahead, so they never pop into view
    obstacleBeforeBag: 8, // m: and at least this far short of the bag
    crossAheadMin: 75,    // m ahead that side-street cars pull out
    crossAheadMax: 115,
    crossLook: 2.6,       // s: a side-street car only pulls out if no traffic will cross its path within this long, so it isn't wrecked off screen. 0 = never looks
  },
};

export type Config = typeof DEFAULTS;
export type KindName = keyof Config['kinds'];

/** A copy of `base` with levers applied, keyed by path ("cop.ramChance"). Unknown paths and wrong types are ignored. */
export function applyLevers(base: Config, levers: Record<string, unknown>): Config {
  const out = structuredClone(base);
  for (const [path, value] of Object.entries(levers)) {
    const keys = path.split('.'), last = keys.pop()!;
    let node: any = out;
    for (const k of keys) node = node?.[k];
    if (!node || typeof node !== 'object' || !(last in node)) continue;
    const cur = node[last];
    const ok = Array.isArray(cur)
      ? Array.isArray(value) && value.length === cur.length && value.every((v) => Number.isFinite(v))
      : typeof cur === typeof value && (typeof value !== 'number' || Number.isFinite(value));
    if (ok) node[last] = value;
  }
  return out;
}

export const CONFIG = applyLevers(DEFAULTS, saved as Record<string, unknown>);

/** The crash chance of a leg, straight from game.legRisk: the server draws against this exact number. */
export function legRisk(g: Pick<Config['game'], 'legRisk' | 'maxLegs'>, leg: number) {
  const h = g.maxLegs > 1 ? Math.min(1, leg / (g.maxLegs - 1)) : 0;
  return Math.max(0, Math.min(0.99, g.legRisk[0] + (g.legRisk[1] - g.legRisk[0]) * h));
}

/** What each leg pays: cash out before it at `before`, survive it for `after`. Fair: before = (1 - risk) * after. */
export function legPrices(g: Pick<Config['game'], 'legRisk' | 'maxLegs' | 'rtp'>) {
  const out: { risk: number; before: number; after: number }[] = [];
  let m = g.rtp;
  for (let i = 0; i < g.maxLegs; i++) { const risk = legRisk(g, i); out.push({ risk, before: m, after: m / (1 - risk) }); m /= 1 - risk; }
  return out;
}

/** Changes whenever a lever that affects the simulation does, so recordings can tell they are out of date. */
export function simKey(cfg: Config) {
  const { play: _p, view: _v, ...sim } = cfg;
  const text = JSON.stringify(sim);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
