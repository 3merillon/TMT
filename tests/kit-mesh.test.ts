/**
 * buildKitMesh v2 (W1-KIT): triangle and draw budgets per LOD, attribute sanity (matId, edge, ao, primAxis,
 * flags), finite data, index ranges, rest-pose partLocal, instance layout and caching.
 */
import { describe, expect, it } from 'vitest';
import type { TankState } from '../src/game/contracts';
import {
  assembleKit, buildKitMesh, createKitPose, decodeAxis, encodeAxis, INSTANCE_FLOATS, instanceMatrix, KIT_FLAG, kitInstanceSource, kitMeshBudget, legalKitLoadouts,
  MAT_ID, KIT_PART_IDS, poseKit, type PartMesh,
} from '../src/game/kit';
import { kitContext, kitGeometry } from '../src/game/kit/build';
import type { Shape } from '../src/game/kit/geometry/shapes';
import { LINK_SECTION } from '../src/game/kit/parts/gear/common';
import { gearRig, linkSlot } from '../src/game/kit/running';
import { geometryBudget } from './helpers/kit-geometry-budget';

const ALL = legalKitLoadouts();
/** Every (hull, gear, turret, weapon) once with a rotating utility: covers every part at every LOD quickly. */
const SAMPLE = ALL.filter((l, i, list) => list.findIndex(o => o.hull === l.hull && o.runningGear === l.runningGear && o.turret === l.turret && o.weapon === l.weapon) === i)
  .map((l, i) => ({ ...l, utility: KIT_PART_IDS.utility[i % KIT_PART_IDS.utility.length] }));

const restTank = (): TankState => ({ id: 0, position: [0, 18.5, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: 0,
  power: .5, health: 100, charge: 0, movement: 0, recoil: 0, suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0],
  trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0, wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-1.2),
  loadout: { tracks: 'grip', barrel: 'cannon', armor: 'light' } });

/** Attribute violations of one part (plain loops, one assertion per part: millions of expects are slow). */
function checkAttributes(p: PartMesh): void {
  const n = p.positions.length / 3, bad: string[] = [];
  if (p.normals.length !== p.positions.length) bad.push('normals length');
  if (p.partLocal.length !== p.positions.length) bad.push('partLocal length');
  if (p.attrs.length !== n) bad.push('attrs length');
  if (p.primAxis.length !== n) bad.push('primAxis length');
  if (p.indices.length % 3) bad.push('indices % 3');
  for (let i = 0; i < p.positions.length; i++) if (!Number.isFinite(p.positions[i]) || !Number.isFinite(p.partLocal[i])) { bad.push(`non-finite position ${i}`); break; }
  for (let i = 0; i < n && bad.length < 5; i++) {
    const l = Math.hypot(p.normals[i * 3], p.normals[i * 3 + 1], p.normals[i * 3 + 2]);
    if (!(Math.abs(l - 1) < 1e-4)) bad.push(`normal ${i} length ${l}`);
    const attrs = p.attrs[i], mat = (attrs >>> 16) & 255, flags = attrs >>> 24, ao = (attrs >>> 8) & 255;
    if (mat > MAT_ID.chrome) bad.push(`matId ${mat}`);
    if (ao < 50) bad.push(`ao ${ao}`);
    // Turned flag iff a primitive axis is present; axes are unit length with z ≤ 0 (canonical sign).
    if (Boolean(flags & KIT_FLAG.turned) !== (p.primAxis[i] !== 0)) bad.push(`turned flag vs axis at ${i}`);
    if (p.primAxis[i]) { const axis = decodeAxis(p.primAxis[i])!; if (Math.abs(Math.hypot(...axis) - 1) > 1e-6 || axis[2] > 1e-6) bad.push(`axis ${axis}`); }
  }
  for (let i = 0; i < p.indices.length; i++) if (p.indices[i] >= n) { bad.push(`index ${p.indices[i]} ≥ ${n}`); break; }
  expect(bad, `${p.part} LOD${p.lod}`).toEqual([]);
}

