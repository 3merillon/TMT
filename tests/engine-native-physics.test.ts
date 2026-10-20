import { expect, it, vi } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { testPhysics } from './helpers/native-physics';
import { DebrisDynamics } from '../src/game/presentation/debris-dynamics';
import { readFileSync } from 'node:fs';
import { DebrisHost, type DebrisFrame } from '../src/game/presentation/debris-host';
import { NativePhysicsWorld } from '../src/game/native-physics';
import { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { WorldQuery } from '../src/game/contracts';
vi.mock('@dimforge/rapier3d-compat', async importOriginal => ({ ...await importOriginal<typeof import('@dimforge/rapier3d-compat')>(), init: vi.fn(() => Promise.reject(new Error('Compatibility WASM must not initialize'))) }));

it('runs gameplay and cosmetic native physics without initializing the compatibility WASM', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1');
  const physics = await testPhysics([0, -1000, 0]);
  const peer = physics.native!.createPresentationWorld(), debris = new DebrisDynamics(peer);
  try {
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    physics.world.createCollider(RAPIER.ColliderDesc.ball(1), body); physics.actors.add(body);
    const stale = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()); physics.world.removeRigidBody(stale);
    expect(() => stale.translation()).toThrow('Unknown native body');
    const shard = { body: { position: [0, 10, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number], radius: 1, age: 0, bounces: 0, sleeping: false },
      positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 1, 0, 0, 0, 1]), rotation: [0, 0, 0, 1] as [number, number, number, number], angularVelocity: [0, 0, 0] as [number, number, number] };
    debris.add(shard);
    for (let i = 0; i < 20; i++) debris.step([shard]);
    expect(body.translation().y).toBe(5); expect(shard.body.position[1]).toBeLessThan(10);
    physics.step(); expect(body.translation().y).toBeLessThan(5);
    expect(RAPIER.init).not.toHaveBeenCalled();
    const target = { x: 9, y: 9, z: 9, w: 9 }; body.rotation(target); expect(target.w).toBe(1);
  } finally { debris.dispose(); physics.dispose(); vi.unstubAllEnvs(); }
});

it('steps the same debris in a bare engine instance (the debris worker) as in the presentation peer, bit for bit', async () => {
  const module = await WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1');
  const physics = await testPhysics([0, -1000, 0]), bare = await RustTerrainCore.createEngine(module);
  const ground = { radius: 18, version: 1, surface: () => null, raycast: () => null, isSolid: (p: number[]) => p[1] < 18,
    * visibilityTriangles() { yield { a: [-12, 18, -12], b: [12, 18, 12], c: [12, 18, -12] }; yield { a: [-12, 18, -12], b: [-12, 18, 12], c: [12, 18, 12] }; } } as unknown as WorldQuery;
  const run = (host: DebrisHost) => {
    const trace: number[] = [];
    const frame = (n: number, commands: DebrisFrame['commands'] = []): void => {
      const terrain = n === 0 ? [{ version: 1, triangles: new Float32Array([...ground.visibilityTriangles!()].flatMap(t => [...t.a, ...t.b, ...t.c])), complete: true }] : [];
      trace.push(...host.apply({ frame: n, commands, water: [], terrain, tanks: [], supports: [], substeps: n % 5 === 2 ? 2 : 1 }).state);
    };
    frame(0, Array.from({ length: 12 }, (_, i): DebrisFrame['commands'][number] => ['add', { id: i + 1, generation: 0, radius: .3, density: 2.2,
      positions: new Float32Array(Array.from({ length: 8 }, (_, k) => [k & 1 ? .25 : -.25, k & 2 ? .05 : -.05, k & 4 ? .2 : -.2]).flat()),
      position: [(i % 4) * .6 - .9, 19 + Math.floor(i / 4) * .4, 0], velocity: [i % 3 - 1, -1, 0], rotation: [0, Math.sin(i * .3), 0, Math.cos(i * .3)], angularVelocity: [1, i % 2, -1] }]));
    for (let n = 1; n < 240; n++) frame(n, n === 120 ? [['kick', 3, [0, 5, 0]], ['remove', 7]] : []);
    host.dispose(); return trace;
  };
  try {
    const peer = run(new DebrisHost(() => physics.native!.createPresentationWorld()));
    const worker = run(new DebrisHost(() => new NativePhysicsWorld(bare).api));
    expect(worker.length).toBe(peer.length);
    expect(worker.findIndex((v, i) => !Object.is(v, peer[i]))).toBe(-1);
    expect(peer.some((v, i) => i % 17 === 14 && v === 1)).toBe(true);
  } finally { bare.dispose(); physics.dispose(); vi.unstubAllEnvs(); }
});
