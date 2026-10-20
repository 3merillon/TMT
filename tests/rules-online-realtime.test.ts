import { describe, expect, it, vi } from 'vitest';
import { RealtimeMatch, type ScriptApi } from '../src/game/realtime/match';
import { makeOnlineSetup } from '../src/game/online/setup';
import { FIXED_DT } from '../src/game/rules/ballistics';
import { distance } from '../src/game/math';
import { realtimeRun, SKIFF_MORTAR, unit, site } from './helpers/realtime';
import { SphereWorld } from './helpers/sphere-world';
import { WRECK_LIFETIME_TICKS } from '../src/game/realtime/rules';

describe('realtime shared authority', () => {
  it('moves three human seats independently and permits simultaneous weapons', () => {
    const setup = makeOnlineSetup('realtime', 3, SKIFF_MORTAR), run = realtimeRun(setup);
    const start = run.match.state.tanks.map(t => [...t.position] as [number, number, number]);
    for (let id = 0; id < 3; id++) {
      expect(run.match.brainOf(id)).toBeNull();
      run.match.command(id, { k: 'drive', throttle: id === 2 ? 0 : 1, steer: id === 1 ? .5 : 0 });
      run.match.command(id, { k: 'aim', yaw: 0, pitch: 1.3, power: 1 });
      expect(run.match.command(id, { k: 'fire' })).toBe(true);
    }
    run.run(60);
    expect(distance(run.match.state.tanks[0].position, start[0])).toBeGreaterThan(1);
    expect(distance(run.match.state.tanks[1].position, start[1])).toBeGreaterThan(1);
    expect(distance(run.match.state.tanks[2].position, start[2])).toBeLessThan(.1);
    expect(run.match.state.projectiles).toHaveLength(3);
    run.match.dispose();
  });
  it('restores live projectiles, NPC decisions and reloads from an online recovery', () => {
    const setup = makeOnlineSetup('coop', 3, SKIFF_MORTAR);
    const run = realtimeRun(setup, { units: [unit(1, site(25), { brain: 'patrol', unarmed: true, waypoints: [site(28)] })], script: { start() {}, tick() {} } });
    run.match.command(1, { k: 'aim', yaw: 0, pitch: 1.3, power: 1 }); run.match.command(1, { k: 'fire' }); run.run(10);
    expect(run.match.checkpoint()).toBeNull();
    const saved = run.match.checkpoint(true)!;
    expect(saved.state.projectiles.length).toBeGreaterThan(0);
    const resumed = new RealtimeMatch(new SphereWorld(), setup, { checkpoint: saved, script: { start() {}, tick() {} } });
    expect(resumed.matchHash()).toBe(run.match.matchHash());
    for (let i = 0; i < 30; i++) { run.run(1); resumed.step(FIXED_DT); }
    expect(resumed.matchHash()).toBe(run.match.matchHash());
    run.match.dispose(); resumed.dispose();
  });
  it('predicts only the local chassis without deciding NPC actions or advancing weapons', () => {
    const setup = makeOnlineSetup('realtime', 3, SKIFF_MORTAR), authority = realtimeRun(setup);
    const world = new SphereWorld(), replica = new RealtimeMatch(world, setup, { replica: true });
    const step = vi.spyOn(world, 'stepTanks');
    replica.applyReplica(authority.match.replica()); const remote = structuredClone(replica.state.tanks[0]);
    for (let i = 0; i < 10; i++) replica.predictReplica(1, { throttle: 1, steer: .2 });
    expect(step).toHaveBeenCalledTimes(10); expect(replica.state.tick).toBe(0);
    expect(replica.state.tanks[0]).toEqual(remote); expect(replica.state.projectiles).toEqual([]);
    expect(replica.drainRealtimeEvents()).toEqual([]);
    authority.match.dispose(); replica.dispose();
  });
  it('applies reused NPC generations to the same slot and preserves a living co-op friend', () => {
    const setup = makeOnlineSetup('coop', 2, SKIFF_MORTAR); let api!: ScriptApi;
    const run = realtimeRun(setup, { script: { start(a) { api = a; }, tick() {} } });
    const replica = new RealtimeMatch(new SphereWorld(), setup, { replica: true });
    const id = api.spawn(unit(1, site(15), { unarmed: true }))!;
    replica.applyReplica(run.match.replica()); api.damage(id, 10000); run.run(WRECK_LIFETIME_TICKS + 1);
    replica.applyReplica(run.match.replica()); expect(api.spawn(unit(1, site(20), { unarmed: true, loadout: SKIFF_MORTAR }))).toBe(id);
    replica.applyReplica(run.match.replica());
    expect(replica.state.tanks).toEqual(run.match.state.tanks);
    expect(replica.unitSpec(id)?.loadout).toEqual(SKIFF_MORTAR);
    api.damage(0, 10000); run.run(1); expect(api.player).toBe(1); expect(run.match.finished).toBe(false);
    run.match.dispose(); replica.dispose();
  });
  it('keeps empty human seats out of the world and reserves their IDs for late joiners', () => {
    const setup = makeOnlineSetup('coop', 3, SKIFF_MORTAR); let api!: ScriptApi;
    const run = realtimeRun(setup, { script: { start(a) { api = a; }, tick() {} } });
    run.match.configureOnlineSeats([{ seat: 0, name: 'Host' }, { seat: 1, name: 'Friend' }]);
    expect(run.match.state.tanks[2]).toMatchObject({ health: 0, retired: true });
    expect(api.spawn(unit(1, site(20), { unarmed: true }))).toBe(3);
    run.run(1);
    run.match.configureOnlineSeats([{ seat: 0, name: 'Host' }, { seat: 1, name: 'Friend' }, { seat: 2, name: 'Late friend' }]);
    expect(run.match.state.tanks[2].health).toBeGreaterThan(0); expect(run.match.state.tanks[2].retired).not.toBe(true);
    expect(run.match.state.tanks[2].name).toBe('Late friend'); expect(run.match.brainOf(2)).toBeNull();
    expect(run.match.checkpoint(true)?.online?.seats).toEqual([0, 1, 2]);
    run.match.dispose();
  });
});
