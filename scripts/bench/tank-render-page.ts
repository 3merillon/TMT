/** Dev-only renderer measurement page: production TankViews, materials, shadows and vehicle lights. */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { Engine, RENDER_MODULES, type CameraRig, type EngineTelemetry, type Vec3 } from '../../src/engine';
import { kitSceneModule } from '../../src/engine/sandbox/kit-scene';
import { TankViews } from '../../src/game/presentation/tank-view';
import { assembleKit, kitLoadoutToLegacy, type HullId, type KitLoadout } from '../../src/game/kit';
import type { GameSnapshot, ImpactEvent, Q4, TankState, V3 } from '../../src/game/contracts';
import { defaultAppearance, MAX_PAINT_DABS } from '../../src/game/meta/cosmetics';
import { workshopSandbox } from '../../src/game/workshop/sandbox';

const query = new URLSearchParams(location.search), count = Math.min(8, Math.max(1, Number(query.get('count') ?? 1)));
const requestedHull = (query.get('hull') ?? 'bastion') as HullId, painted = query.get('paint') === '1', lights = query.get('lights') !== '0';
const comparison = query.get('comparison') === '1';
const canvas = document.querySelector('canvas')!;
const kit: KitLoadout = query.get('set') === 'aether' ? { hull: 'aether_hull', runningGear: 'aether_drive', turret: 'aether_crown', weapon: 'arc_cannon', utility: 'aether_vane' }
  : query.get('set') === 'forge' ? { hull: 'forge_hull', runningGear: 'forge_tracks', turret: 'forge_casemate', weapon: 'forge_mortar', utility: 'steam_sentinel' }
  : { hull: requestedHull, runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna', ...(query.get('reactive') === '1' ? { armor: 'reactive' as const } : {}) };
const hull = kit.hull;
const appearance = { ...defaultAppearance(), lights, finish: { pattern: 'solid' as const, colors: ['#9fc8a5', '#394638', '#b8ac83'] as [string, string, string], scale: 1 }, paint: painted ? Array.from({ length: MAX_PAINT_DABS }, (_, i) => ({
  slot: 'hull' as const, partId: hull, group: 'hull', position: [((i % 16) - 7.5) * .07, .187, (Math.floor(i / 16) - 5.5) * .1] as V3,
  normal: [0, 1, 0] as V3, radius: .07, opacity: .7, softness: .4, color: i % 2 ? '#d9c696' : '#395134',
})) : [] };
Object.assign(workshopSandbox, { active: true, testing: true, appearance, kit });
const setup = kitSceneModule({ tanks: [], cameras: {}, camera: '', overlaps: 0 });
const engine = await Engine.create({ canvas, tier: 'high', dev: true, modules: [...RENDER_MODULES, () => setup.module] });
engine.resize(innerWidth, innerHeight, 1);
const views = new TankViews(engine.services.scene), s = setup.studio;
const point = (x: number, y: number, z: number): V3 => [s[0] * x + s[4] * y + s[8] * z + s[12], s[1] * x + s[5] * y + s[9] * z + s[13], s[2] * x + s[6] * y + s[10] * z + s[14]];
const q = new Quaternion().setFromRotationMatrix(new Matrix4().fromArray(s)).toArray() as Q4;
const tanks: TankState[] = Array.from({ length: count }, (_, id) => {
  const columns = count > 4 ? 4 : count > 1 ? 2 : 1, rows = Math.ceil(count / columns);
  return { id, position: point((id % columns - (columns - 1) / 2) * 2.5, .505, (Math.floor(id / columns) - (rows - 1) / 2) * 3), rotation: [...q],
    velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: .08, power: .5, health: assembleKit(kit).stats.hp, charge: 1, movement: 1, recoil: 0,
    suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [.5, .5], yawVelocity: 0,
    wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-.5), loadout: kitLoadoutToLegacy(kit), kit: { ...kit }, team: 0 };
});
const state: GameSnapshot = { fog: false, tick: 0, time: 0, phase: 'aim', active: 0, turn: 0, phaseTime: 0, tanks, projectiles: [], contacts: tanks.map(() => null), winner: null };
let yaw = .7, pitch = .43, distance = count === 1 ? 5.7 : count === 4 ? 10.5 : 16, frame = 0, previous = performance.now();
let animate = !comparison, dark = false;
let centerHeight = .3, target = point(0, centerHeight, 0);
const up: Vec3 = [s[4], s[5], s[6]];
function camera(): CameraRig {
  return { position: point(Math.sin(yaw) * Math.cos(pitch) * distance, centerHeight + Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance), target, up, fovY: 38 * Math.PI / 180 };
}
const batches: { left: number; samples: { engine: EngineTelemetry; viewCpuMs: number; frameMs: number }[]; done: (v: unknown) => void }[] = [];
function tick(now: number) {
  const dt = Math.min(.05, (now - previous) / 1000), elapsed = now - previous; previous = now; frame++;
  state.tick = frame; state.time = frame / 60;
  if (animate) for (const tank of tanks) {
    tank.turretYaw = Math.sin(frame / 110 + tank.id) * .65; tank.barrelPitch = .12 + Math.sin(frame / 75 + tank.id) * .12;
    tank.trackPhases = [frame * .015, frame * .016]; tank.trackSpeeds = [.9, .96];
    tank.wheelSuspension = Array.from({ length: 8 }, (_, i) => .5 + .15 * Math.sin(frame / 45 + i));
    tank.recoil = Math.max(0, 1 - (frame % 140) / 12);
  }
  const rig = camera(), started = performance.now();
  const pixels = (p: V3) => innerHeight / (2 * Math.tan(rig.fovY / 2) * Math.hypot(p[0] - rig.position[0], p[1] - rig.position[1], p[2] - rig.position[2]));
  views.update(state, dt, () => true, pixels);
  const viewCpuMs = performance.now() - started;
  engine.frame({ time: state.time, dt, camera: rig, sun: { dirToward: up, illuminance: dark ? .25 : 20 }, moon: { dirToward: up, illuminance: 0 }, focus: { world: target, tilt: pitch, distance }, pendingCuts: [] });
  for (let i = batches.length - 1; i >= 0; i--) {
    const batch = batches[i]; batch.samples.push({ engine: engine.telemetry(), viewCpuMs, frameMs: elapsed });
    if (--batch.left === 0) { batches.splice(i, 1); batch.done({ samples: batch.samples, tankViews: views.stats(), adapter: engine.ctx.caps, shaders: null }); }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
const api = { get ready() { return frame >= 240; }, engine, state, views,
  measure: async (frames = 300) => {
    const capture = engine.capture.begin(frames), droppedAtStart = engine.telemetry().gpu.dropped;
    const measured = await new Promise<Record<string, unknown>>(resolve => batches.push({ left: frames, samples: [], done: value => resolve(value as Record<string, unknown>) }));
    engine.capture.seal();
    while (capture.pendingGpu) await new Promise(requestAnimationFrame);
    return { ...measured, capture: capture.dump(), droppedDuringCapture: engine.telemetry().gpu.dropped - droppedAtStart };
  },
  view: (name: string) => {
    animate = false; centerHeight = name === 'tracks' ? -.08 : .3; target = point(0, centerHeight, 0);
    yaw = name === 'side' ? Math.PI / 2 : name === 'tracks' ? 1.4 : name === 'rear' ? Math.PI : name === 'front' ? 0 : name === 'combat' ? .22 : .7;
    pitch = name === 'top' ? 1.35 : name === 'detail' ? .55 : name === 'tracks' ? .11 : name === 'combat' ? .2 : .3;
    distance = name === 'detail' ? 2.8 : name === 'tracks' ? 2.65 : name === 'combat' ? 3.9 : 5.7;
    dark = name === 'night'; if (name === 'combat') tanks[0].turretYaw = .9;
  },
  combat: (fixture: { id: number; position: V3; rotation: Q4; health: number; reactiveArmor: number; event: ImpactEvent }) => {
    const inverse = new Quaternion(...fixture.rotation).invert(), tank = tanks[0];
    const contact = new Vector3(...fixture.event.position).sub(new Vector3(...fixture.position)).applyQuaternion(inverse).applyQuaternion(new Quaternion(...tank.rotation)).add(new Vector3(...tank.position));
    const normal = new Vector3(...fixture.event.normal).applyQuaternion(inverse).applyQuaternion(new Quaternion(...tank.rotation));
    const event: ImpactEvent = { ...fixture.event, position: contact.toArray() as V3, normal: normal.toArray() as V3,
      hits: fixture.event.hits!.filter(h => h.tank === fixture.id).map(h => ({ ...h, tank: tank.id })) };
    views.impact(event); tank.reactiveArmor = fixture.reactiveArmor; tank.health = fixture.health;
    return { health: tank.health, reactiveArmor: tank.reactiveArmor, event };
  },
  shaders: () => engine.shaderCheck(),
};
(window as unknown as { __tankRender: typeof api }).__tankRender = api;
