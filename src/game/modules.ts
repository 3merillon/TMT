import type { Loadout, V3 } from './contracts';
import { assembleLegacy, kitWheelOffsets } from './kit/assembly';
import { V1_MODULE_CATALOG, v1TankStats, type V1TankStats } from './kit/catalog';
import { LAUNCH_SPEED_SCALE } from './world-constants';

/** Canonical equipment has no purchase, rarity, skin, or account fields. */
export const LOADOUT_BUDGET = 10;
export const DEFAULT_LOADOUT: Loadout = { tracks: 'scout', barrel: 'mortar', armor: 'light' };
/** Kit v1 dimensions live in kit/dimensions.ts (the single source); re-exported for existing callers. */
export {
  TRACK_HALF_SPACING, ROAD_WHEEL_RADIUS, WHEEL_SUPPORT_RADIUS, WHEEL_SHOE_CLEARANCE, ROAD_WHEEL_CENTER_Y, SUSPENSION_TRAVEL_SCALE,
  SUSPENSION_MAX_COMPRESSION, SUSPENSION_MAX_DROOP, TREAD_CONTACT_FLOOR, TREAD_CONTACT_CEILING,
} from './kit/dimensions';

/** Driver left is +X for a +Z-forward vehicle in Three's right-handed world. */
export function getWheelOffsets(loadout: Loadout): readonly V3[] { return kitWheelOffsets(assembleLegacy(loadout)); }

export function getTreadContactStations(loadout: Loadout): number[] {
  return [...assembleLegacy(loadout).running.treadStations];
}

/** The v1 part catalogue (kit/catalog.ts). */
export const MODULE_CATALOG = V1_MODULE_CATALOG;

export type TankStats = V1TankStats;

export function validateLoadout(value: unknown): value is Loadout {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.tracks !== 'string' || !Object.hasOwn(MODULE_CATALOG.tracks, item.tracks)
    || typeof item.barrel !== 'string' || !Object.hasOwn(MODULE_CATALOG.barrel, item.barrel)
    || typeof item.armor !== 'string' || !Object.hasOwn(MODULE_CATALOG.armor, item.armor)) return false;
  const loadout = value as Loadout;
  return MODULE_CATALOG.tracks[loadout.tracks].cost + MODULE_CATALOG.barrel[loadout.barrel].cost
    + MODULE_CATALOG.armor[loadout.armor].cost <= LOADOUT_BUDGET;
}

export function getTankStats(loadout: Loadout): TankStats {
  if (!validateLoadout(loadout)) throw new Error('Invalid or over-budget gameplay loadout');
  return v1TankStats(loadout);
}

/** More slider travel for close shots; all simulation/preview/AI paths share it. */
export function getLaunchSpeed(loadout: Loadout, power: number): number {
  const stats = getTankStats(loadout);
  const fraction = Number.isFinite(power) ? Math.max(0, Math.min(1, power)) : 0;
  return LAUNCH_SPEED_SCALE * (stats.minSpeed + (stats.maxSpeed - stats.minSpeed) * fraction ** 1.5);
}
