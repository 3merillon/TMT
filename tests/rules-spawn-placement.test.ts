import { expect, it } from 'vitest';
import { practiceSetup } from '../src/game/api/match';
import { resolveArtillerySpawns } from '../src/game/rules/spawn-placement';
import { spawnPose } from '../src/game/rules/setup';
import { add, distance, mul, normalize, sub } from '../src/game/math';
import type { V3 } from '../src/game/contracts';
import { SphereWorld } from './helpers/sphere-world';

const setup = () => practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });

it('resolves deterministic, separated duel positions with terrain blocking elevated sightlines', () => {
  const world = new SphereWorld(), original = setup(), placed = resolveArtillerySpawns(world, original);
  expect(resolveArtillerySpawns(world, original)).toEqual(placed);
  expect(original.tanks.every(t => t.spawn === 'auto')).toBe(true);
  const [a, b] = placed.tanks.map((_, i) => spawnPose(world, placed, i).position);
  expect(distance(a, b)).toBeGreaterThan(world.radius * 1.2);
  const start = add(a, mul(normalize(a), 2)), end = add(b, mul(normalize(b), 2)), d = sub(end, start);
  expect(world.raycast(start, normalize(d), Math.hypot(...d))).not.toBeNull();
  expect(resolveArtillerySpawns(world, placed)).toBe(placed);
});

it('rejects steep terrain and a flat but isolated landing patch', () => {
  const world = new SphereWorld(), surface = world.surface.bind(world);
  world.surface = direction => {
    const up = normalize(direction), hit = surface(up);
    if (!hit) return null;
    // Tiny flat patch at the pole surrounded by steep, undriveable rock.
    if (up[1] > .96 && up[1] < .9998) hit.normal = [up[1], -up[0], 0];
    return hit;
  };
  const placed = resolveArtillerySpawns(world, setup());
  for (const tank of placed.tanks) {
    expect(tank.spawn).not.toBe('auto');
    if (tank.spawn !== 'auto') expect(tank.spawn.up[1]).toBeLessThan(.96);
  }
});

it('checks the whole track footprint and excludes imminent excavations', () => {
  const world = new SphereWorld(), original = setup();
  original.initialCuts = [{ id: 'opening-crater', center: [0, 18, 0], radius: 5 }];
  const placed = resolveArtillerySpawns(world, original);
  for (let i = 0; i < placed.tanks.length; i++) expect(distance(spawnPose(world, placed, i).position, [0, 18, 0])).toBeGreaterThan(11);
  const empty = new SphereWorld(); empty.surface = () => null;
  expect(() => resolveArtillerySpawns(empty, setup())).toThrow('No safe artillery spawn pair');
});

it('keeps authored, campaign and driving placements, while placing an auto opponent out of sight', () => {
  const world = new SphereWorld(), original = setup();
  original.tanks[0].spawn = { up: [0, 1, 0], heading: .3 };
  const placed = resolveArtillerySpawns(world, original);
  expect(placed.tanks[0].spawn).toEqual(original.tanks[0].spawn);
  expect(placed.tanks[1].spawn).not.toBe('auto');
  for (const mode of ['drive', 'campaign'] as const) {
    const authored = { ...setup(), mode };
    expect(resolveArtillerySpawns(world, authored)).toBe(authored);
  }
  const impossible = new SphereWorld(); impossible.raycast = () => null;
  impossible.surface = (up: V3) => ({ point: mul(normalize(up), 18), normal: normalize(up), distance: 10, material: 1 });
  expect(() => resolveArtillerySpawns(impossible, setup())).toThrow('No safe artillery spawn pair');
});
