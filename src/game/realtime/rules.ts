/** Realtime match rules v1 (docs/architecture.md). Pure tables and helpers; no clocks, no randomness. */
import type { Difficulty } from '../api/match';
import type { KitAssembly, WeaponId } from '../kit/types';
import { FIXED_DT } from '../rules/ballistics';

/** Memory/observation safety ceiling, NOT a six-tank design limit. Swarms don't allocate chassis. */
export const MAX_REALTIME_UNITS = 128;
export const WRECK_LIFETIME_TICKS = 60 * 25;

/** Base main-gun reload in seconds, before the kit's tempo multiplier. */
export const BASE_RELOAD: Readonly<Record<WeaponId, number>> = Object.freeze({
  mortar: 3.0, cannon: 2.2, rail: 3.5, autocannon: 1.2, arc_cannon: 2.4, forge_mortar: 3.4,
});

/** Main-gun reload of a kit in fixed ticks (tempo < 1 reloads faster). */
export function reloadTicks(kit: KitAssembly): number {
  const base = BASE_RELOAD[kit.loadout.weapon];
  return Math.max(1, Math.round(base * kit.stats.tempo / FIXED_DT));
}

/** The automatic coaxial machine gun: hitscan, never cuts terrain. */
export const COAX = Object.freeze({
  range: 12,
  /** Half-angle of the arc around the turret bearing it engages in (radians). */
  arc: 30 * Math.PI / 180,
  intervalTicks: 9,
  damage: 3,
  /** 0.1 per round at 6.7 rounds/s against 0.3/s cooling: about 2.7 s of continuous fire, then about 2 s to recover. */
  heatPerRound: 0.1,
  /** Heat recovered per second. */
  cooling: 0.3,
  /** An overheated gun waits until its heat falls to this. */
  resume: 0.4,
});

/** Fraction of its own shell's blast damage a tank takes. */
export const SELF_DAMAGE = 0.5;

/** A hostile shell predicted to land this close to a tank of the receiving team raises an incoming telegraph. */
export const INCOMING_RADIUS = 6;

/** Brain tuning per difficulty: reaction delay before a first shot on a fresh contact, aim spread, ring lead. */
export interface DifficultyTuning { reactionTicks: number; yawSpread: number; powerSpread: number; ringLeadSeconds: number }
export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyTuning>> = Object.freeze({
  story: { reactionTicks: 90, yawSpread: 0.09, powerSpread: 0.06, ringLeadSeconds: 1.4 },
  normal: { reactionTicks: 54, yawSpread: 0.05, powerSpread: 0.035, ringLeadSeconds: 1.0 },
  hard: { reactionTicks: 30, yawSpread: 0.03, powerSpread: 0.02, ringLeadSeconds: 0.8 },
  ace: { reactionTicks: 18, yawSpread: 0.015, powerSpread: 0.01, ringLeadSeconds: 0.6 },
});

/** Brains decide at 5 Hz, staggered by unit id; steering follows the decided goal every tick. */
export const DECISION_INTERVAL_TICKS = 12;
/** Aim solves admitted per fixed tick across every brain (each is a bounded set of ballistic traces). */
export const AIM_SOLVES_PER_TICK = 1;
/** Steps one brain aim trace may integrate (4 s of flight covers every slice engagement). */
export const BRAIN_TRACE_STEPS = 240;
/** Enemy positions a team last saw stay usable this long (seconds). */
export const LAST_KNOWN_SECONDS = 12;
