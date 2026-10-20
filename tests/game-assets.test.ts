/**
 * Tank asset contract (W1-KIT rewrite): every expectation is derived from the kit (assembleKit / buildKitMesh /
 * poseKit), not from literals of the retired Blender kit.
 * - The review GLB (scripts/kit/export-kit.ts) carries the kit's socket frames and joint hierarchy, sits on the
 *   ground plane and matches the kit's rest geometry.
 * - For every Appendix A loadout: posed muzzle = ring ∘ yaw ∘ trunnion ∘ pitch ∘ muzzle frame; recoil moves the
 *   tube but never the muzzle frame; the sensor is shared; ≤ 24 draws at every LOD; wheels on their stations.
 * - Belts: planted on y = −0.5 at rest, wheels touching the belt, return rollers under the top run, no cut
 *   through a wheel over the suspension extremes, a closed loop, opposite roll in a pivot, ground conformance.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Loadout, TankState } from '../src/game/contracts';
import {
  assembleKit, buildKitMesh, createKitPose, instanceMatrix, kitInstanceSource, kitLoadoutFromLegacy, kitMeshBudget, poseKit,
  type KitAssembly, type KitLoadout, type KitPose,
} from '../src/game/kit';
import { kitContext } from '../src/game/kit/build';
import { BELT_SHOE, gearRig, hubDrop, linkSlot, SUSPENSION } from '../src/game/kit/running';
import { kitContextOf } from '../src/game/kit/assembly';
import { exportKitGlb } from '../scripts/kit/export-kit';

const LEGACY: Loadout[] = (['scout', 'grip'] as const).flatMap(tracks => (['mortar', 'cannon', 'rail'] as const)
  .flatMap(barrel => (['light', 'heavy'] as const).map(armor => ({ tracks, barrel, armor }))));
const GEARS: KitLoadout[] = (['scout', 'grip', 'crawler'] as const).map(runningGear => ({ hull: 'warden', runningGear, turret: 'dome', weapon: 'cannon', utility: 'antenna' }));

function state(over: Partial<TankState> = {}): TankState {
  return { id: 0, position: [5, 7, 11], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0.65, barrelPitch: 0.42, power: .5, health: 100,
    charge: 0, movement: 1, recoil: 0, suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0],
    trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0, wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-1.2),
    loadout: { tracks: 'grip', barrel: 'cannon', armor: 'light' }, ...over };
}
const posed = (a: KitAssembly, over: Partial<TankState> = {}): KitPose => { const p = createKitPose(a); poseKit(a, state(over), p); return p; };
const mat = (m: ArrayLike<number>) => new THREE.Matrix4().fromArray(Array.from(m));
/** Link buffer slots of one belt (mesh side 0 = −X), in belt order (running.ts linkSlot). */
const beltSlots = (a: KitAssembly, meshSide: 0 | 1): number[] => {
  const n = gearRig(kitContext(a.loadout).gear).layout.linkCount;
  return Array.from({ length: n }, (_, i) => linkSlot(n, meshSide, i));
};
/** Tank-local vertices of an instanced part (every instance). */
function instancedPoints(a: KitAssembly, pose: KitPose, part: string, lod: 0 | 1 | 2 = 0): THREE.Vector3[] {
  const mesh = buildKitMesh(a, lod).parts.find(p => p.part === part)!, src = kitInstanceSource(a, mesh)!, out: THREE.Vector3[] = [];
  for (let i = 0; i < src.count; i++) {
    const m = mat(instanceMatrix(pose[src.buffer], src.first + i));
    for (let v = 0; v < mesh.positions.length; v += 3) out.push(new THREE.Vector3(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]).applyMatrix4(m));
  }
  return out;
}

