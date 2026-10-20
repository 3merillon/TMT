import { beforeAll, describe, expect, it, vi } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { cutDebris, splitDebris, TerrainDebris, type DebrisFragment } from '../src/game/presentation/debris';
import type { DebrisDynamics, RigidShard } from '../src/game/presentation/debris-dynamics';
import { stableWaterHulls } from '../src/engine/passes/fluids/hull-motion';
import { InstanceTable } from '../src/engine/passes/gbuffer/part-mesh-data';
import { TerrainCollision } from '../src/game/terrain-collision';
import { add, cross, dot, length, mul, normalize, sub } from '../src/game/math';
import type { V3, WorldQuery } from '../src/game/contracts';
import type { SceneRegistry } from '../src/engine';
import { bumpyPlanet } from './helpers/bumpy-planet';
import { shape, plate, finish } from '../src/game/presentation/campaign-machining';

const collision = new TerrainCollision().apply({ version: 1, removed: [], milliseconds: 0, triangles: 1, rebuilt: 1,
  chunks: [{ id: 'ground', positions: new Float32Array([-1, 18, -1, 0, 18, 1, 1, 18, -1]),
    normals: new Float32Array(9), colors: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), materials: new Uint16Array([1]) }] });
const world: WorldQuery = { radius: 18, version: 1, raycast: collision.raycast.bind(collision), surface: () => null,
  isSolid: p => p[1] <= 18, queryTriangles: collision.queryTriangles.bind(collision) };

// TerrainDebris prewarms its presentation physics on construction; every suite needs Rapier.
beforeAll(async () => { await RAPIER.init(); });

describe('terrain fragments', () => {
  it('uses the real bounded collision query without crashing on impact', () => {
    const fragments = cutDebris(world, [0, 18, 0], 2.6);
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.length).toBeLessThanOrEqual(48);
    for (const piece of fragments) for (let i = 0; i < piece.positions.length; i += 3) {
      const p = [0, 1, 2].map(a => piece.center[a] + piece.positions[i + a]);
      expect(Math.hypot(p[0], p[1] - 18, p[2])).toBeLessThan(2.6);
      expect(p[1]).toBeLessThanOrEqual(18 + 1e-6);
    }
  });
  it('keeps impact dispatch alive when a cosmetic query fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debris = new TerrainDebris({} as SceneRegistry);
    expect(() => debris.impact({ type: 'impact', owner: 0, position: [0, 18, 0], normal: [0, 1, 0], radius: 2 },
      { ...world, queryTriangles() { throw new Error('unavailable'); } })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce(); warn.mockRestore();
  });
});

