/**
 * TankViews writes only what changed (kit/pose.ts KitPoser, tank-view.ts writeInstances): after every frame each instance
 * must still hold world × joint (× instance affine) of the tank's current pose, the pose must be what poseKit writes for
 * the same input, the casters must sit at their joints and every instance must carry the tank's presence, whatever was
 * skipped. Parked and driving tanks, interpolation, LOD switches, visibility, fog, combat scars, reactive armour and a
 * destroyed tank's dark lamps are mixed.
 */
import { describe, expect, it } from 'vitest';
import type { GameSnapshot, ImpactEvent, TankState, V3 } from '../src/game/contracts';
import type { SimInterpolation, TankPose } from '../src/game/api/extensions';
import { practiceSetup } from '../src/game/api/match';
import { createKitPose, kitJointNames, poseKit, type KitAssembly, type KitPose } from '../src/game/kit';
import { mul4, TankViews } from '../src/game/presentation/tank-view';
import { GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

function fakeScene() {
  let id = 1;
  const models = new Map<number, { model: Float32Array; visibility: number }>(), casters = new Map<number, Float64Array>();
  const scene = {
    meshes: { create: () => ({ id: id++ }), destroy: () => {} },
    instances: {
      add: (_m: unknown, init: { model: Float32Array; visibility?: number }) => { const h = { id: id++ }; models.set(h.id, { model: Float32Array.from(init.model.subarray(0, 16)), visibility: init.visibility ?? 1 }); return h; },
      set: (h: { id: number }, model: Float32Array) => { models.get(h.id)!.model.set(model.subarray(0, 16)); },
      setVisibility: (h: { id: number }, visibility: number) => { models.get(h.id)!.visibility = visibility; },
      remove: (h: { id: number }) => { models.delete(h.id); },
    },
    lights: { add: () => ({ id: id++ }), update: () => {}, remove: () => {} },
    get: (k: string) => k === 'partMeshes' ? partMeshes : k === 'sdfCasters' ? sdf : undefined,
  };
  const partMeshes = { create: () => scene.meshes.create(), updateSurface: () => true, restart: () => {} };
  const sdf = {
    create: () => ({ id: id++ }), destroy: () => {},
    add: (_h: unknown, model: ArrayLike<number>) => { const i = { id: id++ }; casters.set(i.id, new Float64Array(model)); return i; },
    set: (i: { id: number }, model: ArrayLike<number>) => { casters.get(i.id)!.set(model); },
    remove: (i: { id: number }) => { casters.delete(i.id); },
  };
  return { scene, models, casters };
}

const bits = (a: Float32Array) => Array.from(new Uint32Array(a.buffer, a.byteOffset, a.length)).join();
const affine = new Float64Array(16);
/** tank-view.ts mulAffine: a × the row-major 3×4 affine at `index`. */
function mulAffine(a: ArrayLike<number>, src: Float32Array, index: number, out: Float32Array): void {
  const o = index * 12, b = affine;
  b[0] = src[o]; b[1] = src[o + 4]; b[2] = src[o + 8]; b[3] = 0; b[4] = src[o + 1]; b[5] = src[o + 5]; b[6] = src[o + 9]; b[7] = 0;
  b[8] = src[o + 2]; b[9] = src[o + 6]; b[10] = src[o + 10]; b[11] = 0; b[12] = src[o + 3]; b[13] = src[o + 7]; b[14] = src[o + 11]; b[15] = 1;
  mul4(a, b, out);
}

interface Entry {
  world: Float64Array; presence: number; assembly: KitAssembly; input: TankState; poser: { pose: KitPose };
  set: { parts: { part: { part: string; joint: string; instances?: Float32Array }; source: { buffer: string; first: number } | null }[] } | null;
  instances: { handle: { id: number }; part: number; sub: number }[]; casters: { group: string; instance: { id: number } }[];
}

describe('incremental tank views', () => {
  it('keep every instance at world × joint × affine of the current pose', () => {
    let seed = 99;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const sim = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'grip', barrel: 'rail', armor: 'heavy' } }));
    const state = structuredClone(sim.state) as GameSnapshot;
    state.tanks.push({ ...structuredClone(state.tanks[0]), id: 2, team: 0, kit: { hull: 'bastion', runningGear: 'crawler', turret: 'wedge', weapon: 'arc_cannon', utility: 'radar', armor: 'reactive' } } as TankState,
      { ...structuredClone(state.tanks[1]), id: 3, team: 1 } as TankState);
    state.tanks.forEach((t, i) => { const a = i * 0.7; t.position = [Math.sin(a) * 18.3, Math.cos(a) * 18.3, 0.5 * i]; t.reactiveArmor = 0; });
    const pose = (t: TankState) => ({ position: [...t.position], rotation: [...t.rotation], turretYaw: t.turretYaw, barrelPitch: t.barrelPitch }) as TankPose;
    let prev = state.tanks.map(pose), curr = state.tanks.map(pose);
    const { scene, models, casters } = fakeScene();
    const views = new TankViews(scene as never);
    views.prebuild(state);
    const entries = (views as unknown as { tanks: Map<number, Entry> }).tanks;
    const hidden = new Set<number>(), fogged = new Set<number>();
    const joint = new Float64Array(16), expected = new Float32Array(16), fresh = new Map<number, KitPose>();
    let distance = 4, checked = 0, mismatches = 0, gearOnly = 0, jointsOnly = 0;
    const still = { world: '', links: '', turret: '' };
    for (let frame = 0; frame < 500; frame++) {
      if (rnd() < 0.5) {
        prev = curr;
        for (const t of state.tanks) {
          // Tank 1 stays parked: its pose inputs repeat bit for bit.
          if (t.id === 1) continue;
          // Tank 3 holds its hull still while its tracks spin, its springs settle and its turret now and then turns.
          if (t.id === 3) {
            t.trackSpeeds = [0.5 + rnd(), -0.5 - rnd()]; t.trackPhases = [t.trackPhases[0] + t.trackSpeeds[0] / 60, t.trackPhases[1] + t.trackSpeeds[1] / 60];
            if (rnd() < 0.3) t.turretYaw += (rnd() - 0.5) * 0.1;
            if (rnd() < 0.2) t.wheelSuspension = t.wheelSuspension.map(v => Math.max(0.2, Math.min(0.8, v + (rnd() - 0.5) * 0.1)));
            continue;
          }
          const step = 0.01 + rnd() * 0.02;
          t.position = [t.position[0] + step, t.position[1] - step * 0.3, t.position[2] + step * 0.2];
          t.turretYaw += (rnd() - 0.5) * 0.1; t.recoil = rnd() < 0.03 ? 1 : t.recoil * 0.9;
          t.trackSpeeds = [1 + rnd(), 1 + rnd()]; t.trackPhases = [t.trackPhases[0] + t.trackSpeeds[0] / 60, t.trackPhases[1] + t.trackSpeeds[1] / 60];
          t.wheelSuspension = t.wheelSuspension.map(v => Math.max(0.2, Math.min(0.8, v + (rnd() - 0.5) * 0.06)));
          t.treadContacts = t.treadContacts.map(() => -0.6 + rnd() * 0.1);
          t.treadTerrain = rnd() < 0.5 ? [[[-1, -0.6], [0, -0.55 + rnd() * 0.05], [1, -0.6]], [[-1, -0.6], [1, -0.58]]] : undefined;
        }
        curr = state.tanks.map(pose); state.tick++; state.time = state.tick / 60;
      }
      if (rnd() < 0.02) { const id = Math.floor(rnd() * 3); if (hidden.has(id)) hidden.delete(id); else hidden.add(id); }
      if (rnd() < 0.02) { const id = 1 + Math.floor(rnd() * 3); if (fogged.has(id)) fogged.delete(id); else fogged.add(id); }
      if (rnd() < 0.02) distance = [1, 4, 12, 40][Math.floor(rnd() * 4)];
      if (frame === 300) state.tanks[1].health = 0;
      if (rnd() < 0.01) state.tanks[2].reactiveArmor = (state.tanks[2].reactiveArmor ?? 0) | (1 << Math.floor(rnd() * 4));
      if (rnd() < 0.03) {
        const target = state.tanks[Math.floor(rnd() * 4)], p = target.position;
        views.impact({ type: 'impact', position: [p[0] + (rnd() - 0.5) * 0.6, p[1] + 0.3, p[2] + 1.2], normal: [0, 1, 0], radius: 0.5, owner: 0,
          hits: [{ tank: target.id, direct: true, damage: 10 + rnd() * 40, exposure: 1, lethal: false }] } as ImpactEvent);
      }
      // Without interpolation a still hull keeps its world matrix bit for bit, so joints and running gear change alone.
      const interp = (frame >= 120 && frame < 320) || rnd() < 0.1 ? undefined : { alpha: rnd(), prev, curr } as SimInterpolation;
      views.beginFrame(state, interp);
      views.update(state, 1 / (60 + rnd() * 90), t => !hidden.has(t.id), () => 400 / distance, interp, t => fogged.has(t.id));
      for (const t of entries.values()) {
        if (!t.set) continue;
        let reference = fresh.get(t.input.id);
        if (!reference) fresh.set(t.input.id, reference = createKitPose(t.assembly));
        poseKit(t.assembly, t.input, reference);
        const posed = t.poser.pose;
        if (t.input.id === 3) {
          const world = Array.from(new Uint32Array(t.world.buffer)).join(), links = bits(posed.linkInstances), turret = bits(posed.joints.get('turret')!);
          if (world === still.world) { if (links !== still.links) gearOnly++; if (turret !== still.turret) jointsOnly++; }
          Object.assign(still, { world, links, turret });
        }
        for (const name of kitJointNames(t.assembly)) if (bits(posed.joints.get(name)!) !== bits(reference.joints.get(name)!)) mismatches++;
        if (bits(posed.linkInstances) !== bits(reference.linkInstances) || bits(posed.wheelInstances) !== bits(reference.wheelInstances)) mismatches++;
        const buffers = posed as unknown as Record<string, Float32Array>;
        for (const inst of t.instances) {
          const p = t.set.parts[inst.part], j = posed.joints.get(p.part.joint);
          if (j) mul4(t.world, j, joint); else joint.set(t.world);
          if (p.source) mulAffine(joint, buffers[p.source.buffer], p.source.first + inst.sub, expected); else expected.set(joint);
          const held = models.get(inst.handle.id)!;
          const broken = t.input.health <= 0 && (['barrel', 'hatch', 'head'].includes(p.part.joint) || ['links', 'sprockets', 'head'].includes(p.part.part));
          if (bits(held.model) !== bits(expected) || !Object.is(held.visibility, broken ? 0 : t.presence)) mismatches++;
          checked++;
        }
        for (const c of t.casters) {
          const j = posed.joints.get(c.group);
          if (j) mul4(t.world, j, joint); else joint.set(t.world);
          if (casters.get(c.instance.id)!.some((v, k) => !Object.is(v, joint[k]))) mismatches++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100000);
    // The still hull exercised writes of the running gear alone and of the joints alone.
    expect(gearOnly).toBeGreaterThan(20);
    expect(jointsOnly).toBeGreaterThan(5);
    expect(mismatches).toBe(0);
  });
});