describe('tank asset contract (kit-derived)', () => {
  it('exports the kit sockets, joint hierarchy and rest geometry in the review GLB', async () => {
    const a = assembleKit(kitLoadoutFromLegacy({ tracks: 'grip', barrel: 'cannon', armor: 'heavy' }));
    const bytes = exportKitGlb(a);
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    gltf.scene.updateMatrixWorld(true);
    const at = (name: string) => gltf.scene.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
    const f = a.frames, ring = new THREE.Vector3(...f.turretRing.position), trunnion = ring.clone().add(new THREE.Vector3(...f.trunnion.position));
    expect(at('turret_ring').distanceTo(ring)).toBeLessThan(1e-5);
    expect(at('trunnion').distanceTo(trunnion)).toBeLessThan(1e-5);
    expect(at('muzzle').distanceTo(trunnion.clone().add(new THREE.Vector3(...f.muzzle.position)))).toBeLessThan(1e-5);
    expect(at('sensor').distanceTo(new THREE.Vector3(...f.sensor.position))).toBeLessThan(1e-5);
    f.exhausts.forEach((e, i) => expect(at(`exhaust_${i}`).distanceTo(new THREE.Vector3(...e.position))).toBeLessThan(1e-5));
    expect(gltf.scene.getObjectByName('muzzle')!.parent!.name).toBe('cradle');
    expect(gltf.scene.getObjectByName('barrel')!.parent!.name).toBe('cradle');
    expect(gltf.scene.getObjectByName('trunnion')!.userData.class).toBe('M');
    // Rest geometry: the belts' grousers sit on the ground plane; the top is the antenna whip / turret.
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    expect(bounds.min.y).toBeGreaterThan(-0.506);
    expect(bounds.min.y).toBeLessThan(-0.49);
    expect(bounds.max.y).toBeGreaterThan(0.8);
    expect(bounds.max.y).toBeLessThan(1.6);
    expect(bounds.max.z).toBeGreaterThanOrEqual(trunnion.z + a.weapon.barrelLength - 1e-4);
    gltf.scene.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
  });

  it('keeps authoritative muzzle, sensor and wheel frames across every Appendix A loadout', () => {
    for (const legacy of LEGACY) {
      const a = assembleKit(kitLoadoutFromLegacy(legacy)), t = { turretYaw: 0.65, barrelPitch: 0.42 };
      const pose = posed(a, t), f = a.frames, lim = a.pitchLimits(t.turretYaw);
      const pitch = Math.min(lim.max, Math.max(lim.min, t.barrelPitch));
      // Expected from the kit's frames: ring, yaw about +Y, trunnion, pitch (about −X, up is positive), muzzle.
      const expected = new THREE.Vector3(...f.muzzle.position)
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), -pitch).add(new THREE.Vector3(...f.trunnion.position))
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), t.turretYaw).add(new THREE.Vector3(...f.turretRing.position));
      const muzzle = (p: KitPose) => new THREE.Vector3(...f.muzzle.position).applyMatrix4(mat(p.joints.get('cradle')!));
      expect(muzzle(pose).distanceTo(expected)).toBeLessThan(1e-5);
      // Recoil slides the tube (barrel joint) but never the muzzle frame.
      const fired = posed(a, { ...t, recoil: 1 });
      expect(muzzle(fired).distanceTo(expected)).toBeLessThan(1e-5);
      const tube = (p: KitPose) => new THREE.Vector3().setFromMatrixPosition(mat(p.joints.get('barrel')!));
      expect(tube(fired).distanceTo(tube(pose))).toBeCloseTo(a.weapon.recoilTravel, 5);
      expect(f.sensor.position).toEqual([0, 0.83, -0.13]);
      // Wheels on the physics stations (legacy gears keep kit v1 stations; driver-left +X first in the state). A visual
      // tyre smaller than the station radius (the Scout's) rides on a hub lowered by the difference: same ground contact.
      const src = kitInstanceSource(a, 'wheels')!, rest = posed(a, { ...t, wheelSuspension: Array(8).fill(0.5) });
      expect(src.count).toBe(8);
      for (let meshSide = 0; meshSide < 2; meshSide++) for (let i = 0; i < 4; i++) {
        const m = instanceMatrix(rest.wheelInstances, src.first + meshSide * 4 + i), station = a.running.stations[(meshSide === 0 ? 1 : 0) * 4 + i];
        expect(m[12]).toBeCloseTo(station.side * a.running.halfSpacing, 6);
        expect(m[13]).toBeCloseTo(station.y0 - hubDrop(kitContextOf(a).gear, kitContextOf(a).gear.wheels[i]), 6);
        expect(m[13] - kitContextOf(a).gear.wheels[i].radius).toBeCloseTo(station.y0 - station.radius, 6);
        expect(m[14]).toBeCloseTo(station.z, 6);
      }
      for (const lod of [0, 1, 2] as const) {
        const budget = kitMeshBudget(buildKitMesh(a, lod));
        expect(budget.draws).toBeLessThanOrEqual(24);
        for (const p of buildKitMesh(a, lod).parts) expect(p.positions.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('plants the belts on the ground plane with every road wheel touching and the rollers under the top run', () => {
    for (const l of GEARS) {
      const a = assembleKit(l), ctx = kitContext(l), g = ctx.gear, pose = posed(a, { wheelSuspension: Array(8).fill(0.5) });
      const links = instancedPoints(a, pose, 'links');
      const minY = Math.min(...links.map(p => p.y));
      expect(Math.abs(minY + 0.5), `${a.key} belt bottom`).toBeLessThan(0.006);
      const rig = gearRig(g), belt = rig.belt(1), probe = { y: 0, z: 0, angle: 0 }, samples: { y: number; z: number }[] = [];
      for (let i = 0; i < 2000; i++) { belt.sample(i / 2000 * belt.length, probe, 0); samples.push({ y: probe.y, z: probe.z }); }
      const gap = (c: { y: number; z: number; r: number }) => Math.min(...samples.map(s => Math.hypot(s.y - c.y, s.z - c.z))) - c.r;
      g.wheels.forEach((_, i) => expect(gap(belt.circles[i]), `${a.key} wheel ${i}`).toBeLessThan(0.004));
      for (let i = 0; i < g.rollers.length; i++) {
        const c = belt.circles[g.wheels.length + i];
        expect(gap(c), `${a.key} roller ${i}`).toBeLessThan(0.004);
        // The roller carries the top run: the belt passes above it.
        const above = samples.filter(s => Math.abs(s.z - c.z) < 0.01 && s.y > c.y);
        expect(above.length).toBeGreaterThan(0);
      }
      expect(g.rollers.length > 0).toBe(l.runningGear === 'grip');
    }
  });

  it('never cuts a wheel with the belt over every suspension extreme and closes the loop', () => {
    for (const l of GEARS) {
      const a = assembleKit(l), g = kitContext(l).gear, rig = gearRig(g), probe = { y: 0, z: 0, angle: 0 }, next = { y: 0, z: 0, angle: 0 };
      for (let mask = 0; mask < 16; mask++) {
        const s = Array.from({ length: 4 }, (_, i) => mask & (1 << i) ? 0.5 + SUSPENSION.compression / SUSPENSION.scale : 0.5 - SUSPENSION.droop / SUSPENSION.scale);
        posed(a, { wheelSuspension: [...s, 0.5, 0.5, 0.5, 0.5] });
        // State side 0 (driver-left, +X) is mesh side 1.
        const belt = rig.belt(1);
        // The tensioner and the top-run sag take up the length change: link spacing stays within 5% of nominal.
        expect(Math.abs(belt.length - belt.nominal) / belt.nominal).toBeLessThan(0.05);
        for (let i = 0; i < 400; i++) {
          const d = i / 400 * belt.length;
          belt.sample(d, probe, 0); belt.sample(d + 1e-4, next, 0);
          expect(Number.isFinite(probe.y) && Number.isFinite(probe.z)).toBe(true);
          // Sag chords are resolved every centimetre: at most 0.5 mm inside a circle between two samples.
          for (let c = 0; c < belt.circles.length; c++) {
            const circle = belt.circles[c], r = c < g.wheels.length ? circle.r - BELT_SHOE * 0.5 : circle.r;
            expect(Math.hypot(probe.y - circle.y, probe.z - circle.z), `${a.key} mask ${mask} circle ${c}`).toBeGreaterThanOrEqual(r - 5e-4);
          }
          expect(Math.hypot(next.y - probe.y, next.z - probe.z)).toBeLessThan(2e-4);
        }
        belt.sample(0, probe, 0); belt.sample(belt.length, next, 0);
        expect(Math.hypot(probe.y - next.y, probe.z - next.z)).toBeLessThan(1e-9);
      }
    }
  });

  it('rolls the driver-left and driver-right belts and wheels oppositely in a pivot', () => {
    const a = assembleKit(GEARS[1]), rest = posed(a, { trackPhases: [0, 0] }), turn = posed(a, { trackPhases: [0.025, -0.025] });
    const lowerRun = (pose: KitPose, meshSide: 0 | 1) => {
      for (const i of beltSlots(a, meshSide)) { const m = instanceMatrix(pose.linkInstances, i); if (m[13] < -0.46 && Math.abs(m[14]) < 0.3) return i; }
      return -1;
    };
    const left = lowerRun(rest, 1), right = lowerRun(rest, 0);
    expect(left).toBeGreaterThanOrEqual(0); expect(right).toBeGreaterThanOrEqual(0);
    const z = (p: KitPose, i: number) => instanceMatrix(p.linkInstances, i)[14];
    // Positive phase (driving forward) runs the lower belt rearward under the hull.
    expect(z(turn, left)).toBeLessThan(z(rest, left));
    expect(z(turn, right)).toBeGreaterThan(z(rest, right));
    // The wheels' ground points move with the lower run.
    const wheels = kitInstanceSource(a, 'wheels')!, g = kitContext(a.loadout).gear;
    for (const [meshSide, phase] of [[1, 0.025], [0, -0.025]] as const) {
      const m = mat(instanceMatrix(turn.wheelInstances, wheels.first + meshSide * 4 + 1)), c = new THREE.Vector3().setFromMatrixPosition(m);
      const bottom = new THREE.Vector3(0, -g.wheelRadius, 0).applyMatrix4(m).sub(c);
      expect(bottom.z).toBeCloseTo(-g.wheelRadius * Math.sin(phase / g.wheelRadius), 6);
    }
  });

  it('conforms the lower run to a raised ground contact without lifting the planted links', () => {
    const a = assembleKit(GEARS[1]), g = kitContext(a.loadout).gear, flat = posed(a);
    // A 6 cm bump under the middle of the driver-left belt (stations 3–5 of 9).
    const contacts = Array(18).fill(-0.5); for (const i of [3, 4, 5]) contacts[i] = -0.44;
    const bump = posed(a, { treadContacts: contacts });
    let lifted = 0, planted = 0;
    for (const i of beltSlots(a, 1)) {
      const m0 = instanceMatrix(flat.linkInstances, i), m1 = instanceMatrix(bump.linkInstances, i);
      if (m0[13] > -0.45) continue; // lower run only
      if (Math.abs(m1[14]) < 0.1 && m1[13] - m0[13] > 0.04) lifted++;
      if (Math.abs(m1[14]) > g.halfLength - 0.05 && Math.abs(m1[13] - m0[13]) < 0.02) planted++;
    }
    expect(lifted).toBeGreaterThan(0);
    expect(planted).toBeGreaterThan(0);
    // The other belt (flat contacts at the ground plane) only keeps its few-millimetre ground clearance.
    for (const i of beltSlots(a, 0)) expect(Math.abs(instanceMatrix(bump.linkInstances, i)[13] - instanceMatrix(flat.linkInstances, i)[13])).toBeLessThan(0.005);
  });
});
