/** Ammunition (plan §3, W1-GAME step 5): `rules.ammo` limits munitions per match (no entry = unlimited); the nuke is
 * one per match unless the rules say otherwise, and it is charge-gated: it needs a full charge and spends it.
 * Drive tests are a sandbox without limits. Pure. */
import type { TankState } from '../contracts';
import type { MatchRules } from '../api/match';
import { MUNITIONS, type MunitionId } from '../munitions';

export const NUKES_PER_MATCH = 1;
/** Charge a nuke needs (and spends): a full radar/overdrive charge (rules/setup MAX_CHARGE). */
export const NUKE_CHARGE = 3;

/** The limited munitions of a tank at match start: every counted rules.ammo entry plus the nuke. */
export function initialAmmo(rules: Pick<MatchRules, 'ammo'>): Partial<Record<MunitionId, number>> {
  const ammo: Partial<Record<MunitionId, number>> = {};
  for (const id of Object.keys(MUNITIONS) as MunitionId[]) {
    const count = rules.ammo[id];
    if (count !== undefined) ammo[id] = count;
  }
  ammo.nuclear ??= NUKES_PER_MATCH;
  return ammo;
}

/** Rounds left of a munition (Infinity = unlimited). */
export function roundsLeft(tank: Pick<TankState, 'ammo'>, id: MunitionId): number {
  return tank.ammo?.[id] ?? Infinity;
}

/** Why a munition cannot be fired now, or null when it can. */
export function ammoBlock(tank: Pick<TankState, 'ammo' | 'charge'>, id: MunitionId, sandbox: boolean): 'empty' | 'charge' | null {
  if (sandbox) return null;
  if (roundsLeft(tank, id) <= 0) return 'empty';
  if (id === 'nuclear' && tank.charge < NUKE_CHARGE) return 'charge';
  return null;
}

/** Spend one round (and the nuke's charge). Call only after ammoBlock returned null. */
export function spendAmmo(tank: TankState, id: MunitionId, sandbox: boolean): void {
  if (sandbox) return;
  if (tank.ammo?.[id] !== undefined) tank.ammo[id] = tank.ammo[id]! - 1;
  if (id === 'nuclear') tank.charge -= NUKE_CHARGE;
}
