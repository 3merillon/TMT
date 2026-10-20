/**
 * Kit v1 dimensions: the ONLY home of the v1 tank's literal numbers (W0-KIT).
 *
 * Every value is copied verbatim from the pre-kit call sites (simulation.ts, tank-collision.ts,
 * resident-tanks.ts, modules.ts, tread-contact.ts, track-footprints.ts, tank-belt-path.ts) and
 * from the original procedural tank recipe. Since kit v2 (W1-KIT) geometry lives in parts/**; these
 * numbers remain for the legacy call sites that still import them (and the legacy gears' physics stations,
 * pinned by `tests/kit-v1-identity.test.ts`), until those call sites move to the assembly API.
 *
 * Derived helpers keep the legacy floating-point operation order: do not "simplify" them.
 * Pure data, no imports beyond types: safe for the simulation, workers and Node scripts.
 */
import type { V3 } from '../contracts';

/** Frozen at runtime (a write throws in strict-mode modules); typed as V3 so math helpers accept it. */
type Tuple3 = V3;
const v3 = (x: number, y: number, z: number): Tuple3 => Object.freeze([x, y, z]) as unknown as Tuple3;
/** Object.freeze without literal-type inference, so the fields read as plain numbers. */
const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

// ---------------------------------------------------------------------------------------------
// Root, support and sight
// ---------------------------------------------------------------------------------------------

/** Local Y of flat ground under the root (recipe `support.ground`): the root sits 0.5 above it. */
export const SUPPORT_GROUND_Y = -0.5;
/** Height above the terrain surface at which the simulation places a tank root (spawn, scan estimate). */
export const ROOT_SURFACE_LIFT = 0.55;
/** Hull-local point other tanks aim their line of sight at. */
export const SIGHT_TARGET: Tuple3 = v3(0, 0.65, 0);

// ---------------------------------------------------------------------------------------------
// Pivots and sockets (recipe `pivots`)
// ---------------------------------------------------------------------------------------------

/** Turret yaw pivot, hull frame (recipe `pivots.turret`). */
export const TURRET_RING: Tuple3 = v3(0, 0.2, -0.08);
/** Barrel pitch pivot, turret frame (recipe `pivots.barrel`); hull [0, .4, .12] at yaw 0. */
export const TRUNNION: Tuple3 = v3(0, 0.2, 0.2);
/** Sight/sensor socket, hull frame (recipe `pivots.sensor`; attached to the root, not the turret). */
export const SENSOR: Tuple3 = v3(0, 0.83, -0.13);
/** Exhaust pipes (recipe chassis[9] / chassis[20]): cylinders along Z at (±x, y, z). */
export const EXHAUST = frozen({ x: 0.4, y: 0.03, z: -0.83, radius: 0.048, length: 0.22 });
/** Whip antenna mast (recipe turret[8]), turret frame: centre and height. */
export const ANTENNA = frozen({ x: -0.24, y: 0.46, z: -0.16, height: 0.28 });

/** Barrel pitch range; kit v1 has no yaw dependence. */
export const MIN_BARREL_PITCH = -35 * Math.PI / 180;
export const MAX_BARREL_PITCH = 85 * Math.PI / 180;
/** Cosmetic recoil travel of the whole barrel group at recoil 1. */
export const RECOIL_TRAVEL = .105;

// ---------------------------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------------------------

/** Trunnion-to-muzzle length (recipe `barrels[k].length`) and the visual bore radius at the muzzle. */
export const WEAPON_DIMENSIONS = frozen({
  mortar: frozen({ length: 0.72, boreRadius: 0.091 }),
  cannon: frozen({ length: 1.08, boreRadius: 0.04875 }),
  rail: frozen({ length: 1.40, boreRadius: 0.036 }),
});

// ---------------------------------------------------------------------------------------------
// Running gear
// ---------------------------------------------------------------------------------------------

/** Track centre-line |x| (recipe `tracks.centres`). */
export const TRACK_HALF_SPACING = 0.55;
/** Belt width, road-wheel station half length and authored link count per gear (recipe `tracks`). */
export const GEAR_DIMENSIONS = frozen({
  scout: frozen({ width: .23, halfLength: 0.59, links: 28 }),
  grip: frozen({ width: .31, halfLength: 0.62, links: 32 }),
});
export const ROAD_WHEEL_RADIUS = 0.19;
export const ROAD_WHEEL_CENTER_Y = -0.26;
/** Full swept shoe exterior, with terrain clearance measured from its arc (== .24 exactly). */
export const WHEEL_SUPPORT_RADIUS = ROAD_WHEEL_RADIUS + .05;
export const WHEEL_SHOE_CLEARANCE = .004;
export const SUSPENSION_TRAVEL_SCALE = 0.4;
export const SUSPENSION_MAX_COMPRESSION = 0.085;
export const SUSPENSION_MAX_DROOP = 0.12;
export const TREAD_CONTACT_FLOOR = -1.2;
export const TREAD_CONTACT_CEILING = 0.3;
/** Extra tread-contact station beyond each end wheel. */
export const TREAD_STATION_OVERHANG = .18;
/** Belt shoe thickness around the road wheels: the belt circle radius is wheel + shoe (== .215). */
export const BELT_SHOE = .025;
/** Raised end gears: centre height, radius, and their offsets beyond the end road wheels. */
export const END_GEAR = frozen({ y: .08, radius: .145, sprocketAhead: .25, idlerBehind: .33 });
/** Sliding rear-idler take-up range beyond the rear wheel, and the minimum idler-to-rear-wheel centre distance. */
export const IDLER_TAKE_UP = frozen({ min: .16, max: .50, wrap: .332 });

