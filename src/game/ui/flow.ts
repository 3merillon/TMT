/**
 * The front-end flow (pure): which screen is up, and which events may change it.
 *
 *   boot ─BOOT─▶ title ─OPEN─▶ {skirmish, workshop, settings, campaign, help} ─BACK─▶ title
 *   boot ─BOOT(deepLink)─▶ loading                      (?mode / ?seed deep links skip the title)
 *   skirmish ─START─▶ loading ─READY─▶ match ⇄ pause    (PAUSE / RESUME, BACK resumes)
 *   loading ─FAIL─▶ skirmish (a skirmish start, with the error) | error (deep links and restarts)
 *   match | pause ─FINISH─▶ results;  pause ─FORFEIT─▶ results (no winner)
 *   match | pause | results | error ─RESTART─▶ loading;  pause | results | error ─MENU─▶ title
 *   pause ─OPEN settings─▶ settings ─BACK─▶ pause;  any ─FATAL─▶ error (device lost, no WebGPU)
 *
 * `transition` returns the same state object when a guard rejects the event, so callers can compare by
 * identity. The DOM layer (ui/controller.ts) runs the side effects for each accepted transition.
 */
export type MenuScreen = 'skirmish' | 'online' | 'workshop' | 'settings' | 'campaign' | 'help';
export type Screen = 'boot' | 'title' | MenuScreen | 'loading' | 'match' | 'pause' | 'results' | 'error';
export type StartOrigin = 'deeplink' | 'skirmish' | 'online' | 'workshop' | 'campaign' | 'restart';
export interface MatchResult { readonly winner: number | null; readonly forfeited: boolean }
export interface FlowState {
  readonly screen: Screen;
  /** Where BACK goes from a menu screen: the title, or the pause menu for settings opened in a match. */
  readonly back: 'title' | 'pause' | null;
  /** What started the current or last load (decides where a failure lands). */
  readonly origin: StartOrigin | null;
  readonly result: MatchResult | null;
  readonly error: string | null;
  /** The error needs a page reload (lost device, no WebGPU): RESTART and MENU reload instead. */
  readonly fatal: boolean;
  /** Every screen entered, oldest first (bounded); window.__tmtGame.ui.history. */
  readonly history: readonly Screen[];
}
export type FlowEvent =
  | { type: 'BOOT'; deepLink: boolean }
  | { type: 'OPEN'; screen: MenuScreen }
  | { type: 'BACK' }
  | { type: 'START' }
  | { type: 'PLAYGROUND' }
  | { type: 'READY' }
  | { type: 'FAIL'; message: string }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  /** `fresh`: a campaign mission from its beginning, never from its checkpoint. */
  | { type: 'RESTART'; fresh?: boolean }
  | { type: 'FORFEIT' }
  | { type: 'FINISH'; winner: number | null }
  | { type: 'MENU' }
  | { type: 'LEAVE' }
  /** Validated browser destination; the controller resolves the associated session first. */
  | { type: 'RESTORE'; screen: Exclude<Screen, 'boot' | 'error'>; back?: 'title' | 'pause' | null; origin?: StartOrigin | null; result?: MatchResult | null }
  | { type: 'FATAL'; message: string };

export const MENU_SCREENS: readonly MenuScreen[] = Object.freeze(['skirmish', 'online', 'workshop', 'settings', 'campaign', 'help']);
const HISTORY_LIMIT = 64;

export function initialFlow(): FlowState {
  return { screen: 'boot', back: null, origin: null, result: null, error: null, fatal: false, history: ['boot'] };
}
const isMenu = (screen: Screen): screen is MenuScreen => (MENU_SCREENS as readonly string[]).includes(screen);
function enter(state: FlowState, screen: Screen, changes: Partial<Omit<FlowState, 'screen' | 'history'>> = {}): FlowState {
  const history = [...state.history, screen];
  return { ...state, ...changes, screen, history: history.length > HISTORY_LIMIT ? history.slice(-HISTORY_LIMIT) : history };
}

/** The next state, or `state` itself when the event is not allowed on this screen. */
export function transition(state: FlowState, event: FlowEvent): FlowState {
  const { screen } = state;
  switch (event.type) {
    case 'RESTORE':
      return state.fatal ? state : enter(state, event.screen, { back: event.back ?? null, origin: event.origin ?? null, result: event.result ?? null, error: null });
    case 'BOOT':
      if (screen !== 'boot') return state;
      return event.deepLink ? enter(state, 'loading', { origin: 'deeplink' }) : enter(state, 'title');
    case 'OPEN':
      if (!isMenu(event.screen)) return state;
      if (screen === 'title') return enter(state, event.screen, { back: 'title', error: null });
      if (screen === 'online' && (event.screen === 'workshop' || event.screen === 'settings')) return enter(state, event.screen, { back: 'title', error: null });
      if (screen === 'pause' && event.screen === 'settings') return enter(state, 'settings', { back: 'pause' });
      return state;
    case 'BACK':
      if (isMenu(screen)) return enter(state, state.back ?? 'title', { back: null, error: null });
      if (screen === 'pause') return enter(state, 'match');
      return state;
    case 'START':
      return screen === 'skirmish' || screen === 'online' || screen === 'workshop' || screen === 'campaign' ? enter(state, 'loading', { origin: screen, back: null, error: null, result: null }) : state;
    case 'PLAYGROUND':
      return screen === 'title' ? enter(state, 'loading', { origin: 'deeplink', back: null, error: null, result: null }) : state;
    case 'READY':
      return screen === 'loading' ? enter(state, 'match', { error: null, result: null }) : state;
    case 'FAIL':
      if (screen !== 'loading') return state;
      return state.origin === 'skirmish'
        ? enter(state, 'skirmish', { back: 'title', error: event.message })
        : enter(state, 'error', { error: event.message, fatal: false });
    case 'PAUSE':
      return screen === 'match' ? enter(state, 'pause') : state;
    case 'RESUME':
      return screen === 'pause' ? enter(state, 'match') : state;
    case 'RESTART':
      if (screen === 'error' && state.fatal) return state;
      return screen === 'match' || screen === 'pause' || screen === 'results' || screen === 'error'
        ? enter(state, 'loading', { origin: 'restart', result: null, error: null }) : state;
    case 'FORFEIT':
      return screen === 'pause' ? enter(state, 'results', { result: { winner: null, forfeited: true } }) : state;
    case 'FINISH':
      return screen === 'match' || screen === 'pause' ? enter(state, 'results', { result: { winner: event.winner, forfeited: false } }) : state;
    case 'MENU':
      if (screen === 'error' && state.fatal) return state;
      return screen === 'loading' || screen === 'pause' || screen === 'results' || screen === 'error'
        ? enter(state, 'title', { back: null, origin: null, result: null, error: null }) : state;
    case 'LEAVE':
      return screen === 'pause' ? enter(state, state.origin === 'campaign' || state.origin === 'workshop' || state.origin === 'skirmish' ? state.origin : 'title', { back: 'title', result: null, error: null }) : state;
    case 'FATAL':
      return state.fatal ? state : enter(state, 'error', { error: event.message, fatal: true });
  }
}
export function canTransition(state: FlowState, event: FlowEvent): boolean { return transition(state, event) !== state; }

/** The simulation runs only while the match screen is up; every other screen pauses it. */
export function simulationPaused(state: FlowState): boolean { return state.screen !== 'match'; }
/** Screens drawn over the live battlefield (the HUD stays mounted underneath). */
export function overMatch(state: FlowState): boolean {
  return state.screen === 'match' || state.screen === 'pause' || state.screen === 'results' || (state.screen === 'settings' && state.back === 'pause');
}
