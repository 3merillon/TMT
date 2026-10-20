import type { Vec3 } from '../core/types';
import type { ResidentArrangement } from '../gpu/terrain/arrangement';
import type { BodyCandidate, ColliderDescription, OccupiedRegion } from '../gpu/terrain/contracts';
import { ResidentFailure } from '../gpu/terrain/contracts';
import { mean } from '../gpu/terrain/math';

function description(regions: readonly OccupiedRegion[], arrangement: ResidentArrangement, center: Vec3): ColliderDescription {
  const ids = [...new Set(regions.flatMap(r => r.faces.flatMap(f => [...f.vertices])))], local = new Map(ids.map((id, i) => [id, i]));
  const points = ids.map(id => arrangement.vertices[id].position), volume = regions.reduce((s, r) => s + r.volume, 0);
  const localCenter = mean(points), offset = localCenter.map((v, i) => v - center[i]) as Vec3;
  const vertices = new Float32Array(points.flatMap(p => p.map((v, i) => v - localCenter[i]))), indices: number[] = [];
  for (const r of regions) for (const face of r.faces) for (let i = 1; i + 1 < face.vertices.length; i++) indices.push(local.get(face.vertices[0])!, local.get(face.vertices[i])!, local.get(face.vertices[i + 1])!);
  return { regionIds: regions.map(r => r.id), vertices, indices: new Uint32Array(indices), volume, offset };
}
/** Qualified merge: disjoint convex occupied cells may become ONE axis-aligned
 * box only if their summed occupied volume fills their bounding box. This cannot
 * bridge an arch/hole. Everything else remains one convex collider per region. */
export function structuralCandidate(id: number, regions: readonly OccupiedRegion[], arrangement: ResidentArrangement): BodyCandidate {
  const steps = structuralCandidateSteps(id, regions, arrangement); for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
/** structuralCandidate(), yielding every few dozen regions (a collapsing building has thousands). */
export function* structuralCandidateSteps(id: number, regions: readonly OccupiedRegion[], arrangement: ResidentArrangement): Generator<void, BodyCandidate> {
  const points = [...new Set(regions.flatMap(r => r.faces.flatMap(f => [...f.vertices])))].map(i => arrangement.vertices[i].position);
  const center = mean(points), groups = new Map<string, OccupiedRegion[]>();
  for (const r of regions) { const group = groups.get(r.source) ?? []; group.push(r); groups.set(r.source, group); }
  yield;
  const colliders: ColliderDescription[] = [];
  for (const group of groups.values()) {
    const p = [...new Set(group.flatMap(r => r.faces.flatMap(f => [...f.vertices])))].map(i => arrangement.vertices[i].position);
    // Loops, not Math.min(...p): a large group would overflow the argument stack.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of p) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[a]); hi[a] = Math.max(hi[a], v[a]); }
    const boxVolume = lo.reduce((s, x, i) => s * (hi[i] - x), 1), volume = group.reduce((s, r) => s + r.volume, 0);
    if (Math.abs(boxVolume - volume) <= Math.max(1e-7, volume * 1e-7)) {
      const vertices = new Float32Array(Array.from({ length: 8 }, (_, mask) => [0, 1, 2].map(a => ((mask & (1 << a)) ? hi[a] : lo[a]) - center[a])).flat());
      // convexHull computes the hull of a certified full box, not of a concave structure.
      colliders.push({ regionIds: group.map(r => r.id), vertices, indices: new Uint32Array(), volume });
    } else for (const r of group) { colliders.push(description([r], arrangement, center)); if (colliders.length % 64 === 0) yield; }
  }
  if (colliders.length > 8192) throw new ResidentFailure('capacity', 'Structural compound exceeds admitted collider capacity');
  return { id, regions, center, colliders };
}