describe('rubble contacts and buoyancy', () => {
  it('secondary fragments partition the original solid volume', () => {
    const volume = (positions: Float32Array) => {
      let v = 0;
      for (let i = 0; i < positions.length; i += 9) {
        const [a, b, c, d, e, f, g, h, j] = positions.slice(i, i + 9);
        v += (a * (e * j - f * h) + b * (f * g - d * j) + c * (d * h - e * g)) / 6;
      }
      return Math.abs(v);
    };
    for (const f of cutDebris(world, [0, 18, 0], 2.6)) {
      const children = splitDebris(f);
      expect(children).toHaveLength(8);
      expect(children.reduce((v, child) => v + volume(child.positions), 0)).toBeCloseTo(volume(f.positions), 6);
    }
  });
  it('ignores hull solver chatter but retains accumulated slow travel', () => {
    const h = { centre: [0, 18, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [.5, .5, 1] };
    let poses = [h];
    for (const x of [0.001, -0.002, 0.001, 0.003]) {
      poses = stableWaterHulls([{ ...h, centre: [x, 18, 0] }], poses) as typeof poses;
      expect(poses[0]).toBe(h);
    }
    expect(stableWaterHulls([{ ...h, centre: [0.006, 18, 0] }], poses)[0].centre[0]).toBe(0.006);
  });
});

/** The 29baad2 cutDebris, kept verbatim as the oracle for the allocation-free one. */
function referenceCut(world: WorldQuery, center: V3, radius: number, limit = 48): DebrisFragment[] {
  if (!center.every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0 || limit <= 0) return [];
  const bounds = { min: center.map(v => v - radius) as V3, max: center.map(v => v + radius) as V3 };
  const query = world.queryTriangles?.(bounds, 2048); if (!query) return [];
  const pieces: DebrisFragment[] = [];
  const subdivide = (a: V3, b: V3, c: V3, normal: V3, material: number, depth: number) => {
    if (pieces.length >= limit) return;
    const centroid = mul(add(add(a, b), c), 1 / 3), edge = Math.max(length(sub(a, b)), length(sub(b, c)), length(sub(c, a)));
    if (length(sub(centroid, center)) - edge > radius) return;
    if (edge > Math.max(0.5, radius * 0.42) && depth < 6) {
      const ab = mul(add(a, b), 0.5), bc = mul(add(b, c), 0.5), ca = mul(add(c, a), 0.5);
      for (const t of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) subdivide(t[0], t[1], t[2], normal, material, depth + 1);
      return;
    }
    if ([a, b, c].some(p => length(sub(p, center)) >= radius * 0.97)) return;
    const thickness = Math.min(0.4, edge * 0.45, radius * 0.18);
    const vertices = [a, b, c, ...[a, b, c].map(p => sub(p, mul(normal, thickness)))];
    if (vertices.slice(3).some(p => length(sub(p, center)) > radius || !world.isSolid(p))) return;
    const origin = mul(vertices.reduce((sum, p) => add(sum, p), [0, 0, 0] as V3), 1 / 6);
    const faces = [[0, 1, 2], [5, 4, 3], [0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2], [2, 5, 3], [2, 3, 0]];
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (const face of faces) {
      let [p, q, r] = face.map(i => vertices[i]);
      let n = normalize(cross(sub(q, p), sub(r, p)));
      if (dot(n, sub(mul(add(add(p, q), r), 1 / 3), origin)) < 0) { [q, r] = [r, q]; n = mul(n, -1); }
      for (const v of [p, q, r]) { indices.push(indices.length); positions.push(...sub(v, origin)); normals.push(...n); }
    }
    pieces.push({ center: origin, textureOrigin: origin, positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices),
      radius: Math.max(...vertices.map(p => length(sub(p, origin)))) * 0.6, material });
  };
  const ordered = [...query.triangles].sort((a, b) => length(sub(a.a, center)) - length(sub(b.a, center)));
  for (const t of ordered) subdivide(t.a, t.b, t.c, t.normal, t.material, 0);
  return pieces;
}
const fragmentBits = (fragments: DebrisFragment[]) => fragments.flatMap(f => [...f.center, ...f.textureOrigin!, f.radius, f.material, ...f.positions, ...f.normals, ...f.indices]);
describe('allocation-free cut', () => {
  it('cuts exactly the reference fragments, in the same order', () => {
    const planet = bumpyPlanet(6), cases: [WorldQuery, V3, number, number][] = [[world, [0, 18, 0], 2.6, 48], [world, [.3, 18.2, -.1], 1.1, 5]];
    for (const [i, d] of ([[0, 1, 0], [.4, .8, .3], [-.7, .2, .5], [.1, -.9, -.4], [.6, -.3, -.7]] as V3[]).entries()) {
      const hit = planet.collision.surface(normalize(d))!;
      for (const [radius, limit] of [[1.4, 48], [2.6, 48], [3.5, 48], [2.6, 9], [3.5, 1]]) cases.push([planet.whole, add(hit.point, mul(hit.normal, i * .1 - .2)), radius, limit]);
    }
    let compared = 0;
    for (const [where, center, radius, limit] of cases) {
      const expected = referenceCut(where, center, radius, limit), actual = cutDebris(where, center, radius, limit);
      expect(actual.length).toBe(expected.length);
      const a = fragmentBits(actual), b = fragmentBits(expected);
      expect(a.length).toBe(b.length);
      for (let k = 0; k < a.length; k++) if (!Object.is(a[k], b[k])) throw new Error(`fragment value ${k} differs: ${a[k]} vs ${b[k]}`);
      for (const f of actual) expect(f.textureOrigin).toBe(f.center);
      compared += actual.length;
    }
    expect(compared).toBeGreaterThan(200);
  });
});

