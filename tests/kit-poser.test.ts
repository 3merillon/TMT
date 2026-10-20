/**
 * The allocation-free pose kernels (kit/pose.ts, running.ts, belt.ts) and KitPoser's memo: poseKit writes, byte for
 * byte, what the kernels wrote before the rewrite, and KitPoser.update writes exactly what poseKit writes while it
 * reposes only the joints or the running gear whose inputs changed.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TankState } from '../src/game/contracts';
import { assembleKit, createKitPose, kitJointNames, poseKit, type KitAssembly, type KitLoadout, type KitPose, type KitPresentationHints } from '../src/game/kit';
import { KitPoser, POSED_GEAR, POSED_JOINTS } from '../src/game/kit/pose';
import { makeTank } from './helpers/vehicle-world';

type Posed = TankState & KitPresentationHints;

it('clears cached ground support on death and poses the wreck with fully drooped running gear', () => {
  const a = assembleKit({ hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' });
  const poser = new KitPoser(a), tank = makeTank(0, { position: [0, 18.5, 0] });
  tank.treadContacts.fill(-.3); poser.update(tank);
  tank.health = 0; expect(poser.update(tank) & POSED_GEAR).toBe(POSED_GEAR);
  const free = createKitPose(a);
  poseKit(a, { ...tank, treadContacts: [], treadTerrain: undefined, wheelSuspension: Array(8).fill(0) }, free);
  expect(poser.pose.wheelInstances).toEqual(free.wheelInstances);
  expect(poser.pose.linkInstances).toEqual(free.linkInstances);
  expect(poser.update(tank)).toBe(0);
});
// Every running gear design and every utility head motion (whip, spin, pitch, idle).
const LOADOUTS: KitLoadout[] = [
  { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' },
  { hull: 'bastion', runningGear: 'grip', turret: 'wedge', weapon: 'rail', utility: 'radar', armor: 'reactive' },
  { hull: 'skiff', runningGear: 'crawler', turret: 'cradle', weapon: 'cannon', utility: 'periscope' },
  { hull: 'aether_hull', runningGear: 'aether_drive', turret: 'aether_crown', weapon: 'arc_cannon', utility: 'aether_vane' },
  { hull: 'forge_hull', runningGear: 'forge_tracks', turret: 'forge_casemate', weapon: 'forge_mortar', utility: 'steam_sentinel' },
];
function rng(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
/** A seeded drive: airborne, coarse contacts, sorted and unsorted detailed terrain, shots, turns and presentation hints. */
function drive(seed: number, count: number): Posed[] {
  const random = rng(seed), list: Posed[] = [];
  const terrain = (): [number, number][] => { const pts: [number, number][] = []; for (let z = -1.6; z < 1.6; z += 0.04 + random() * 0.3) pts.push([z, -0.62 + random() * 0.14]); return pts; };
  for (let i = 0; i < count; i++) {
    const ground = i % 4, detail = ground >= 2 ? [terrain(), terrain()] : undefined, s = Math.sin(i * 0.35), c = Math.cos(i * 0.35);
    if (ground === 3) for (const side of detail!) side.reverse();
    const hints: KitPresentationHints = i % 5 === 0 ? { aiming: true } : i % 5 === 1 ? { aiming: false } : i % 5 === 2 ? { hatch: random() } : {};
    list.push({ id: 0, position: [0, 18.5, 0], rotation: [0.6 * s, 0.8 * s, 0, c], velocity: [random() * 4 - 2, random() - 0.5, random() * 6 - 3], heading: 0,
      turretYaw: random() * 7 - 3.5, barrelPitch: random() * 1.4 - 0.5, power: .5, health: 100, charge: 0, movement: 0, recoil: random() < 0.3 ? random() * 1.2 : 0,
      suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [random() * 40 - 20, random() * 40 - 20], trackSpeeds: [random() * 4 - 2, random() * 0.6 - 0.3],
      trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: random() - 0.5, wheelSuspension: Array.from({ length: 8 }, () => 0.1 + random() * 0.8),
      treadContacts: Array.from({ length: 18 }, () => ground === 0 || random() < 0.15 ? -1.2 : -0.62 + random() * 0.12), ...(detail ? { treadTerrain: detail } : {}),
      loadout: { tracks: 'grip', barrel: 'cannon', armor: 'light' }, time: i * 0.37, ...hints });
  }
  return list;
}
function bits(a: Float32Array): Uint32Array { return new Uint32Array(a.buffer, a.byteOffset, a.length); }
function samePose(a: KitAssembly, p: KitPose, q: KitPose): boolean {
  const arrays = [...kitJointNames(a).map(name => [p.joints.get(name)!, q.joints.get(name)!]), [p.linkInstances, q.linkInstances], [p.wheelInstances, q.wheelInstances]];
  return arrays.every(([x, y]) => x.length === y.length && bits(x).every((word, i) => word === bits(y)[i]));
}

