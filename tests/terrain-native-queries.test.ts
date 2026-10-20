import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { encodeRustCore, RustTerrainCore } from '../src/gpu/terrain/rust-core';
import { NativeResidentQueries, NativeTerrainCollision, releaseNativeQuery, retainNativeQuery, nativeBallisticQuery } from '../src/game/native-queries';
import { TerrainCollision, type CollisionChunk } from '../src/game/terrain-collision';
import { ResidentQueries } from '../src/game/resident-queries';
import type { TerrainHit, V3, Q4 } from '../src/game/contracts';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { StructuralPhysics } from '../src/game/structural-physics';
import { NativeBallistics } from '../src/game/native-ballistics';
import { NativeCombat } from '../src/game/native-combat';
import { NativeMatch } from '../src/game/native-match';
import { practiceSetup } from '../src/game/api/match';
import { GameSimulation } from '../src/game/simulation';
import { advanceFlight, type Flight } from '../src/game/rules/ballistics';
import { normalize, sub, mul } from '../src/game/math';
import type { WorldQuery, ImpactEvent, ProjectileState } from '../src/game/contracts';

const module = WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
function chunk(id: string, core: RustTerrainCore, feed: ReturnType<RustTerrainCore['queryBvh']>): CollisionChunk {
  const c = { mesh: { id, positions: feed.positions.slice(), indices: feed.indices.slice(), materials: feed.materials.slice(), normals: new Float32Array(), colors: new Float32Array() },
    root: { min: Array.from(feed.box.subarray(0, 3)) as V3, max: Array.from(feed.box.subarray(3, 6)) as V3 }, box: feed.box.slice(), skip: feed.skip.slice(), leaf: feed.leaf.slice(), faces: feed.faces.slice() };
  retainNativeQuery(c, core, feed.nativeId ?? core.retainQueryOutput()); return c;
}
function compareHit(a: TerrainHit | null, b: TerrainHit | null): void {
  expect(!!a).toBe(!!b); if (!a || !b) return;
  expect(a.material).toBe(b.material); expect(a.distance).toBeCloseTo(b.distance, 10);
  for (let i = 0; i < 3; i++) { expect(a.point[i]).toBeCloseTo(b.point[i], 10); expect(a.normal[i]).toBeCloseTo(b.normal[i], 10); }
}
it('native snapshots match ray, swept-sphere and bounded-triangle behavior before and after moved-body transforms', async () => {
  const input = structuralFixture('arch'), lattice = residentLattice(input.bounds), a = new ResidentArrangement(lattice, input.sources, 2048, true, true);
  input.cuts.forEach(c => a.addCut(c));
  const initial = encodeRustCore({ lattice, sources: a.boxes, sourceFields: a.boxFields, fields: a.preparedFields(0), canonicalConstruction: true });
  const core = await RustTerrainCore.createWorld(await module, initial, a.fields.length), compiler = await RustTerrainCore.create(await module, lattice, initial);
  const physics = StructuralPhysics.createNative(core, input.planetCenter);
  try {
    core.begin(1); core.ingest(compiler.compile(lattice.brickOrder.map(brick => ({ brick, tets: null })), 1, [], a.fields.length, [], undefined, true)); core.connect(); core.detach(); core.commit();
    const fixed = chunk('fixed', core, core.queryBvh({ anchored: true }, [0, 0, 0], true)), id = core.bodyWords()[4];
    const body = chunk('body', core, core.bodyQueryBvh(id, false, true));
    const fixedMap = new Map([['fixed', fixed]]), bodyMap = new Map([['body', body]]);
    const n = new NativeTerrainCollision(core, 1, fixedMap), t = new TerrainCollision(1, fixedMap);
    const nb = new NativeTerrainCollision(core, 1, bodyMap), tb = new TerrainCollision(1, bodyMap);
    const rb = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(3, 7, -2).setRotation({ x: 0, y: Math.sin(.4), z: 0, w: Math.cos(.4) }));
    const pose = () => { const p = rb.translation(), q = rb.rotation(); return { position: [p.x, p.y, p.z] as V3, rotation: [q.x, q.y, q.z, q.w] as Q4 }; };
    const nq = new NativeResidentQueries(core, 1, n, new Map([[id, { collision: nb, pose: () => { throw new Error('Native query crossed the JS pose boundary'); } }]]), new Map([[id, rb.handle]]));
    const tq = new ResidentQueries(1, t, new Map([[id, { collision: tb, pose }]]));
    let seed = 721; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 900; i++) {
      if (i === 300 || i === 600) expect(nq.syncPoses()).toBe(tq.syncPoses());
      if (i === 450) { rb.setTranslation({ x: -2, y: 10, z: 1 }, false); rb.setRotation({ x: Math.sin(.25), y: 0, z: 0, w: Math.cos(.25) }, false); }
      const origin: V3 = [random() * 24 - 12, random() * 18 - 3, random() * 24 - 12], direction: V3 = [random() - .5, random() - .5, random() - .5];
      compareHit(n.raycast(origin, direction, 50), t.raycast(origin, direction, 50)); compareHit(nq.raycast(origin, direction, 50), tq.raycast(origin, direction, 50));
      expect(n.blocked(origin, direction, 50)).toBe(t.blocked(origin, direction, 50)); expect(nq.isSolid(origin)).toBe(tq.isSolid(origin));
      expect(nq.blocked(origin, direction, 50)).toBe(tq.blocked(origin, direction, 50)); compareHit(nq.surface(direction), tq.surface(direction));
      const r = .03 + random(), ns = nq.sweepSphere(origin, direction, 50, r), ts = tq.sweepSphere(origin, direction, 50, r);
      expect(ns === null).toBe(ts === null); if (ns !== null && ts !== null) expect(ns).toBeCloseTo(ts, 9);
      if (i % 3 === 0) {
        const bounds = { min: origin, max: origin.map(v => v + 4) as V3 }, maximum = 1 + i % 500;
        const x = nq.queryTriangles(bounds, maximum), y = tq.queryTriangles(bounds, maximum);
        expect(x.overflow).toBe(y.overflow); expect(x.triangles.length).toBe(y.triangles.length);
        x.triangles.forEach((v, k) => { expect(v.material).toBe(y.triangles[k].material); for (const key of ['a', 'b', 'c', 'normal'] as const) v[key].forEach((w, j) => expect(w).toBeCloseTo(y.triangles[k][key][j], 10)); });
      }
    }
    // Flight integration + launch clearance + segment CCD share the retained query
    // snapshots, including their held moving-body poses, without a JS query call.
    const setup = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    const flights = new NativeBallistics(core, setup, 9.8, 18); let impacts = 0, guards = 0;
    try {
      for (const [native, oracle] of [[n, t], [nq, tq]] as const) for (let shot = 0; shot < 80; shot++) {
        const f: Flight = { position: [random() * 10 - 5, random() * 12, random() * 8 - 4], vx: random() * 3 - 1.5, vy: -10, vz: random() * 3 - 1.5, age: 0 };
        const ref = structuredClone(f);
        for (let tick = 0; tick < 90; tick++) {
          const from = ref.position, u = normalize([ref.vx, ref.vy, ref.vz]);
          let hit = ref.age === 0 ? oracle.raycast(sub(from, mul(u, 1)), u, 1) : null;
          if (!hit && ref.age === 0 && oracle.isSolid(from)) hit = { point: [...from], normal: normalize(from), distance: 0, material: 0 };
          const stepped = !hit;
          if (stepped) { advanceFlight(ref, { gravity: 9.8, wind: null, windFactor: 0 }); const d = sub(ref.position, from); hit = oracle.raycast(from, normalize(d), Math.hypot(...d)); }
          const actual = flights.advance(f, 1, 0, nativeBallisticQuery(native));
          expect(actual.stepped).toBe(stepped); compareHit(actual.hit, hit);
          for (let i = 0; i < 3; i++) expect(f.position[i]).toBeCloseTo(ref.position[i], 9);
          if (hit) { impacts++; if (!stepped) guards++; break; }
          if (actual.expired) break;
        }
        flights.release(f);
      }
      expect(impacts).toBeGreaterThan(25); expect(guards).toBeGreaterThan(5); expect(flights.retainedFlights()).toBe(0);
    } finally { flights.dispose(); }
    const gameWorld: WorldQuery = { radius: 18, version: 1, raycast: (o, d, m) => nq.raycast(o, d, m), isSolid: p => nq.isSolid(p), surface: d => nq.surface(d),
      ballisticQuery: () => nativeBallisticQuery(nq), createBallistics: (s, g) => new NativeBallistics(core, s, g, 18),
      createMatchLifecycle: (s, state) => new NativeMatch(core, s, state), createCombat: (s, state, kit) => new NativeCombat(core, s, state, kit) };
    const simulation = new GameSimulation(gameWorld, setup);
    const ray = vi.spyOn(gameWorld, 'raycast').mockImplementation(() => { throw new Error('Flight crossed host ray boundary'); });
    const solid = vi.spyOn(gameWorld, 'isSolid').mockImplementation(() => { throw new Error('Flight crossed host solid boundary'); });
    try {
      expect(simulation.preview(0).length).toBeGreaterThan(1);
      const combat = (simulation as unknown as { nativeCombat: NativeCombat }).nativeCombat;
      const oracleWorld: WorldQuery = { radius: 18, version: 1, raycast: (o, d, m) => tq.raycast(o, d, m), isSolid: p => tq.isSolid(p), surface: d => tq.surface(d) };
      const reference = new GameSimulation(oracleWorld, setup);
      let affected = 0, obstructed = 0;
      try {
        for (const [native, oracle] of [[n, t], [nq, tq]] as const) for (let shot = 0; shot < 80; shot++) {
          const point: V3 = [random() * 8 - 4, random() * 10, random() * 8 - 4];
          const hit: TerrainHit = { point, normal: normalize(point), distance: 0, material: 0 };
          for (let id = 0; id < 2; id++) {
            const position: V3 = [point[0] + random() * 5 - 2.5, point[1] + random() * 5 - 2.5, point[2] + random() * 5 - 2.5];
            simulation.state.tanks[id].position = [...position]; reference.state.tanks[id].position = [...position];
            simulation.state.tanks[id].velocity = [0, 0, 0]; reference.state.tanks[id].velocity = [0, 0, 0];
            combat.restore(id, { health: 1000 }); reference.state.tanks[id].health = 1000;
          }
          oracleWorld.raycast = (o, d, m) => oracle.raycast(o, d, m);
          const projectile: ProjectileState = { id: shot, owner: 0, position: point, velocity: [0, -1, 0], age: .5 };
          const direct = shot % 3 ? null : 1;
          const actual = combat.impact(projectile, hit, direct, nativeBallisticQuery(native), () => { throw new Error('Blast crossed host query boundary'); });
          (reference as unknown as { impact(p: ProjectileState, h: TerrainHit, d: number | null): void }).impact(projectile, hit, direct);
          const expected = (reference.step(0).find(e => e.type === 'impact') as ImpactEvent).hits!;
          expect(actual.length).toBe(expected.length); affected += actual.length;
          actual.forEach((h, i) => { const e = expected[i]; expect({ ...h, exposure: 0 }).toEqual({ ...e, exposure: 0 }); expect(h.exposure).toBeCloseTo(e.exposure, 11); if (h.exposure < .35) obstructed++; });
          for (let id = 0; id < 2; id++) simulation.state.tanks[id].velocity.forEach((v, i) => expect(v).toBeCloseTo(reference.state.tanks[id].velocity[i], 10));
        }
        expect(affected).toBeGreaterThan(100); expect(obstructed).toBeGreaterThan(10);
      } finally { reference.dispose(); }
    } finally { ray.mockRestore(); solid.mockRestore(); simulation.dispose(); }
    // Copied immutable native snapshots survive arena compaction and ownership rollback.
    const before = n.raycast([0, 12, 0], [0, -1, 0], 30); core.compactPages(); core.begin(2); core.abort(); compareHit(n.raycast([0, 12, 0], [0, -1, 0], 30), before);
    // Native scenes retain their chunks even after the host releases the separate chunk handle.
    releaseNativeQuery(fixed); compareHit(n.raycast([0, 12, 0], [0, -1, 0], 30), before);
    for (const maximum of [0, -1, 2049, 1.5, NaN]) expect(() => n.queryTriangles({ min: [0, 0, 0], max: [1, 1, 1] }, maximum)).toThrow('Invalid bounded');
    expect(n.raycast([NaN, 0, 0], [1, 0, 0], 10)).toBeNull(); expect(n.raycast([0, 0, 0], [0, 0, 0], 10)).toBeNull(); expect(n.blocked([0, 0, 0], [1, 0, 0], Infinity)).toBe(false);
    // Top-tree skips still count every skipped root toward the historical visit ceiling.
    const many = new Map(Array.from({ length: 8193 }, (_, i) => [String(i), body])); const overflow = new NativeTerrainCollision(core, 1, many);
    const bounds = { min: [100, 100, 100] as V3, max: [101, 101, 101] as V3 };
    expect(overflow.queryTriangles(bounds)).toEqual(new TerrainCollision(1, many).queryTriangles(bounds)); expect(overflow.queryTriangles(bounds).overflow).toBe(true);
    // Identical geometry with different materials must choose the last chunk in
    // insertion order, including hits exactly on shared triangle boundaries.
    const first = core.queryBvh({ anchored: true }); first.materials.fill(7); const firstChunk = chunk('first', core, first);
    const last = core.queryBvh({ anchored: true }); last.materials.fill(9); const lastChunk = chunk('last', core, last);
    const empty = new NativeTerrainCollision(core, 1, new Map());
    for (const order of [[firstChunk, lastChunk], [lastChunk, firstChunk]]) {
      const tied = new Map(order.map(c => [c.mesh.id, c])), actual = new NativeTerrainCollision(core, 1, tied), expected = new TerrainCollision(1, tied);
      for (const x of [-3, -1.5, 0, 1.5, 3]) {
        const origin: V3 = [x, 12, 0], direction: V3 = [0, -1, 0];
        const hit = actual.raycast(origin, direction, 30); compareHit(hit, expected.raycast(origin, direction, 30));
        if (hit) expect(hit.material).toBe(order[1].mesh.materials[0]);
        for (const radius of [.1, .5, 1]) { const u = actual.sweepSphere(origin, direction, 30, radius), v = expected.sweepSphere(origin, direction, 30, radius); expect(u === null).toBe(v === null); if (u !== null && v !== null) expect(u).toBeCloseTo(v, 10); }
      }
      releaseNativeQuery(actual); expect(() => actual.raycast([0, 0, 0], [0, 1, 0], 10)).toThrow('Unknown query snapshot');
      const bodyScenes = order.map(c => new NativeTerrainCollision(core, 1, new Map([[c.mesh.id, c]])));
      const localBodies = new Map(bodyScenes.map((collision, k) => [k, { collision, pose }]));
      const composed = new NativeResidentQueries(core, 1, empty, localBodies, new Map([[0, rb.handle], [1, rb.handle]]));
      const reference = new ResidentQueries(1, new TerrainCollision(), localBodies);
      for (const maximum of [1, 2, 40, 2048]) {
        const bounds = { min: [-20, -20, -20] as V3, max: [20, 20, 20] as V3 }, u = composed.queryTriangles(bounds, maximum), v = reference.queryTriangles(bounds, maximum);
        expect(u.overflow).toBe(v.overflow); expect(u.triangles).toEqual(v.triangles);
      }
    }
    expect(nq.syncPoses()).toBe(false); physics.world.removeRigidBody(rb);
    expect(() => nq.raycast([0, 15, 0], [0, -1, 0], 50)).not.toThrow();
    expect(() => nq.syncPoses()).toThrow('Unknown native body');
  } finally { physics.dispose(); core.dispose(); compiler.dispose(); }
}, 60000);
