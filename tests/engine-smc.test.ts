// W1-ENG-SCENE: Surface Memory Cube planning (plan §4.13) — seam stamps write both faces, crater clears stay inside the
// angular radius, the 4 Hz decay removes whole 1/255 steps at the configured fade times, and the instance packing.
import { describe, expect, it } from 'vitest';
import {
  packSmcQuads, planSmcClear, planSmcStamp, SMC_CHANNELS, SMC_DECAY_HZ, SMC_FADE_SECONDS, SMC_INSTANCE_FLOATS, SMC_SIZE, SmcDecay, smcDiscCoverage, smcTexel,
} from '../src/engine/scene/surface-memory';
import { cubeDir, cubeFaceOf, cubeUv } from '../src/world/cube-sphere';

type V3 = [number, number, number];
const norm = (v: readonly number[]): V3 => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const R = 18.4;

/** Point-in-quad test in face space (convex, any winding). */
function insideQuad(corners: [number, number][], p: [number, number]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(c) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

describe('SMC stamps', () => {
  it('a track patch straddling a cube seam is written into BOTH faces, each covering its side of the seam', () => {
    // Centre exactly on the +X / +Y edge (x = y), heading along the edge (z).
    const center: V3 = [R / Math.SQRT2, R / Math.SQRT2, 0.3];
    const quads = planSmcStamp({ center, forward: [0, 0, 1], halfLength: 0.4, halfWidth: 0.16, strength: 0.8 });
    expect(quads.map(q => q.face).sort()).toEqual([0, 2]);
    // Every sample of the true footprint lands inside the quad of the face that owns it.
    const up = norm(center), right = norm([up[1] * 1 - up[2] * 0, up[2] * 0 - up[0] * 1, 0]);
    for (let a = -0.9; a <= 0.9; a += 0.3) for (let b = -0.9; b <= 0.9; b += 0.3) {
      const p = norm([center[0] + right[0] * b * 0.16, center[1] + right[1] * b * 0.16, center[2] + a * 0.4]);
      const face = cubeFaceOf(p);
      const quad = quads.find(q => q.face === face)!;
      expect(quad, `face ${face}`).toBeDefined();
      expect(insideQuad(quad.corners, cubeUv(p, face))).toBe(true);
    }
  });

  it('a patch away from any seam writes only its own face', () => {
    const quads = planSmcStamp({ center: [0, R, 0], forward: [0, 0, 1], halfLength: 0.4, halfWidth: 0.15, strength: 1 });
    expect(quads.map(q => q.face)).toEqual([2]);
    expect(Math.abs(quads[0].corners[0][0])).toBeLessThan(0.05);
  });

  it('a patch at a cube corner reaches all three faces', () => {
    const c = norm([1, 1, 1]).map(v => v * R) as V3;
    expect(planSmcStamp({ center: c, halfWidth: 0.3, strength: 1 }).map(q => q.face).sort()).toEqual([0, 2, 4]);
  });

  it('a scorch wider than a face near a cube corner keeps every face it covers (no face dropped, no seam cut)', () => {
    const c = norm([1, 0.9, 0.8]).map(v => v * R) as V3;
    const quads = planSmcStamp({ center: c, halfWidth: 11, strength: 1 });
    const angle = Math.atan(11 / R);
    // Every face holding a texel of the disc gets a quad containing that texel.
    for (let face = 0; face < 6; face++) for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
      const uv: [number, number] = [-1 + i / 10, -1 + j / 10], d = cubeDir(face, uv);
      if (smcDiscCoverage(d, norm(c), Math.cos(angle), 0.35) <= 0) continue;
      const q = quads.find(x => x.face === face);
      expect(q, `face ${face}`).toBeDefined();
      const us = q!.corners.map(k => k[0]), vs = q!.corners.map(k => k[1]);
      expect(uv[0]).toBeGreaterThanOrEqual(Math.min(...us) - 1e-9); expect(uv[0]).toBeLessThanOrEqual(Math.max(...us) + 1e-9);
      expect(uv[1]).toBeGreaterThanOrEqual(Math.min(...vs) - 1e-9); expect(uv[1]).toBeLessThanOrEqual(Math.max(...vs) + 1e-9);
    }
  });

  it('rectangles carry the tread range and the end-soft flag; discs carry their angular radius', () => {
    const [rect] = planSmcStamp({ center: [0, R, 0], forward: [1, 0, 0], halfWidth: 0.1, strength: 0.6, tread: [3, 5], endSoft: 0 });
    expect(rect.tread).toEqual([3, 5]);
    expect(rect.disc[3]).toBe(-2);
    expect(rect.disc[0]).toBe(0);
    const [disc] = planSmcStamp({ center: [0, R, 0], halfWidth: 2, strength: 1 });
    expect(disc.disc[3]).toBeCloseTo(Math.cos(Math.atan(2 / R)), 12);
    const out = new Float32Array(SMC_INSTANCE_FLOATS * 2);
    expect(packSmcQuads([rect, disc], out)).toBe(2);
    expect(Array.from(out.subarray(8, 12))).toEqual([Math.fround(0.6), Math.fround(0.3), 3, 5]);
    expect(out[SMC_INSTANCE_FLOATS + 15]).toBeCloseTo(disc.disc[3], 6);
  });

  it('rejects degenerate stamps', () => {
    expect(planSmcStamp({ center: [0, 0, 0], halfWidth: 1, strength: 1 })).toEqual([]);
    expect(planSmcStamp({ center: [0, R, 0], halfWidth: 0, strength: 1 })).toEqual([]);
  });
});

