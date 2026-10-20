import { describe, expect, it, vi } from 'vitest';
import { RealtimeMatch, type ScriptApi } from '../src/game/realtime/match';
import { MAX_REALTIME_UNITS, WRECK_LIFETIME_TICKS } from '../src/game/realtime/rules';
import { realtimeRun, realtimeSetup, site, unit, WARDEN } from './helpers/realtime';
import { SphereWorld } from './helpers/sphere-world';
import { FIXED_DT } from '../src/game/rules/ballistics';
import { distance } from '../src/game/math';
import { MissionRunner, missionSetup } from '../src/game/campaign/mission';
import { missionById } from '../src/game/campaign/catalog';

describe('realtime actor lifecycle', () => {
  it('runs fourteen full chassis alongside forty cheap swarm actors', () => {
    const units = Array.from({ length: 53 }, (_, i) => unit(0, site(8 + i % 6, (i % 11 - 5) * 2), {
      brain: 'patrol', unarmed: true, waypoints: [site(25)], motionKind: i < 13 ? 'chassis' : 'swarm',
    }));
    const run = realtimeRun(realtimeSetup(), { units });
    const physics = vi.spyOn(run.world, 'stepTanks');
    const before = run.match.state.tanks.map(t => [...t.position] as [number, number, number]);
    run.run(60);
    expect(run.match.state.tanks).toHaveLength(54);
    expect(physics.mock.calls.every(([tanks]) => tanks.length === 14 && tanks.every(t => t.motionKind === 'chassis'))).toBe(true);
    expect(run.match.state.tanks.slice(1).filter(t => distance(t.position, before[t.id]) > .2).length).toBe(53);
    run.match.dispose();
  });
  it('removes wreck bodies and reuses their generation safely across repeated waves', () => {
    let api!: ScriptApi;
    const run = realtimeRun(realtimeSetup(), { script: { start(a) { api = a; }, tick() {} } });
    const removed: number[] = []; Object.assign(run.world, { removeTank: (id: number) => removed.push(id) });
    const id = api.spawn(unit(1, site(12), { unarmed: true, group: 'wave-one' }))!;
    const generation = run.match.state.tanks[id].generation!;
    api.damage(id, 10000); run.run(1);
    expect(run.events.filter(e => e.type === 'kill' && e.tank === id)).toHaveLength(1);
    expect(run.match.state.tanks[id].retired).not.toBe(true);
    run.run(WRECK_LIFETIME_TICKS);
    expect(removed).toEqual([id]);
    expect(api.spawn(unit(1, site(15), { group: 'wave-two', unarmed: true }))).toBe(id);
    expect(run.match.state.tanks[id].generation).toBeGreaterThan(generation);
    expect(api.group('wave-one')).toHaveLength(1); expect(api.group('wave-one')[0].health).toBe(0);
    expect(api.group('wave-two')[0].health).toBeGreaterThan(0);
    expect(run.match.state.tanks).toHaveLength(2);
    expect(MAX_REALTIME_UNITS).toBeGreaterThanOrEqual(64);
    run.match.dispose();
  });
  it.each(['air', 'swarm'] as const)('turns destroyed %s units into falling solver wrecks', motionKind => {
    let api!: ScriptApi;
    const run = realtimeRun(realtimeSetup(), { units: [unit(0, site(4), { unarmed: true, motionKind, altitude: 3 })], script: { start(a) { api = a; }, tick() {} } });
    run.run(180); const t = run.match.state.tanks[1];
    if (motionKind === 'air') expect(Math.hypot(...t.position)).toBeGreaterThan(20);
    api.damage(1, 10000);
    const physics = vi.spyOn(run.world, 'stepTanks'); run.run(1);
    expect(t.motionKind).toBe('chassis'); expect(physics.mock.calls[0][0].map(t => t.id)).toContain(1);
    run.match.dispose();
  });
  it('rejects snapshots during flights, then resumes the same observed AI and random stream', () => {
    const run = realtimeRun(realtimeSetup({ fog: true }), { units: [unit(1, site(12, 4), { brain: 'rusty', maxHealth: 1000, damageScale: .1 })] });
    run.run(12);
    const saved = run.match.checkpoint()!; expect(saved).not.toBeNull();
    const world = new SphereWorld();
    const restored = new RealtimeMatch(world, run.match.setup, { checkpoint: saved });
    expect(restored.matchHash()).toBe(run.match.matchHash());
    for (let i = 0; i < 90; i++) {
      const drive = { throttle: .5, steer: .2 };
      run.run(1, drive); restored.step(FIXED_DT, drive);
    }
    expect(restored.matchHash()).toBe(run.match.matchHash());
    restored.command(0, { k: 'aim', yaw: 0, pitch: 1.2, power: 1 }); restored.command(0, { k: 'fire' });
    expect(restored.checkpoint()).toBeNull();
    restored.dispose(); run.match.dispose();
  });
  it('restores mission flags and objectives without duplicating its opening spawns', () => {
    const def = missionById('p3'), runner = new MissionRunner(def);
    const run = realtimeRun(missionSetup(def, WARDEN), { script: runner }); run.run(1);
    const saved = run.match.checkpoint()!;
    const resumed = new MissionRunner(def), match = new RealtimeMatch(new SphereWorld(), run.match.setup, { script: resumed, checkpoint: saved });
    expect(match.matchHash()).toBe(run.match.matchHash());
    expect(resumed.objectiveList()).toEqual(runner.objectiveList()); expect(resumed.beatId).toBe(runner.beatId);
    expect(match.state.tanks).toHaveLength(run.match.state.tanks.length);
    expect(match.drainRealtimeEvents().some(e => e.type === 'spawn')).toBe(false);
    match.dispose(); run.match.dispose();
  });
});
