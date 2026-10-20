/** Reproducible live render/physics fixture: /dev/kit.html?damage=1[&model=dragonfly]. */
import { Matrix4, Quaternion } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { bootKitScene } from '../../src/engine/sandbox/kit-scene';
import { GameSimulation } from '../../src/game/simulation';
import { practiceSetup } from '../../src/game/api/match';
import { TankViews } from '../../src/game/presentation/tank-view';
import { TerrainDebris } from '../../src/game/presentation/debris';
import { VehicleDamage } from '../../src/game/presentation/vehicle-damage';
import { damageVehicle } from '../../src/game/rules/vehicle-damage';
import { add, mul, normalize, rotate, dot } from '../../src/game/math';
import type { ImpactEvent, V3, WorldQuery } from '../../src/game/contracts';

export async function damagePreview(canvas: HTMLCanvasElement, status: HTMLElement | null, params: URLSearchParams): Promise<void> {
  await RAPIER.init();
  let floor: V3[] = [], floorNormal: V3 = [0, 1, 0];
  const world: WorldQuery = { radius: 18, version: 1, isSolid: p => Math.hypot(...p) < 18,
    * visibilityTriangles() {
      for (const indices of [[0, 2, 1], [0, 3, 2]]) if (floor.length) yield {
        a: floor[indices[0]], b: floor[indices[1]], c: floor[indices[2]], normal: floorNormal, material: 1 };
    },
    surface: direction => { const normal = normalize(direction); return { point: mul(normal, 18), normal, distance: 0, material: 0 }; },
    raycast: (origin, direction, max) => {
      const b = dot(origin, direction), discriminant = b * b - dot(origin, origin) + 18 * 18;
      if (discriminant < 0) return null;
      const distance = -b - Math.sqrt(discriminant); if (distance < 0 || distance > max) return null;
      const point = add(origin, mul(direction, distance)); return { point, normal: normalize(point), distance, material: 0 };
    } };
  const sim = new GameSimulation(world, practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'grip', barrel: 'cannon', armor: 'heavy' } })), state = sim.state;
  const tank = state.tanks[0]; state.tanks.splice(1); tank.maxHealth = tank.health = 130;
  const model = params.get('model');
  if (model && ['dragonfly', 'rustling', 'skimmer', 'spire', 'relay', 'watchtower'].includes(model)) tank.visualKind = model as typeof tank.visualKind;
  let views: TankViews | undefined, debris: TerrainDebris | undefined, fire: VehicleDamage | undefined, damaged = false, scarred = false;
  await bootKitScene(canvas, { tanks: [{ label: 'Damage inspection', at: [0, 0], heading: 0, tint: [.3, .35, .22], parts: [], overlaps: [] }],
    camera: 'quarter', cameras: { quarter: { targetLocal: [0, .65, 0], distance: 5.2, yaw: .9, pitch: .35 } }, overlaps: 0,
    info: { fixture: 'vehicle-damage', model: model ?? 'tank' },
    animate: (engine, roots, time, dt) => {
      if (!views) {
        const root = roots[0], q = new Quaternion().setFromRotationMatrix(new Matrix4().fromArray(root));
        tank.position = [root[12], root[13], root[14]]; tank.rotation = [q.x, q.y, q.z, q.w];
        floorNormal = rotate([0, 1, 0], tank.rotation);
        floor = [[-16, -.496, -16], [16, -.496, -16], [16, -.496, 16], [-16, -.496, 16]]
          .map(p => add(tank.position, rotate(p as V3, tank.rotation)));
        debris = new TerrainDebris(engine.services.scene);
        views = new TankViews(engine.services.scene, (...args) => debris!.detach(...args)); fire = new VehicleDamage(engine.services.scene);
      }
      state.time = time; state.tick = Math.floor(time * 60);
      const hit = (local: V3, damage: number) => {
        const position = add(tank.position, rotate(local, tank.rotation));
        const event: ImpactEvent = { type: 'impact', position, normal: normalize(position), radius: .7, owner: 0,
          hits: [{ tank: 0, damage, exposure: 1, direct: true, lethal: false }] };
        damageVehicle(tank, position, damage, true); views!.impact(event);
      };
      if (time > 1.5 && !damaged) {
        damaged = true; tank.health = params.get('burn') === '0' ? 95 : 25;
        hit(tank.visualKind === 'dragonfly' ? [.3, .5, -.5] : [.8, -.08, .3], tank.visualKind === 'dragonfly' ? 85 : 50);
      }
      if (time > 3 && !scarred) { scarred = true; hit([.23, .16, .85], 18); }
      views.beginFrame(state); views.update(state, dt, () => true, () => 300); fire!.update(state, dt, () => true);
      debris!.update(world, dt, state.tanks);
      if (window.__tmtKit) Object.assign(window.__tmtKit.info, { debris: debris!.active, machinery: tank.machinery,
        gas: engine.services.scene.get('fluids')?.stats().gasLive });
    } }, status);
}
