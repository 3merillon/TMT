// @contract v1 — docs/architecture.md#contracts-and-invariants
// api/match.ts
import type { Loadout, V3 } from '../contracts'; import type { MunitionId } from '../munitions';
import type { TerrainStructure } from '../terrain-structures'; import type { CutRequest } from '../../gpu/terrain/transactions';
import { kitLoadoutFromLegacy } from '../kit/catalog';
export type TeamId = number;
export type Difficulty = 'story' | 'normal' | 'hard' | 'ace';
export type BotProfileId = 'legacy' | 'rusty' | 'tosser' | 'hornet' | 'bulwark' | 'vex' | 'mole' | 'pyro' | 'poolshark' | 'medic' | 'cyborg';
export interface KitLoadoutIds { hull: string; runningGear: string; turret: string; weapon: string; utility: string; armor?: string } // validated by kit.validateKitLoadout
export interface WindRule { mean: number; gust: number; period: number }
export interface MatchRules {
  moveSeconds: number; aimSeconds?: number; maxTurns?: number; suddenDeathTurn?: number;
  wind: WindRule | null; fog: boolean; projectileAge: number; gravityScale: number;
  ammo: Partial<Record<MunitionId, number>>; radarCost: number; startCharge: number; friendlyFire: boolean;
  commitWindowTicks: number;                 // K, default 12
  turnModel: 'tempo' | 'realtime';           // tempo: equal tempo == strict alternation; realtime: src/game/realtime (campaign)
  /** Artillery uses only deliberate player shots; other realtime modes retain the automatic coax. */
  autoCoax?: boolean;
  brace: boolean; taps: boolean; overdrive: boolean; supplyEvery: number; fallDamage: boolean; // default false until W2 GAME-2 implements them
}
export interface TankSpawn { team: TeamId; loadout: KitLoadoutIds; spawn: 'auto' | { up: V3; heading: number };
  brain?: BotProfileId; difficulty?: Difficulty; name?: string; maxHealth?: number }
export interface ObjectiveDef { kind: 'eliminate' | 'survive' | 'demolish' | 'targets' | 'hold' | 'reach' | 'protect' | 'intercept' | 'excavate' | 'trick'; params?: Record<string, unknown> }
export interface MatchSetup {
  crew?: import('../campaign/loadout').CrewBuild;
  id: string; seed: number; mode: 'bot' | 'local' | 'drive' | 'skirmish' | 'campaign' | 'online';
  /** Admitted human seats, stable across reconnects and authority changes. */
  online?: { kind: 'duel' | 'realtime' | 'artillery' | 'coop'; seats: number[];
    /** Save ownership is fixed when the room is created, independently of simulation-host elections. */
    campaignOwnerSeat?: number; runId?: string };
  planet: { kind: 'auto' | 'temperate' | 'glacial' | 'dune' | 'volcanic'; recipe?: string };
  structures?: TerrainStructure[]; initialCuts?: CutRequest[];
  teams: { id: TeamId; name: string; ai: boolean }[]; tanks: TankSpawn[];
  rules: MatchRules; objectives: ObjectiveDef[];
  environment?: { timeOfDay?: number; weatherSeed?: number; water?: string; vegetation?: string };
}

/** Today's practice duel: line-of-sight contacts (fog), unlimited ammo (no entry = unlimited),
 * one starting radar charge, and every tank inside a blast takes damage (friendly fire on).
 * The literals mirror simulation.ts (MOVE_SECONDS, MAX_PROJECTILE_AGE, RADAR_COST; checked by
 * tests/rules-match-setup) so this contract never imports the simulation it configures. */
export const DEFAULT_RULES: MatchRules = Object.freeze({                    // reproduces today's practice duel
  moveSeconds: 30, wind: null, fog: true, projectileAge: 8, gravityScale: 1,
  ammo: Object.freeze({}), radarCost: 3, startCharge: 1, friendlyFire: true,
  commitWindowTicks: 12, turnModel: 'tempo', brace: false, taps: false, overdrive: false, supplyEvery: 0, fallDamage: false,
});
export function practiceSetup(o: { seed: number; mode: 'bot' | 'local' | 'drive'; player: Loadout; opponent?: Loadout }): MatchSetup {
  if (!Number.isSafeInteger(o.seed) || o.seed < 0) throw new Error(`Practice seed must be a non-negative integer, got ${o.seed}`);
  if (o.mode !== 'bot' && o.mode !== 'local' && o.mode !== 'drive') throw new Error(`Unknown practice mode ${String(o.mode)}`);
  const ai = o.mode === 'bot';
  return {
    id: `practice:${o.mode}:${o.seed}`, seed: o.seed, mode: o.mode, planet: { kind: 'auto' },
    teams: [{ id: 0, name: o.mode === 'local' ? 'Player 1' : 'You', ai: false }, { id: 1, name: ai ? 'Practice AI' : o.mode === 'local' ? 'Player 2' : 'Drive target', ai }],
    tanks: [
      { team: 0, loadout: legacyToKitIds(o.player), spawn: 'auto' },
      { team: 1, loadout: legacyToKitIds(o.opponent ?? o.player), spawn: 'auto', ...(ai ? { brain: 'legacy' as const, difficulty: 'normal' as const } : {}) },
    ],
    rules: { ...DEFAULT_RULES, ammo: { ...DEFAULT_RULES.ammo } },
    objectives: o.mode === 'drive' ? [] : [{ kind: 'eliminate' }],
  };
}
/** CC-005: one table. Delegates to the kit's Appendix A mapping (src/game/kit/catalog.ts kitLoadoutFromLegacy). */
export function legacyToKitIds(l: Loadout): KitLoadoutIds {                    // table in Appendix A
  let kit: KitLoadoutIds;
  try { kit = kitLoadoutFromLegacy(l); } catch { throw new Error(`Unknown v1 loadout ${JSON.stringify(l)}`); }
  return { hull: kit.hull, runningGear: kit.runningGear, turret: kit.turret, weapon: kit.weapon, utility: kit.utility };
}
