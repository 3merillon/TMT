import { expect, it, vi } from 'vitest';
import { DebrisDynamics, type RigidShard } from '../src/game/presentation/debris-dynamics';
import { campaignModel } from '../src/game/presentation/campaign-models';
import { createKitPose, assembleKit, tankKit, poseKit } from '../src/game/kit';
import { vehiclePartMissing } from '../src/game/rules/vehicle-parts';
import { makeTank } from './helpers/vehicle-world';
import { testPhysics } from './helpers/native-physics';
import { applyPoint } from '../src/game/kit/geometry/math';
import { add, rotate } from '../src/game/math';
import type { V3, WorldQuery } from '../src/game/contracts';

it.each(['rustling', 'dragonfly', 'skimmer', 'spire', 'relay', 'watchtower'] as const)('%s detached parts fall onto terrain, never a ghost of their intact vehicle', async visualKind => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1');
  const physics = await testPhysics([0, 0, 0]), dynamics = new DebrisDynamics(physics.native!.createPresentationWorld());
  try {
    const tank = makeTank(0, { position: [0, 18.5, 0] }); tank.visualKind = visualKind; tank.health = 0; tank.wheelSuspension.fill(0);
    const floor: WorldQuery = { radius: 18, version: 1, surface: () => null, raycast: () => null, isSolid: p => p[1] < 18,
      visibilityTriangles: () => [{ a: [-40, 18, -40], b: [40, 18, 40], c: [40, 18, -40], normal: [0, 1, 0], material: 1 },
        { a: [-40, 18, -40], b: [-40, 18, 40], c: [40, 18, 40], normal: [0, 1, 0], material: 1 }] };
    const kit = assembleKit(tankKit(tank)), pose = createKitPose(kit); poseKit(kit, tank, pose);
    const shards: RigidShard[] = [];
    for (const part of campaignModel(visualKind, 0)) if (vehiclePartMissing(tank, part.part, part.joint)) {
      const matrix = new Float64Array(pose.joints.get(part.joint) ?? pose.joints.get('hull')!), vertices = new Float32Array(part.positions.length), center: V3 = [0, 0, 0];
      for (let i = 0; i < vertices.length; i += 3) {
        const p = applyPoint(matrix, part.positions[i], part.positions[i + 1], part.positions[i + 2]); vertices.set(p, i);
        for (let k = 0; k < 3; k++) center[k] += p[k] / (vertices.length / 3);
      }
      for (let i = 0; i < vertices.length; i++) vertices[i] -= center[i % 3];
      const shard: RigidShard = { positions: vertices, rotation: [0, 0, 0, 1], angularVelocity: [1, 2, 3],
        body: { position: add(tank.position, center), velocity: [0, 2, 0], radius: .5, age: 0, bounces: 0, sleeping: false, density: 7.5 } };
      dynamics.add(shard); shards.push(shard);
    }
    expect(shards.length).toBeGreaterThan(0);
    // Removing the chassis after the initial launch isolates terrain support and catches floating shards.
    for (let frame = 0; frame < 600; frame++) { dynamics.syncScene(floor, frame < 120 ? [tank] : []); dynamics.step(shards); }
    for (const s of shards) {
      let bottom = Infinity;
      for (let i = 0; i < s.positions.length; i += 3) bottom = Math.min(bottom, add(s.body.position, rotate([s.positions[i], s.positions[i + 1], s.positions[i + 2]], s.rotation))[1]);
      expect(bottom).toBeGreaterThan(17.94); expect(bottom).toBeLessThan(18.08);
      // Long rotor blades can still rock against the ground; no shard retains a launch/fall velocity.
      expect(Math.hypot(...s.body.velocity)).toBeLessThan(.25);
    }
  } finally { dynamics.dispose(); physics.dispose(); vi.unstubAllEnvs(); }
}, 30000);
