import { expect, it } from 'vitest';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { setup, LATEST_ENGINE } from './helpers/rust-resident';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import { resolveArtillerySpawns } from '../src/game/rules/spawn-placement';
import { spawnPose } from '../src/game/rules/setup';
import { practiceSetup } from '../src/game/api/match';
import { distance, dot, normalize, rotate } from '../src/game/math';
import { makeTank } from './helpers/vehicle-world';

it.each([0, 1, 2, 3, 7, 13])('seed %i: both duel tanks can drive away from their generated spawn on real terrain', async seed => {
  const { terrain } = await setup(2, true, LATEST_ENGINE, residentPlanet(seed, undefined, 'resident-f32-game-v3'));
  const world = ResidentGameTerrain.adopt(terrain, seed);
  try {
    await world.initialize();
    const player = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
    const opponent = { tracks: 'grip', barrel: 'cannon', armor: 'heavy' } as const;
    const match = resolveArtillerySpawns(world, practiceSetup({ seed, mode: 'local', player, opponent }));
    const tanks = match.tanks.map((_, i) => {
      const pose = spawnPose(world, match, i), tank = makeTank(i, { ...pose, loadout: i ? opponent : player });
      tank.heading = pose.heading; return tank;
    });
    for (let i = 0; i < 60; i++) world.stepTanks(tanks, tanks.map(() => ({ throttle: 0, steer: 0 })), 1 / 60);
    const starts = tanks.map(t => [...t.position] as typeof t.position);
    for (let i = 0; i < 180; i++) world.stepTanks(tanks, tanks.map((t, id) => ({ throttle: distance(starts[id], t.position) < 3 ? .5 : 0, steer: 0 })), 1 / 60);
    for (const [i, tank] of tanks.entries()) {
      expect(distance(starts[i], tank.position)).toBeGreaterThan(1);
      expect(dot(rotate([0, 1, 0], tank.rotation), normalize(tank.position))).toBeGreaterThan(.8);
      expect(world.isSolid(tank.position)).toBe(false);
    }
  } finally { world.dispose(); }
}, 90000);
