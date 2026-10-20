/**
 * Phase-aware input contexts (pure): menu screens, aiming on your turn, driving (relocation after a shot, or the
 * drive test and realtime matches, which aim and drive at once), and watching the opponent.
 */
import type { GameSnapshot } from '../../contracts';
import type { Screen } from '../flow';
import type { InputContext } from './bindings';

export interface ContextInput {
  screen: Screen;
  snapshot: GameSnapshot | undefined;
  observer: number;
  /** The session reported 'ready' for the running match. */
  ready: boolean;
  /** `?mode=drive`: free driving with aiming and firing. */
  driveTest: boolean;
  /** A realtime match (the campaign): drive, aim and fire at any time, like the drive test but with a war on. */
  realtime?: boolean;
}

export function inputContext(o: ContextInput): InputContext {
  if (o.screen !== 'match') return 'menu';
  const state = o.snapshot;
  if (!o.ready || !state || state.phase === 'finished') return 'watch';
  if (o.driveTest) return 'drive';
  if (o.realtime) return state.tanks[o.observer]?.health > 0 ? 'drive' : 'watch';
  if (state.active !== o.observer) return 'watch';
  if (state.phase === 'aim') return 'aim';
  if (state.phase === 'resolving') return 'drive';
  return 'watch';
}

/** The observer may aim now (their aim phase, or any time in the drive test except a terrain update). */
export function canAim(o: ContextInput): boolean {
  const state = o.snapshot;
  if (o.screen !== 'match' || !o.ready || !state) return false;
  if (o.realtime) return state.phase === 'aim' && state.tanks[o.observer]?.health > 0;
  if (state.active !== o.observer) return false;
  return state.phase === 'aim' || (o.driveTest && state.phase === 'resolving');
}
/** The observer may drive now (relocation after their shot, or the drive test). */
export function canDrive(o: ContextInput): boolean {
  const state = o.snapshot;
  if (o.screen !== 'match' || !o.ready || !state || state.phase === 'terrain') return false;
  if (o.realtime) return state.phase === 'aim' && state.tanks[o.observer]?.health > 0;
  if (state.active !== o.observer) return false;
  return o.driveTest || state.phase === 'resolving';
}
