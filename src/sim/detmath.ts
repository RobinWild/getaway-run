// Deterministic math: the same bits in every JS engine.
//
// The live pages replay fights in the viewer's browser that were played in Node at build time, and the
// results have to match exactly. JS only guarantees +, -, *, /, sqrt, floor/round/abs/min/max and % to be
// exact (IEEE 754, no fused multiply-add); Math.sin, cos, atan2, hypot etc. are "implementation-approximated",
// and do differ in the last bit between engines and versions (Node 22 vs current Chrome, for one). One bit is
// enough: fights are chaotic, so it grows into a different winner.
//
// Importing this module replaces Math.sin, cos, atan2 and hypot with pure-arithmetic versions (fdlibm's
// algorithms, accurate to about 1 ulp). It must run before planck loads, because planck copies them into
// locals when its module is evaluated: every module that imports planck imports this first.
//
// The sim must not use other transcendental functions (pow / `**` with non-power-of-two results, exp, log,
// tan, asin, acos, ...) without adding a deterministic version here.

const PIO2_1 = 1.57079632673412561417e+00; // first 33 bits of pi/2 (n * PIO2_1 is exact for |n| < 2^20)
const PIO2_2 = 6.07710050630396597660e-11; // next 33 bits
const PIO2_2T = 2.02226624879595063154e-21; // pi/2 - (PIO2_1 + PIO2_2)
const INV_PIO2 = 6.36619772367581382433e-01;
const PIO4 = 7.85398163397448278999e-01;
const TWO_PI = 6.28318530717958623200e+00;

// sin / cos kernels on [-pi/4, pi/4] (fdlibm __kernel_sin / musl __cos, no tail)
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

function kSin(x: number) {
  const z = x * x, v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}

function kCos(x: number) {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z, w = 1 - hz;
  return w + (((1 - w) - hz) + z * r);
}

/** x reduced to [-pi/4, pi/4] and its quadrant (0..3). */
function reduce(x: number): [number, number] {
  if (Math.abs(x) > 1e6) x = x % TWO_PI; // % is exact; keeps n * PIO2_1 exact below
  const n = Math.round(x * INV_PIO2);
  const y = ((x - n * PIO2_1) - n * PIO2_2) - n * PIO2_2T;
  return [y, n & 3];
}

function sin(x: number) {
  if (!Number.isFinite(x)) return NaN;
  if (x === 0) return x; // keeps -0
  if (Math.abs(x) <= PIO4) return kSin(x);
  const [y, q] = reduce(x);
  return q === 0 ? kSin(y) : q === 1 ? kCos(y) : q === 2 ? -kSin(y) : -kCos(y);
}

function cos(x: number) {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= PIO4) return kCos(x);
  const [y, q] = reduce(x);
  return q === 0 ? kCos(y) : q === 1 ? -kSin(y) : q === 2 ? -kCos(y) : kSin(y);
}

// atan (fdlibm s_atan.c)
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02,
  -5.83357013379057348645e-02, 4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];

function atan(x: number) {
  if (x !== x) return x;
  const neg = x < 0;
  let a = Math.abs(x);
  if (a >= 7.378697629483821e19) return neg ? -ATANHI[3] - ATANLO[3] : ATANHI[3] + ATANLO[3]; // 2^66
  let id: number;
  if (a < 0.4375) {
    if (a < 7.450580596923828e-9) return x; // 2^-27
    id = -1;
  } else if (a < 1.1875) {
    if (a < 0.6875) { id = 0; a = (2 * a - 1) / (2 + a); } else { id = 1; a = (a - 1) / (a + 1); }
  } else if (a < 2.4375) { id = 2; a = (a - 1.5) / (1 + 1.5 * a); } else { id = 3; a = -1 / a; }
  const z = a * a, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - ((a * (s1 + s2) - ATANLO[id]) - a);
  return neg ? -r : r;
}

// atan2 (fdlibm e_atan2.c)
const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16, PIO2 = 1.5707963267948965580e+00;
const negative = (v: number) => v < 0 || Object.is(v, -0);

function atan2(y: number, x: number) {
  if (x !== x || y !== y) return NaN;
  if (x === 1) return atan(y);
  const m = (negative(y) ? 1 : 0) | (negative(x) ? 2 : 0);
  if (y === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI;
  if (x === 0) return m & 1 ? -PIO2 : PIO2;
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) return [PI / 4, -PI / 4, 3 * PI / 4, -3 * PI / 4][m];
    return [0, -0, PI, -PI][m];
  }
  if (!Number.isFinite(y)) return m & 1 ? -PIO2 : PIO2;
  const ratio = Math.abs(y / x);
  const z = ratio > 1.152921504606847e18 ? PIO2 + 0.5 * PI_LO // 2^60
    : x < 0 && ratio < 8.673617379884035e-19 ? 0 // 2^-60
    : atan(ratio);
  return m === 0 ? z : m === 1 ? -z : m === 2 ? PI - (z - PI_LO) : (z - PI_LO) - PI;
}

function hypot(...xs: number[]) {
  let s = 0, nan = false;
  for (const v of xs) {
    const a = Math.abs(+v);
    if (a === Infinity) return Infinity;
    if (a !== a) nan = true;
    s += a * a;
  }
  return nan ? NaN : Math.sqrt(s);
}

const M = Math as { -readonly [K in keyof Math]: Math[K] };
M.sin = sin;
M.cos = cos;
M.atan2 = atan2;
M.hypot = hypot;

export {};