describe('SMC crater clear', () => {
  it('coverage is exactly zero outside the sphere\'s angular radius and full near its axis', () => {
    const center: V3 = [2, 19.5, -1], radius = 2.6;
    const quads = planSmcClear(center, radius);
    expect(quads.length).toBeGreaterThan(0);
    const angle = Math.asin(radius / Math.hypot(...center));
    const axis = norm(center);
    for (const q of quads) expect(q.disc[3]).toBeCloseTo(Math.cos(angle), 12);
    // Sample every texel direction of the owning face near the crater (the WGSL uses the same function).
    const size = 256, t = smcTexel(center, size);
    let inside = 0;
    for (let y = t.y - 30; y <= t.y + 30; y++) for (let x = t.x - 30; x <= t.x + 30; x++) {
      const d = cubeDir(t.face, [(x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1]);
      const cover = smcDiscCoverage(d, axis, Math.cos(angle), 0.02);
      const a = Math.acos(Math.min(1, d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]));
      if (a > angle) expect(cover).toBe(0);
      else { inside++; if (a < angle * 0.9) expect(cover).toBe(1); }
    }
    expect(inside).toBeGreaterThan(20);
  });

  it('a clear near a seam covers both faces and never a sphere containing the planet centre', () => {
    expect(planSmcClear([R / Math.SQRT2 + 0.5, R / Math.SQRT2 + 0.5, 0], 2).map(q => q.face).sort()).toEqual([0, 2]);
    expect(planSmcClear([0, 1, 0], 5)).toEqual([]);
  });
});

describe('SMC decay and sizes', () => {
  it('removes whole 1/255 steps at 4 Hz so a full mark fades in its channel time', () => {
    for (const channel of SMC_CHANNELS) {
      const decay = new SmcDecay();
      const i = SMC_CHANNELS.indexOf(channel);
      let removed = 0, t = 0;
      while (removed < 255 && t < 2000) { const steps = decay.advance(1 / 60); t += 1 / 60; if (steps) removed += steps[i]; }
      expect(t).toBeGreaterThan(SMC_FADE_SECONDS[channel] * 0.97);
      expect(t).toBeLessThan(SMC_FADE_SECONDS[channel] * 1.03 + 1 / SMC_DECAY_HZ);
    }
  });

  it('ticks at 4 Hz regardless of frame rate', () => {
    const a = new SmcDecay(), b = new SmcDecay();
    for (let k = 0; k < 600; k++) a.advance(1 / 120);
    for (let k = 0; k < 150; k++) b.advance(1 / 30);
    // 5 s of frames either way (float accumulation may land a hair short of the 20th tick).
    for (const d of [a, b]) { expect(d.ticks).toBeGreaterThanOrEqual(19); expect(d.ticks).toBeLessThanOrEqual(20); }
    a.advance(1 / 120); b.advance(1 / 30);
    expect(a.ticks).toBe(20); expect(b.ticks).toBe(20);
  });

  it('1024² per face on High/Ultra, 512² on Low/Medium (24 MB at High)', () => {
    expect(SMC_SIZE).toEqual({ low: 512, medium: 512, high: 1024, ultra: 1024 });
    expect(SMC_SIZE.high ** 2 * 6 * 4).toBe(25165824);
  });
});

it('reports the decay owed between ticks, so a reader sees the trample fade continuously', () => {
  const decay = new SmcDecay();
  let drawn = 1;
  const seen: number[] = [];
  for (let frame = 0; frame < 240; frame++) {
    const steps = decay.advance(1 / 60);
    if (steps) drawn -= steps[2] / 255;
    seen.push(drawn - decay.pending('trample'));
  }
  // The visible value falls by 1/(60 × 30) of full per frame, exactly, across the 4 Hz ticks.
  for (let i = 1; i < seen.length; i++) expect(seen[i - 1] - seen[i]).toBeCloseTo(1 / 60 / 30, 9);
});
