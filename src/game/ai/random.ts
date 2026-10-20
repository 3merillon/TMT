/** Seeded brain randomness (N4: no Math.random): mulberry32 plus Box–Muller gaussians. Each brain owns one stream,
 * seeded from (match seed, tank, profile), so replays reproduce every personality roll. */
export class BrainRandom {
  private state: number;
  private spare: number | null = null;
  constructor(seed: number) { this.state = seed >>> 0; }
  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Standard normal. */
  gaussian(): number {
    if (this.spare !== null) { const value = this.spare; this.spare = null; return value; }
    const u = Math.max(1e-12, this.next()), v = this.next(), radius = Math.sqrt(-2 * Math.log(u));
    this.spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  }
}

/** A 32-bit seed from integers (FNV-1a over their bytes). */
export function brainSeed(...parts: (number | string)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) for (const char of String(part)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}
