// The game loop in the browser: stake, ride without stopping, settle. Money is whole cents; only the screen uses dollars.
import { CONFIG } from '../config';
import { LocalServer, type LegPlayback, type Offer, type Track } from '../serve/localServer';
import { Scene, VIEW } from './render3d';
import { mountLeverPanel } from './levers';

const SETTINGS = CONFIG.play;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const mult = (m: number) => `${m.toFixed(2)}x`;

type Phase = 'loading' | 'bet' | 'wait' | 'leg' | 'aftermath' | 'over'; // wait: the leg is locked, its branch not yet in hand

const server = new LocalServer();
const scene = new Scene();

let phase: Phase = 'loading';
let credit = SETTINGS.startCredit;
let stake = 2500;
let offer: Offer | null = null;
let leg: LegPlayback | null = null;
let legTime = 0;
let queued = false;              // the player has asked to cash out at the next bag
let paidAt: number | null = null; // multiplier they cashed out at, while the run carries on without them
let aftermathLeft = 0;
let bannerLeft = 0;              // >0: the banner is a passing message, and hides itself
let exploded = false;
let auto = false;                // autoplay: bets, rides without cashing out, and starts the next run by itself
let autoWait = SETTINGS.autoPause;
let round = 0;                   // bumped by every new run, so a reveal for an abandoned one is ignored

function toggleAuto() {
  auto = !auto;
  $('auto').innerHTML = `AUTO<br>${auto ? 'ON' : 'OFF'}`;
  $('auto').classList.toggle('on', auto);
}

// Debug menu (live build too): ride the escape track to watch a whole run, and arm a crash for the next leg whenever you like
const TRACKS: Track[] = ['random', 'escape'];
const TRACK_LABEL: Record<Track, string> = { random: 'Track: random (server draw)', escape: 'Track: escape every leg' };
function setTrack(t: Track) {
  server.track = t;
  $('track').textContent = TRACK_LABEL[t];
  $('track').classList.toggle('forced', t !== 'random');
  markDebug();
  try { localStorage.setItem('debugTrack', t); } catch { /* storage blocked: just don't remember it */ }
}
function setCrashArmed(on: boolean) {
  server.crashNext = on;
  $('crashNext').textContent = on ? 'Crash armed: next leg crashes (tap to cancel)' : 'Crash next leg';
  $('crashNext').classList.toggle('forced', on);
  markDebug();
}
/** The Debug button turns amber while anything is forcing the result, so a forced run is never mistaken for a fair one. */
function markDebug() {
  const t = document.getElementById('track'), c = document.getElementById('crashNext');
  $('debugBtn').classList.toggle('armed', !!t?.classList.contains('forced') || !!c?.classList.contains('forced'));
}
function mountDebugButtons() {
  const track = document.createElement('button'), crash = document.createElement('button');
  track.id = 'track'; crash.id = 'crashNext';
  const menu = $('debugMenu');
  menu.append(track, crash);
  $('debugBtn').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); $('debugBtn').blur(); };
  document.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('#debugMenu, #debugBtn')) menu.classList.remove('open'); });
  let saved: string | null = null;
  try { saved = localStorage.getItem('debugTrack'); } catch { /* ignore */ }
  setTrack(TRACKS.includes(saved as Track) ? saved as Track : 'random');
  setCrashArmed(false);
  track.onclick = () => { setTrack(TRACKS[(TRACKS.indexOf(server.track) + 1) % TRACKS.length]); track.blur(); };
  crash.onclick = () => { setCrashArmed(!server.crashNext); crash.blur(); };
}

function runAutoplay(dt: number) {
  if (!auto) return;
  if (phase === 'bet') {
    if (stake > credit) { credit += SETTINGS.topUp; renderCredit(); }
    startRide();
    autoWait = SETTINGS.autoPause;
  } else if (phase === 'over' && (autoWait -= dt) <= 0) {
    autoWait = SETTINGS.autoPause;
    void newRound();
  }
}