// The digest of the kernels at 93b8a7e (before the rewrite), which allocated per call and used Math.hypot.
const GOLDEN = '09ce67f985268683edc3482bfd76f0fc5539e28174166570889b62d0f6f0bb10';

describe('kit poser', () => {
  it('poses every gear design byte for byte as the kernels did before the allocation-free rewrite', () => {
    const hash = createHash('sha256');
    for (const loadout of LOADOUTS) {
      const a = assembleKit(loadout), out = createKitPose(a);
      for (const t of drive(11, 48)) {
        poseKit(a, t, out);
        for (const name of kitJointNames(a)) hash.update(out.joints.get(name)!);
        hash.update(out.linkInstances); hash.update(out.wheelInstances);
      }
    }
    expect(hash.digest('hex')).toBe(GOLDEN);
  });

  it('writes what poseKit writes and reposes only what changed', () => {
    const random = rng(5), BOTH = POSED_JOINTS | POSED_GEAR;
    for (const loadout of LOADOUTS) {
      const a = assembleKit(loadout), poser = new KitPoser(a), expected = createKitPose(a), states = drive(23, 32);
      let t = states[0], mismatches = 0;
      const wrong: string[] = [];
      // `must`: what the change has to repose; `may`: what it can repose besides (a clamp can absorb a change).
      const step = (next: Posed, must: number, may: number, label: string) => {
        const posed = poser.update(next);
        poseKit(a, next, expected);
        if (!samePose(a, poser.pose, expected)) mismatches++;
        if ((posed & must) !== must || (posed & ~(must | may)) !== 0) wrong.push(`${label}: ${posed}`);
        t = next;
      };
      step(t, BOTH, 0, 'first');
      for (let i = 0; i < 240; i++) {
        const r = random();
        if (r < 0.15) step(structuredClone(t), 0, 0, 'equal copy');
        else if (r < 0.3) step({ ...t, turretYaw: t.turretYaw + 0.25 }, POSED_JOINTS, 0, 'traverse');
        else if (r < 0.4) step({ ...t, aiming: !t.aiming, hatch: undefined }, 0, POSED_JOINTS, 'hatch');
        else if (r < 0.55) step({ ...t, trackPhases: [t.trackPhases[0] + 0.01, t.trackPhases[1]] }, POSED_GEAR, 0, 'roll');
        else if (r < 0.65) step({ ...t, wheelSuspension: t.wheelSuspension.map((v, k) => k === 5 ? v * 0.9 : v) }, 0, POSED_GEAR, 'spring');
        else if (r < 0.75) {
          // The caller may refill the arrays it handed in: the memo compares values, not identities.
          if (t.treadTerrain) t.treadTerrain[1][2][1] -= 0.01; else t.treadContacts[12] = -0.6;
          step(t, t.treadTerrain ? POSED_GEAR : 0, POSED_GEAR, 'refilled ground');
        } else step(states[Math.floor(random() * states.length)], 0, BOTH, 'jump');
      }
      expect(mismatches, a.key).toBe(0);
      expect(wrong, a.key).toEqual([]);
    }
  });
});
