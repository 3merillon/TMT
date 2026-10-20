/**
 * World physics constants: the single home of gravity and launch-speed scaling.
 *
 * One gravity (plan §3, W1-GAME): projectiles and Rapier bodies both fall at 9.81 u/s². Launch speeds are scaled by
 * sqrt(9.81 / 7.5) ≈ 1.144, so every trajectory is the legacy (g = 7.5) curve flown 1.144× faster: ranges are
 * preserved up to the fixed-step discretisation (tests/rules-gravity, mortar, cannon and rail at 15/45/75° over the
 * power range: ≤ 0.33 % on the curved planet; on flat ground ≤ 0.87 % from 1 u, and < 0.01 u for shorter lobs, which
 * is up to 2.5 % of a 0.2 u range). A level may scale gravity (MatchRules.gravityScale; World 6 uses 0.6).
 */
import type { V3 } from './contracts';

/** Projectile gravity in u/s², toward the planet centre (× MatchRules.gravityScale). */
export const GRAVITY_BALLISTIC = 9.81;
/** Rigid-body (Rapier) gravity in u/s², toward the planet centre. */
export const GRAVITY_BODY = 9.81;
/** The ballistic gravity before W1-GAME unified it; launch speeds are scaled against it. */
export const LEGACY_GRAVITY_BALLISTIC = 7.5;
/** Multiplier on every launch speed derived from the kit's weapon stats: sqrt(9.81 / 7.5). */
export const LAUNCH_SPEED_SCALE = Math.sqrt(GRAVITY_BALLISTIC / LEGACY_GRAVITY_BALLISTIC);
/** The game planet is centred on the origin (plan §4.4). */
export const PLANET_CENTER: Readonly<V3> = Object.freeze([0, 0, 0]) as Readonly<V3>;