function setChips() {
  const host = $('chips');
  host.innerHTML = '';
  for (const c of SETTINGS.chips) {
    const b = document.createElement('button');
    b.textContent = `$${c}`;
    b.className = stake === c * 100 ? 'chip on' : 'chip';
    b.onclick = () => { stake = c * 100; setChips(); };
    host.appendChild(b);
  }
}

function showBetPanel(show: boolean) { $('dock').classList.toggle('betting', show); }

function renderCredit() {
  $('creditVal').textContent = money(credit);
  $('topup').style.display = credit < 1000 && phase === 'bet' ? 'inline-block' : 'none';
}

function setBig(value: number, tone = '') {
  $('mult').textContent = mult(value);
  $('mult').className = tone;
}

function setCash(enabled: boolean, text: string, hot = false) {
  const b = $<HTMLButtonElement>('cash');
  b.disabled = !enabled;
  b.textContent = text;
  b.className = hot ? 'hot' : '';
}

function banner(title: string, sub: string, tone: string, seconds = 0) {
  $('bannerTitle').textContent = title;
  $('bannerSub').textContent = sub;
  $('banner').className = `show ${tone}`;
  bannerLeft = seconds;
}

async function newRound() {
  round++;
  phase = 'loading';
  $('banner').className = '';
  $('next').style.display = 'none';
  bannerLeft = 0;
  scene.reset();
  const start = await server.newRun().catch((e) => { console.error(e); return null; });
  if (!start) {
    phase = 'over'; // so Next run, and Space, can try again
    banner('No run to play', 'A recorded run could not be loaded. Try again, or re-record from the Levers panel.', 'bad');
    $('next').style.display = 'inline-block';
    return;
  }
  scene.addMeta(start.meta);
  scene.showFrame(start.firstFrame);
  offer = start.offer;
  leg = null; queued = false; paidAt = null; exploded = false;
  setBig(1);
  setCash(false, 'Cash out');
  phase = 'bet';
  showBetPanel(true);
  renderCredit();
}

function startRide() {
  if (phase !== 'bet' || stake > credit) return;
  credit -= stake;
  renderCredit();
  showBetPanel(false);
  beginLeg(0);
}

/** Start the next leg, `carry` seconds in, so that time spent past the end of the last one is not lost. */
function beginLeg(carry: number) {
  phase = 'wait';
  const mine = round;
  server.lock().then((l) => { setCrashArmed(server.crashNext); if (mine === round) startLeg(l, carry); }, (e) => {
    if (mine !== round) return;
    console.error(e);
    finish('Connection lost', 'The next leg could not be loaded. Your stake has been returned.', 'warn', 0);
    credit += paidAt === null ? stake : 0;
    renderCredit();
  });
}

function startLeg(l: LegPlayback, carry: number) {
  leg = l;
  scene.beginLeg(leg);
  legTime = carry;
  phase = 'leg';
  queued = false;
  refreshDuringLeg();
}

function refreshDuringLeg() {
  if (paidAt !== null) { setCash(true, 'Skip to next run'); return; }
  if (queued) setCash(true, 'Cashing out at next bag. Tap to cancel', true);
  else setCash(true, 'Cash out at next bag');
}

function settle(m: number) {
  const pay = Math.floor(stake * m + 1e-6);
  credit += pay;
  renderCredit();
  return pay;
}

function onCashPressed() {
  if (paidAt !== null && (phase === 'leg' || phase === 'wait' || phase === 'aftermath')) { void newRound(); return; }
  if (phase === 'leg') { queued = !queued; refreshDuringLeg(); }
}

function endLegReached(carry: number) {
  const done = leg!;
  scene.collectBag();
  scene.endLeg(done);
  const nextOffer = server.nextOffer();
  const value = offer!.multAfter;
  $('mult').animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });

  if (queued && paidAt === null) {
    paidAt = value;
    const pay = settle(value);
    banner('You got out', `${money(pay)} banked at ${mult(value)}. Watch what happens without you.`, 'good', SETTINGS.cashBannerSeconds);
  }
  offer = nextOffer;

  if (!nextOffer) { // survived the last leg
    if (paidAt === null) { const pay = settle(value); finish('CLEAN GETAWAY', `Paid ${money(pay)} at ${mult(value)}`, 'good', value); }
    else finish('The robber got away', `You had cashed out at ${mult(paidAt)}. Riding on would have paid ${mult(value)}.`, 'warn', value);
    return;
  }
  if (paidAt !== null) setBig(value);
  beginLeg(carry);
}

