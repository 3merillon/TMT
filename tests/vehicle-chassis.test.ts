/** The solver chassis construction (W1-PHY): ballasted mass properties from the assembly, the collider set and its
 * collision groups, static-terrain trimesh flags, the StructuralPhysics force/torque queue, the FORCE_PROVIDERS
 * registry, deterministic input shaping, the chassis drive state in the checkpoint motions, chassisReach, the tank-contact
 * probe, the representative suspension stations and dispose(). */
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import type { TankState } from '../src/game/contracts';
import { assembleKit, kitLoadoutFromLegacy, type KitAssembly } from '../src/game/kit';
import { kitBumpStops, kitWheelOffsets } from '../src/game/kit/assembly';
import { COLLISION_GROUP, collisionGroups, StructuralPhysics } from '../src/game/structural-physics';
import { BALLAST, chassisMassProps, ROLL_INERTIA_PER_MASS, SELF_RIGHT } from '../src/game/vehicle/tuning';
import { chassisReach, chassisShapes } from '../src/game/vehicle/chassis';
import { WHEEL_PROBE_GROUPS, type TankTouch } from '../src/game/vehicle/drive-model';
import { shapeInput } from '../src/game/vehicle/input-shaping';
import { FORCE_PROVIDERS, type ChassisForceContext } from '../src/game/vehicle/force-providers';
import { ResidentTanks, type ChassisMotion } from '../src/game/resident-tanks';
import { addBox, axisAngle, DEFAULT, flatTank, HEAVY, IDLE, kitOf, LEGACY_LOADOUTS, loadoutName, rideHeight, TICK, tilt, withWorld } from './helpers/vehicle-world';

interface ChassisInternals { chassis: Map<number, { body: RAPIER.RigidBody; colliders: RAPIER.Collider[]; kit: KitAssembly; recovery: { righting: number; flipped: number } }> }
const internals = (bridge: ResidentTanks) => bridge as unknown as ChassisInternals;
/** Rapier interaction test between two packed group words. */
const interacts = (a: number, b: number) => ((a >>> 16) & (b & 0xffff)) !== 0 && ((b >>> 16) & (a & 0xffff)) !== 0;

describe('mass properties', () => {
  for (const loadout of LEGACY_LOADOUTS) it(`${loadoutName(loadout)}: the ballast keel puts the COM at y −0.25…−0.22, z ≈ −0.02 and keeps the kit mass`, async () => {
    const kit = assembleKit(kitLoadoutFromLegacy(loadout)), props = chassisMassProps(kit);
    expect(props.mass).toBe(kit.massProps.mass);
    expect(props.com[1]).toBeGreaterThanOrEqual(-.25); expect(props.com[1]).toBeLessThanOrEqual(-.22);
    expect(props.com[2]).toBeCloseTo(-.02, 2);
    expect(props.inertia[2]).toBeGreaterThanOrEqual(ROLL_INERTIA_PER_MASS * props.mass - 1e-12);
    expect(props.ballastFraction).toBeGreaterThanOrEqual(0); expect(props.ballastFraction).toBeLessThanOrEqual(BALLAST.maxFraction);
    await withWorld(w => {
      const t = flatTank(w, loadout); w.step();
      const body = internals(w.bridge).chassis.get(t.id)!.body;
      body.recomputeMassPropertiesFromColliders(); // zero-density colliders: the additional properties are the chassis
      const com = body.localCom();
      expect(body.mass()).toBeCloseTo(props.mass, 4);
      [com.x, com.y, com.z].forEach((v, i) => expect(v).toBeCloseTo(props.com[i], 5));
    });
  });
  it('never raises an already-low COM and caps the keel for a very high one', () => {
    const fake = (y: number) => ({ key: `fake${y}`, massProps: { mass: 10, com: [0, y, .01], inertia: [4, 5, 2] } }) as unknown as KitAssembly;
    const low = chassisMassProps(fake(-.3));
    expect(low.ballastFraction).toBe(0); expect(low.com).toEqual([0, -.3, .01]); expect(low.inertia).toEqual([4, 5, ROLL_INERTIA_PER_MASS * 10]);
    const high = chassisMassProps(fake(2));
    expect(high.ballastFraction).toBe(BALLAST.maxFraction); expect(high.com[1]).toBeCloseTo(2 + BALLAST.maxFraction * (BALLAST.keelY - 2), 12);
    expect(() => chassisMassProps(({ key: 'bad', massProps: { mass: 0, com: [0, 0, 0], inertia: [1, 1, 1] } }) as unknown as KitAssembly)).toThrow(/mass/);
  });
  it('reads the kit through tankKit: TankState.kit wins over the legacy loadout and a kit change rebuilds the body', async () => {
    await withWorld(w => {
      w.addPlane();
      // The kit equivalent of the over-budget grip/rail/heavy build: the legacy loadout alone could never be driven.
      const t = flatTank(w, DEFAULT); t.kit = { hull: 'bastion', runningGear: 'grip', turret: 'dome', weapon: 'rail', utility: 'antenna' };
      w.run(30);
      const entry = internals(w.bridge).chassis.get(t.id)!;
      expect(entry.kit.key).toBe('bastion.grip.dome.rail.antenna');
      expect(entry.body.mass()).toBeCloseTo(kitOf(t).massProps.mass, 4);
      t.kit = { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };
      w.run(30);
      const rebuilt = internals(w.bridge).chassis.get(t.id)!;
      expect(rebuilt.body).not.toBe(entry.body);
      expect(rebuilt.body.mass()).toBeCloseTo(kitOf(t).massProps.mass, 4);
      expect(tilt(t).upDot).toBeGreaterThan(.99);
    });
  });
});

