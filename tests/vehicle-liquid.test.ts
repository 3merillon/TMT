import { describe, expect, it } from 'vitest';
import { liquidResistance } from '../src/game/vehicle/liquid-motion';
import { GameLiquids, GAME_LIQUID_N, validateLiquidCheckpoint } from '../src/game/liquids';
import { FLAT_PLANET_CENTER, flatTank, makeTank, VehicleWorld } from './helpers/vehicle-world';
import type { WorldQuery } from '../src/game/contracts';

describe('liquid drive resistance', () => {
  it('ramps from dry through track immersion to 60% speed in water and 30% in lava', () => {
    const tank = makeTank(0, { position: [0, 100.5, 0] });
    const at = (level: number, material: 'water' | 'lava' = 'water') => liquidResistance(tank, () => ({ level, material }));
    expect(at(99).speed).toBe(1);
    expect(at(100.1).speed).toBeGreaterThan(.97);
    const speeds = [100, 100.1, 100.25, 100.5, 100.75, 101, 102].map(level => at(level).speed);
    expect(speeds).toEqual([...speeds].sort((a, b) => b - a));
    expect(at(102).speed).toBeCloseTo(.6);
    expect(at(102, 'lava').speed).toBeCloseTo(.3);
    expect(at(102, 'lava').drag).toBeGreaterThan(at(102).drag);
    tank.rotation = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    expect(at(100.5).submerged).toBeGreaterThan(.1);
    expect(at(100.5).submerged).toBeLessThan(.9);
    expect(at(102).speed).toBeCloseTo(.6);
  });
  it.each(['water', 'lava'] as const)('%s slows both player and enemy physics, then restores speed on land', async material => {
    let level = 99999;
    const world = await VehicleWorld.create(FLAT_PLANET_CENTER, () => ({ level, material }));
    try {
      world.addPlane(); const player = flatTank(world, undefined, [-5, 0, 0]), enemy = flatTank(world, undefined, [5, 0, 0]);
      const input = [{ throttle: 1, steer: 0 }, { throttle: 1, steer: 0 }];
      world.run(200, () => input);
      const dry = world.tanks.map(t => Math.hypot(t.velocity[0], t.velocity[2]));
      level = 100005; world.run(200, () => input);
      const wet = world.tanks.map(t => Math.hypot(t.velocity[0], t.velocity[2]));
      const target = material === 'water' ? .6 : .3;
      for (let i = 0; i < 2; i++) expect(wet[i] / dry[i]).toBeGreaterThan(target - .04);
      for (let i = 0; i < 2; i++) expect(wet[i] / dry[i]).toBeLessThan(target + .03);
      expect(wet[0]).toBeCloseTo(wet[1], 3);
      level = 99999; world.run(200, () => input);
      expect(Math.hypot(player.velocity[0], player.velocity[2]) / dry[0]).toBeGreaterThan(.97);
      expect(Math.hypot(enemy.velocity[0], enemy.velocity[2]) / dry[1]).toBeGreaterThan(.97);
    } finally { world.dispose(); }
  });
  it('preserves the gameplay basin layout across saves and ignores later relocated spawns', () => {
    let reads = 0;
    const world = { surface(d: number[]) { reads++; const r = 16 + d[1]; return { point: d.map(v => v * r) }; } } as unknown as WorldQuery;
    const field = new GameLiquids(world, 'volcanic');
    field.configure([[0, 18, 0]]);
    expect(reads).toBe(6 * GAME_LIQUID_N ** 2);
    expect(field.sample([0, -15.2, 0])?.material).toBe('lava');
    const snapshot = field.checkpoint()!;
    const restored = new GameLiquids(world, 'volcanic'); restored.restore(validateLiquidCheckpoint(snapshot));
    restored.configure([[0, -15.2, 0]]);
    expect(restored.checkpoint()).toEqual(snapshot);
    expect(restored.sample([0, -15.2, 0])).toEqual(field.sample([0, -15.2, 0]));
    expect(reads).toBe(6 * GAME_LIQUID_N ** 2);
    expect(() => validateLiquidCheckpoint({ ...snapshot, labels: [Infinity] })).toThrow('Invalid checkpoint liquids');
  });
});
