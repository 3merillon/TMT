import { expect, it, vi } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { testPhysics } from './helpers/native-physics';
import { axisAngle, DEFAULT, FLAT_PLANET_CENTER, HEAVY, kitOf, makeTank } from './helpers/vehicle-world';
import { DriveModel, type ChassisFrame, type DriveCommand } from '../src/game/vehicle/drive-model';
import { NativeDriveModel } from '../src/game/vehicle/native-drive';
import { chassisMassProps } from '../src/game/vehicle/tuning';
import { rotateInto, vec } from '../src/game/vehicle/vec';

function frame(body: RAPIER.RigidBody): ChassisFrame {
  const position = body.translation(), rotation = body.rotation(), delta = [position.x, position.y + 100000, position.z], l = Math.hypot(...delta) || 1;
  return { position, rotation, com: body.worldCom(), linvel: body.linvel(), angvel: body.angvel(),
    right: rotateInto(vec(), rotation, 1, 0, 0), up: rotateInto(vec(), rotation, 0, 1, 0), forward: rotateInto(vec(), rotation, 0, 0, 1), planetUp: vec(delta[0] / l, delta[1] / l, delta[2] / l) };
}
const telemetry = (t: ReturnType<typeof makeTank>) => [...t.trackSpeeds, ...t.trackContact, ...t.trackGroundSpeeds, ...t.trackSlip, ...t.wheelSuspension];
function near(a: number[], b: number[], tolerance: number) { expect(a.length).toBe(b.length); for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `word ${i}: ${a[i]} versus ${b[i]}`).toBeLessThan(tolerance); }

it.each(['fixed', 'moving', 'dynamic'] as const)('matches the TS force model on %s supports without host wheel queries or force callbacks', async supportKind => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1');
  const a = await testPhysics(FLAT_PLANET_CENTER), b = await testPhysics(FLAT_PLANET_CENTER);
  try {
    const tanks = [makeTank(0, { loadout: supportKind === 'dynamic' ? HEAVY : DEFAULT, position: [0, .5, 0] }), makeTank(0, { loadout: supportKind === 'dynamic' ? HEAVY : DEFAULT, position: [0, .5, 0] })];
    const kit = kitOf(tanks[0]), props = chassisMassProps(kit);
    const entries = [a, b].map(physics => {
      const floor = physics.world.createRigidBody((supportKind === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : supportKind === 'moving' ? RAPIER.RigidBodyDesc.kinematicVelocityBased() : RAPIER.RigidBodyDesc.dynamic()).setTranslation(0, -.25, 0));
      physics.world.createCollider(RAPIER.ColliderDesc.cuboid(8, .25, 8).setDensity(2), floor);
      const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, .5, 0).setAdditionalMassProperties(props.mass,
        vec(...props.com), vec(...props.inertia), { x: 0, y: 0, z: 0, w: 1 }));
      physics.actors.add(body); physics.step(); return { physics, floor, body };
    });
    const old = new DriveModel(a, kit), native = new NativeDriveModel(b, kit, entries[1].body);
    expect(native.suspensionOrder).toEqual(old.suspensionOrder);
    const call = b.native!.call.bind(b.native!);
    const boundary = vi.spyOn(b.native!, 'call').mockImplementation((op, id, words) => { if (op === 40 || op === 13) throw new Error('Host wheel/point query'); return call(op, id, words); });
    const force = vi.spyOn(b, 'addContactForce');
    for (let i = 0; i < 48; i++) {
      const q = axisAngle([1, 0, 1], .13 * Math.sin(i)), commands: DriveCommand[] = [];
      for (const [j, { body, floor, physics }] of entries.entries()) {
        body.setTranslation(vec(.2, .46 + .08 * Math.cos(i), .1), true); body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
        body.setLinvel(vec(.3 * Math.sin(i), .1, 1.2 * Math.cos(i)), true); body.setAngvel(vec(.1, .4 * Math.sin(i), -.2), true);
        floor.setTranslation(vec(0, -.25, 0), true); floor.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        if (supportKind !== 'fixed') { floor.setLinvel(vec(.2, 0, -.4), true); floor.setAngvel(vec(0, .03, 0), true); }
        commands[j] = { throttle: Math.sin(i), steer: Math.cos(i), traction: .8, lateral: 1.1, yawRate: 0,
          touch: i % 3 ? null : { count: 2, total: 20, force: 15, moment: vec(0, 9, 12) } };
        physics.addContactForce(body, [.2, 1, .3], [.1, .4, -.2]); physics.addContactTorque(body, [.03, -.1, .02]);
      }
      old.common = native.common = .5 * Math.sin(i / 3);
      const reports = [old.apply(entries[0].body, tanks[0], frame(entries[0].body), commands[0], 1 / 60), native.apply(entries[1].body, tanks[1], frame(entries[1].body), commands[1], 1 / 60)];
      // The only host force so far is the explicit external force above.
      expect(force).toHaveBeenCalledTimes(1); force.mockClear();
      expect(reports[1].contacts).toBe(reports[0].contacts); expect(reports[1].front).toBe(reports[0].front); expect(reports[1].rear).toBe(reports[0].rear);
      near(telemetry(tanks[1]), telemetry(tanks[0]), 1e-8); expect(native.common).toBeCloseTo(old.common, 12);
      for (const { physics, body } of entries) { physics.addContactForce(body, [-.4, .2, 1], [.3, -.2, .1]); physics.step(); }
      force.mockClear();
      for (const key of ['body', 'floor'] as const) {
        const x = entries[0][key], y = entries[1][key];
        near(Object.values(y.linvel()), Object.values(x.linvel()), 2e-6); near(Object.values(y.angvel()), Object.values(x.angvel()), 2e-6);
      }
      if (i % 4 === 0) { old.updateBelts(tanks[0], commands[0], frame(entries[0].body), 1 / 60); native.updateBelts(tanks[1], commands[1], frame(entries[1].body), 1 / 60); old.idle(tanks[0]); native.idle(tanks[1]); near(telemetry(tanks[1]), telemetry(tanks[0]), 1e-8); }
    }
    boundary.mockRestore();
    expect(() => b.native!.call(61, entries[1].body.handle, [NaN])).toThrow('Invalid native drive');
    native.common = .75; expect(native.common).toBe(.75);
    b.world.removeRigidBody(entries[1].body); expect(() => { native.common = 0; }).toThrow('Unknown native drive');
  } finally { a.dispose(); b.dispose(); vi.unstubAllEnvs(); }
});
