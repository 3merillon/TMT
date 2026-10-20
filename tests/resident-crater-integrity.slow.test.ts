import { CameraPose } from '../src/game/presentation/camera-pose';
import { expect, it } from 'vitest';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { setup, LATEST_ENGINE } from './helpers/rust-resident';
import { resolveArtillerySpawns } from '../src/game/rules/spawn-placement';
import { spawnPose } from '../src/game/rules/setup';
import { practiceSetup } from '../src/game/api/match';
import { TankFollowCamera, cameraClearanceRadius } from '../src/game/follow-camera';
import type { V3 } from '../src/game/contracts';

it.each([7, 13])('keeps seed %i closed through overlapping excavations down to the protected core', async seed => {
  const { terrain } = await setup(2, true, LATEST_ENGINE, residentPlanet(seed, undefined, 'resident-f32-game-v3'));
  try {
    await terrain.initialize();
    const match = resolveArtillerySpawns(terrain.queries, practiceSetup({ seed, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    expect(match.tanks.every(t => t.spawn !== 'auto')).toBe(true);
    const camera = new CameraPose(65, 2.4, .08, 220), follow = new TankFollowCamera(camera), target: V3 = [0, 0, 0];
    follow.update(spawnPose(terrain.queries, match, 0), target, 0, true, terrain.queries);
    for (const [i, center] of ([[0, 18, 0], [0, 12, 0], [0, 6, 0], [4, 6, 2]] as V3[]).entries()) {
      await terrain.cut({ id: `deep-${i}`, center, radius: 8 });
      expect(terrain.history.at(-1)?.seam).toMatchObject({ unpaired: 0, orientationErrors: 0 });
      expect(terrain.verifyOracle()).toEqual([]); // Includes detached fragments and their closed boundaries.
      expect(terrain.queries.isSolid([0, 0, 0])).toBe(true);
      const floor = terrain.queries.surface([0, 1, 0]);
      expect(floor).not.toBeNull();
      const tank = { position: [0, floor!.point[1] + .55, 0] as V3, rotation: [0, 0, 0, 1] as [number, number, number, number] };
      for (let frame = 0; frame < 48; frame++) {
        follow.orbit(40, -15); follow.addTrauma(1); follow.update(tank, target, 1 / 60, false, terrain.queries);
        expect(terrain.queries.isSolid(camera.position)).toBe(false);
        expect(terrain.queries.sweepSphere(camera.position, [0, 1, 0], 0, cameraClearanceRadius(camera))).toBeNull();
      }
    }
  } finally { terrain.dispose(); }
}, 90000);
