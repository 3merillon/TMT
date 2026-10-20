/** Engine v16: resident bot controllers serve their surface, ray, trace and canonical elevation requests inside the
 * engine on the world's composed query lease, charged to the match-owned query meter. The host-serviced path (the
 * v15 contract, still used under observation wrappers and extension segment hooks) is the reference. */
import { expect, it, vi } from 'vitest';
import { GameSimulation, MatchReplay, FIXED_DT } from '../src/game/simulation';
import { validateResidentCheckpoint } from '../src/game/resident-checkpoint';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { NativeMeter } from '../src/game/native-match';
import { botWorld, botSetup, play, LATEST_ENGINE } from './helpers/rust-resident';

type Internals = { nativeMatch: { meter?: NativeMeter; core: RustTerrainCore; id: number }; trace: unknown; meteredWorld: unknown; brainInstances: unknown[] };
const internals = (sim: GameSimulation) => sim as unknown as Internals;
/** Fails the test if a resident decision ever falls back to host-serviced queries. */
function forbidHostQueries(sim: GameSimulation): void {
  const s = internals(sim);
  s.trace = () => { throw new Error('host trace called'); };
  s.meteredWorld = () => { throw new Error('host metered query called'); };
}

it.each(['legacy', 'rusty', 'cyborg'] as const)('v16 %s serves its queries inside the engine exactly like the host path and replays', async profile => {
  const a = await botWorld(1), b = await botWorld(4), c = await botWorld(2);
  b.botQuery = () => undefined; // same engine and meter, host-serviced queries: the v15 reference
  const sa = new GameSimulation(a, botSetup(profile)), sb = new GameSimulation(b, botSetup(profile));
  let replay: MatchReplay | undefined;
  try {
    expect(a.resident.engine).toBe(`rust-engine-v${LATEST_ENGINE}`); forbidHostQueries(sa);
    const resident = vi.spyOn(internals(sa).brainInstances[1] as { stepResident: () => unknown }, 'stepResident');
    await play(sa, 900); await play(sb, 900);
    expect(resident).toHaveBeenCalled(); expect(sa.aiTelemetry().decisions).toBeGreaterThanOrEqual(1);
    expect(sa.state).toEqual(sb.state); expect(sa.commandLog()).toEqual(sb.commandLog()); expect(sa.aiTelemetry()).toEqual(sb.aiTelemetry());
    expect(sa.aiTelemetry().peakStepsPerTick).toBeLessThanOrEqual(48);
    const checkpoint = sa.checkpoint(); checkpoint.terrain = await a.saveCheckpoint();
    expect(validateResidentCheckpoint(checkpoint.terrain).engine).toBe(`rust-engine-v${LATEST_ENGINE}`);
    replay = new MatchReplay(c, JSON.parse(JSON.stringify(checkpoint))); forbidHostQueries(replay.simulation);
    for (let i = 0; i < 40000 && !replay.done; i++) if (replay.advance(i % 7 + 1) === 'stalled') await new Promise(resolve => setTimeout(resolve, 0));
    expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(sa.state);
  } finally { sa.dispose(); sb.dispose(); replay?.simulation.dispose(); a.dispose(); b.dispose(); c.dispose(); }
}, 180000);

it('meters resident work per tick and rejects malformed meter, lease and controller requests atomically', async () => {
  const world = await botWorld(1), sim = new GameSimulation(world, botSetup('rusty'));
  try {
    const m = internals(sim).nativeMatch, core = m.core, id = m.id;
    expect(m.meter!.read()).toEqual({ used: 0, limit: 48, peak: 0 });
    for (const d of [[1, 48], [2, 48], [1, .5]]) expect(() => core.matchCommand(id, 62, d)).toThrow('Invalid query meter admission');
    expect(() => core.matchCommand(id, 62, [1, NaN])).toThrow();
    for (const d of [[3, 0], [1, 2], [0, 0], [1]]) expect(() => core.matchCommand(id, 64, d)).toThrow();
    expect(() => m.meter!.charge(47, true)).toThrow('Invalid query meter charge'); expect(m.meter!.charge(2, false)).toBe(true);
    for (let i = 0; i < 46; i++) m.meter!.charge(1, false);
    expect(m.meter!.charge(1, false)).toBe(false); expect(m.meter!.read()).toEqual({ used: 48, limit: 48, peak: 48 });
    expect(m.meter!.charge(1, true)).toBe(true); expect(m.meter!.read()).toEqual({ used: 49, limit: 48, peak: 49 });
    sim.step(FIXED_DT); expect(m.meter!.read().used).toBe(0); expect(m.meter!.read().peak).toBe(49);
    const brain = internals(sim).brainInstances[1] as { stepResident(lease: unknown): unknown }, lease = world.botQuery()!;
    expect(lease.kind).toBe(2);
    expect(() => brain.stepResident({ ...lease, kind: 1 })).toThrow('Invalid resident bot query lease');
    expect(() => brain.stepResident({ ...lease, core: {} })).toThrow('own engine');
    const unbound = core.createProfile([1, id, 7, 0, .5, .1, .1, .1, .5, 8, 4, .1, 1.2, 1, 3, .5, 1, 0, -1, -1]);
    expect(() => core.profileCommand(unbound, 4, [2, lease.id, lease.range, 0])).toThrow('bound personality');
    core.disposeProfile(unbound);
    const before = sim.checkpoint();
    expect(() => core.profileCommand(1, 4, [2, lease.id, lease.range, 1, 1, 0, 1])).toThrow('No elevation request pending');
    expect(sim.checkpoint()).toEqual(before);
  } finally { sim.dispose(); world.dispose(); }
}, 60000);

