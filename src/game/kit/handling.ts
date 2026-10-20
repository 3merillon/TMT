/**
 * Handling fallback (plan risk R6; W1-KIT fix round 2). Pending an orchestrator decision; W3-KITPHY retunes the
 * vehicle model for every v2 assembly and then removes this file (inertia floor 0, speed scale 1).
 *
 * Kit v2 keeps its v2 visuals, geometry and masses (mass = Σ parts, COM from part mass boxes). Two physics-facing
 * values keep kit v1's proportions, because W1-PHY's drive model and its drivability suite (verify:vehicle, which
 * Gate 1 requires green with v2 masses) are tuned on them:
 *
 * - `massProps.inertia` is at least mass × INERTIA_FLOOR_PER_MASS (x pitch, y yaw, z roll), kit v1's authored
 *   proportions. The part-box inertia is 0.4–0.55× kit v1's: the arcade keel (mass.ts) concentrates 59–76% of the
 *   mass in a flat box at the COM. On the part-box inertia a scout rode out of the vertical-walled pit that must
 *   trap it (vehicle-recovery).
 * - `stats.speed` is the Experience §1.11 top speed × SPEED_SCALE. The design speed is ≈ 13% above kit v1's for the
 *   legacy builds (warden/scout/dome/mortar 5.22 u/s vs 4.60); × 0.88 gives 4.59. At the design speed the
 *   full-throttle turns of the seed-7 drive route rolled past 20° and a scout pressed nose to nose against a heavy
 *   tank turned 0.83 rad in 2 s (≥ 1 required).
 *
 * Measured on the KIT+PHY trial merge (ovh/w1-kit + ovh/w1-phy 4e11219, verify:vehicle): 16 failures with the
 * round-1 kit; 4 with the fender fix alone (parts/hulls/common.ts fenderSpan); 1 with the fender fix and this file
 * (the barrel-lever test, pinned to kit v1's −35° depression: a CC for W1-PHY).
 */
import type { V3 } from '../contracts';

/** Inertia floor per unit mass about the tank's principal axes (x pitch, y yaw, z roll): kit v1's proportions. */
export const INERTIA_FLOOR_PER_MASS: Readonly<V3> = Object.freeze([0.45, 0.5, 0.24]) as Readonly<V3>;

/** Scale on the Experience §1.11 top speed (gear.baseSpeed × √(11 / mass)). */
export const SPEED_SCALE = 0.88;
