/**
 * Vehicle tuning: every number of the resident chassis model lives here, checked by tests/vehicle-drivability.test.ts. Tank
 * dimensions (stations, spacing, radii, proxies, mass) always come from the kit assembly, never from this file, so the
 * tuning survives kit changes. Pure data and functions: safe for the simulation (plan §4.2).
 *
 * Design envelope (h = COM height above the ground, T/2 = half track spacing, L/2 = half wheelbase):
 * - no trip-roll when sliding: μ_lat · h_traction < 0.8 · T/2, where tangential forces act at TRACTION_HEIGHT · h;
 * - no wheelie or back-flip: atan(μ_long) stays ~10° under the pitch-over angle atan(L/2 / h);
 * - launch and brake stay under 5° pitch: accelerations ≤ 7 / 10 m/s² × mobility at h ≈ 0.265.
 */
import type { V3 } from '../contracts';
import type { GearId, KitAssembly } from '../kit/types';

// ---- mass properties -----------------------------------------------------------------------------------------------

/**
 * The arcade ballast: a lead keel low in the hull. The keel takes a share β of the tank's mass (the total mass stays
 * the kit's, so gameplay mass, recoil and blast Δv are unchanged) and sits at (com.x, keelY, keelZ) in the hull frame.
 * β is solved per assembly so the combined COM height lands on `targetComY`; an assembly that is already lower gets
 * no keel, and β never exceeds `maxFraction`. Kit v1 (COM at the root, 0.5 above ground) needs β ≈ 0.78, which puts
 * the combined COM at y −0.235, z −0.02 (0.265 above the ground). Kit v2 targets y ≈ −0.22 on its own (W1-KIT) and
 * then needs only a small keel. Measured: COM −0.22…−0.30 all stop the rolls; −0.22 is the lab's tuned value.
 */
export const BALLAST = Object.freeze({ keelY: -.30, keelZ: -.025, targetComY: -.235, maxFraction: .85 });
/** Roll inertia floor per unit mass (about the forward axis): slows tipping (kit v1 authored 0.24). */
export const ROLL_INERTIA_PER_MASS = .34;
/** Inertia per unit mass used by the assists to turn angular gains into torques. */
export const ASSIST_INERTIA_PER_MASS = .35;

export interface ChassisMassProps { readonly mass: number; readonly com: Readonly<V3>; readonly inertia: Readonly<V3>; readonly ballastFraction: number }
const massCache = new WeakMap<KitAssembly, ChassisMassProps>();
/** The solver chassis mass properties: the assembly's `massProps` plus the ballast keel and the roll-inertia floor.
 * Inertia is principal in the hull frame: x pitch, y yaw, z roll. Cached per assembly. */
export function chassisMassProps(kit: KitAssembly): ChassisMassProps {
  let props = massCache.get(kit);
  if (props) return props;
  const { mass, com, inertia } = kit.massProps;
  if (!(mass > 0) || !com.every(Number.isFinite) || !inertia.every(v => Number.isFinite(v) && v > 0)) throw new Error(`Invalid kit mass properties for ${kit.key}`);
  const drop = com[1] - BALLAST.targetComY, depth = com[1] - BALLAST.keelY;
  const beta = drop > 0 && depth > 0 ? Math.min(BALLAST.maxFraction, drop / depth) : 0;
  const combined: V3 = [com[0], com[1] + beta * (BALLAST.keelY - com[1]), com[2] + beta * (BALLAST.keelZ - com[2])];
  props = Object.freeze({ mass, com: Object.freeze(combined), inertia: Object.freeze([inertia[0], inertia[1], Math.max(inertia[2], ROLL_INERTIA_PER_MASS * mass)] as V3), ballastFraction: beta });
  massCache.set(kit, props);
  return props;
}

/** Legacy mobility: √(9.3 / mass), 1 for the default v1 tank. It scales acceleration, braking and pivot rate. */
export const MOBILITY_REFERENCE_MASS = 9.3;
export const mobility = (kit: KitAssembly): number => Math.sqrt(MOBILITY_REFERENCE_MASS / kit.massProps.mass);
/** Preserve the accepted Warden/Scout/Dome/Mortar moving turn while giving every heavier build a real yaw cost. */
export const TURN_REFERENCE_MASS = 10.1;

