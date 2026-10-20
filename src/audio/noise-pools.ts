// Ported from Pinionfall src/audio/spatial-audio.ts (getBrownPool, getCombatNoise, makeLoopableNoiseBuffer) and
// src/audio/procedural-wind-synth.ts (makePinkNoiseBuffer) (MIT, same owner)
/**
 * Shared noise pools: white, pink and brown buffers created ONCE per AudioContext and read at seeded random offsets.
 * Pinionfall's `makeWhiteNoiseBuffer` allocated and filled a fresh buffer per one-shot (hot-path garbage); here no
 * one-shot ever allocates a buffer, which tests/audio-buses enforces with a counting fake context.
 *
 * Every pool has a 30 ms seam crossfade so a looping read never ticks. The generators are seeded (no Math.random).
 */
import { mulberry32 } from './rng';
import type { NoiseColor } from './sfx/tank-sfx-math';

/** Pool lengths (s). White covers every white layer (≤ 1.2 s) plus offsets; brown the longest rumble (≤ 3.4 s) and
 * peals; the pink pair (incommensurate lengths) drives the stereo wind bed and the pink layers. */
export const NOISE_SECONDS = { white: 2, brown: 6.5, pinkL: 7, pinkR: 8 } as const;

/** White noise at amplitude `amp`. */
export function fillWhite(d: Float32Array, rand: () => number, amp = 0.6): void {
  for (let i = 0; i < d.length; i++) d[i] = (rand() * 2 - 1) * amp;
}
/** Brown noise (integrated white, Pinionfall's thunder recipe), clamped to ±1. */
export function fillBrown(d: Float32Array, rand: () => number): void {
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = last * 0.96 + (rand() * 2 - 1) * 0.04;
    const v = last * 3.2;
    d[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
}
/** The wind synth's cheap pink approximation (a one-pole low-pass on white), normalised to a 0.95 peak. */
export function fillPink(d: Float32Array, rand: () => number): void {
  let b = 0, maxAbs = 0;
  for (let i = 0; i < d.length; i++) {
    b = 0.99 * b + 0.05 * (rand() * 2 - 1);
    d[i] = b;
    const a = Math.abs(b);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 0) { const k = 0.95 / maxAbs; for (let i = 0; i < d.length; i++) d[i] *= k; }
}
/** 30 ms crossfade of the tail into the head, so looping playback does not click at the wrap. */
export function crossfadeSeam(d: Float32Array, sampleRate: number): void {
  const n = Math.min(d.length >> 2, Math.ceil(sampleRate * 0.03));
  for (let i = 0; i < n; i++) {
    const t = i / n, k = d.length - n + i;
    d[k] = d[k] * (1 - t) + d[i] * t;
  }
}

type Fill = (d: Float32Array, rand: () => number) => void;
function fillPool(buffer: AudioBuffer, fill: Fill, seed: number): AudioBuffer {
  const data = buffer.getChannelData(0);
  fill(data, mulberry32(seed));
  crossfadeSeam(data, buffer.sampleRate);
  return buffer;
}

export class NoisePools {
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly pinkL: AudioBuffer;
  readonly pinkR: AudioBuffer;
  private rand: () => number;

  constructor(ctx: BaseAudioContext, seed = 0x7a11c0de) {
    const make = (seconds: number, fill: Fill, s: number) => fillPool(ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * seconds)), ctx.sampleRate), fill, s);
    this.white = make(NOISE_SECONDS.white, fillWhite, seed ^ 0x1);
    this.brown = make(NOISE_SECONDS.brown, fillBrown, seed ^ 0x2);
    this.pinkL = make(NOISE_SECONDS.pinkL, fillPink, 0x1a2b3c4d);
    this.pinkR = make(NOISE_SECONDS.pinkR, fillPink, 0x5e6f7081);
    this.rand = mulberry32(seed ^ 0x3);
  }

  /** The pools of `new NoisePools(ctx, seed)`, written into these buffers (the pink pair has fixed seeds). Valid only
   * before any source has been given a seeded pool: a browser may take a buffer's contents when it is assigned. */
  reseed(seed: number): void {
    fillPool(this.white, fillWhite, seed ^ 0x1);
    fillPool(this.brown, fillBrown, seed ^ 0x2);
    this.rand = mulberry32(seed ^ 0x3);
  }

  get(color: NoiseColor): AudioBuffer {
    return color === 'white' ? this.white : color === 'brown' ? this.brown : this.pinkL;
  }
  /** A seeded start offset leaving room for `dur` seconds (0 when the read must loop anyway). */
  offset(buffer: AudioBuffer, dur: number): number {
    const room = buffer.duration - dur - 0.05;
    return room > 0 ? this.rand() * room : this.rand() * buffer.duration * 0.5;
  }
}
