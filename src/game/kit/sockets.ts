/**
 * Kit v2 socket schema (W1-KIT, brief step 2). Sockets are the shared interfaces between slots:
 *
 * - hull.turretRing: ONE frame shared by every hull (RING_FRAME); the class range the hull accepts differs.
 *   Turrets require one ring class; RING_RADIUS gives the bearing radius per class.
 * - hull.trackMount: the running gear's stations, belt and envelope are hull-independent; the hull adapts its
 *   lower-hull half-width to the gear's track channel (trackChannelHalfWidth) and its fenders to the belt.
 * - turret.trunnion: per turret (it sets the elevation envelope); weapons of an accepted class attach at its
 *   origin with the bore along +Z. The mantlet (a solid of revolution about the trunnion X axis) is sized by
 *   the weapon class so the recoiling tube's tail always stays inside it.
 * - turret.utility: per turret, on the roof behind z_trunnion − (R_mantlet + 0.03).
 * - hull.exhausts / hull.sensor: per hull (the sensor is the shared line-of-sight origin).
 *
 * Classes are ordered S < M < L. A part pair is legal when the provider's range contains the requirer's class.
 */
import type { HullId, TurretId, V3Like, WeaponId } from './parts/types';

export type SocketClass = 'S' | 'M' | 'L';
export const SOCKET_CLASSES: readonly SocketClass[] = Object.freeze(['S', 'M', 'L']);
const rank = (c: SocketClass) => SOCKET_CLASSES.indexOf(c);
export const classInRange = (c: SocketClass, range: readonly [SocketClass, SocketClass]): boolean => rank(c) >= rank(range[0]) && rank(c) <= rank(range[1]);

/** Local Y of flat ground under the tank root (the sim places roots 0.5 above the surface). */
export const GROUND_Y = -0.5;
/** The turret-ring socket, identical on every hull (hull frame). Its plane is the top of the deck collar. */
export const RING_FRAME: Readonly<V3Like> = Object.freeze([0, 0.2, -0.08]) as Readonly<V3Like>;
/** Deck top around the ring collar (the collar rises from here to the ring plane). */
export const DECK_Y = 0.185;
/** Turret bearing radius per ring class. The hull collar is RING_RADIUS + RING_COLLAR_MARGIN. */
export const RING_RADIUS: Readonly<Record<SocketClass, number>> = Object.freeze({ S: 0.25, M: 0.32, L: 0.39 });
export const RING_COLLAR_MARGIN = 0.022;
/** Sponson / fender underside: at least topRunY + 0.05 for every gear (design rule). */
export const SPONSON_UNDERSIDE = 0.125;
/** Belly height of every hull (ground clearance 0.22). */
export const BELLY_Y = -0.28;
/** Track-channel keep-out margin: lower-hull half-width = c − w/2 − margin. */
export const TRACK_CHANNEL_MARGIN = 0.015;
/** The shared line-of-sight origin (hull frame; kit v1 value, kept so observation geometry is unchanged). */
export const SENSOR_POSITION: Readonly<V3Like> = Object.freeze([0, 0.83, -0.13]) as Readonly<V3Like>;

/** Ring classes each hull accepts (brief: Skiff S–M, Warden S–L, Bastion M–L). */
export const HULL_RING_RANGE: Readonly<Record<HullId, readonly [SocketClass, SocketClass]>> = Object.freeze({
  skiff: ['S', 'M'], warden: ['S', 'L'], bastion: ['M', 'L'], aether_hull: ['S', 'M'], forge_hull: ['M', 'L'],
});
/**
 * Ring class each turret requires. Dome M and Cradle S follow Experience §1.11. The Wedge is M here (the
 * reference lists L): with L it could not mount on the Skiff, and the brief requires a ≤ −30° turret on every
 * hull (kit-pitch-limits). L is reserved for Ironside (W4).
 */
export const TURRET_RING_CLASS: Readonly<Record<TurretId, SocketClass>> = Object.freeze({ dome: 'M', cradle: 'S', wedge: 'M', aether_crown: 'M', forge_casemate: 'L' });
/** Trunnion classes each turret accepts. Dome takes S–L because Appendix A maps every v1 barrel onto it. */
export const TURRET_TRUNNION_RANGE: Readonly<Record<TurretId, readonly [SocketClass, SocketClass]>> = Object.freeze({
  dome: ['S', 'L'], cradle: ['S', 'M'], wedge: ['M', 'L'], aether_crown: ['S', 'L'], forge_casemate: ['M', 'L'],
});
/** Weapon (trunnion) class. */
export const WEAPON_CLASS: Readonly<Record<WeaponId, SocketClass>> = Object.freeze({ mortar: 'S', cannon: 'M', rail: 'L', autocannon: 'S', arc_cannon: 'M', forge_mortar: 'L' });
/** Minimum mantlet radius per weapon class (the tube tail sets a larger one when needed). */
export const MANTLET_RADIUS: Readonly<Record<SocketClass, number>> = Object.freeze({ S: 0.132, M: 0.135, L: 0.148 });
/** Where the recoiling tube's rear end sits at full recoil (cradle frame z); the mantlet always contains it. */
export const TUBE_TAIL_Z = -0.1;

/** Socket-compatibility problem for a (hull, turret, weapon) triple, or null when legal. */
export function socketMismatch(hull: HullId, turret: TurretId, weapon: WeaponId): { slot: 'turret' | 'weapon'; message: string } | null {
  const ring = TURRET_RING_CLASS[turret], ringRange = HULL_RING_RANGE[hull];
  if (!classInRange(ring, ringRange)) return { slot: 'turret', message: `socket mismatch: ${turret} needs ring ${ring}, ${hull} offers ${ringRange.join('–')}` };
  const trunnion = WEAPON_CLASS[weapon], trunnionRange = TURRET_TRUNNION_RANGE[turret];
  if (!classInRange(trunnion, trunnionRange)) return { slot: 'weapon', message: `socket mismatch: ${weapon} is class ${trunnion}, ${turret} trunnion takes ${trunnionRange.join('–')}` };
  return null;
}

/** The mantlet radius that seats a weapon's tube tail (radius `tubeRadius`) with 8 mm to spare. */
export function mantletRadius(weapon: WeaponId, tubeRadius: number): number {
  return Math.max(MANTLET_RADIUS[WEAPON_CLASS[weapon]], Math.hypot(TUBE_TAIL_Z, tubeRadius) + 0.008);
}