// ---- friction and drive envelope -------------------------------------------------------------------------------------

/** Solver-only track friction per running gear (the kit's gameplay traction stats are untouched). Longitudinal is
 * capped at 1.6: grip at 2.0 still back-flipped climbing a crater wall; lateral stays under the trip-roll bound. */
export const GEAR_TRACTION: Readonly<Record<GearId, { readonly longitudinal: number; readonly lateral: number }>> = Object.freeze({
  scout: Object.freeze({ longitudinal: 1.3, lateral: .95 }),
  grip: Object.freeze({ longitudinal: 1.6, lateral: 1.15 }),
  crawler: Object.freeze({ longitudinal: 1.6, lateral: 1.3 }),
  aether_drive: Object.freeze({ longitudinal: 1.6, lateral: 1.25 }),
  forge_tracks: Object.freeze({ longitudinal: 1.6, lateral: 1.35 }),
});
/** Belt acceleration and braking in u/s² at mobility 1 (braking also applies on reversal). Launch 12 → 7 took the
 * scout's launch pitch from 12.9° to 2.2°; braking gets its own, faster ramp. */
export const DRIVE_ACCELERATION = 7;
export const BRAKE_ACCELERATION = 10;

/** Load transfer between the left and right wheel of an axle: ΔF = ANTI_ROLL · (m / stations) · Δcompression. A
 * wheel without contact counts as MISSING_COMPRESSION. */
export const ANTI_ROLL = 60;
export const MISSING_COMPRESSION = -.12;
/** Tangential (drive and grip) forces act at this fraction of the COM height above each contact, halving their
 * roll and pitch moments (a Unity-style force application point; no effect on yaw). */
export const TRACTION_HEIGHT = .5;

// ---- suspension (per unit wheel mass, m / stations) -----------------------------------------------------------------

export const SUSPENSION = Object.freeze({
  /** The wheel ball starts this far above its neutral contact and sweeps down at most `castLength`. */
  castAbove: .7, castLength: .92,
  /** Compression stiffness (s⁻², ≈ 2 Hz) and damping; the preload carries g at neutral. */
  stiffness: 160, damping: 18,
  /** Softer droop: the load falls linearly from g at neutral to zero at this extension (≈ 1.6 Hz), so wheels stay
   * loaded over crests instead of unloading within 6 cm. */
  droopToZero: .1,
  /** Per-wheel load ceiling in units of m·g. */
  maxLoad: .75,
  /** Contacts whose normal is steeper than this (n·up) are walls, not ground. */
  minNormalUp: .2,
});
/** Per-contact velocity servo gains (s⁻¹): longitudinal toward the belt speed, lateral toward zero slip. */
export const TRACTION_SERVO = Object.freeze({ longitudinal: 24, lateral: 32 });

// ---- steering and input -----------------------------------------------------------------------------------------------

/** Commanded yaw rate (rad/s): `pivot × mobility` at zero throttle, blending to `turn` at full throttle. The belts run
 * at ±ω·halfSpacing around the common speed; the common speed yields so the outer belt never exceeds top speed. */
export const STEERING = Object.freeze({ pivot: 2.1, turn: 1.3 });
/** Drive pitch guard (traction control): the belts stop powering the tank further nose-up (forward) or nose-down
 * (reverse) between `soft` and `hard` pitch against planet up, so a tank never motors up a vertical wall into a
 * back-flip. Ramps and crater rims peak below 62°. */
export const PITCH_GUARD = Object.freeze({ soft: 65 * Math.PI / 180, hard: 80 * Math.PI / 180 });
/** Wheelie guard (traction control): the belts stop powering the nose further up relative to the remaining wheel
 * contacts (between `soft` and `hard`) while the tank shoves something it cannot move (ground speed below `stall` ×
 * the commanded speed), or between `liftedSoft` and `liftedHard` while the leading axle has lost ground contact
 * (its nose rides on another tank or an obstacle). Pushing or ramming at bumper height against drive at the ground
 * otherwise rears tanks up into a wedge. Ramps and crater rims keep the leading wheels loaded. */
