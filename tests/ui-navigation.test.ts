import { describe, expect, it } from 'vitest';
import { BrowserNavigation, navigationSearch, type NavigationHost, type NavigationRoute } from '../src/game/ui/navigation';
import { NavigationGames } from '../src/game/ui/navigation-session';
import { practiceSetup } from '../src/game/api/match';
import { DEFAULT_LOADOUT } from '../src/game/modules';

/** Traversals are deliberately asynchronous, as in a browser. Writes truncate Forward. */
class Browser implements NavigationHost {
  entries: { state: unknown; search: string }[];
  cursor = 0;
  pending: number | null = null;
  listener: (state: unknown) => void = () => {};
  constructor(search = '') { this.entries = [{ state: null, search }]; }
  state() { return structuredClone(this.entries[this.cursor].state); }
  search() { return this.entries[this.cursor].search; }
  write(state: unknown, search: string, replace: boolean) {
    if (!replace) { this.entries.splice(this.cursor + 1); this.cursor++; }
    this.entries[this.cursor] = { state: structuredClone(state), search };
  }
  go(delta: number) { this.pending = this.cursor + delta; }
  listen(callback: (state: unknown) => void) { this.listener = callback; return () => { this.listener = () => {}; }; }
  flush() {
    if (this.pending === null) return;
    this.cursor = this.pending; this.pending = null;
    if (!this.entries[this.cursor]) throw new Error('Navigation escaped the application');
    this.listener(this.state());
  }
  back() { this.go(-1); this.flush(); }
  forward() { this.go(1); this.flush(); }
}
function harness(search = '') {
  const host = new Browser(search), changes: NavigationRoute[] = [];
  const nav = new BrowserNavigation(host, route => changes.push(route));
  return { host, nav, changes };
}