describe('collider set', () => {
  it('round hull boxes, capsule stops and articulated turret/barrel colliders that ignore static terrain', async () => {
    await withWorld(w => {
      const t = flatTank(w, { tracks: 'grip', barrel: 'rail', armor: 'heavy' }); w.step();
      const entry = internals(w.bridge).chassis.get(t.id)!, shapes = chassisShapes(entry.kit), terrain = collisionGroups(COLLISION_GROUP.terrain, COLLISION_GROUP.all);
      expect(entry.colliders).toHaveLength(shapes.length);
      expect(shapes.filter(s => s.parent !== 'hull')).toHaveLength(entry.kit.proxies.filter(p => p.parent !== 'hull').length);
      // Proxies, plus the two end gears per side that proxies lack, plus the two stops.
      expect(shapes).toHaveLength(entry.kit.proxies.length + 4 + kitBumpStops(entry.kit).length);
      shapes.forEach((shape, i) => {
        const collider = entry.colliders[i];
        expect(collider.density()).toBe(0);
        expect(interacts(collider.collisionGroups(), terrain), shape.source).toBe(shape.parent === 'hull');
        expect(interacts(collider.collisionGroups(), WHEEL_PROBE_GROUPS), shape.source).toBe(false);
        if (shape.kind === 'capsule') {
          expect(collider.shapeType()).toBe(RAPIER.ShapeType.Capsule);
          expect(collider.radius()).toBeCloseTo(shape.radius, 6); expect(collider.halfHeight()).toBeCloseTo(shape.halfHeight, 6);
          const stop = kitBumpStops(entry.kit).find((_, k) => shape.source === `bumpStop${k}`)!;
          expect(shape.center[1] - shape.radius).toBeCloseTo(stop.center[1] - stop.half[1], 12); // same maximum-compression bottom
          expect(shape.halfHeight + shape.radius).toBeCloseTo(stop.half[2], 12);
        } else if (shape.border > 0) {
          expect(collider.shapeType()).toBe(RAPIER.ShapeType.RoundCuboid);
          const inner = collider.halfExtents()!, r = collider.roundRadius();
          [inner.x + r, inner.y + r, inner.z + r].forEach((v, k) => expect(v).toBeCloseTo(shape.half[k], 6));
        }
      });
    });
  });
  it('the barrel never levers the hull: a depressed rail through a terrain block leaves the tank level', async () => {
    // Every dimension comes from the kit (the block used to be pinned to kit v1: a muzzle at −35°, a hull reaching 1.01):
    // the block starts 0.1 ahead of the hull-frame colliders (hull, fenders, end gears) and its top is 0.2 above the
    // muzzle of the rail depressed to its front-arc limit at ride height, so the barrel is buried in it.
    const loadout = { tracks: 'scout', barrel: 'rail', armor: 'light' } as const, kit = assembleKit(kitLoadoutFromLegacy(loadout)), pitch = kit.pitchLimits(0).min;
    const ring = kit.frames.turretRing.position, trunnion = kit.frames.trunnion.position, length = kit.weapon.barrelLength;
    const zReach = (s: ReturnType<typeof chassisShapes>[number]) => s.kind === 'capsule' ? s.halfHeight + s.radius : s.rotation[3] === 1 ? s.half[2] : Math.hypot(s.half[1], s.half[2]);
    const front = Math.max(...chassisShapes(kit).filter(s => s.parent === 'hull').map(s => s.center[2] + zReach(s)));
    const top = -kitWheelOffsets(kit)[0][1] + ring[1] + trunnion[1] + Math.sin(pitch) * length + .2;
    await withWorld(w => {
      w.addPlane(); addBox(w, [-2, -1, front + .1], [2, top, 2.6]); // clear of the hull and end gears, under the depressed barrel
      const t = flatTank(w, loadout); t.barrelPitch = pitch;
      w.run(120);
      // The muzzle is buried deep in the block (hull frame; the root rides at rideHeight above the plane).
      const muzzleY = t.position[1] + ring[1] + trunnion[1] + Math.sin(t.barrelPitch) * length, muzzleZ = t.position[2] + ring[2] + trunnion[2] + Math.cos(t.barrelPitch) * length;
      expect(muzzleZ).toBeGreaterThan(front + .1 + .1); expect(muzzleY).toBeLessThan(top - .15);
      expect(Math.abs(tilt(t).pitch)).toBeLessThan(1.5);
      expect(Math.abs(t.position[1] - rideHeight(t))).toBeLessThan(.03);
      // Raising the barrel back out of the block moves nothing either.
      t.barrelPitch = .4; w.run(30);
      expect(Math.abs(tilt(t).pitch)).toBeLessThan(1.5);
    });
  });
  it('static terrain pages are trimeshes with FIX_INTERNAL_EDGES in the terrain group', async () => {
    await withWorld(w => {
      w.addPlane();
      const colliders: RAPIER.Collider[] = [];
      w.physics.world.forEachCollider(c => { if (c.parent()?.isFixed()) colliders.push(c); });
      expect(colliders).toHaveLength(1);
      expect((colliders[0].shape as unknown as { flags: number }).flags).toBe(RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
      expect(colliders[0].collisionGroups()).toBe(collisionGroups(COLLISION_GROUP.terrain, COLLISION_GROUP.all));
    });
  });
  it('chassisReach bounds every collider at any turret yaw and barrel pitch', async () => {
    for (const loadout of LEGACY_LOADOUTS) await withWorld(w => {
      w.addPlane();
      const t = flatTank(w, loadout), kit = kitOf(t), reach = chassisReach(kit), limits = kit.pitchLimits(0);
      for (const yaw of [0, 1.3, Math.PI, -2.2]) for (const pitch of [limits.min, limits.max]) {
        t.turretYaw = yaw; t.barrelPitch = pitch; w.step();
        const entry = internals(w.bridge).chassis.get(t.id)!, origin = entry.body.translation();
        for (const collider of entry.colliders) {
          const p = collider.translation(), shape = collider.shapeType() === RAPIER.ShapeType.Capsule ? collider.halfHeight() + collider.radius()
            : Math.hypot(...Object.values(collider.halfExtents()!)) + (collider.shapeType() === RAPIER.ShapeType.RoundCuboid ? collider.roundRadius() : 0);
          expect(Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) + shape, `${loadoutName(loadout)} yaw ${yaw} pitch ${pitch}`).toBeLessThanOrEqual(reach + 1e-9);
        }
      }
    });
  });
});

