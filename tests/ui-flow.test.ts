import { describe, expect, it } from 'vitest';
import { canTransition, initialFlow, MENU_SCREENS, overMatch, simulationPaused, transition, type FlowEvent, type FlowState, type Screen } from '../src/game/ui/flow';

const run = (events: FlowEvent[], from: FlowState = initialFlow()) => events.reduce(transition, from);
const boot = (deepLink = false) => transition(initialFlow(), { type: 'BOOT', deepLink });
const inMatch = () => run([{ type: 'OPEN', screen: 'skirmish' }, { type: 'START' }, { type: 'READY' }], boot());

const ALL_EVENTS: FlowEvent[] = [
  { type: 'BOOT', deepLink: false }, { type: 'BOOT', deepLink: true }, ...MENU_SCREENS.map(screen => ({ type: 'OPEN', screen }) as FlowEvent),
  { type: 'BACK' }, { type: 'START' }, { type: 'READY' }, { type: 'FAIL', message: 'x' }, { type: 'PAUSE' }, { type: 'RESUME' },
  { type: 'RESTART' }, { type: 'FORFEIT' }, { type: 'FINISH', winner: 0 }, { type: 'MENU' }, { type: 'FATAL', message: 'lost' },
];

describe('front-end flow', () => {
  it('boots to the title, and a deep link skips the title straight into loading', () => {
    expect(initialFlow().screen).toBe('boot');
    expect(boot().screen).toBe('title');
    const deep = boot(true);
    expect(deep.screen).toBe('loading');
    expect(deep.origin).toBe('deeplink');
    expect(deep.history).toEqual(['boot', 'loading']);
    expect(transition(deep, { type: 'READY' }).screen).toBe('match');
    expect(transition(deep, { type: 'READY' }).history).toEqual(['boot', 'loading', 'match']);
    // BOOT happens once.
    const titled = boot();
    expect(transition(titled, { type: 'BOOT', deepLink: true })).toBe(titled);
  });

  it('opens every menu screen from the title and BACK returns to the title', () => {
    for (const screen of MENU_SCREENS) {
      const opened = transition(boot(), { type: 'OPEN', screen });
      expect(opened.screen).toBe(screen);
      expect(opened.back).toBe('title');
      expect(transition(opened, { type: 'BACK' }).screen).toBe('title');
      // Queue navigation can open Workshop and Settings without losing its Online return path.
      for (const other of MENU_SCREENS) expect(canTransition(opened, { type: 'OPEN', screen: other })).toBe(screen === 'online' && ['workshop', 'settings'].includes(other));
    }
    const title = boot();
    expect(transition(title, { type: 'BACK' })).toBe(title);
    expect(transition(title, { type: 'START' })).toBe(title);
  });

  it('runs title → skirmish → match → pause → results → retry/menu in order', () => {
    const states: Screen[] = [];
    let state = boot();
    for (const event of [{ type: 'OPEN', screen: 'skirmish' }, { type: 'START' }, { type: 'READY' }, { type: 'PAUSE' }, { type: 'FORFEIT' }] as FlowEvent[]) {
      state = transition(state, event);
      states.push(state.screen);
    }
    expect(states).toEqual(['skirmish', 'loading', 'match', 'pause', 'results']);
    expect(state.result).toEqual({ winner: null, forfeited: true });
    expect(state.history).toEqual(['boot', 'title', 'skirmish', 'loading', 'match', 'pause', 'results']);
    const retry = transition(state, { type: 'RESTART' });
    expect(retry.screen).toBe('loading');
    expect(retry.origin).toBe('restart');
    expect(retry.result).toBeNull();
    expect(transition(retry, { type: 'READY' }).screen).toBe('match');
    const menu = transition(state, { type: 'MENU' });
    expect(menu.screen).toBe('title');
    expect(menu.result).toBeNull();
  });

  it('pauses and resumes only in a match; BACK from pause resumes', () => {
    const match = inMatch();
    const paused = transition(match, { type: 'PAUSE' });
    expect(paused.screen).toBe('pause');
    expect(transition(paused, { type: 'RESUME' }).screen).toBe('match');
    expect(transition(paused, { type: 'BACK' }).screen).toBe('match');
    expect(transition(paused, { type: 'PAUSE' })).toBe(paused);
    expect(transition(match, { type: 'RESUME' })).toBe(match);
    for (const screen of ['title', 'loading', 'results'] as const) {
      const state = screen === 'title' ? boot() : screen === 'loading' ? boot(true) : transition(match, { type: 'FINISH', winner: 1 });
      expect(canTransition(state, { type: 'PAUSE' })).toBe(false);
    }
  });

  it('opens settings from the pause menu and returns there', () => {
    const paused = transition(inMatch(), { type: 'PAUSE' });
    const settings = transition(paused, { type: 'OPEN', screen: 'settings' });
    expect(settings.screen).toBe('settings');
    expect(settings.back).toBe('pause');
    expect(overMatch(settings)).toBe(true);
    expect(simulationPaused(settings)).toBe(true);
    expect(transition(settings, { type: 'BACK' }).screen).toBe('pause');
    for (const screen of ['skirmish', 'workshop', 'campaign', 'help'] as const) expect(canTransition(paused, { type: 'OPEN', screen })).toBe(false);
  });

  it('records the winner on FINISH, from the match or while paused, and restarts from pause', () => {
    const match = inMatch();
    expect(transition(match, { type: 'FINISH', winner: 1 }).result).toEqual({ winner: 1, forfeited: false });
    expect(transition(transition(match, { type: 'PAUSE' }), { type: 'FINISH', winner: null }).result).toEqual({ winner: null, forfeited: false });
    expect(transition(transition(match, { type: 'PAUSE' }), { type: 'RESTART' }).screen).toBe('loading');
    // The developer bar restarts straight from the match (drive test reset and toggle).
    expect(transition(match, { type: 'RESTART' }).screen).toBe('loading');
    expect(canTransition(boot(), { type: 'RESTART' })).toBe(false);
    expect(canTransition(boot(true), { type: 'RESTART' })).toBe(false);
    expect(transition(transition(match, { type: 'PAUSE' }), { type: 'MENU' }).screen).toBe('title');
    // FORFEIT needs the pause menu; FINISH is ignored away from a match.
    expect(canTransition(match, { type: 'FORFEIT' })).toBe(false);
    expect(canTransition(boot(), { type: 'FINISH', winner: 0 })).toBe(false);
    expect(canTransition(boot(true), { type: 'FINISH', winner: 0 })).toBe(false);
  });

  it('sends a failed skirmish start back to the setup with the error, other failures to the error screen', () => {
    const loading = run([{ type: 'OPEN', screen: 'skirmish' }, { type: 'START' }], boot());
    const failed = transition(loading, { type: 'FAIL', message: 'N-tank matches arrive with W1-GAME' });
    expect(failed.screen).toBe('skirmish');
    expect(failed.error).toBe('N-tank matches arrive with W1-GAME');
    expect(transition(failed, { type: 'START' }).error).toBeNull();
    const deepFailed = transition(boot(true), { type: 'FAIL', message: 'no world' });
    expect(deepFailed.screen).toBe('error');
    expect(deepFailed.fatal).toBe(false);
    expect(transition(deepFailed, { type: 'RESTART' }).screen).toBe('loading');
    expect(transition(deepFailed, { type: 'MENU' }).screen).toBe('title');
    expect(canTransition(boot(), { type: 'FAIL', message: 'x' })).toBe(false);
    expect(canTransition(inMatch(), { type: 'READY' })).toBe(false);
  });

  it('treats FATAL as terminal: only a reload leaves it', () => {
    const fatal = transition(inMatch(), { type: 'FATAL', message: 'device lost' });
    expect(fatal.screen).toBe('error');
    expect(fatal.fatal).toBe(true);
    for (const event of ALL_EVENTS) expect(transition(fatal, event)).toBe(fatal);
    expect(transition(initialFlow(), { type: 'FATAL', message: 'no WebGPU' }).screen).toBe('error');
  });

  it('only the match screen runs the simulation', () => {
    const match = inMatch();
    expect(simulationPaused(match)).toBe(false);
    for (const state of [boot(), boot(true), transition(match, { type: 'PAUSE' }), transition(match, { type: 'FINISH', winner: 0 })]) expect(simulationPaused(state)).toBe(true);
    expect(overMatch(match)).toBe(true);
    expect(overMatch(boot())).toBe(false);
  });

  it('returns to the menu while loading and ignores a late ready event', () => {
    const cancelled = transition(boot(true), { type: 'MENU' });
    expect(cancelled.screen).toBe('title');
    expect(transition(cancelled, { type: 'READY' })).toBe(cancelled);
  });

  it('restores browser destinations while keeping fatal errors terminal', () => {
    const paused = transition(inMatch(), { type: 'RESTORE', screen: 'pause', origin: 'campaign' });
    expect(simulationPaused(paused)).toBe(true);
    expect(transition(paused, { type: 'LEAVE' }).screen).toBe('campaign');
    const settings = transition(paused, { type: 'RESTORE', screen: 'settings', back: 'pause', origin: 'campaign' });
    expect(overMatch(settings)).toBe(true);
    expect(transition(settings, { type: 'BACK' }).screen).toBe('pause');
    const fatal = transition(settings, { type: 'FATAL', message: 'Device lost' });
    expect(transition(fatal, { type: 'RESTORE', screen: 'title' })).toBe(fatal);
    expect(transition(boot(), { type: 'PLAYGROUND' }).screen).toBe('loading');
    expect(transition(paused, { type: 'PLAYGROUND' })).toBe(paused);
  });

  it('never throws and keeps a bounded history under any event sequence', () => {
    let state = initialFlow();
    let seed = 7;
    for (let i = 0; i < 5000; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      state = transition(state, ALL_EVENTS[seed % ALL_EVENTS.length]);
      if (state.fatal) state = initialFlow();
    }
    expect(state.history.length).toBeLessThanOrEqual(64);
  });
});