describe('browser navigation', () => {
  it('lets buttons and browser traversal share menu entries without building Back loops', () => {
    const { host, nav, changes } = harness('?dev&capture=1');
    expect(nav.boot(false).screen).toBe('title');
    nav.visit({ screen: 'campaign' });
    expect(host.search()).toBe('?dev&capture=1&screen=campaign');
    nav.back(); host.flush();
    expect(changes.at(-1)?.screen).toBe('title');
    host.forward(); expect(nav.route.screen).toBe('campaign');
    nav.visit({ screen: 'workshop' }); nav.back(); host.flush();
    expect(nav.route.screen).toBe('campaign');
    nav.visit({ screen: 'title' }); host.flush();
    nav.visit({ screen: 'campaign' }); host.flush();
    expect(host.entries).toHaveLength(3);
  });
  it('inserts a pause before a live battle, resumes the same key and leaves from pause', () => {
    const { host, nav } = harness(); nav.boot(false);
    nav.visit({ screen: 'campaign' });
    const key = nav.startGame('mode=campaign&mission=p1');
    expect(nav.route.screen).toBe('match');
    host.back(); expect(nav.route).toMatchObject({ screen: 'pause', game: key });
    host.back(); expect(nav.route).toEqual({ screen: 'campaign' });
    host.forward(); expect(nav.route.screen).toBe('pause');
    nav.visit({ ...nav.route, screen: 'match' }); host.flush();
    expect(nav.route).toMatchObject({ screen: 'match', game: key });
    expect(host.entries).toHaveLength(4);
  });
  it('retains a pause guard when settings truncate the previous Forward battle', () => {
    const { host, nav } = harness(); nav.boot(false); nav.visit({ screen: 'skirmish' }); nav.startGame('mode=bot&seed=7');
    nav.visit({ ...nav.route, screen: 'pause' }); host.flush();
    nav.visit({ ...nav.route, screen: 'settings' });
    nav.back(); host.flush();
    nav.visit({ ...nav.route, screen: 'match' });
    expect(nav.route.screen).toBe('match');
    expect(host.entries).toHaveLength(4);
    host.back(); expect(nav.route.screen).toBe('pause');
    host.back(); expect(nav.route.screen).toBe('skirmish');
  });
  it('seeds safe ancestors for direct links and preserves a real exit boundary', () => {
    const { host, nav } = harness('?mode=campaign&mission=p2&dev');
    expect(nav.boot(true).screen).toBe('match');
    host.back(); expect(nav.route.screen).toBe('pause');
    host.back(); expect(nav.route.screen).toBe('campaign');
    host.back(); expect(nav.route.screen).toBe('title');
    expect(host.cursor).toBe(0); expect(host.pending).toBeNull();
  });
  it('reloads menus, paused games and their settings without adding history entries', () => {
    const { host, nav } = harness('?mode=campaign&mission=p1&screen=settings&dev');
    expect(nav.boot(true)).toMatchObject({ screen: 'settings', parent: 'campaign' });
    const count = host.entries.length, before = nav.route;
    nav.dispose();
    const reloaded = new BrowserNavigation(host, () => {});
    expect(reloaded.boot(true)).toEqual(before);
    expect(host.entries).toHaveLength(count);
    reloaded.back(); host.flush(); expect(reloaded.route.screen).toBe('pause');
    const menu = harness('?screen=workshop&dev');
    expect(menu.nav.boot(false).screen).toBe('workshop');
    menu.host.back(); expect(menu.nav.route.screen).toBe('title');
  });
  it('retries and next missions reuse the live slot and leave only one pause entry', () => {
    const { host, nav } = harness('?mode=campaign&mission=p1'); nav.boot(true);
    const key = nav.route.game;
    for (let i = 0; i < 20; i++) {
      nav.replace({ ...nav.route, screen: 'results' });
      expect(nav.startGame('mode=campaign&mission=p2')).toBe(key);
    }
    expect(host.entries).toHaveLength(4);
    host.back(); expect(nav.route.screen).toBe('pause');
    nav.startGame('mode=campaign&mission=p3');
    expect(host.entries).toHaveLength(4);
  });
  it('serializes rapid button navigation against the pending native traversal', () => {
    const { host, nav } = harness(); nav.boot(false); nav.visit({ screen: 'campaign' });
    nav.back(); nav.visit({ screen: 'settings' });
    host.flush();
    expect(nav.route.screen).toBe('settings');
    expect(host.entries).toHaveLength(2);
    host.back(); expect(nav.route.screen).toBe('title');
    host.forward(); expect(nav.route.screen).toBe('settings');
  });
  it('puts a forfeit in the live slot, retaining the pause guard for retry', () => {
    const { host, nav } = harness('?mode=bot&seed=7'); nav.boot(true);
    host.back(); expect(nav.route.screen).toBe('pause');
    nav.finishGame(); host.flush();
    // The session resolver changes the finished live destination into results.
    nav.replace({ ...nav.route, screen: 'results' });
    nav.startGame('mode=bot&seed=7');
    expect(host.entries).toHaveLength(4);
    host.back(); expect(nav.route.screen).toBe('pause'); expect(nav.direction).toBe(-1);
    host.back(); expect(nav.route.screen).toBe('skirmish');
    host.forward(); expect(nav.route.screen).toBe('pause'); expect(nav.direction).toBe(1);
  });
  it('ignores corrupt or foreign state and sanitizes route query strings', () => {
    const { host, nav } = harness('?screen=help');
    host.entries[0].state = { ironOrrery: 1, trail: 'a', path: [{ id: 'bad', route: { screen: 'pause', game: '../no', parent: 'bad', query: '' } }] };
    expect(nav.boot(false).screen).toBe('help');
    expect(navigationSearch('?mode=campaign&screen=pause&mission=p1&dev&capture=1', { screen: 'campaign' }))
      .toBe('?dev&capture=1&screen=campaign');
    expect(navigationSearch('?%73creen=pause&dev&mode=bot', { screen: 'help' })).toBe('?dev&screen=help');
  });
});

