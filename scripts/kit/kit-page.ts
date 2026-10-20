/**
 * Kit sandbox page (dev only, W1-KIT): the entry of `dev/kit.html`. Builds kit v2 tanks with the kit API, poses them,
 * runs the interference validator on every displayed pose and hands plain render data to
 * src/engine/sandbox/kit-scene.ts (the engine never imports game code).
 *
 *   dev/kit.html?sheet=1   every variant of every slot, each at a joint extreme: yaw 0/90/180 (hulls), droop /
 *                      compression / mixed suspension (gears), pitch min and max with full recoil (turrets and
 *                      weapons), utility heads deflected, spun and following.
 *   dev/kit.html?assembly=hull,gear,turret,weapon,utility&yaw=&pitch=&recoil=&susp=&susp2=&terrain=&hatch=&view=rear|quarter|front|side
 *                      one tank close up (angles in degrees; the pitch is clamped to pitchLimits(yaw); susp in
 *                      metres, one value or four rear → front; terrain=1 lays ground under the wheels).
 *   &lod=0|1|2         render the tanks from that LOD of buildKitMesh (default 0; the validator always uses LOD0).
 * `window.__tmtKit = { ready, overlaps, … }` (overlaps = validator overlaps > 1 mm over the displayed poses).
 */
import { assembleKit, buildKitMesh, createKitPose, kitInstanceSource, KitError, validateKitLoadout, writeKitPose, type KitAssembly, type KitLoadout } from '../../src/game/kit';
import { kitContext } from '../../src/game/kit/build';
import { createRigPose, poseRig, restState, type RigState } from '../../src/game/kit/rig';
import { SUSPENSION } from '../../src/game/kit/running';
import { groundThroughWheels, overlapsAt, type KitOverlap } from '../../src/game/kit/validate';
import { WHIP } from '../../src/game/kit/parts/utilities/antenna';
import { bootKitScene, type KitScenePart, type KitSceneSetup, type KitSceneTank } from '../../src/engine/sandbox/kit-scene';
import { campaignModel, type CampaignModel } from '../../src/game/presentation/campaign-models';
import { DRAGONFLY_ROTOR, DRAGONFLY_TAIL_ROTOR } from '../../src/game/presentation/dragonfly-model';
import { rotY, rotX } from '../../src/game/kit/geometry/math';
import { tankSurface } from '../../src/game/presentation/tank-surface';
import { defaultAppearance } from '../../src/game/meta/cosmetics';

type V3 = [number, number, number];
const DEG = Math.PI / 180;
const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
/** Toy paint palette (linear): olive, sand, signal red, navy, forest, ochre. */
const PAINT: V3[] = [[0.2, 0.26, 0.1], [0.55, 0.42, 0.22], [0.5, 0.08, 0.05], [0.08, 0.14, 0.3], [0.1, 0.22, 0.12], [0.6, 0.36, 0.06]];

interface Cell { loadout: KitLoadout; label: string; pose: (a: KitAssembly, s: RigState) => RigState; at: [number, number]; heading?: number }

function rest(a: KitAssembly): RigState { return restState(kitContext(a.loadout)); }
function susp(a: KitAssembly, deltas: readonly number[], deltasOther = deltas, terrain = false): RigState {
  const y0 = kitContext(a.loadout).gear.wheelY0, wheelY: [number[], number[]] = [deltas.map(d => y0 + d), deltasOther.map(d => y0 + d)];
  return { ...rest(a), wheelY, ...(terrain ? { ground: groundThroughWheels(kitContext(a.loadout), wheelY) } : {}) };
}
function aim(a: KitAssembly, yaw: number, pitch: 'min' | 'max' | number, recoil = 0): Partial<RigState> {
  const lim = a.pitchLimits(yaw), p = pitch === 'min' ? lim.min : pitch === 'max' ? lim.max : Math.max(lim.min, Math.min(lim.max, pitch));
  return { yaw, pitch: p, recoil };
}

