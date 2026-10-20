/** Seeded randomness for audio variation. Pure: no DOM, no WebAudio, no Math.random.
 * Audio is presentation, so it may vary freely, but seeding every variation (shot id, match seed) keeps captures
 * reproducible and makes "deterministic but varied" testable. */

/** A 32-bit avalanche hash of up to three integers (non-integers are truncated). */
export function hash32(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (c | 0) ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Maps a 32-bit hash to [0, 1). */
export function unit01(h: number): number { return (h >>> 0) / 4294967296; }

/** A small, fast generator (mulberry32): returns a function yielding values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stateful stream with the helpers the recipes use. */
export class Rng {
  private readonly next01: () => number;
  constructor(seed: number) { this.next01 = mulberry32(seed); }
  /** [0, 1) */
  next(): number { return this.next01(); }
  /** [a, b) */
  range(a: number, b: number): number { return a + (b - a) * this.next01(); }
  /** [-1, 1) */
  signed(): number { return this.next01() * 2 - 1; }
  /** 1 ± amount */
  jitter(amount: number): number { return 1 + (this.next01() * 2 - 1) * amount; }
  /** Integer in [0, n) */
  int(n: number): number { return Math.floor(this.next01() * n); }
}