function finish(title: string, sub: string, tone: string, shown: number) {
  phase = 'over';
  setBig(shown, tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : '');
  setCash(false, 'Cash out');
  banner(title, sub, tone);
  $('next').style.display = 'inline-block';
  renderCredit();
}

function onCrash() {
  const done = leg!;
  scene.explode(done.cause === 'busted');
  exploded = true;
  // a bust plays until the recording's cars have all stopped; anything else, for a set time
  aftermathLeft = done.cause === 'busted' ? (done.recording.frames.length - 1 - done.recording.endFrame) * VIEW.frameTime : SETTINGS.aftermathSeconds;
  if (paidAt === null) { setBig(0, 'bad'); setCash(false, 'Cash out'); }
  phase = 'aftermath';
}

function endCrash() {
  const done = leg!;
  const title = done.cause === 'busted' ? 'BUSTED' : 'WRECKED';
  if (paidAt !== null) finish(`${title}, but you got out`, `Banked at ${mult(paidAt)}. You escaped in time.`, 'good', paidAt);
  else finish(title, `Lost ${money(stake)} on leg ${done.leg + 1}`, 'bad', 0);
}

function tick(dt: number) {
  runAutoplay(dt);
  if (phase === 'leg' && leg) {
    legTime += dt;
    const endTime = leg.recording.endFrame * VIEW.frameTime;
    if (legTime >= endTime) {
      scene.play(leg, endTime);
      if (leg.outcome === 'crash') { if (!exploded) onCrash(); }
      else endLegReached(legTime - endTime); // straight into the next leg: nothing stops at a bag
    }
    if (phase === 'leg' && leg) { // still riding, possibly on a leg that has only just begun
      scene.play(leg, legTime);
      if (paidAt === null && offer) {
        const prog = Math.min(1, Math.max(0, (scene.robberY - scene.origin) / leg.bag.y));
        const live = offer.multBefore + (offer.multAfter - offer.multBefore) * (prog * prog);
        setBig(live);
      }
    }
  } else if (phase === 'aftermath' && leg) {
    legTime += dt;
    scene.play(leg, legTime);
    aftermathLeft -= dt;
    if (aftermathLeft <= 0) endCrash();
  }
  if (bannerLeft > 0) { bannerLeft -= dt; if (bannerLeft <= 0 && phase !== 'over') $('banner').className = ''; }
  scene.update(dt);
}

async function main() {
  await scene.init($('stage'));
  setChips();
  mountDebugButtons();
  if (import.meta.env.DEV) { // dev-server tools: they need its endpoints, so the live build leaves them out
    mountLeverPanel();
    const menu = $('debugMenu'), label = document.createElement('small');
    label.textContent = 'Dev tools';
    menu.append(label, $('leverToggle'));
    menu.insertAdjacentHTML('beforeend', '<a href="analysis.html">Analysis</a><a href="explain.html">Branch explorer</a>');
  }
  $('go').onclick = startRide;
  $('cash').onclick = onCashPressed;
  $('next').onclick = () => { void newRound(); };
  $('topup').onclick = () => { credit += SETTINGS.topUp; renderCredit(); };
  $('auto').onclick = () => { toggleAuto(); $('auto').blur(); }; // blur, so Space doesn't press it again
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest?.('#levers')) return; // typing in the lever panel
    if (e.code === 'KeyA') toggleAuto();
    if (e.code === 'KeyT') $('track').click();
    if (e.code === 'KeyC') $('crashNext').click();
    if (e.code === 'Space') { e.preventDefault(); if (phase === 'bet') startRide(); else if (phase === 'over') $('next').click(); else onCashPressed(); }
  });
  let last = performance.now();
  const frame = (now: number) => {
    tick(Math.min(0.05, (now - last) / 1000));
    last = now;
    scene.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await newRound();
}

void main();
