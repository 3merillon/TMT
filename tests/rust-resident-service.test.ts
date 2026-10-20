import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { RustResidentTerrain, type RustPageBackend } from '../src/gpu/terrain/rust-service';
import { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { RustWorkerSurface } from '../src/gpu/terrain/rust-core-pool';
import type { RustWorkerMessage } from '../src/gpu/terrain/rust-core-worker';
import type { GpuPage } from '../src/gpu/terrain/page-batch';
import type { TerrainRenderHost } from '../src/gpu/terrain/render-host';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { replayResident, residentReplay, validateResidentCheckpoint } from '../src/game/resident-checkpoint';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import { FakeTerrainHost } from './helpers/geometry-gate';
import { GameSimulation, MatchReplay, FIXED_DT } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';

import { module, Worker, Gate, setup } from './helpers/rust-resident';

it('replays the default native match checksum through live resident transactions and different worker counts', async () => {
  const a = await setup(1, true), b = await setup(4, true), wa = ResidentGameTerrain.adopt(a.terrain, 19), wb = ResidentGameTerrain.adopt(b.terrain, 19);
  let sim: GameSimulation | undefined, replay: MatchReplay | undefined;
  try {
    await wa.initialize(); await wb.initialize();
    const s = practiceSetup({ seed: 19, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    s.initialCuts = [{ id: 'native-hash-initial', center: [0, 6, 0], radius: 2.5 }]; sim = new GameSimulation(wa, s);
    for (let i = 0; i < 500 && sim.state.tick < 90; i++) {
      sim.step(FIXED_DT, { throttle: sim.state.tick > 30 ? .6 : 0, steer: .2 });
      if (sim.stalledOn) await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(sim.state.tick).toBe(90); expect(wa.version).toBeGreaterThan(1);
    const checkpoint = sim.checkpoint(); checkpoint.terrain = await wa.saveCheckpoint();
    expect(validateResidentCheckpoint(checkpoint.terrain).engine).toBe('rust-engine-v22');
    replay = new MatchReplay(wb, JSON.parse(JSON.stringify(checkpoint)));
    for (let i = 0; i < 500 && !replay.done; i++) { const status = replay.advance(i % 7 + 1); if (status === 'stalled') await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(sim.state);
    expect(b.terrain.verifyOracle()).toEqual([]);
  } finally { sim?.dispose(); replay?.simulation.dispose(); wa.dispose(); wb.dispose(); }
}, 60000);

it.each([false, true])('native=%s: publishes retained Rust geometry atomically, recuts a moved body and replays identically across worker counts', async native => {
  const a = await setup(1, native), b = await setup(4, native);
  try {
    await a.terrain.initialize();
    for (const cut of a.input.cuts) await a.terrain.cut(cut);
    expect(a.physics.bodies.size).toBe(1); const parent = a.physics.bodies.get(1)!;
    expect(parent.candidate.regions).toHaveLength(0); expect(parent.candidate.regionCount).toBeGreaterThan(0);
    parent.body.setTranslation({ x: 0, y: 20, z: 0 }, true);
    const q = a.terrain.queries, visible = a.host.visible, epoch = a.terrain.epoch;
    const staged = (await a.terrain.prepare([{ id: 'body-recut', center: [0, 20, 0], radius: 2.25 }]))!;
    expect(a.terrain.queries).toBe(q); expect(a.host.visible).toEqual(visible); expect(a.physics.bodies.size).toBe(1); expect(a.terrain.epoch).toBe(epoch);
    expect(staged.bodies).toHaveLength(2); expect(staged.replaced).toEqual([1]); a.terrain.commit(staged);
    expect(a.physics.bodies.size).toBe(2); expect(Math.abs(a.terrain.history.at(-1)!.ledger.error)).toBeLessThan(1e-4);
    await a.terrain.rebuild(); expect(a.physics.bodies.size).toBe(2);
    expect(a.terrain.verifyOracle()).toEqual([]);
    await replayResident(b.terrain, residentReplay(a.terrain), a.physics.motions(), a.physics.tick);
    expect(b.physics.motions()).toEqual(a.physics.motions());
    expect(b.terrain.history.map(e => e.ledger)).toEqual(a.terrain.history.map(e => e.ledger));
    expect([...b.terrain.queries.fixed.chunks].map(([id, c]) => [id, c.mesh.positions, c.mesh.indices])).toEqual([...a.terrain.queries.fixed.chunks].map(([id, c]) => [id, c.mesh.positions, c.mesh.indices]));
    const game = ResidentGameTerrain.adopt(a.terrain); game.initialized = true; for (let i = 0; i < a.terrain.epoch; i++) game.bump();
    const checkpoint = await game.saveCheckpoint(); expect(checkpoint.engine).toBe(native ? 'rust-engine-v22' : 'rust-resident-v1');
    if (native) { a.physics.nativeChassis = false; expect((await game.saveCheckpoint()).engine).toBe('rust-engine-v2'); a.physics.nativeDrive = false; expect((await game.saveCheckpoint()).engine).toBe('rust-engine-v1'); a.physics.nativeDrive = a.physics.nativeChassis = true; }
    expect(() => validateResidentCheckpoint({ ...checkpoint, engine: 'unknown' })).toThrow('engine');
  } finally { a.terrain.dispose(); b.terrain.dispose(); expect(a.gate.live + b.gate.live).toBe(0); expect(a.host.disposedWhileVisible + b.host.disposedWhileVisible).toBe(0); }
}, 60000);

it.each([false, true])('native=%s: rolls back GPU, host and cancellation failures, accepts changed-word retries and rejects moved pose fences', async native => {
  const { terrain, input, gate, host, physics } = await setup(1, native);
  try {
    await terrain.initialize(); const initial = terrain.queries, visible = host.visible, live = gate.live;
    gate.fail = true; await expect(terrain.cut(input.cuts[0])).rejects.toThrow('GPU admission'); gate.fail = false;
    expect(terrain.queries).toBe(initial); expect(host.visible).toEqual(visible); expect(gate.live).toBe(live);
    const stagePhysics = vi.spyOn(physics, 'stageSteps').mockImplementationOnce(function*() { throw new Error('physics failed'); });
    await expect(terrain.cut(input.cuts[0])).rejects.toThrow('physics failed'); stagePhysics.mockRestore();
    expect(terrain.queries).toBe(initial); expect(host.visible).toEqual(visible); expect(gate.live).toBe(live);
    const failed = (await terrain.prepare([input.cuts[0]]))!; const commit = vi.spyOn(host, 'commit').mockImplementationOnce(() => { throw new Error('host failed'); });
    expect(() => terrain.commit(failed)).toThrow('host failed'); commit.mockRestore(); expect(terrain.queries).toBe(initial); expect(gate.live).toBe(live);
    const controller = new AbortController(); let entered!: () => void, release!: () => void;
    const entering = new Promise<void>(r => { entered = r; }); gate.gate = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const operation = terrain.cut(input.cuts[0], controller.signal), rejected = expect(operation).rejects.toThrow('cancelled'); await entering; controller.abort(); await rejected;
    gate.gate = undefined; release(); await new Promise(r => setTimeout(r, 0)); expect(gate.live).toBe(live); expect(terrain.queries).toBe(initial);
    await terrain.cut({ ...input.cuts[0], radius: 2.5 }); await terrain.cut(input.cuts[1]); expect(physics.bodies.size).toBe(1);
    const body = physics.bodies.get(1)!.body; body.setTranslation({ x: 0, y: 20, z: 0 }, true);
    const staged = (await terrain.prepare([{ id: 'moved-recut', center: [0, 20, 0], radius: 2.25 }]))!;
    body.setTranslation({ x: 0, y: 21, z: 0 }, true); expect(() => terrain.commit(staged)).toThrow('advanced'); expect(physics.bodies.get(1)!.body).toBe(body);
    await terrain.cut({ id: 'moved-recut', center: [0, 21, 0], radius: 2.25 }); expect(physics.bodies.size).toBe(2);
  } finally { terrain.dispose(); expect(gate.live).toBe(0); expect(host.disposedWhileVisible).toBe(0); }
}, 60000);