describe('tank contact probe', () => {
  interface TouchInternals { chassis: Map<number, { touch: TankTouch }> }
  it('reports the head-on contact force and point of two tanks pressed nose to nose, and nothing apart', async () => {
    await withWorld(w => {
      w.addPlane();
      const a = flatTank(w, DEFAULT, [0, 0, 0]), b = flatTank(w, DEFAULT, [0, 0, 2.2], axisAngle([0, 1, 0], Math.PI));
      w.run(20);
      const touch = (id: number) => (w.bridge as unknown as TouchInternals).chassis.get(id)!.touch;
      expect(touch(a.id).count).toBe(0);
      w.run(60, () => [{ throttle: 1, steer: 0 }, IDLE]);
      w.step([{ throttle: 1, steer: 0 }, IDLE]); // probe the last step's manifolds
      for (const t of [a, b]) {
        const { count, total, force, moment } = touch(t.id), height = moment.y / force - (t.position[1] - rideHeight(t));
        expect(count).toBeGreaterThan(0);
        expect(force).toBeGreaterThan(20); expect(force).toBeLessThanOrEqual(total + 1e-9);
        expect(force / total).toBeGreaterThan(.9); // head-on
        expect(height).toBeGreaterThan(.2); expect(height).toBeLessThan(.9); // bumper height above the ground
        expect(Math.abs(moment.z / force - (a.position[2] + b.position[2]) / 2)).toBeLessThan(.3); // between the two
      }
    });
  });
  it('TankState.suspension reports the four axle-end stations of the kit (driver-right rear, left rear, right front, left front)', async () => {
    await withWorld(w => {
      w.addPlane(); const t = flatTank(w, DEFAULT); w.run(30);
      const stations = kitOf(t).running.stations, order = [4, 0, 7, 3];
      expect(order.map(i => stations[i].side)).toEqual([-1, 1, -1, 1]);
      expect(stations[4].z).toBe(Math.min(...stations.filter(s => s.side < 0).map(s => s.z)));
      expect(stations[3].z).toBe(Math.max(...stations.filter(s => s.side > 0).map(s => s.z)));
      expect(t.suspension).toEqual(order.map(i => t.wheelSuspension[i]));
    });
  });
  it('dispose() removes every chassis body from the world', async () => {
    await withWorld(w => {
      w.addPlane(); flatTank(w, DEFAULT, [0, 0, 0]); flatTank(w, HEAVY, [4, 0, 0]); w.step();
      expect(w.physics.world.bodies.len()).toBe(3);
      w.bridge.dispose();
      expect(w.physics.world.bodies.len()).toBe(1);
      expect(w.physics.actors.size).toBe(0);
      expect(w.bridge.bodyOf(0)).toBeUndefined();
    });
  });
});

