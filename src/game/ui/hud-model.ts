/**
 * HUD model (pure): what the HUD shows for a snapshot, the match setup and the observer. Works for N tanks and
 * teams; reads optional fields that arrive with W1-GAME (TankState.ammo) structurally, so it compiles before and
 * after that merge. Enemy health follows fog of war: shown while the observer sees the tank, then "last seen".
 */
import type { GameSnapshot, TankState } from '../contracts';
import type { MatchRules, MatchSetup } from '../api/match';
import { MUNITIONS, type MunitionId } from '../munitions';
import { assembleKit, tankKit } from '../kit';

export const TEAM_COLORS: readonly string[] = Object.freeze(['#3f7a4a', '#b4532a', '#2f6f8f', '#b98d45']);
export interface RosterRow {
  index: number; name: string; team: number; color: string; self: boolean; ally: boolean; active: boolean; destroyed: boolean;
  /** Current health when visible, the last seen value otherwise, null when never seen. */
  health: number | null; maxHealth: number; stale: boolean;
}
export interface Banner { turn: string; tag: string; title: string; detail: string }
export interface AmmoChip { id: MunitionId; name: string; short: string; count: number | null; selected: boolean; empty: boolean }

const SHORT: Readonly<Record<MunitionId, string>> = { explosive: 'HE', heavy: 'HVY', incendiary: 'INC', nuclear: 'NUK' };

export function tankMaxHealth(tank: TankState, setup?: MatchSetup): number {
  // The simulation records the spawn health on the tank (realtime units spawn after the setup was written).
  if (tank.maxHealth !== undefined) return tank.maxHealth;
  const override = setup?.tanks[tank.id]?.maxHealth;
  if (override !== undefined) return override;
  try { return assembleKit(tankKit(tank)).stats.hp; } catch { return 100; }
}
export function teamOf(setup: MatchSetup | undefined, index: number, state?: GameSnapshot): number { return state?.tanks[index]?.team ?? setup?.tanks[index]?.team ?? index; }
/** A realtime match (src/game/realtime): no turns, every unit acts at once. */
export function isRealtime(setup: MatchSetup | undefined): boolean { return setup?.rules.turnModel === 'realtime'; }
/** The spawn's name, else its team's name when the team has one tank, else 'You' / 'Tank n'. */
export function tankName(setup: MatchSetup | undefined, index: number, observer: number): string {
  const spawn = setup?.tanks[index];
  if (spawn?.name) return spawn.name;
  if (index === observer && setup?.mode !== 'local') return 'You';
  const team = spawn && setup?.teams.find(t => t.id === spawn.team);
  if (team && setup!.tanks.filter(t => t.team === spawn.team).length === 1) return team.name;
  return `Tank ${index + 1}`;
}
/** Whether the observer currently sees tank `index` (allies always; v1 contacts are per observer). */
export function tankVisible(state: GameSnapshot, setup: MatchSetup | undefined, observer: number, index: number): boolean {
  if (index === observer || teamOf(setup, index, state) === teamOf(setup, observer, state)) return true;
  if (setup && !setup.rules.fog) return true;
  const observed = state.observations?.[observer]?.[index];
  if (state.observations && isRealtime(setup)) return !!observed?.visible;
  if (state.tanks.length === 2) return !!state.contacts[observer]?.visible;
  return false;
}

/** `lastSeen` (tank index → health) is updated in place with every visible enemy. */
export function rosterRows(state: GameSnapshot, setup: MatchSetup | undefined, observer: number, lastSeen: Map<number, number>): RosterRow[] {
  const ownTeam = teamOf(setup, observer, state), realtime = isRealtime(setup);
  const rows = state.tanks.map((tank, index) => {
    const team = teamOf(setup, index, state), visible = tankVisible(state, setup, observer, index);
    if (visible) lastSeen.set(index, tank.health);
    const seen = lastSeen.get(index);
    return {
      index, name: tank.name ?? tankName(setup, index, observer), team, color: TEAM_COLORS[team % TEAM_COLORS.length], self: index === observer, ally: team === ownTeam,
      active: !realtime && state.active === index && state.phase !== 'finished', destroyed: visible ? tank.health <= 0 : (seen ?? 1) <= 0,
      health: visible ? Math.max(0, tank.health) : seen === undefined ? null : Math.max(0, seen), maxHealth: tankMaxHealth(tank, setup), stale: !visible,
    };
  });
  // A realtime mission spawns many units: list your side and the enemies you have seen and not yet destroyed.
  return realtime ? rows.filter(row => row.ally || (row.health !== null && !row.destroyed)) : rows;
}