describe('shard presentation', () => {
  it.each([19, 17.8])('settles a vehicle panel starting at height %s (including embedded parts), then retires it without dither', height => {
    const table = new InstanceTable(), visibility = vi.fn(), destroy = vi.fn();
    const scene = { get: () => undefined, meshes: { create: () => ({ id: 1 }), destroy },
      instances: { add: (m: { id: number }, init: never) => ({ id: table.add(m.id, init) }), remove: (h: { id: number }) => table.remove(h.id),
        set: (h: { id: number }, model: Float32Array) => table.set(h.id, model), setVisibility: visibility } };
    const floor: WorldQuery = { ...world, * visibilityTriangles() {
      yield { a: [-12, 18, -12], b: [12, 18, 12], c: [12, 18, -12], normal: [0, 1, 0], material: 1 };
      yield { a: [-12, 18, -12], b: [-12, 18, 12], c: [12, 18, 12], normal: [0, 1, 0], material: 1 };
    } };
    const s = shape(0); plate(s, [0, 0, 0], [.5, .05, .4]); const panel = finish(s, 'panel', 'hull', 0), original = panel.positions.slice();
    const debris = new TerrainDebris(scene as never), transform = new Float32Array(new Matrix4().makeTranslation(0, height, 0).elements);
    try {
      debris.detach(panel, transform, [.3, .3, .2], [1, 2, 0]);
      expect(debris.active).toBe(1); expect(panel.positions).toEqual(original);
      const pieces = (debris as unknown as { pieces: RigidShard[] }).pieces;
      for (let i = 0; i < 600; i++) debris.update(floor, 1 / 60);
      expect(pieces[0].body.age).toBeGreaterThan(9);
      expect(pieces[0].body.position[1]).toBeGreaterThan(17.97); expect(pieces[0].body.position[1]).toBeLessThan(18.12);
      expect(visibility).not.toHaveBeenCalled();
      for (let i = 0; i < 300; i++) debris.update(floor, 1 / 60);
      expect(debris.active).toBe(0); expect(destroy).toHaveBeenCalledOnce();
    } finally { debris.dispose(); }
  });
  it('keeps every instance at its shard pose and writes nothing for resting shards', () => {
    const planet = bumpyPlanet(6), table = new InstanceTable(), calls = { set: 0, visibility: 0 };
    let meshes = 0;
    const scene = { get: () => undefined, meshes: { create: () => ({ id: ++meshes }), destroy: () => {} },
      instances: { add: (m: { id: number }, init: never) => ({ id: table.add(m.id, init) }), remove: (h: { id: number }) => table.remove(h.id),
        set: (h: { id: number }, model: Float32Array) => { calls.set++; table.set(h.id, model); },
        setVisibility: (h: { id: number }, v: number) => { calls.visibility++; table.setVisibility(h.id, v); } } };
    const debris = new TerrainDebris(scene as never), hit = planet.collision.surface([0, 1, 0])!;
    debris.impact({ type: 'impact', owner: 0, position: hit.point, normal: hit.normal, radius: 2.4, cut: { id: 'a', center: hit.point, radius: 2.4 } }, planet.whole);
    debris.commit(['a']);
    const pieces = (debris as unknown as { pieces: (RigidShard & { instance: { id: number } })[] }).pieces, expected = new Float32Array(16), model = new Matrix4();
    const last = new Map<object, string>();
    let skipped = 0;
    try {
      for (let frame = 0; frame < 600; frame++) {
        table.beginFrame(); calls.set = calls.visibility = 0;
        debris.update(planet.whole, frame % 5 === 2 ? 0 : 1 / 60);
        let moved = 0;
        for (const p of pieces) {
          expected.set(model.compose(new Vector3(...p.body.position), new Quaternion(...p.rotation), new Vector3(1, 1, 1)).elements);
          const actual = table.model(p.instance.id);
          for (let k = 0; k < 16; k++) if (!Object.is(actual[k], expected[k])) throw new Error(`frame ${frame}: instance ${p.instance.id} element ${k} is stale`);
          const pose = [...p.body.position, ...p.rotation].join();
          if (last.get(p.body) !== pose) { moved++; last.set(p.body, pose); }
        }
        // One write per shard that moved since the last frame, none for the others.
        expect(calls.set).toBe(moved);
        skipped += pieces.length - moved;
      }
      expect(pieces.length).toBeGreaterThan(10);
      expect(skipped).toBeGreaterThan(1000);
    } finally { debris.dispose(); }
  });
  it('cooks the terrain pages ahead of the first blast, a slice per frame', () => {
    const planet = bumpyPlanet(6), scene = { get: () => undefined } as unknown as SceneRegistry;
    const ahead = new TerrainDebris(scene), plain = new TerrainDebris(scene);
    try {
      for (let frame = 0; frame < 60; frame++) { ahead.update(planet.pages, 1 / 60); plain.update(planet.whole, 1 / 60); }
      // The in-process channel's host owns the debris world (a native world would cook it in the worker).
      const dynamics = (debris: TerrainDebris) => (debris as unknown as { channel?: { host: { dynamics?: DebrisDynamics } } }).channel?.host.dynamics;
      let cooked = 0; dynamics(ahead)!.world.forEachCollider(c => { if (!c.parent()) cooked++; });
      expect(cooked).toBe(planet.count);
      // Without pages (the whole-surface path) nothing is built before the first blast, as before.
      expect(dynamics(plain)).toBeUndefined();
    } finally { ahead.dispose(); plain.dispose(); }
  });
});