export const WHEELIE_GUARD = Object.freeze({ soft: 6 * Math.PI / 180, hard: 18 * Math.PI / 180, stall: .35, liftedSoft: 8 * Math.PI / 180, liftedHard: 20 * Math.PI / 180 });
/** Tank-on-tank contact (pushing and ramming; ResidentTanks reads each chassis's contacts with other tanks from the
 * last step's Rapier manifolds). Rapier resolves hull-to-hull contacts at bumper height (the kit v1 end gears, ~0.3
 * above the COM) while traction acts near the ground, so a push forms a couple that reared both tanks into an A-frame:
 * ramming at top speed on flat ground peaked at 28.5° pitch, and on the seed-7 capture route the rammer sat 31° nose-up
 * against the opponent. Three rules, all active only while touching another tank:
 * - the longitudinal traction acts at the contact height, for the share of it that the head-on contact force
 *   (weighted by |n · forward|; a side scrape adds ~0) balances, so drive and contact form no couple (ramming: ≤ 8°);
 * - the belts stop powering the nose further up against the wheel support between `soft` and `hard` (the contact
 *   normal tilts as one hull rises against the other and would otherwise lift it further: 14° → 10.4° on the route);
 * - steering while a head-on contact blocks the throttle direction blends the throttle toward a pivot. With both belts
 *   driving into a flat face a differential-steered hull cannot yaw (the pressed pair turned together by ~0.4 rad in
 *   2 s); the inner belt must pull back, and then it turns away (≥ 1.2 rad in 2 s).
 * `reachMargin` pads the per-kit bounding radius (chassisReach) that gates the contact query. */
export const TANK_CONTACT = Object.freeze({ soft: 6 * Math.PI / 180, hard: 14 * Math.PI / 180, reachMargin: .1 });
/** Deterministic shaping of digital drive input (u/s of the value): throttle 4/s, steer 6/s. Analog (fractional)
 * DriveInput values pass straight through. */
export const INPUT_SHAPING = Object.freeze({ throttle: 4, steer: 6 });

// ---- assists and recovery -------------------------------------------------------------------------------------------

/** Roll-biased righting torque toward the mean wheel normal (planet up with fewer than `minContacts` contacts):
 * torque = I · (stiffness · excess − damping · ω_tilt), with excess = tilt − deadband (no deadband airborne), the
 * pitch component scaled by `pitchScale` so hill-climb pitch stays free. */
export const RIGHTING_ASSIST = Object.freeze({ stiffness: 8, damping: 3, deadband: 20 * Math.PI / 180, pitchScale: .25, minContacts: 3, airborneDamping: .5,
  /** While one axle is off the ground and the other on it (a nose or tail propped on an obstacle), pitch is not
   * hill-climbing: the full pitch component applies, with this damping multiplier. */
  proppedPitchScale: 1, proppedDamping: 3 });
/** Air control: the righting assist runs at this scale while no wheel touches, landing the tank wheels-down. */
export const AIR_CONTROL = .6;
/** The scripted self-right action: a hop along planet up, then a closed-loop rotation to upright (heading kept)
 * between `rotateFrom` and `rotateTo`, holding upright until the action ends. It starts on DriveInput.selfRight when
 * the tank is tipped (up·planetUp < manualBelowUp), or by itself once the tank has lain flipped
 * (up·planetUp < flippedBelowUp, speed < flippedSpeed) for `autoAfterTicks`. */
export const SELF_RIGHT = Object.freeze({
  ticks: 45, rotateFrom: 8, rotateTo: 34, hopSpeed: 3.6, maxRate: 12,
  manualBelowUp: .8, flippedBelowUp: .3, flippedSpeed: .5, autoAfterTicks: 180,
});

// ---- rigid body and contact geometry ----------------------------------------------------------------------------------

export const CHASSIS_BODY = Object.freeze({ linearDamping: .05, angularDamping: .8, friction: .65, restitution: 0 });
export const CONTACT_GEOMETRY = Object.freeze({
  /** Rounded edges on the rigid hull, fender and end-gear boxes (never more than 45 % of the thinnest half extent). */
  border: .05, borderShare: .45,
  /** Belt wrapped around the end gears: their collision half extent is gear radius + this. */
  endGearBelt: .025,
});