function tank(cell: Cell, index: number, lod: 0 | 1 | 2): { tank: KitSceneTank; overlaps: KitOverlap[] } {
  const a = assembleKit(cell.loadout), ctx = kitContext(a.loadout);
  const state = cell.pose(a, rest(a));
  const rig = createRigPose();
  poseRig(ctx, state, rig);
  const pose = createKitPose(a);
  writeKitPose(a, rig, pose);
  const parts: KitScenePart[] = [];
  for (const p of buildKitMesh(a, lod).parts) {
    const src = kitInstanceSource(a, p);
    if (src) {
      const buffer = pose[src.buffer];
      parts.push({ mesh: { ...p, instances: buffer.slice(src.first * 12, (src.first + src.count) * 12), label: `${a.key}:${p.part}` }, joint: IDENTITY });
    } else parts.push({ mesh: p, joint: pose.joints.get(p.joint) ?? IDENTITY });
  }
  const overlaps = overlapsAt(a, state, cell.label);
  return {
    tank: { label: cell.label, at: cell.at, heading: cell.heading ?? 0, tint: PAINT[index % PAINT.length], parts, overlaps: overlaps.map(o => ({ min: o.min, max: o.max })) },
    overlaps,
  };
}

const BASE: KitLoadout = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
const with_ = (patch: Partial<KitLoadout>): KitLoadout => ({ ...BASE, ...patch });

function sheetCells(): Cell[] {
  // One column per slot (hull, gear, turret, weapon, utility), one row per variant; every tank turned a little
  // toward the camera so the sheet shows its front, one side and the deck.
  // Rows 3.6 apart leave a label-high gap between a tank's nose and the next row's turret on screen.
  const dx = 3.05, dz = 3.6, heading = -0.55, col = (c: number) => (c - 2) * dx;
  // Three variants per column, centred against the utility column's four.
  const at = (c: number, r: number): [number, number] => [col(c), (r - (c === 4 ? 1.5 : 1)) * dz];
  const { droop, compression } = SUSPENSION;
  const cells: Omit<Cell, 'heading'>[] = [
    // Hulls at yaw 0 / 90 / 180 with the gun at pitchLimits(yaw).min (gun over the deck at 180).
    { loadout: with_({ hull: 'skiff' }), label: 'Skiff · yaw 0 · pitch min', at: at(0, 0), pose: (a, s) => ({ ...s, ...aim(a, 0, 'min') }) },
    { loadout: with_({ hull: 'warden' }), label: 'Warden · yaw 90 · pitch min', at: at(0, 1), pose: (a, s) => ({ ...s, ...aim(a, 90 * DEG, 'min') }) },
    { loadout: with_({ hull: 'bastion' }), label: 'Bastion · yaw 180 · pitch min', at: at(0, 2), pose: (a, s) => ({ ...s, ...aim(a, 180 * DEG, 'min') }) },
    // Running gear at the suspension extremes.
    { loadout: with_({ runningGear: 'scout', turret: 'cradle', weapon: 'mortar' }), label: 'Scout · droop', at: at(1, 0), pose: a => susp(a, [-droop, -droop, -droop, -droop]) },
    { loadout: with_({ runningGear: 'grip' }), label: 'Grip · compressed', at: at(1, 1), pose: a => susp(a, [compression, compression, compression, compression]) },
    // Crawler: alternating stations at full travel on terrain through the wheel bottoms (the belt stays out of the
    // notches between its drooped and compressed interleaved wheels: belt.ts linkReach; kit-interference covers ½–1).
    { loadout: with_({ runningGear: 'crawler', turret: 'wedge' }), label: 'Crawler · mixed · on terrain', at: at(1, 2), pose: a => susp(a, [compression, -droop, compression, -droop], [-droop, compression, -droop, compression], true) },
    // Turrets at their joint extremes (front arc).
    { loadout: with_({ turret: 'dome' }), label: 'Dome · +75° · recoil', at: at(2, 0), pose: (a, s) => ({ ...s, ...aim(a, 0, 'max', 1), hatch: 1 }) },
    { loadout: with_({ turret: 'wedge' }), label: 'Wedge · −30°', at: at(2, 1), pose: (a, s) => ({ ...s, ...aim(a, 0, 'min'), hatch: 1 }) },
    { loadout: with_({ turret: 'cradle', weapon: 'mortar' }), label: 'Cradle · +88° · recoil', at: at(2, 2), pose: (a, s) => ({ ...s, ...aim(a, 0, 'max', 1) }) },
    // Weapons elevated with full recoil (the tube tail stays in the mantlet).
    { loadout: with_({ weapon: 'mortar' }), label: 'Mortar · max · recoil', at: at(3, 0), pose: (a, s) => ({ ...s, ...aim(a, 30 * DEG, 'max', 1) }) },
    { loadout: with_({ weapon: 'cannon' }), label: 'Cannon · 20° · recoil', at: at(3, 1), pose: (a, s) => ({ ...s, ...aim(a, -30 * DEG, 20 * DEG, 1) }) },
    { loadout: with_({ weapon: 'rail', turret: 'wedge' }), label: 'Rail · 12° · recoil', at: at(3, 2), pose: (a, s) => ({ ...s, ...aim(a, 20 * DEG, 12 * DEG, 1) }) },
    // Utilities with their heads deflected.
    { loadout: with_({ utility: 'antenna' }), label: 'Antenna · sway', at: at(4, 0), pose: (a, s) => ({ ...s, ...aim(a, 25 * DEG, 10 * DEG), head: [WHIP.maxTilt, WHIP.maxTilt * 0.6] }) },
    { loadout: with_({ utility: 'radar' }), label: 'Radar · spin', at: at(4, 1), pose: (a, s) => ({ ...s, ...aim(a, 0, 5 * DEG), head: [0.7, 0] }) },
    { loadout: with_({ utility: 'periscope' }), label: 'Periscope · follow', at: at(4, 2), pose: (a, s) => { const g = aim(a, -20 * DEG, 25 * DEG); return { ...s, ...g, head: [Math.min(30 * DEG, g.pitch ?? 0), 0] }; } },
    { loadout: with_({ utility: 'smoke', hull: 'bastion', runningGear: 'crawler' }), label: 'Smoke · Bastion', at: at(4, 3), pose: (a, s) => ({ ...s, ...aim(a, 0, 0) }) },
  ];
  return cells.map(c => ({ ...c, heading }));
}

