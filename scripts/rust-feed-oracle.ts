/** Independent existing query output and GPU wire-contract checks for numeric Rust publication. */
import assert from 'node:assert/strict';
import { residentQueryChunk, queryCollision } from '../src/game/resident-queries';
import type { BoundaryFace, Connectivity } from '../src/game/terrain-connectivity';
import type { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import type { OccupiedRegion } from '../src/gpu/terrain/contracts';
import type { RustSelection, RustTerrainCore } from '../src/gpu/terrain/rust-core';

export function verifyRustFeed(world: RustTerrainCore, reference: ResidentArrangement, regions: readonly OccupiedRegion[], graph: Connectivity): void {
  const index = new Map(regions.map((r, i) => [r.id, i])), parents = Uint32Array.from(regions, (_, i) => i);
  const root = (id: number): number => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id]; } return id; };
  for (const portal of graph.portals) { const a = root(index.get(portal.a)!), b = root(index.get(portal.b)!); parents[Math.max(a, b)] = Math.min(a, b); }
  for (let i = 0; i < parents.length; i++) parents[i] = root(i);
  assert.deepEqual(world.components(), parents, 'Resident connected-component partition');
  const check = (boundary: readonly BoundaryFace[], selection: RustSelection, origin: readonly [number, number, number]) => {
    const expected = residentQueryChunk('oracle', boundary, reference, [...origin]), actual = world.queryChunk(selection, origin);
    assert.deepEqual(actual.positions, expected.positions, 'CPU query position words'); assert.deepEqual(actual.indices, expected.indices, 'CPU query index words'); assert.deepEqual(actual.materials, expected.materials, 'CPU query material words');
    const bvh = world.queryBvh(selection, origin), oracle = queryCollision([expected]).chunks.get('oracle');
    for (const key of ['box', 'skip', 'leaf', 'faces'] as const) if (oracle) assert.deepEqual(bvh[key], oracle[key], `CPU BVH ${key}`); else assert.equal(bvh[key].length, 0);
    const surfaces = new Map(reference.fields.map(f => [f.id, f.surface])), triangles: number[] = [], references: number[] = [], scratch = new Float32Array(3), bits = new Uint32Array(scratch.buffer);
    for (const { region, face } of boundary) {
      const start = references.length / 8, surface = surfaces.get(face.source), kind = surface?.kind === 'planet' ? 1 : surface?.kind === 'sphere' ? 2 : 0;
      scratch.set(surface?.kind === 'sphere' ? surface.center : [0, 0, 0]);
      for (const id of face.vertices) references.push(id, face.vertices[0], face.vertices[1], face.vertices[2], region.material | (kind << 16), bits[0], bits[1], bits[2]);
      for (let i = 1; i + 1 < face.vertices.length; i++) triangles.push(face.vertices[0], face.vertices[i], face.vertices[i + 1], region.material, start, start + i, start + i + 1, 0);
    }
    const surface = world.gpuSurface(selection); assert.deepEqual(surface.triangles, Uint32Array.from(triangles), 'GPU surface triangle words'); assert.deepEqual(surface.references, Uint32Array.from(references), 'GPU source normal/reference words');
  };
  for (let brick = 0; brick < reference.lattice.brickOrder.length; brick++) check(graph.boundary.filter(b => b.region.brick === reference.lattice.brickOrder[brick]), { brick }, [0, 0, 0]);
  const anchored = new Set(graph.anchored.map(r => r.id)); check(graph.boundary.filter(b => anchored.has(b.region.id)), { anchored: true }, [0, 0, 0]);
  for (const group of graph.detached) { const members = new Set(group.map(r => r.id)), component = Math.min(...group.map(r => index.get(r.id)!)); check(graph.boundary.filter(b => members.has(b.region.id)), { component }, [1.125, -2.25, 3.375]); }
  const triangles: number[] = [], descriptors: number[] = [], volumes: number[] = [];
  for (const region of regions) { const start = triangles.length / 4; for (const face of region.faces) for (let i = 1; i + 1 < face.vertices.length; i++) triangles.push(face.vertices[0], face.vertices[i], face.vertices[i + 1], 0); descriptors.push(start, triangles.length / 4 - start, 0, 0); volumes.push(region.volume); }
  const packed = world.gpuVolumes(); assert.deepEqual(packed.descriptors, Uint32Array.from(descriptors)); assert.deepEqual(packed.triangles, Uint32Array.from(triangles)); assert.deepEqual(packed.volumes, Float64Array.from(volumes));
}