describe('unsaved editor navigation', () => {
  function guarded() {
    const host = new Browser(), changes: NavigationRoute[] = [];
    const questions: { leave(): void; keep(): void }[] = [];
    let dirty = false;
    const nav = new BrowserNavigation(host, route => changes.push(route), {
      needed: (from, to) => dirty && from.screen === 'workshop' && to.screen !== 'workshop',
      request: (leave, keep) => questions.push({ leave, keep }),
    });
    nav.boot(false); nav.visit({ screen: 'workshop' });
    return { host, nav, questions, changes, paint() { dirty = true; } };
  }

  it('guards direct server navigation without changing the current history or repeating the dialog', () => {
    const { host, nav, questions, changes, paint } = guarded(); paint();
    const before = host.entries.length;
    nav.visit({ screen: 'online' }); nav.visit({ screen: 'title' }); nav.back();
    expect(questions).toHaveLength(1); expect(nav.busy).toBe(true);
    expect(nav.route.screen).toBe('workshop'); expect(host.search()).toBe('?screen=workshop');
    expect(host.entries).toHaveLength(before);
    questions[0].keep(); expect(nav.busy).toBe(false);
    nav.visit({ screen: 'online' }); expect(questions).toHaveLength(2);
    questions[1].leave(); questions[1].leave();
    expect(nav.route.screen).toBe('online'); expect(changes.filter(route => route.screen === 'online')).toHaveLength(1);
    expect(host.entries).toHaveLength(before + 1);
  });

  it('restores native Back before asking and keeps the same URL and Forward chain on cancellation', () => {
    const { host, nav, questions, changes, paint } = guarded(); paint();
    const before = structuredClone(host.entries), count = changes.length;
    host.back();
    expect(nav.route.screen).toBe('workshop'); expect(changes).toHaveLength(count); expect(questions).toHaveLength(0);
    host.flush();
    expect(host.cursor).toBe(1); expect(host.search()).toBe('?screen=workshop'); expect(questions).toHaveLength(1);
    questions[0].keep();
    expect(nav.busy).toBe(false); expect(host.entries).toEqual(before); expect(changes).toHaveLength(count);
    host.back(); host.flush(); questions[1].leave(); host.flush();
    expect(nav.route.screen).toBe('title'); expect(nav.direction).toBe(-1);
    host.forward(); expect(nav.route.screen).toBe('workshop'); expect(host.entries).toEqual(before);
  });

  it('guards native Forward and replays its exact destination once after approval', () => {
    const { host, nav, questions, paint } = guarded();
    nav.visit({ screen: 'help' }); host.back(); paint();
    const before = structuredClone(host.entries);
    host.forward(); host.flush();
    expect(nav.route.screen).toBe('workshop'); expect(host.search()).toBe('?screen=workshop');
    questions[0].keep(); expect(host.entries).toEqual(before);
    host.forward(); host.flush(); questions[1].leave(); host.flush();
    expect(nav.route.screen).toBe('help'); expect(nav.direction).toBe(1); expect(host.entries).toEqual(before);
  });

  it('coalesces repeated native Back and waits for rollback before replaying an approved intent', () => {
    const { host, nav, questions, changes, paint } = guarded(); paint();
    host.back(); host.flush();
    host.back();
    expect(questions).toHaveLength(1);
    questions[0].leave();
    expect(nav.route.screen).toBe('workshop');
    host.flush(); expect(nav.route.screen).toBe('workshop');
    host.flush(); expect(nav.route.screen).toBe('title');
    expect(changes.filter(route => route.screen === 'title')).toHaveLength(1);
    expect(questions).toHaveLength(1); expect(nav.busy).toBe(false);
  });

  it('keeps the editor and first intent while saving fails, then permits a successful retry', () => {
    const { host, nav, questions, paint } = guarded(); paint();
    let launches = 0, cancelled = 0;
    nav.beforeLeave({ screen: 'match' }, () => { launches++; nav.startGame('mode=drive&seed=7'); }, () => { cancelled++; });
    // A failed save invokes neither callback: the editor/dialog remain available for another decision.
    nav.visit({ screen: 'online' }); expect(questions).toHaveLength(1);
    expect(launches).toBe(0); expect(nav.route.screen).toBe('workshop'); expect(host.entries).toHaveLength(2);
    questions[0].keep(); expect(cancelled).toBe(1); expect(nav.busy).toBe(false);
    nav.beforeLeave({ screen: 'match' }, () => { launches++; nav.startGame('mode=drive&seed=7'); });
    questions[1].leave(); expect(launches).toBe(1); expect(nav.route.screen).toBe('match'); expect(host.entries).toHaveLength(4);
  });
});

describe('per-tab launch records', () => {
  const setup = () => practiceSetup({ seed: 7, mode: 'bot', player: DEFAULT_LOADOUT });
  it('restores validated launch options and terminal results without storing simulation snapshots', () => {
    let data: string | null = null;
    const storage = { getItem: () => data, setItem: (_: string, value: string) => { data = value; } };
    const games = new NavigationGames(storage);
    games.set('game', { setup: setup(), workshop: false, sandbox: false, result: { winner: 0, forfeited: false } });
    expect(new NavigationGames(storage).get('game')).toEqual(games.get('game'));
    expect(data).not.toContain('checkpoint');
    for (let i = 0; i < 12; i++) games.set(String(i), { setup: setup(), workshop: false, sandbox: false });
    expect(new NavigationGames(storage).get('game')).toBeUndefined();
  });
  it('rejects stale/corrupt setup and works with blocked or full storage', () => {
    const games = new NavigationGames({ getItem: () => '{', setItem: () => { throw new Error('quota'); } });
    games.set('ok', { setup: setup(), workshop: false, sandbox: false });
    expect(games.get('ok')?.setup.seed).toBe(7);
    const stale = new NavigationGames({ getItem: () => JSON.stringify([['bad', { setup: {}, workshop: false, sandbox: false }]]), setItem: () => {} });
    expect(stale.get('bad')).toBeUndefined();
  });
});