function singleCell(params: URLSearchParams): Cell {
  const ids = (params.get('assembly') ?? '').split(',');
  const loadout = validateKitLoadout({ hull: ids[0], runningGear: ids[1], turret: ids[2], weapon: ids[3], utility: ids[4] });
  const num = (key: string, fallback: number) => { const v = Number(params.get(key)); return params.has(key) && Number.isFinite(v) ? v : fallback; };
  return {
    loadout, label: ids.join(' · '), at: [0, 0],
    pose: (a, s) => {
      // susp = one wheel-centre offset (m) for every station, or four comma-separated (rear → front); susp2 = the
      // driver-right belt (defaults to susp); terrain=1 adds ground that explains the pattern.
      const list = (key: string) => { const v = (params.get(key) ?? '').split(',').map(Number); return v.length === 4 && v.every(Number.isFinite) ? v : Number.isFinite(v[0]) && params.get(key) ? [v[0], v[0], v[0], v[0]] : null; };
      const yaw = num('yaw', 0) * DEG, out: RigState = { ...s, ...aim(a, yaw, num('pitch', 0) * DEG, num('recoil', 0)), hatch: num('hatch', 0) };
      const left = list('susp'), right = list('susp2') ?? left;
      if (left && right) return { ...out, ...susp(a, left, right, params.get('terrain') === '1'), yaw: out.yaw, pitch: out.pitch, recoil: out.recoil, hatch: out.hatch };
      return out;
    },
  };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('kit-canvas') as HTMLCanvasElement;
  const status = document.getElementById('kit-status');
  if (params.get('damage') === '1') {
    const { damagePreview } = await import('./damage-preview');
    await damagePreview(canvas, status, params); return;
  }
  const model = params.get('model') as CampaignModel | null;
  if (model && ['dragonfly', 'rustling', 'spire', 'relay', 'watchtower', 'skimmer'].includes(model)) {
    const lod = Math.max(0, Math.min(2, Number(params.get('lod') ?? 0))) as 0 | 1 | 2;
    const rotorAngle = Number(params.get('rotor') ?? .3);
    const parts = campaignModel(model, lod).map(mesh => {
      const joint = new Float32Array(mesh.joint === 'flight-rotor' ? rotY(rotorAngle) : mesh.joint === 'flight-tail-rotor' ? rotX(rotorAngle + .1) : IDENTITY);
      if (mesh.joint === 'flight-rotor') joint.set(DRAGONFLY_ROTOR, 12);
      else if (mesh.joint === 'flight-tail-rotor') joint.set(DRAGONFLY_TAIL_ROTOR, 12);
      else if (mesh.joint === 'turret') { joint[13] = .2; joint[14] = -.08; }
      return { mesh: { ...mesh, tankSurface: tankSurface(defaultAppearance(), BASE, undefined, mesh.part) }, joint };
    });
    await bootKitScene(canvas, { tanks: [{ label: model, at: [0, 0], heading: 0, tint: [.25, .32, .20], parts, overlaps: [] }],
      cameras: model === 'dragonfly' ? {
        quarter: { targetLocal: [0, .72, -.35], distance: 5.7, yaw: .85, pitch: .28 },
        side: { targetLocal: [0, .72, -.40], distance: 5.7, yaw: Math.PI / 2, pitch: .06 },
        front: { targetLocal: [0, .72, -.15], distance: 5.7, yaw: 0, pitch: .12 },
        rear: { targetLocal: [0, .72, -.65], distance: 5.4, yaw: 2.5, pitch: .25 },
        top: { targetLocal: [0, .55, -.55], distance: 7.4, yaw: 0, pitch: 1.48 },
        cockpit: { targetLocal: [0, .95, .40], distance: 2.8, yaw: .9, pitch: .14 },
        rotor: { targetLocal: [0, 1.18, -.34], distance: 1.25, yaw: .9, pitch: .25 },
        gun: { targetLocal: [0, .31, .76], distance: 1.2, yaw: .9, pitch: .06 },
        intakes: { targetLocal: [0, .88, -.14], distance: 1.7, yaw: .65, pitch: .16 },
      } : { quarter: { targetLocal: [0, .25, -.25], distance: 4.8, yaw: .85, pitch: .35 },
        side: { targetLocal: [0, .25, -.25], distance: 4.8, yaw: Math.PI / 2, pitch: .15 } },
      camera: params.get('view') ?? 'quarter', overlaps: 0, info: { model, lod, triangles: parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0) } }, status);
    return;
  }
  const sheet = params.get('sheet') === '1' || !params.has('assembly');
  let cells: Cell[];
  try { cells = sheet ? sheetCells() : [singleCell(params)]; }
  catch (error) {
    const message = error instanceof KitError ? error.message : String(error);
    window.__tmtKit = { ready: false, overlaps: -1, error: message, frames: 0, tanks: 0, info: {}, engine: null };
    if (status) { status.textContent = message; status.dataset.error = 'true'; }
    return;
  }
  const lodParam = Number(params.get('lod') ?? 0), lod = (lodParam === 1 || lodParam === 2 ? lodParam : 0) as 0 | 1 | 2;
  const built = cells.map((cell, i) => tank(cell, i, lod));
  const overlaps = built.flatMap(b => b.overlaps);
  if (overlaps.length) console.warn('[kit] validator overlaps', overlaps);
  const view = params.get('view') ?? 'quarter';
  const cameras: KitSceneSetup['cameras'] = sheet
    ? { sheet: { targetLocal: [0, 0.1, 1.0], distance: 19.2, yaw: 0, pitch: 0.7 } }
    : {
        rear: { targetLocal: [0, 0.05, -0.2], distance: 3.3, yaw: Math.PI, pitch: 0.32 },
        quarter: { targetLocal: [0, 0.15, 0], distance: 3.6, yaw: 0.75, pitch: 0.34 },
        front: { targetLocal: [0, 0.1, 0.2], distance: 3.4, yaw: 0, pitch: 0.25 },
        side: { targetLocal: [0, 0.1, 0], distance: 3.8, yaw: Math.PI / 2, pitch: 0.18 },
      };
  await bootKitScene(canvas, {
    tanks: built.map(b => b.tank), cameras, camera: sheet ? 'sheet' : view, overlaps: overlaps.length, labels: sheet,
    info: { mode: sheet ? 'sheet' : 'assembly', lod, assemblies: cells.map(c => Object.values(c.loadout).join('.')), overlapList: overlaps.slice(0, 20).map(o => `${o.a} ↔ ${o.b} ${(o.depth * 1000).toFixed(1)}mm @ ${o.state}`) },
  }, status);
}

main().catch(error => {
  console.error('[kit] page failed', error);
  window.__tmtKit = { ready: false, overlaps: -1, error: String(error), frames: 0, tanks: 0, info: {}, engine: null };
});
