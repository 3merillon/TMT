import { describe, expect, it } from 'vitest';
import { dragonflyModel, DRAGONFLY_ROTOR, DRAGONFLY_TAIL_ROTOR } from '../src/game/presentation/dragonfly-model';
import type { PartMesh } from '../src/game/kit/types';
type V = [number, number, number];
const vertices = (m: PartMesh): V[] => Array.from({ length: m.positions.length / 3 }, (_, i) => Array.from(m.positions.subarray(i * 3, i * 3 + 3)) as V);
const axisValues = (m: PartMesh, axis: number) => vertices(m).map(p => p[axis]);

function surfaceSpan(m: PartMesh, x: number, z: number, axis = 1): [number, number] {
  const points = vertices(m), heights: number[] = [];
  const uAxis = axis === 0 ? 1 : 0, vAxis = axis === 2 ? 1 : 2;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = points[m.indices[i]], b = points[m.indices[i + 1]], c = points[m.indices[i + 2]];
    const den = (b[vAxis] - c[vAxis]) * (a[uAxis] - c[uAxis]) + (c[uAxis] - b[uAxis]) * (a[vAxis] - c[vAxis]);
    if (Math.abs(den) < 1e-12) continue;
    const u = ((b[vAxis] - c[vAxis]) * (x - c[uAxis]) + (c[uAxis] - b[uAxis]) * (z - c[vAxis])) / den;
    const v = ((c[vAxis] - a[vAxis]) * (x - c[uAxis]) + (a[uAxis] - c[uAxis]) * (z - c[vAxis])) / den;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) heights.push(u * a[axis] + v * b[axis] + (1 - u - v) * c[axis]);
  }
  return [Math.min(...heights), Math.max(...heights)];
}

function clip(poly: V[], axis: number, at: number, sign: number): V[] {
  const out: V[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = (a[axis] - at) * sign, db = (b[axis] - at) * sign;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) out.push(a.map((v, j) => v + (b[j] - v) * da / (da - db)) as V);
  }
  return out;
}
/** Triangle against a complete swept annulus, including faces whose vertices all miss the disk. */
function intersectsSweep(triangle: V[], axis: number, origin: V, inner: number, outer: number, lo: number, hi: number): boolean {
  const local = triangle.map(p => p.map((v, j) => v - origin[j]) as V);
  const poly = clip(clip(local, axis, lo, 1), axis, hi, -1);
  if (!poly.length) return false;
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const radii = poly.map(p => Math.hypot(p[u], p[v]));
  if (Math.max(...radii) < inner) return false;
  let closest = Math.min(...radii);
  const crosses: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[u] - a[u], dy = b[v] - a[v];
    const t = Math.max(0, Math.min(1, -(a[u] * dx + a[v] * dy) / (dx * dx + dy * dy || 1)));
    closest = Math.min(closest, Math.hypot(a[u] + dx * t, a[v] + dy * t));
    crosses.push(a[u] * b[v] - a[v] * b[u]);
  }
  if (poly.length >= 3 && (crosses.every(n => n > 0) || crosses.every(n => n < 0))) closest = 0;
  return closest < outer;
}