describe('StructuralPhysics queue', () => {
  async function spinner() {
    const physics = await StructuralPhysics.create([0, -1e9, 0]);
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setAngularDamping(0));
    physics.world.createCollider(RAPIER.ColliderDesc.ball(1).setDensity(1), body); physics.actors.add(body);
    return { physics, body };
  }
  it('applies queued torques after the step reset, while a plain addTorque before step() is erased', async () => {
    const { physics, body } = await spinner();
    try {
      body.addTorque({ x: 0, y: 10, z: 0 }, true); physics.step();
      expect(body.angvel().y).toBe(0);
      const inertia = body.principalInertia().y;
      physics.addContactTorque(body, [0, 10, 0]); physics.step();
      expect(body.angvel().y).toBeCloseTo(10 / inertia * TICK, 5);
      physics.step(); // the queue is consumed: no torque carries over
      expect(body.angvel().y).toBeCloseTo(10 / inertia * TICK, 5);
    } finally { physics.dispose(); }
  });
  it('applies each queued force exactly once, however many are queued', async () => {
    const { physics, body } = await spinner();
    try {
      for (let i = 0; i < 200; i++) physics.addContactForce(body, [1, 0, 0], [0, 0, 0]);
      physics.step(); const vx = body.linvel().x;
      expect(vx).toBeCloseTo(200 / body.mass() * TICK, 4);
      physics.step(); expect(body.linvel().x).toBeCloseTo(vx, 6);
    } finally { physics.dispose(); }
  });
  it('never reads the wall clock itself: lastStepMs uses an injected clock or stays 0', async () => {
    const plain = await StructuralPhysics.create([0, 0, 0]);
    let now = 5;
    const timed = await StructuralPhysics.create([0, 0, 0], { clock: () => (now += 2) });
    try { plain.step(); timed.step(); expect(plain.lastStepMs).toBe(0); expect(timed.lastStepMs).toBe(2); }
    finally { plain.dispose(); timed.dispose(); }
  });
});

describe('FORCE_PROVIDERS', () => {
  it('runs registered providers after the drive model with a working context and applies their modifiers', async () => {
    const seen: { tick: number; dt: number; kit: string; tank: number }[] = [];
    let modifiers = { traction: 1, lateral: 1, angularDampingAdd: 0 }, lift = 0;
    const factory = () => ({
      id: 'test-provider',
      modifiers: () => modifiers,
      apply(c: ChassisForceContext) {
        seen.push({ tick: c.tick, dt: c.dt, kit: c.kit.key, tank: c.tank.id });
        const com = c.tank.position, v = c.pointVelocity(com);
        expect(v.every(Number.isFinite)).toBe(true);
        if (lift) c.addForceAtPoint([0, lift, 0], com);
        c.addTorque([0, 0, 0]);
      },
    });
    FORCE_PROVIDERS.push(factory);
    try {
      await withWorld(w => {
        w.addPlane(); const t = flatTank(w, DEFAULT), mass = kitOf(t).massProps.mass;
        w.run(60);
        expect(seen).toHaveLength(60); expect(seen[59]).toMatchObject({ dt: TICK, kit: kitOf(t).key, tank: t.id }); expect(seen[59].tick - seen[0].tick).toBe(59);
        // Traction 0: full throttle cannot move the tank.
        modifiers = { traction: 0, lateral: 0, angularDampingAdd: .5 };
        const z = t.position[2]; w.run(60, () => ({ throttle: 1, steer: 0 }));
        expect(Math.abs(t.position[2] - z)).toBeLessThan(.02);
        expect(internals(w.bridge).chassis.get(t.id)!.body.angularDamping()).toBeCloseTo(.8 + .5, 6);
        // A provider force (buoyancy-like, 3 g upward) lifts the tank off the ground.
        modifiers = { traction: 1, lateral: 1, angularDampingAdd: 0 }; lift = 3 * 9.81 * mass;
        const y = t.position[1]; w.run(30); expect(t.position[1]).toBeGreaterThan(y + .3);
      });
    } finally { FORCE_PROVIDERS.splice(FORCE_PROVIDERS.indexOf(factory), 1); }
    expect(FORCE_PROVIDERS).not.toContain(factory);
  });
});

