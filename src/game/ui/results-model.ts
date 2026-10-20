/** Results model (pure): the outcome headline and the match stats for the results screen. */
import type { GameSnapshot } from '../contracts';
import type { MatchSetup } from '../api/match';
import { tankMaxHealth, tankName, teamOf } from './hud-model';
import type { MatchSummary } from './screens/context';

export interface SummaryInput {
  state: GameSnapshot | undefined;
  setup: MatchSetup | undefined;
  /** The tank whose side the summary is written for (the profile owner, tank 0). */
  observer: number;
  winner: number | null;
  forfeited: boolean;
  /** Shells fired per tank. */
  shots: ReadonlyMap<number, number>;
}

/** Whether `winner` (a tank index) is on the observer's team. */
export function wonBy(setup: MatchSetup | undefined, observer: number, winner: number | null): boolean {
  return winner !== null && teamOf(setup, winner) === teamOf(setup, observer);
}
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function matchSummary(o: SummaryInput): MatchSummary {
  const { state, setup, observer, winner } = o;
  const local = setup?.mode === 'local';
  let head: Pick<MatchSummary, 'title' | 'eyebrow' | 'detail' | 'outcome'>;
  if (o.forfeited) head = { title: 'Forfeited.', eyebrow: 'MATCH ABANDONED', detail: 'No winner this time. The planet keeps its scars.', outcome: 'forfeit' };
  else if (winner === null) head = { title: 'Mutual destruction.', eyebrow: 'MATCH DRAWN', detail: 'Both sides are out. Nobody keeps the hill.', outcome: 'draw' };
  else if (local) head = { title: `${tankName(setup, winner, -1)} wins.`, eyebrow: 'MATCH COMPLETE', detail: 'Pass the device back and call a rematch.', outcome: 'other' };
  else if (wonBy(setup, observer, winner)) head = { title: 'Victory!', eyebrow: 'MATCH WON', detail: 'A shot well placed. The workshop salutes you.', outcome: 'win' };
  else head = { title: 'Defeat.', eyebrow: 'MATCH LOST', detail: 'Time for a new angle.', outcome: 'loss' };
  const stats: MatchSummary['stats'] = [];
  if (state) {
    const own = state.tanks[observer];
    const ownTeam = teamOf(setup, observer);
    const realtime = setup?.rules.turnModel === 'realtime';
    const dealt = state.tanks.reduce((sum, tank, index) => teamOf(setup, index) === ownTeam || tank.retired && tank.destroyedAt === undefined ? sum : sum + Math.max(0, tankMaxHealth(tank, setup) - Math.max(0, tank.health)), 0);
    if (!realtime) stats.push({ label: 'Turns', value: String(state.turn) });
    stats.push(
      { label: 'Shots fired', value: String(o.shots.get(observer) ?? 0) },
      { label: realtime ? 'Enemy hull lost' : 'Damage dealt', value: String(Math.round(dealt)) },
      { label: 'Hull left', value: own ? `${Math.max(0, Math.ceil(own.health))}/${tankMaxHealth(own, setup)}` : '—' },
      { label: 'Match time', value: clock(state.time) },
    );
  }
  return { ...head, stats };
}
