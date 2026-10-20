import { describe, expect, it } from 'vitest';
import { RealtimeCore } from '../src/game/realtime/core';
import { CRAWLER_COMPONENTS, activeComponents, componentPoint } from '../src/game/realtime/components';
import { RealtimeMatch, type ScriptApi } from '../src/game/realtime/match';
import { realtimeRun, realtimeSetup, site, unit } from './helpers/realtime';
import { SphereWorld } from './helpers/sphere-world';
import type { TankState } from '../src/game/contracts';

describe('Rust vehicle components', () => {
  const fixture = () => {
    const run = realtimeRun(realtimeSetup(), { units: [unit(1, site(12), { components: CRAWLER_COMPONENTS, unarmed: true, immobile: true })] });
    return { run, tank: run.match.state.tanks[1], core: new RealtimeCore() };
  };
  it('requires all four drives and both feeds before the core can take a hit', () => {
    const { run, tank, core } = fixture(), components = tank.components!, initial = tank.health;
    tank.health = core.damageComponents(tank, componentPoint(tank, components[6]), 1000, .1, 6);
    expect(tank.health).toBe(initial);
    for (let i = 0; i < 6; i++) {
      expect(activeComponents(tank)[0].stage).toBe(i < 4 ? 0 : 1);
      tank.health = core.damageComponents(tank, componentPoint(tank, components[i]), 1000, .1, i);
      expect(components[i].health).toBe(0);
      expect(components[6].health).toBe(160);
    }
    expect(activeComponents(tank).map(c => c.id)).toEqual(['core']);
    tank.health = core.damageComponents(tank, componentPoint(tank, components[6]), 1000, .1, 6);
    expect(tank.health).toBe(0); run.match.dispose();
  });
  it('hits the closest wreck until retirement and bounds collision batches without dropping later actors', () => {
    const { run, tank, core } = fixture();
    const wreck = { ...tank, id: 2, components: undefined, health: 0, position: [0, 18, 5] } as TankState;
    const behind = { ...wreck, id: 3, health: 100, position: [0, 18, 10] } as TankState;
    expect(core.sweep([0, 18, 0], [0, 0, 1], 20, [wreck, behind], null)?.tank).toBe(2);
    wreck.retired = true;
    expect(core.sweep([0, 18, 0], [0, 0, 1], 20, [wreck, behind], null)?.tank).toBe(3);
    const crowd = Array.from({ length: 128 }, (_, i) => ({ ...tank, id: i, position: [30 + i, 18, 12] as [number, number, number] }));
    crowd[127] = { ...crowd[127], components: undefined, position: [0, 18, 7] };
    expect(core.sweep([0, 18, 0], [0, 0, 1], 20, crowd, null)?.tank).toBe(127);
    run.match.dispose();
  });
  it('keeps hazard damage and repairs consistent with component pools and checkpoints', () => {
    let api!: ScriptApi;
    const run = realtimeRun(realtimeSetup(), { units: [unit(1, site(12), { components: CRAWLER_COMPONENTS, unarmed: true })], script: { start(a) { api = a; }, tick() {} } });
    const tank = run.match.state.tanks[1]; api.damage(1, 80);
    expect(tank.components![0].health).toBe(0); expect(tank.components![1].health).toBe(10);
    api.heal(1, 20); expect(tank.components![0].health).toBe(0); expect(tank.components![1].health).toBe(30);
    expect(tank.health).toBe(tank.components!.reduce((sum, c) => sum + c.health, 0));
    const restored = new RealtimeMatch(new SphereWorld(), run.match.setup, { checkpoint: run.match.checkpoint()! });
    expect(restored.state.tanks[1].components).toEqual(tank.components);
    expect(restored.matchHash()).toBe(run.match.matchHash());
    api.damage(1, 10000); expect(tank.components!.every(c => c.health === 0)).toBe(true);
    run.run(1); expect(run.events.filter(e => e.type === 'kill' && e.tank === 1)).toHaveLength(1);
    run.match.dispose(); restored.dispose();
  });
  it('rejects corrupted component checkpoints before packing them into the native core', () => {
    const { run } = fixture();
    for (const corrupt of [
      (tank: TankState) => { tank.components![0].radius = NaN; },
      (tank: TankState) => { tank.components = Array.from({ length: 17 }, () => tank.components![0]); },
      (tank: TankState) => { tank.components![0].stage = 99; },
      (tank: TankState) => { tank.health += 1; },
    ]) {
      const saved = run.match.checkpoint()!; corrupt(saved.state.tanks[1]);
      expect(() => new RealtimeMatch(new SphereWorld(), run.match.setup, { checkpoint: saved })).toThrow(/component state/);
    }
    run.match.dispose();
  });
});
