/**
 * Fluid presenter: feeds the engine's `fluids` facet from presentation.
 * - **Dry spawns:** the tank positions at the start of a match are points that must stay dry, so the sea level solved for
 *   the planet kind stays below every spawn.
 * - **Hulls:** every tank's body and two tracks at its rendered pose, every frame. Hidden tanks too, by the amended D7: a wake is
 *   real, and gives a tank away only where the water is seen.
 *   Structural chunks and cosmetic debris share sixteen additional envelopes at their displayed poses.
 * - **Blasts:** every impact (public, as today) pushes the water around it.
 * The initial basin layout comes from gameplay; transient waves remain presentation only.
 */
import type { WaterHull } from '../../engine/passes/fluids/water';
import { tankFluidBoxes } from '../vehicle/liquid-shape';
export { tankFluidBoxes } from '../vehicle/liquid-shape';
import { composeTRS, renderedPose, transformPoint } from './tank-view';
import type { Presenter, ViewServices } from './presenters';
import { selectWaterHulls, structuralWaterHulls } from './structural-water';

export function fluidPresenter(): Presenter {
  let services: ViewServices | null = null;
  let configured = false;
  let retained = new Set<string>();
  return {
    name: 'fluids',
    install(v) { services = v; },
    reset() { configured = false; retained.clear(); services?.scene.get('fluids')?.setHulls([]); },
    onUpdate(s, _dt, interp) {
      if (!services) return;
      const fluids = services.scene.get('fluids');
      if (!fluids) return;
      if (!configured && s.tanks.length) {
        fluids.configure({ dryPoints: s.tanks.map(t => t.position), basins: services.world?.()?.liquidBasins?.() });
        configured = true;
      }
      const hulls: WaterHull[] = [];
      // Water motion history is indexed by slot, so snapshot array order must not swap tanks.
      for (const tank of [...s.tanks].sort((a, b) => a.id - b.id).slice(0, 8)) {
        const pose = renderedPose(s, tank, interp);
        const m = composeTRS(pose.position, pose.rotation);
        const axes = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
        tankFluidBoxes(tank).forEach((box, slot) => hulls.push({ id: `tank:${tank.id}:${slot}`, centre: transformPoint(m, box.center), axes, half: box.half }));
      }
      const world = services.world?.();
      const solids = selectWaterHulls([...structuralWaterHulls(world), ...(services.debrisWaterHulls?.() ?? [])], world, retained);
      retained = new Set(solids.flatMap(h => h.id ? [h.id] : []));
      hulls.push(...solids);
      fluids.setHulls(hulls);
    },
    onGameEvent(e) {
      if (e.type !== 'impact' || !services) return;
      services.scene.get('fluids')?.impulse(e.position, e.radius, e.normal, e.munition);
    },
  };
}
