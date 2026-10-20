/**
 * poseKit v2 (W1-KIT): joint continuity over a 1000-tick drive, belt phase continuity, tensioner travel,
 * statelessness, the recoiling tube, gun-over-deck clamping, suspension members following their wheels, and
 * the output buffers' sizes and reuse.
 */
import { describe, expect, it } from 'vitest';
import type { TankState } from '../src/game/contracts';
import { assembleKit, createKitPose, INSTANCE_FLOATS, instanceMatrix, kitInstanceSource, kitJointNames, poseKit, type KitLoadout, type KitPose } from '../src/game/kit';
import { kitContext } from '../src/game/kit/build';
import { gearRig, hubDrop, linkSlot, SUSPENSION } from '../src/game/kit/running';

function state(over: Partial<TankState> = {}): TankState {
  return { id: 0, position: [0, 18.5, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: 0, power: .5, health: 100,
    charge: 0, movement: 0, recoil: 0, suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0],
    trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0, wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-1.2),
    loadout: { tracks: 'grip', barrel: 'cannon', armor: 'light' }, ...over };
}
function rng(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const translation = (m: ArrayLike<number>) => [m[12], m[13], m[14]];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function instances(pose: KitPose, a: ReturnType<typeof assembleKit>, part: string): Float64Array[] {
  const src = kitInstanceSource(a, part);
  if (!src) return [];
  return Array.from({ length: src.count }, (_, i) => instanceMatrix(pose[src.buffer], src.first + i));
}

const LOADOUTS: KitLoadout[] = [
  { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' },
  { hull: 'bastion', runningGear: 'grip', turret: 'wedge', weapon: 'rail', utility: 'radar' },
  { hull: 'skiff', runningGear: 'crawler', turret: 'cradle', weapon: 'cannon', utility: 'periscope' },
];

describe('kit pose', () => {
  it('drives 1000 ticks without joint or instance jumps and keeps belt phase continuity', () => {
    for (const loadout of LOADOUTS) {
      const a = assembleKit(loadout), random = rng(7), pose = createKitPose(a), prev = createKitPose(a);
      const dt = 1 / 60, yawStep = 0.01, links = gearRig(kitContext(a.loadout).gear).layout;
      // The displayed pitch follows pitchLimits(yaw), which is continuous with a bounded slope.
      let slope = 0;
      for (let i = 0; i < 3600; i++) slope = Math.max(slope, Math.abs(a.pitchLimits((i + 1) / 3600 * 2 * Math.PI).min - a.pitchLimits(i / 3600 * 2 * Math.PI).min) / (2 * Math.PI / 3600));
      let phase = [0, 0], yaw = 0, pitch = 0, recoil = 0, susp = Array(8).fill(0.5), vel = [0, 0];
      let maxLinkStep = 0, maxWheelStep = 0, maxJointStep = 0;
      for (let tick = 0; tick < 1000; tick++) {
        // Smooth drive inputs: speeds up to 4 u/s, suspension wandering over its range, a 0.6 rad/s traverse, a
        // gun sweep (≤ 0.47 rad/s) and a shot every 200 ticks.
        vel = vel.map(v => Math.max(-4, Math.min(4, v + (random() - 0.5) * 0.6)));
        phase = phase.map((p, i) => p + vel[i] * dt);
        susp = susp.map(s => Math.max(0.2, Math.min(0.72, s + (random() - 0.5) * 0.05)));
        yaw += yawStep; pitch = Math.sin(tick * 0.013) * 0.6;
        recoil = tick % 200 === 0 ? 1 : recoil * Math.exp(-6 * dt);
        poseKit(a, state({ turretYaw: yaw, barrelPitch: pitch, recoil, trackPhases: [phase[0], phase[1]], trackSpeeds: [vel[0], vel[1]], wheelSuspension: susp }), pose);
        if (tick > 0) {
          const L = instances(pose, a, 'links'), Lp = instances(prev, a, 'links');
          for (let i = 0; i < L.length; i++) maxLinkStep = Math.max(maxLinkStep, dist(translation(L[i]), translation(Lp[i])));
          const W = instances(pose, a, 'wheels'), Wp = instances(prev, a, 'wheels');
          for (let i = 0; i < W.length; i++) maxWheelStep = Math.max(maxWheelStep, dist(translation(W[i]), translation(Wp[i])));
          for (const name of ['turret', 'cradle', 'barrel']) {
            const m = pose.joints.get(name)!, mp = prev.joints.get(name)!;
            // A point one metre along the joint's +Z moves by at most the per-tick rotation (the shot tick excepted).
            const tip = [m[8] + m[12], m[9] + m[13], m[10] + m[14]], tipPrev = [mp[8] + mp[12], mp[9] + mp[13], mp[10] + mp[14]];
            if (!(name === 'barrel' && recoil > 0.99)) maxJointStep = Math.max(maxJointStep, dist(tip, tipPrev));
          }
        }
        prev.joints = new Map([...pose.joints].map(([k, v]) => [k, v.slice()]));
        prev.linkInstances = pose.linkInstances.slice(); prev.wheelInstances = pose.wheelInstances.slice();
      }
      // At 4 u/s a link moves 6.7 cm per tick along the belt; the belt shape itself only changes slowly.
      expect(maxLinkStep, a.key).toBeLessThan(4 * dt * 1.2 + 0.02);
      expect(maxWheelStep, a.key).toBeLessThan(0.02);
      expect(maxJointStep, a.key).toBeLessThan(yawStep + slope * yawStep + 0.6 * 0.013 + 0.012);
      expect(links.linkCount).toBeGreaterThan(40);
    }
  });

  it('moves every link by exactly the phase delta along a static belt (no teleport at the phase origin)', () => {
    const a = assembleKit(LOADOUTS[1]), p0 = createKitPose(a), p1 = createKitPose(a);
    const { pitch, linkCount } = gearRig(kitContext(a.loadout).gear).layout;
    poseKit(a, state({ trackPhases: [0, 0] }), p0);
    poseKit(a, state({ trackPhases: [pitch, pitch] }), p1);
    // One pitch of travel moves every link onto its successor's seat.
    const L0 = instances(p0, a, 'links'), L1 = instances(p1, a, 'links');
    for (const side of [0, 1] as const) for (let i = 0; i < linkCount; i++) {
      const cur = linkSlot(linkCount, side, i), next = linkSlot(linkCount, side, (i + 1) % linkCount);
      expect(dist(translation(L1[cur]), translation(L0[next]))).toBeLessThan(2e-3);
    }
  });

  it('swings the idler on its tensioner by at most ±0.04 and keeps wheels, arms and bogies connected', () => {
    for (const loadout of LOADOUTS) {
      const a = assembleKit(loadout), ctx = kitContext(a.loadout), g = ctx.gear, rig = gearRig(g), rest = [g.idler.z, g.idler.y];
      for (const s of [0.2, 0.5, 0.71]) {
        const pose = createKitPose(a);
        poseKit(a, state({ wheelSuspension: Array(8).fill(s) }), pose);
        for (const side of [0, 1] as const) {
          const idler = rig.belt(side).circles[rig.belt(side).idler];
          expect(Math.hypot(idler.z - rest[0], idler.y - rest[1])).toBeLessThanOrEqual(g.tensioner.travel + 1e-6);
        }
        const wheels = instances(pose, a, 'wheels');
        const expectY = g.wheelY0 + Math.max(-SUSPENSION.droop, Math.min(SUSPENSION.compression, (s - 0.5) * SUSPENSION.scale));
        // Hubs of visual tyres smaller than the station radius (the Scout's) sit lower by the difference.
        wheels.forEach((w, i) => expect(w[13]).toBeCloseTo(expectY - hubDrop(g, g.wheels[i % g.wheels.length]), 6));
        if (g.suspension !== 'bogie') {
          // Each torsion arm's axle end sits on its wheel (scout) or rocker (crawler) axis.
          const arms = instances(pose, a, 'arms'), ends = g.suspension === 'torsion' ? wheels : instances(pose, a, 'bogies');
          arms.forEach((m, i) => { const end = [m[8] * -g.armLength + m[12], m[9] * -g.armLength + m[13], m[10] * -g.armLength + m[14]]; expect(Math.hypot(end[1] - ends[i][13], end[2] - ends[i][14])).toBeLessThan(1e-6); });
        }
      }
    }
  });

  it('recoils only the tube, clamps the displayed pitch to pitchLimits(yaw) and keeps the muzzle frame still', () => {
    const a = assembleKit(LOADOUTS[0]), at = (over: Partial<TankState>) => { const p = createKitPose(a); poseKit(a, state(over), p); return p; };
    const rest = at({}), fired = at({ recoil: 1 }), over = at({ recoil: 3 });
    expect([...fired.joints.get('cradle')!]).toEqual([...rest.joints.get('cradle')!]);
    expect(fired.joints.get('barrel')![14] - rest.joints.get('barrel')![14]).toBeCloseTo(-a.weapon.recoilTravel, 6);
    expect([...over.joints.get('barrel')!]).toEqual([...fired.joints.get('barrel')!]);
    // Gun over the deck: an order to depress below the limit shows the limit.
    const yaw = Math.PI, lim = a.pitchLimits(yaw), low = at({ turretYaw: yaw, barrelPitch: -1 }), atLimit = at({ turretYaw: yaw, barrelPitch: lim.min });
    expect([...low.joints.get('cradle')!]).toEqual([...atLimit.joints.get('cradle')!]);
  });

  it('is stateless: the same state poses identically whatever was posed before', () => {
    const random = rng(99);
    for (const loadout of LOADOUTS) {
      const a = assembleKit(loadout), target = state({ turretYaw: 0.4, barrelPitch: 0.2, trackPhases: [1.3, -0.7], wheelSuspension: [0.3, 0.6, 0.5, 0.7, 0.4, 0.5, 0.55, 0.45] });
      const first = createKitPose(a), second = createKitPose(a);
      poseKit(a, target, first);
      for (let i = 0; i < 5; i++) poseKit(a, state({ turretYaw: random() * 6, trackPhases: [random() * 9, random() * 9], wheelSuspension: Array.from({ length: 8 }, () => random()) }), second);
      poseKit(a, target, second);
      expect([...second.linkInstances]).toEqual([...first.linkInstances]);
      expect([...second.wheelInstances]).toEqual([...first.wheelInstances]);
      for (const name of kitJointNames(a)) expect([...second.joints.get(name)!]).toEqual([...first.joints.get(name)!]);
    }
  });

  it('sizes, reuses and repairs the output pose; opens the hatch while aiming and spins the radar with time', () => {
    const a = assembleKit(LOADOUTS[1]), pose = createKitPose(a);
    expect([...pose.joints.keys()]).toEqual(kitJointNames(a));
    expect(pose.linkInstances.length % INSTANCE_FLOATS).toBe(0);
    const links = pose.linkInstances;
    poseKit(a, state(), pose);
    expect(pose.linkInstances).toBe(links);
    const broken = { joints: new Map(), linkInstances: new Float32Array(3), wheelInstances: new Float32Array(0) } as KitPose;
    poseKit(a, state(), broken);
    expect(broken.linkInstances.length).toBe(links.length);
    expect(broken.joints.get('radar')).toHaveLength(16);
    const shut = createKitPose(a), open = createKitPose(a);
    poseKit(a, { ...state(), aiming: false } as TankState, shut);
    poseKit(a, { ...state(), aiming: true } as TankState, open);
    expect([...open.joints.get('hatch')!]).not.toEqual([...shut.joints.get('hatch')!]);
    const t0 = createKitPose(a), t1 = createKitPose(a);
    poseKit(a, { ...state(), time: 0 } as TankState, t0);
    poseKit(a, { ...state(), time: 1 } as TankState, t1);
    expect([...t1.joints.get('radar')!]).not.toEqual([...t0.joints.get('radar')!]);
  });
});
