// Seed helpers copied from the reference project (src/tournament/bracket.ts): `mix` and the seeded shuffle.

/** murmur3 fmix32: spreads consecutive numbers into unrelated seeds. */
export function mix(h: number) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function shuffle<T>(xs: T[], rng: () => number) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}