describe('Dragonfly airframe geometry', () => {
  for (const lod of [0, 1, 2] as const) it(`keeps the full rotor sweeps clear of the airframe at LOD ${lod}`, () => {
    const parts = dragonflyModel(lod);
    for (const [name, axis, origin, inner] of [
      ['flight-rotor', 1, DRAGONFLY_ROTOR, .27], ['flight-tail-rotor', 0, DRAGONFLY_TAIL_ROTOR, .07],
    ] as const) {
      const rotor = parts.find(p => p.part === name)!;
      const blade = vertices(rotor).filter(p => Math.hypot(p[(axis + 1) % 3], p[(axis + 2) % 3]) > inner);
      const lo = Math.min(...blade.map(p => p[axis])) - .012, hi = Math.max(...blade.map(p => p[axis])) + .012;
      const outer = Math.max(...blade.map(p => Math.hypot(p[(axis + 1) % 3], p[(axis + 2) % 3]))) + .012;
      const hits: string[] = [];
      for (const part of parts.filter(p => p.joint === 'hull')) {
        const points = vertices(part);
        for (let i = 0; i < part.indices.length; i += 3) {
          if (intersectsSweep([points[part.indices[i]], points[part.indices[i + 1]], points[part.indices[i + 2]]], axis, origin, inner, outer, lo, hi)) { hits.push(part.part); break; }
        }
      }
      expect(hits, `${name} swept clearance`).toEqual([]);
    }
    const tail = parts.find(p => p.part === 'flight-tail-rotor')!;
    const tailRadius = Math.max(...vertices(tail).map(p => Math.hypot(p[1], p[2])));
    expect(DRAGONFLY_TAIL_ROTOR[1] + tailRadius).toBeLessThan(DRAGONFLY_ROTOR[1] - .025);
  });

  it('seats the cockpit frames on the lower skin and clears the intakes from the glazing', () => {
    const parts = dragonflyModel(0), body = parts.find(p => p.part === 'dragonfly-fuselage')!, points = vertices(body);
    // At every canopy seam there must be attached skin both above and below the sill.
    for (const [z, w, sill] of [[.10, .20, .31], [.37, .19, .285], [.74, .164, .255]]) for (const side of [-1, 1]) {
      const p: V = [w * side, sill * .75, z], connected: number[] = [];
      for (let i = 0; i < body.indices.length; i += 3) {
        const tri = Array.from(body.indices.subarray(i, i + 3), j => points[j]);
        if (tri.some(q => q.every((v, j) => Math.abs(v - p[j]) < 1e-6))) connected.push(...tri.map(q => q[1] - p[1]));
      }
      expect(Math.min(...connected)).toBeLessThan(-.01);
      expect(Math.max(...connected)).toBeGreaterThan(.01);
    }
    const glass = points.filter((p, i) => (body.attrs[i] >>> 16 & 255) === 6 && p[1] > .15);
    const rear = Math.min(...glass.map(p => p[2]));
    expect(Math.max(...glass.map(p => p[2])) - rear).toBeLessThan(.70);
    for (const engine of parts.filter(p => p.part.startsWith('flight-engine'))) expect(Math.max(...axisValues(engine, 2))).toBeLessThan(rear - .002);
  });

  it('retains long thin blades, grounded skids, damage groups and useful LOD reduction', () => {
    const counts: number[] = [];
    for (const lod of [0, 1, 2] as const) {
      const parts = dragonflyModel(lod);
      const rotor = parts.find(p => p.part === 'flight-rotor')!, blade = vertices(rotor).filter(p => p[2] > .4);
      const span = Math.max(...blade.map(p => p[2])), chord = Math.max(...blade.map(p => p[0])) - Math.min(...blade.map(p => p[0]));
      expect(span / chord).toBeGreaterThan(15);
      expect(span).toBeGreaterThan(1.8);
      for (const skid of parts.filter(p => p.part.startsWith('flight-skid'))) {
        expect(Math.min(...axisValues(skid, 1))).toBeGreaterThan(-.501);
        // Low-poly round rails stay within a centimetre of the authored contact plane.
        expect(Math.min(...axisValues(skid, 1))).toBeLessThan(-.49);
      }
      for (const p of parts) {
        expect([...p.positions, ...p.normals].every(Number.isFinite)).toBe(true);
        expect(Math.max(...p.indices)).toBeLessThan(p.positions.length / 3);
        for (let i = 0; i < p.normals.length; i += 3) expect(Math.hypot(...p.normals.subarray(i, i + 3))).toBeCloseTo(1, 5);
      }
      expect(parts.filter(p => p.part.startsWith('flight-pod')).length).toBe(3);
      expect(parts.filter(p => p.part.startsWith('flight-engine')).length).toBe(2);
      expect(parts.find(p => p.part === 'flight-tail')?.joint).toBe('hull');
      counts.push(parts.reduce((n, p) => n + p.indices.length / 3, 0));
    }
    expect(counts[0], `triangle counts: ${counts}`).toBeLessThan(18_000);
    expect(counts[1]).toBeLessThan(counts[0] * .8);
    expect(counts[2]).toBeLessThan(counts[0] * .4);
  });
  it('physically seats the gun adapter in the belly and both swashplate races together', () => {
    for (const lod of [0, 1, 2] as const) {
      const parts = dragonflyModel(lod), body = parts.find(p => p.part === 'dragonfly-fuselage')!;
      const gun = parts.find(p => p.part === 'flight-pod-chin-gun')!, rotor = parts.find(p => p.part === 'flight-rotor')!;
      for (const x of [-.05, 0, .05]) {
        const belly = surfaceSpan(body, x, .72)[0], mount = surfaceSpan(gun, x, .72);
        expect(mount[1]).toBeGreaterThan(belly + .01);
        expect(mount[0]).toBeLessThan(belly - .05);
      }
      const lower = surfaceSpan(body, .08, DRAGONFLY_ROTOR[2])[1];
      const upper = surfaceSpan(rotor, .08, 0)[0] + DRAGONFLY_ROTOR[1];
      expect(Math.abs(upper - lower)).toBeLessThan(.003);
    }
  });
  it('keeps the nose optics exposed behind their rim and the intake bores genuinely recessed', () => {
    for (const lod of [0, 1, 2] as const) {
      const parts = dragonflyModel(lod), body = parts.find(p => p.part === 'dragonfly-fuselage')!;
      const points = vertices(body);
      const optics = points.filter((p, i) => (body.attrs[i] >>> 16 & 255) === 6 && p[2] > 1);
      expect(optics.length).toBeGreaterThan(0);
      const lensFront = Math.max(...optics.map(p => p[2]));
      for (const x of [-.012, .012]) {
        // An unobstructed forward ray reaches the glass, not an intersecting hull or cap.
        expect(surfaceSpan(body, x, .012 * .75, 2)[1]).toBeCloseTo(lensFront, 5);
      }
      expect(Math.max(...axisValues(body, 2)) - lensFront).toBeGreaterThan(.008);
      for (const side of [-1, 1]) {
        const engine = parts.find(p => p.part === `flight-engine-${side}`)!;
        const compressor = surfaceSpan(engine, side * .302, .49 * .75, 2)[1];
        expect(compressor).toBeGreaterThan(-.17);
        expect(compressor).toBeLessThan(-.12);
        expect(Math.max(...axisValues(engine, 2)) - compressor).toBeGreaterThan(.15);
      }
    }
  });
  it('preserves a clear waist and tail taper instead of a constant-width body', () => {
    const body = dragonflyModel(0).find(p => p.part === 'dragonfly-fuselage')!;
    const width = (y: number, z: number) => { const [lo, hi] = surfaceSpan(body, y, z, 0); return hi - lo; };
    const nose = width(.04, .94), cockpit = width(.08, .45), shoulder = width(.13, -.4), aft = width(.14, -.87);
    expect(shoulder).toBeGreaterThan(cockpit * 1.25);
    expect(cockpit).toBeGreaterThan(nose * 1.35);
    expect(aft).toBeLessThan(shoulder * .65);
  });
});
