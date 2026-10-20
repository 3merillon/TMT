// Ported from Pinionfall src/gpu/grass-lattice.test.ts (MIT, same owner)
// src/world/cube-sphere: the equi-angular cube mapping every planet texture shares (SMC, grass sites, water grids).
// Properties: one owning face per direction, exact round trip, uniform-enough spacing, TS/WGSL mirror identity, and the
// stable site hash W2-VEG builds on.
import { describe, expect, it } from 'vitest';
import {
  CUBE_FACE_ARC, CUBE_FACE_AXES, CUBE_SPHERE_WGSL, cubeDir, cubeFaceOf, cubeHash01, cubeLatticeStep, cubeLocate, cubeSiteHash, cubeUv, cubeUv01, facesTouching,
} from '../src/world/cube-sphere';

type V3 = [number, number, number];
/** Fibonacci sphere plus the awkward axis, edge and corner directions. */
function sampleDirs(n: number): V3[] {
  const out: V3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < n; k++) {
    const y = 1 - (2 * k + 1) / n, r = Math.sqrt(Math.max(0, 1 - y * y)), th = ga * k;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  const s3 = 1 / Math.sqrt(3), s2 = 1 / Math.sqrt(2);
  out.push([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [s3, s3, s3], [-s3, s3, -s3], [s3, -s3, s3], [-s3, -s3, -s3], [s2, s2, 0], [0, s2, s2], [s2, 0, -s2], [-s2, s2, 0]);
  return out;
}
const DIRS = sampleDirs(4000);

describe('cube-sphere mapping', () => {
  it('every direction has exactly one owning face, with uv inside [-1, 1]² (edges reached)', () => {
    let worst = 0;
    for (const d of DIRS) {
      const f = cubeFaceOf(d);
      const [u, v] = cubeUv(d, f);
      worst = Math.max(worst, Math.abs(u), Math.abs(v));
      expect(Math.abs(u)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-9);
      const a = CUBE_FACE_AXES[f];
      expect(d[0] * a[0] + d[1] * a[1] + d[2] * a[2]).toBeGreaterThan(0);
    }
    expect(worst).toBeGreaterThan(0.999);
  });

  it('cubeDir is the exact inverse of cubeUv', () => {
    let worst = 0;
    for (const d of DIRS) {
      const f = cubeFaceOf(d), back = cubeDir(f, cubeUv(d, f));
      worst = Math.max(worst, Math.hypot(back[0] - d[0], back[1] - d[1], back[2] - d[2]));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('documents the face convention: face centres and u/v axes', () => {
    const table: [number, V3, V3, V3][] = [
      [0, [1, 0, 0], [0, 0, -1], [0, 1, 0]], [1, [-1, 0, 0], [0, 0, 1], [0, 1, 0]], [2, [0, 1, 0], [1, 0, 0], [0, 0, -1]],
      [3, [0, -1, 0], [1, 0, 0], [0, 0, 1]], [4, [0, 0, 1], [1, 0, 0], [0, 1, 0]], [5, [0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    for (const [face, centre, uAxis, vAxis] of table) {
      cubeDir(face, [0, 0]).forEach((x, k) => expect(x).toBeCloseTo(centre[k], 12));
      const du = cubeDir(face, [0.01, 0]), dv = cubeDir(face, [0, 0.01]);
      expect(du[0] * uAxis[0] + du[1] * uAxis[1] + du[2] * uAxis[2]).toBeGreaterThan(0.005);
      expect(dv[0] * vAxis[0] + dv[1] * vAxis[1] + dv[2] * vAxis[2]).toBeGreaterThan(0.005);
    }
  });

  it('equal-angle warp: texel area varies < 20 % across a face (the raw cube: 1.73×)', () => {
    const R = 18, step = cubeLatticeStep(0.03, R);
    const area = (u: number, v: number) => {
      const p = cubeDir(4, [u, v]), qu = cubeDir(4, [u + step, v]), qv = cubeDir(4, [u, v + step]);
      const a = [0, 1, 2].map(i => (qu[i] - p[i]) * R), b = [0, 1, 2].map(i => (qv[i] - p[i]) * R);
      return Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
    };
    let lo = Infinity, hi = 0;
    for (let a = 0; a < 30; a++) for (let b = 0; b < 30; b++) {
      const u = -1 + 2 * a / 29, v = -1 + 2 * b / 29;
      if (Math.abs(u) + step > 1 || Math.abs(v) + step > 1) continue;
      const s = Math.sqrt(area(u, v)); lo = Math.min(lo, s); hi = Math.max(hi, s);
    }
    expect(lo).toBeGreaterThan(0.03 * 0.85); expect(hi).toBeLessThan(0.03 * 1.05);
    expect(hi / lo).toBeLessThan(1.2);
    expect(cubeLatticeStep(0.3, 800)).toBeCloseTo(0.3 / (800 * CUBE_FACE_ARC), 15);
  });

  it('cubeLocate and uv01 follow the texel convention (row 0 at v = -1)', () => {
    const { face, uv } = cubeLocate([3, 17, -2]);
    expect(face).toBe(2);
    const uv01 = cubeUv01(uv);
    expect(uv01[0]).toBeCloseTo((uv[0] + 1) / 2, 15);
    expect(uv01[1]).toBeCloseTo((uv[1] + 1) / 2, 15);
    expect(cubeUv01([-1, -1])).toEqual([0, 0]);
  });

  it('facesTouching: small footprints touch their face, seam footprints both faces, corners three', () => {
    expect(facesTouching([0, 1, 0], 0.01)).toEqual([2]);
    expect(facesTouching([1, 1, 0.1], 0.02)).toEqual([0, 2]);
    expect(facesTouching([1, 1, 1], 0.02)).toEqual([0, 2, 4]);
    expect(facesTouching([0, 1, 0], Math.PI / 2 + 0.1).length).toBe(5);
  });
});

describe('stable site hash (W2-VEG lattice)', () => {
  it('depends only on (face, i, j, seed) and is unbiased', () => {
    expect(cubeSiteHash(2, 17, -9, 0x99)).toBe(cubeSiteHash(2, 17, -9, 0x99));
    expect(cubeSiteHash(3, 17, -9, 0x99)).not.toBe(cubeSiteHash(2, 17, -9, 0x99));
    expect(cubeSiteHash(2, 17, -9, 0x9a)).not.toBe(cubeSiteHash(2, 17, -9, 0x99));
    let sum = 0, lo = 1, hi = 0, n = 0;
    for (let i = -40; i <= 40; i++) for (let j = -40; j <= 40; j++) {
      const h = cubeHash01(cubeSiteHash(4, i, j, 0xabcd), 0x77);
      sum += h; lo = Math.min(lo, h); hi = Math.max(hi, h); n++;
    }
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.02);
    expect(lo).toBeLessThan(0.02); expect(hi).toBeGreaterThan(0.98);
  });
});

describe('TS ↔ WGSL mirror', () => {
  it('the WGSL is generated from the TS constants and has every mirrored function', () => {
    expect(CUBE_SPHERE_WGSL).toContain(`const CS_FACE_ARC: f32 = ${CUBE_FACE_ARC};`);
    for (const fn of ['cs_face_of', 'cs_gnomonic', 'cs_uv', 'cs_dir', 'cs_locate', 'cs_uv01', 'cs_hash', 'cs_hash01', 'cs_site_hash']) expect(CUBE_SPHERE_WGSL).toMatch(new RegExp(`fn ${fn}\\(`));
    // Same face-order switch as the TS (the gnomonic numerators, face by face).
    for (const pair of ['vec2f(-d.z, d.y) / d.x', 'vec2f(d.z, d.y) / -d.x', 'vec2f(d.x, -d.z) / d.y', 'vec2f(d.x, d.z) / -d.y', 'vec2f(d.x, d.y) / d.z', 'vec2f(-d.x, d.y) / -d.z']) expect(CUBE_SPHERE_WGSL).toContain(pair);
    expect(CUBE_SPHERE_WGSL).not.toMatch(/\r/);
  });
});