describe('input shaping', () => {
  it('slews digital input at 4/s (throttle) and 6/s (steer) and passes analog input straight through', () => {
    const s = { throttle: 0, steer: 0 };
    shapeInput(s, { throttle: 1, steer: -1 }, TICK); expect(s.throttle).toBeCloseTo(4 / 60, 12); expect(s.steer).toBeCloseTo(-6 / 60, 12);
    for (let i = 0; i < 30; i++) shapeInput(s, { throttle: 1, steer: -1 }, TICK);
    expect(s).toEqual({ throttle: 1, steer: -1 });
    shapeInput(s, { throttle: .37, steer: -.52 }, TICK); expect(s).toEqual({ throttle: .37, steer: -.52 });
    shapeInput(s, { throttle: Number.NaN, steer: 7 }, TICK); expect(s.throttle).toBeCloseTo(.37 - 4 / 60, 12); expect(s.steer).toBeCloseTo(-.52 + 6 / 60, 12);
    shapeInput(s, undefined, TICK); expect(Number.isFinite(s.throttle) && Number.isFinite(s.steer)).toBe(true);
  });
});

describe('recovery and checkpoint state', () => {
  it('selfRight on an upright tank does nothing', async () => {
    await withWorld(w => {
      w.addPlane(); const t = flatTank(w, DEFAULT); w.run(60);
      const y = t.position[1]; w.run(30, i => ({ throttle: 0, steer: 0, selfRight: i === 0 }));
      expect(internals(w.bridge).chassis.get(t.id)!.recovery.righting).toBe(-1);
      expect(Math.abs(t.position[1] - y)).toBeLessThan(.01);
    });
  });
  it('a destroyed tank is a wreck: no auto self-right', async () => {
    await withWorld(w => {
      w.addPlane(); const t = w.addTank({ loadout: DEFAULT, position: [0, 1.4, 0], rotation: [0, 0, 1, 0] }); t.health = 0;
      w.run(SELF_RIGHT.autoAfterTicks + SELF_RIGHT.ticks + 60);
      // The actual wreck rocks onto the sloping turret roof rather than a flat proxy box.
      expect(tilt(t).upDot).toBeLessThan(-.7);
      expect(internals(w.bridge).chassis.get(t.id)!.recovery).toEqual({ righting: -1, flipped: 0 });
    });
  });
  it('carries the drive and recovery state through motions() and restore()', async () => {
    let saved: ChassisMotion[] = [];
    await withWorld(w => {
      w.addPlane(); const t = flatTank(w, DEFAULT); w.run(30); w.run(5, () => ({ throttle: 1, steer: -1 }));
      saved = w.bridge.motions();
      expect(saved[0].drive).toMatchObject({ throttle: 20 / 60, steer: -30 / 60, righting: -1, flipped: 0 });
      expect(saved[0].drive!.common).toBeGreaterThan(0);
      void t;
    });
    await withWorld(w => {
      w.addPlane(); const t = flatTank(w, DEFAULT);
      const motion: ChassisMotion = { ...saved[0], drive: { ...saved[0].drive!, righting: SELF_RIGHT.ticks - 2, flipped: 7 } };
      w.bridge.restore([motion]);
      w.step({ throttle: 1, steer: -1 });
      const drive = w.bridge.motions()[0].drive!;
      expect(drive.throttle).toBeCloseTo(saved[0].drive!.throttle + 4 / 60, 12);
      expect(drive.righting).toBe(SELF_RIGHT.ticks - 1);
      w.step(IDLE); expect(w.bridge.motions()[0].drive!.righting).toBe(-1);
      expect(() => w.bridge.restore([{ ...motion, drive: { ...motion.drive!, throttle: 3 } }])).toThrow(/drive state/);
      expect(() => w.bridge.restore([{ ...motion, drive: { ...motion.drive!, righting: .5 } }])).toThrow(/drive state/);
      void (t as TankState);
    });
  });
});