export function banner(state: GameSnapshot, setup: MatchSetup | undefined, observer: number, driveTest: boolean): Banner {
  const own = state.active === observer, turn = driveTest ? 'DRIVE TEST' : `TURN ${String(state.turn).padStart(2, '0')}`;
  const activeName = tankName(setup, state.active, observer);
  const local = setup?.mode === 'local';
  if (state.phase === 'finished') return { turn, tag: 'MATCH OVER', title: 'Match complete.', detail: '' };
  if (isRealtime(setup)) return { turn: setup?.mode === 'campaign' ? 'MISSION' : 'BATTLE', tag: 'LIVE', title: 'Drive, aim, fire.',
    detail: setup?.rules.autoCoax === false ? 'Simultaneous artillery. Set elevation and power; fire again when reloaded.'
      : 'Everyone moves at once. The machine gun fires by itself at what your turret faces.' };
  if (state.phase === 'terrain') return { turn, tag: 'TERRAIN UPDATE', title: 'The ground is changing.', detail: 'The blast is carving a new firing line.' };
  if (driveTest) return { turn, tag: 'FREE DRIVE', title: 'Take it for a drive.', detail: 'WASD drive · left mouse target · left+wheel range · Space fire' };
  if (!own) return { turn, tag: local ? `${activeName.toUpperCase()}'S TURN` : 'OPPONENT TURN', title: `${activeName} is up.`, detail: 'Watch the shot and plan your reply.' };
  if (state.phase === 'resolving') return { turn, tag: 'RELOCATE', title: 'Leave the firing line.', detail: 'Drive until your distance or time runs out.' };
  const who = local ? `${activeName.toUpperCase()} · ` : '';
  return { turn, tag: `${who}YOUR SHOT`, title: 'Find your angle.', detail: 'Bearing, elevation, power — then fire.' };
}

/** Remaining rounds per munition: TankState.ammo when the sim provides it (W1-GAME), else the rules' allowance; null = unlimited. */
export function ammoChips(tank: TankState, rules: MatchRules | undefined): AmmoChip[] {
  const live = (tank as TankState & { ammo?: Partial<Record<MunitionId, number>> }).ammo;
  const selected = tank.munition ?? 'explosive';
  return (Object.keys(MUNITIONS) as MunitionId[]).map(id => {
    const count = live && Object.hasOwn(live, id) ? live[id]! : rules && Object.hasOwn(rules.ammo, id) ? rules.ammo[id]! : null;
    return { id, name: MUNITIONS[id].name, short: SHORT[id], count, selected: id === selected, empty: count !== null && count <= 0 };
  });
}
/** The next (or previous) munition that still has rounds. */
export function cycleMunition(chips: readonly AmmoChip[], step: 1 | -1): MunitionId | undefined {
  const start = chips.findIndex(c => c.selected);
  for (let i = 1; i <= chips.length; i++) {
    const chip = chips[(start + step * i + chips.length * 2) % chips.length];
    if (!chip.empty) return chip.id;
  }
  return undefined;
}

export function windLabel(rules: MatchRules | undefined): string {
  if (!rules?.wind) return 'Calm';
  return `${rules.wind.mean.toFixed(1)} m/s · gusts ${rules.wind.gust.toFixed(1)}`;
}
/** Seconds left to aim, or null without an aim limit. */
export function aimSecondsLeft(state: GameSnapshot, rules: MatchRules | undefined): number | null {
  if (rules?.turnModel === 'realtime' || rules?.aimSeconds === undefined || state.phase !== 'aim') return null;
  return Math.max(0, rules.aimSeconds - state.phaseTime);
}
export function objectiveLabel(state: GameSnapshot, setup: MatchSetup | undefined, observer: number): string {
  const objective = setup?.objectives[0];
  if (setup?.mode === 'campaign') return 'Mission objectives';
  if (!objective) return setup?.mode === 'drive' ? 'Free drive · no objective' : 'Last tank standing';
  if (objective.kind === 'eliminate') {
    const ownTeam = teamOf(setup, observer);
    const enemies = state.tanks.filter((_, index) => teamOf(setup, index) !== ownTeam);
    const down = enemies.filter(t => t.health <= 0).length;
    return `Eliminate the opposition · ${down}/${enemies.length}`;
  }
  return `Objective: ${objective.kind}`;
}