describe('kit mesh', () => {
  it('meets the triangle and draw budgets at every LOD for every legal assembly', () => {
    const worst = [0, 0, 0], worstKeys = ['', '', ''];
    for (const l of ALL) {
      for (const lod of [0, 1, 2] as const) {
        const { triangles, draws } = geometryBudget(l, lod), key = Object.values(l).join('.');
        if (triangles > worst[lod]) { worst[lod] = triangles; worstKeys[lod] = key; }
        expect(draws, `${key} LOD${lod} draws`).toBeLessThanOrEqual(24);
      }
    }
    // Count directly from production shapes for every legal combination, then verify
    // against the renderer's merged/instanced meshes for every slot option at all LODs.
    const seen = new Set<string>();
    for (const l of ALL) {
      const keys = Object.entries(l).map(([slot, id]) => `${slot}:${id}`);
      if (keys.every(key => seen.has(key))) continue;
      keys.forEach(key => seen.add(key));
      for (const lod of [0, 1, 2] as const) expect(geometryBudget(l, lod)).toEqual(kitMeshBudget(buildKitMesh(assembleKit(l), lod)));
    }
    // Brief: LOD0 ≤ 20k, LOD1 ≈ 5k, LOD2 ≈ 1k (triangles per tank, repeated parts included); "≈" allows 20 %.
    expect(worst[0], worstKeys[0]).toBeLessThanOrEqual(20000);
    expect(worst[1], worstKeys[1]).toBeLessThanOrEqual(6000);
    expect(worst[2], worstKeys[2]).toBeLessThanOrEqual(1200);
    expect(worst[1]).toBeLessThan(worst[0] * 0.35);
    expect(worst[2]).toBeLessThan(worst[1] * 0.45);
  });

  it('draws every other belt link at double pitch at LOD2 from the leading slots of the same pose buffer', () => {
    for (const gear of KIT_PART_IDS.runningGear) {
      const a = assembleKit({ hull: 'warden', runningGear: gear, turret: 'dome', weapon: 'cannon', utility: 'antenna' });
      const { linkCount, pitch } = gearRig(kitContext(a.loadout).gear).layout;
      // An even count per belt makes the double-pitch links tile the loop exactly (no overlap at the seam).
      expect(linkCount % 2, gear).toBe(0);
      const lod0 = buildKitMesh(a, 0).parts.find(p => p.part === 'links')!, lod2 = buildKitMesh(a, 2).parts.find(p => p.part === 'links')!;
      const src0 = kitInstanceSource(a, lod0)!, src2 = kitInstanceSource(a, lod2)!;
      expect(src0.count).toBe(2 * linkCount);
      expect(src2).toEqual({ buffer: 'linkInstances', first: 0, count: linkCount });
      expect(lod2.instances!.length / INSTANCE_FLOATS).toBe(src2.count);
      // The leading slots are links 0, 2, 4 … of each belt: consecutive slots are two pitches apart along the belt.
      const pose = createKitPose(a);
      poseKit(a, restTank(), pose);
      for (const meshSide of [0, 1] as const) for (let k = 0; k < linkCount / 2; k++) {
        const slot = linkSlot(linkCount, meshSide, 2 * k);
        expect(slot).toBeLessThan(src2.count);
        expect(linkSlot(linkCount, meshSide, 2 * k + 1)).toBeGreaterThanOrEqual(src2.count);
        const m = instanceMatrix(pose.linkInstances, slot), next = instanceMatrix(pose.linkInstances, linkSlot(linkCount, meshSide, (2 * k + 2) % linkCount));
        expect(Math.hypot(next[13] - m[13], next[14] - m[14])).toBeLessThan(2 * pitch + 1e-3);
      }
      // The double-pitch link spans two pitches (less the same gap fraction as a single link).
      const zs = Array.from({ length: lod2.positions.length / 3 }, (_, i) => lod2.positions[i * 3 + 2]);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(pitch * (1 + LINK_SECTION.lengthFraction), 5);
    }
  });

  it('emits sane, finite attributes on every part', () => {
    for (const l of SAMPLE.slice(0, 20)) for (const p of buildKitMesh(assembleKit(l), 0).parts) checkAttributes(p);
    for (const l of SAMPLE.slice(0, 6)) for (const lod of [1, 2] as const) for (const p of buildKitMesh(assembleKit(l), lod).parts) checkAttributes(p);
  });

  it('uses every material class where it belongs and marks chamfers', () => {
    const a = assembleKit({ hull: 'bastion', runningGear: 'grip', turret: 'wedge', weapon: 'rail', utility: 'periscope' });
    const mats = new Set<number>(), edged = new Set<string>();
    for (const p of buildKitMesh(a, 0).parts) for (let i = 0; i < p.attrs.length; i++) { mats.add((p.attrs[i] >>> 16) & 255); if ((p.attrs[i] & 255) === 255) edged.add(p.part); }
    for (const id of [MAT_ID.paint, MAT_ID.darkSteel, MAT_ID.rubber, MAT_ID.gunmetal, MAT_ID.brass, MAT_ID.signal, MAT_ID.glass, MAT_ID.chrome]) expect(mats.has(id), `matId ${id}`).toBe(true);
    expect(edged.has('hull')).toBe(true);
    expect(edged.has('turret')).toBe(true);
  });

  it('lays out one PartMesh per rigid group plus instanced running gear matching the pose buffers', () => {
    for (const gear of KIT_PART_IDS.runningGear) {
      const a = assembleKit({ hull: 'warden', runningGear: gear, turret: 'dome', weapon: 'cannon', utility: 'radar' });
      const mesh = buildKitMesh(a, 0), parts = new Map(mesh.parts.map(p => [p.part, p]));
      expect([...parts.keys()].slice(0, 6)).toEqual(['hull', 'turret', 'hatch', 'cradle', 'barrel', 'head']);
      expect(parts.get('head')!.joint).toBe('radar');
      const counts = gearRig(kitContext(a.loadout).gear).layout.counts;
      for (const p of mesh.parts) {
        const src = kitInstanceSource(a, p);
        if (!p.instances) { expect(src).toBeNull(); continue; }
        expect(src).not.toBeNull();
        expect(p.instances.length / INSTANCE_FLOATS).toBe(src!.count);
        expect(src!.count).toBe(counts[p.part as keyof typeof counts]);
        expect(p.joint).toBe('hull');
      }
      expect(parts.get('links')!.instances!.length / INSTANCE_FLOATS).toBe(counts.links);
      const suspension = kitContext(a.loadout).gear.suspension;
      expect(parts.has('springs')).toBe(suspension === 'bogie');
      expect(parts.has('rollers')).toBe(suspension === 'bogie');
      expect(parts.has('arms')).toBe(suspension !== 'bogie');
    }
  });

  it('winds every part consistently, so no edge is traversed twice in one direction (closed shadow volumes)', () => {
    const conflicts: string[] = [], seen = new Set<Shape>();
    // Shape objects are cached by all builder dependencies. Inspect every distinct
    // production shape at every LOD, avoiding repeated checks of identical pieces.
    for (const l of ALL) for (const lod of [0, 1, 2] as const) for (const [group, shapes] of kitGeometry(kitContext(l), lod).groups) for (const shape of shapes) {
      if (seen.has(shape)) continue;
      seen.add(shape);
      const part = { positions: Float32Array.from(shape.mb.p), indices: shape.mb.idx, part: group };
      const key = (i: number) => `${part.positions[i * 3]},${part.positions[i * 3 + 1]},${part.positions[i * 3 + 2]}`;
      const counts = new Map<string, [number, number]>();
      for (let t = 0; t < part.indices.length; t += 3) for (let e = 0; e < 3; e++) {
        const p = key(part.indices[t + e]), q = key(part.indices[t + (e + 1) % 3]);
        if (p === q) continue;
        const edge = p < q ? `${p}|${q}` : `${q}|${p}`, c = counts.get(edge) ?? [0, 0];
        c[p < q ? 0 : 1]++; counts.set(edge, c);
      }
      let bad = 0;
      for (const [forward, reverse] of counts.values()) if (forward !== reverse && forward + reverse > 1) bad++;
      if (bad) conflicts.push(`${Object.values(l).join('.')}:${part.part}@lod${lod}: ${bad}`);
    }
    expect(conflicts).toEqual([]);
  });

  it('stores the tank-local rest pose in partLocal for rigid parts', () => {
    const a = assembleKit({ hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' });
    const turret = buildKitMesh(a, 0).parts.find(p => p.part === 'turret')!, ring = a.frames.turretRing.position;
    for (let i = 0; i < turret.positions.length; i += 3) for (let k = 0; k < 3; k++) expect(turret.partLocal[i + k]).toBeCloseTo(turret.positions[i + k] + ring[k], 5);
    const barrel = buildKitMesh(a, 0).parts.find(p => p.part === 'barrel')!, t = a.frames.trunnion.position;
    expect(barrel.partLocal[2] - barrel.positions[2]).toBeCloseTo(ring[2] + t[2], 5);
  });

  it('oct-encodes axes with a canonical sign and reserves 0 for "no axis"', () => {
    expect(encodeAxis(0, 0, 0)).toBe(0);
    const axes: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0.3, -0.4, 0.866], [-0.6, 0.8, 0]];
    for (const v of axes) {
      const code = encodeAxis(v[0], v[1], v[2]);
      expect(code).not.toBe(0);
      const d = decodeAxis(code)!, l = Math.hypot(...v), sign = v[2] > 0 ? -1 : 1;
      for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(v[k] / l * sign, 3);
    }
  });

  it('caches per key and LOD', () => {
    const a = assembleKit({ hull: 'skiff', runningGear: 'crawler', turret: 'cradle', weapon: 'cannon', utility: 'smoke' });
    expect(buildKitMesh(a, 0)).toBe(buildKitMesh(a, 0));
    expect(buildKitMesh(a, 1)).not.toBe(buildKitMesh(a, 0));
    expect(buildKitMesh(a, 2).parts.every(p => p.lod === 2)).toBe(true);
  });
});