/** Road-wheel station z: index 0 (rear) .. 3 (front). */
export function wheelStationZ(index: number, halfLength: number): number {
  return (index / 3 * 2 - 1) * halfLength;
}
/** Nine rear→front tread-contact stations. */
export function treadStationsFor(halfLength: number): number[] {
  return [-halfLength - TREAD_STATION_OVERHANG, -halfLength, -2 * halfLength / 3, -halfLength / 3, 0, halfLength / 3, 2 * halfLength / 3, halfLength, halfLength + TREAD_STATION_OVERHANG];
}

/** Visual-only running-gear proportions (tank-visual): belt link, road-wheel tire, hubs and end gears. */
export const RUNNING_GEAR_VISUAL = frozen({
  /** Link sole (bevelled) and grouser: heights/offsets in u; lengths/width as fractions of pitch/belt width. */
  link: frozen({ soleHeight: .035, soleLength: .94, soleBevel: .007, soleY: -.005, grouserWidth: .97, grouserHeight: .014, grouserLength: .21, grouserY: .018,
    /** Half shoe length as a fraction of pitch, used to sample and seat each link on the belt. */
    shoeHalf: .47 }),
  /** Annular rubber tire lathe profile: radii in u, half widths as fractions of the belt width. */
  tire: frozen({ innerRadius: .145, shoulderRadius: .189, rimHalfWidth: .4, treadHalfWidth: .3, segments: 16 }),
  /** Hub (road wheel) and toothed end gear: outer radii in u; other sizes as fractions of radius or belt width. */
  hub: frozen({ roadWheel: .165, gear: .120, core: .40, coreWidth: .90, coreSegments: 12, ringRadius: .88, ringTube: .09, ringSides: 5, ringSegments: 16,
    spokes: 6, spokeWidth: .84, spokeHeight: .14, spokeLength: .62, spokeOffset: .57, toothHeight: .023, toothLength: .026, toothInset: .013 }),
});

// ---------------------------------------------------------------------------------------------
// Collision proxies (tank-collision `tankHullBoxes`) and rigid-body stops (resident-tanks)
// ---------------------------------------------------------------------------------------------

/** Main rigid envelope: belly, deck and fenders. */
export const HULL_PROXY = frozen({ center: v3(0, .025, 0), half: v3(.535, .29, .905) });
/** Glacis armor plate per hull, pitched about X. */
export const ARMOR_PROXY = frozen({
  warden: frozen({ pitch: .18, center: v3(0, .28, .5), half: v3(.45, .023, .16) }),
  bastion: frozen({ pitch: .25, center: v3(0, .29, .49), half: v3(.51, .075, .215) }),
});
/** Fender/sponson box per side at (±x, y, 0). */
export const FENDER_PROXY = frozen({ x: .59, y: .13, half: v3(.09, .085, .84) });
/** Half extent (Y and Z) of the raised end-gear boxes. */
export const END_GEAR_PROXY_HALF = .17;
/** Turret box, turret frame. */
export const TURRET_PROXY = frozen({ center: v3(0, .22, 0), half: v3(.39, .24, .385) });
/** Barrel boxes along the cradle's +Z: breech, sleeve and the per-weapon shaft [start, muzzle + tip]. */
export const BARREL_PROXY = frozen({
  breech: frozen({ z: .15, half: v3(.16, .16, .13) }),
  sleeve: frozen({ z: .28, half: v3(.125, .125, .16) }),
  shaft: frozen({
    mortar: frozen({ halfX: .174, halfY: .174, start: .28, tip: .018 }),
    cannon: frozen({ halfX: .094, halfY: .094, start: .28, tip: .018 }),
    rail: frozen({ halfX: .161, halfY: .106, start: .40, tip: .005 }),
  }),
});
/** Radial margin of the swept barrel envelope beyond the muzzle (collision travel bound). */
export const BARREL_SWEEP_MARGIN = .23;
/** Rigid maximum-compression stops under each track (Rapier chassis only). */
export const BUMP_STOP = frozen({ y: -.255, halfHeight: .16, halfLength: .69 });

// ---------------------------------------------------------------------------------------------
// Mass properties (resident-tanks chassis)
// ---------------------------------------------------------------------------------------------

/** Centre of mass at the root (0.5 above ground). W1-KIT derives it from part mass boxes. */
export const CENTER_OF_MASS: Tuple3 = v3(0, 0, 0);
/** Principal inertia per unit mass. */
export const INERTIA_PER_MASS: Tuple3 = v3(.45, .5, .24);
