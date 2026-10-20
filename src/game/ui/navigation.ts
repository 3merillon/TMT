/** Browser history owns navigation; simulation snapshots never go into history.state.
 * A battle has a pause entry immediately before its live entry. Native Back therefore
 * pauses once, then reaches the menu. The title is a real boundary: Back can leave it. */
import { MENU_SCREENS, type MenuScreen } from './flow';
import { rewriteSearch, MATCH_QUERY_KEYS } from './launch';

export type MenuRouteScreen = 'title' | MenuScreen;
export interface NavigationRoute {
  screen: MenuRouteScreen | 'match' | 'pause' | 'results';
  game?: string;
  parent?: MenuRouteScreen;
  /** Only mode/seed/mission: diagnostics stay on the current page. */
  query?: string;
}
interface Entry { id: string; route: NavigationRoute }
interface HistoryState { ironOrrery: 1; trail: string; path: Entry[] }
export interface NavigationHost {
  state(): unknown;
  search(): string;
  write(state: HistoryState, search: string, replace: boolean): void;
  go(delta: number): void;
  listen(callback: (state: unknown) => void): () => void;
}
export interface NavigationGuard {
  needed(from: NavigationRoute, to: NavigationRoute): boolean;
  request(continueLeaving: () => void, cancelLeaving: () => void): void;
}
const menus: readonly string[] = ['title', ...MENU_SCREENS];
const screens = [...menus, 'match', 'pause', 'results'];
const id = () => globalThis.crypto.randomUUID();
const same = (a: NavigationRoute, b: NavigationRoute) => a.screen === b.screen && a.game === b.game;
const menu = (screen: string): screen is MenuRouteScreen => menus.includes(screen);

export function navigationSearch(search: string, route: NavigationRoute): string {
  const base = rewriteSearch(search, [...MATCH_QUERY_KEYS, 'screen']);
  const extra = [route.game ? route.query : '', route.screen === 'title' || route.screen === 'match' ? '' : `screen=${route.screen}`].filter(Boolean).join('&');
  return `${base}${extra ? `${base ? '&' : '?'}${extra}` : ''}`;
}
export function matchQuery(search: string): string {
  const p = new URLSearchParams(search), result = new URLSearchParams();
  for (const key of ['mode', 'seed', 'mission']) if (p.has(key)) result.set(key, p.get(key)!);
  return result.toString();
}
export function menuFromSearch(search: string): MenuRouteScreen | null {
  const screen = new URLSearchParams(search).get('screen');
  return screen && menu(screen) ? screen : null;
}
function validRoute(value: unknown): value is NavigationRoute {
  if (!value || typeof value !== 'object') return false;
  const r = value as NavigationRoute;
  if (!screens.includes(r.screen)) return false;
  if (r.game !== undefined) return typeof r.game === 'string' && /^[\w-]{1,80}$/.test(r.game)
    && ['match', 'pause', 'settings', 'results'].includes(r.screen) && !!r.parent && menu(r.parent)
    && typeof r.query === 'string' && r.query.length < 200 && matchQuery(`?${r.query}`) === r.query;
  return menu(r.screen);
}
function readState(value: unknown): HistoryState | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as HistoryState;
  return s.ironOrrery === 1 && typeof s.trail === 'string' && Array.isArray(s.path) && s.path.length > 0 && s.path.length <= 256
    && s.path.every(e => e && typeof e.id === 'string' && validRoute(e.route)) ? s : null;
}

export class BrowserNavigation {
  private trail: string = id();
  private entries: Entry[] = [];
  private cursor = 0;
  direction = 0;
  private pending: NavigationRoute | null = null;
  private queued: (() => void) | null = null;
  private leaving: { route: NavigationRoute; run: () => void; cancel?: () => void; requested: boolean; approved: boolean } | null = null;
  private returning = false;
  private allowing = 0;
  private permittedPop: string | null = null;
  private readonly unlisten: () => void;
  constructor(private readonly host: NavigationHost, private readonly changed: (route: NavigationRoute) => void, private readonly guard?: NavigationGuard) {
    this.unlisten = host.listen(state => this.pop(state));
  }
  get route(): NavigationRoute { return this.entries[this.cursor].route; }
  get busy(): boolean { return !!this.pending || !!this.leaving || this.returning; }
  dispose(): void { this.leaving = null; this.unlisten(); }

  needsGuard(route: NavigationRoute): boolean {
    return !this.allowing && !!this.entries.length && !same(this.route, route) && (this.guard?.needed(this.route, route) ?? false);
  }
  /** First intent wins while the save/discard dialog is open. Cancellation makes a fresh intent possible. */
  beforeLeave(route: NavigationRoute, run: () => void, cancel?: () => void): boolean {
    if (this.leaving || this.returning) { cancel?.(); return false; }
    if (!this.needsGuard(route)) { run(); return true; }
    this.leaving = { route, run, cancel, requested: false, approved: false }; this.requestLeave(); return true;
  }
  private requestLeave(): void {
    const pending = this.leaving;
    if (!pending || pending.requested || this.returning) return;
    pending.requested = true;
    this.guard!.request(() => {
      if (this.leaving !== pending) return;
      pending.approved = true;
      if (!this.returning) this.completeLeave();
    }, () => {
      if (this.leaving !== pending) return;
      this.leaving = null; pending.cancel?.();
    });
  }
  private completeLeave(): void {
    const pending = this.leaving; if (!pending) return;
    this.leaving = null; this.allowing++;
    try { pending.run(); } finally { this.allowing--; }
  }

  /** A reload reuses its entry. Direct links get real menu ancestors before the battle. */
  boot(deep: boolean): NavigationRoute {
    const saved = readState(this.host.state());
    if (saved) { this.accept(saved); return this.route; }
    const search = this.host.search(), requested = menuFromSearch(search);
    this.entries = [{ id: id(), route: { screen: 'title' } }]; this.cursor = 0; this.write(true);
    if (deep && (!requested || requested === 'settings')) {
      const query = matchQuery(search), parent = new URLSearchParams(search).get('mode') === 'campaign' ? 'campaign' : 'skirmish';
      this.push({ screen: parent });
      const game = id(), pause: NavigationRoute = { screen: 'pause', game, parent, query };
      this.push(pause);
      const screen = new URLSearchParams(search).get('screen');
      if (screen !== 'pause') this.push({ ...pause, screen: screen === 'settings' ? 'settings' : 'match' });
    } else if (requested && requested !== 'title') this.push({ screen: requested });
    return this.route;
  }

  /** Called once per START; retries/next missions reuse the battle's history slot. */
  startGame(query: string, parent?: MenuRouteScreen): string {
    if (this.busy) throw new Error('Wait for browser navigation before starting a game.');
    if (this.needsGuard({ screen: 'match' })) throw new Error('Resolve unsaved changes before starting a game.');
    const current = this.route;
    const game = current.game ?? id(), origin = current.parent ?? parent ?? (menu(current.screen) ? current.screen : 'title');
    const route: NavigationRoute = { screen: 'match', game, parent: origin, query };
    if (!current.game) { this.push({ ...route, screen: 'pause' }); this.push(route); }
    else if (current.screen === 'pause') this.push(route);
    else if (this.entries[this.cursor - 1]?.route.game === game && this.entries[this.cursor - 1]?.route.screen === 'pause') this.replace(route);
    else { this.replace({ ...route, screen: 'pause' }); this.push(route); }
    return game;
  }
  finishGame(): void {
    const route = this.route;
    if (!route.game) return;
    // A forfeit happens on the guard entry. Put results in the live slot so a
    // retry still has exactly one pause guard and its original menu behind it.
    if (route.screen === 'pause') this.visit({ ...route, screen: 'match' });
    else this.replace({ ...route, screen: 'results' });
  }
  replace(route: NavigationRoute): void {
    if (this.leaving || this.returning) return;
    if (this.pending) { this.queued = () => this.replace(route); return; }
    if (this.needsGuard(route)) { this.beforeLeave(route, () => this.replace(route)); return; }
    this.entries[this.cursor] = { ...this.entries[this.cursor], route }; this.write(true);
  }
  /** Use an existing entry when possible, so menu and pause buttons do not grow loops. */
  visit(route: NavigationRoute): void {
    if (this.leaving || this.returning) return;
    if (this.pending) { this.queued = same(this.pending, route) ? null : () => this.visit(route); return; }
    if (same(this.route, route)) return;
    if (this.needsGuard(route)) { this.beforeLeave(route, () => this.visit(route)); return; }
    let found = -1;
    for (let i = this.cursor - 1; i >= 0; i--) if (same(this.entries[i].route, route)) { found = i; break; }
    if (found < 0) for (let i = this.cursor + 1; i < this.entries.length; i++) if (same(this.entries[i].route, route)) { found = i; break; }
    if (found >= 0) { this.pending = route; if (this.allowing) this.permittedPop = this.entries[found].id; this.host.go(found - this.cursor); }
    else { this.push(route); this.direction = 1; this.changed(route); }
  }
  back(): void {
    if (this.busy) return;
    if (this.cursor > 0) {
      const route = this.entries[this.cursor - 1].route;
      if (this.needsGuard(route)) { this.beforeLeave(route, () => this.back()); return; }
      this.pending = route; if (this.allowing) this.permittedPop = this.entries[this.cursor - 1].id; this.host.go(-1);
    }
  }
  private push(route: NavigationRoute): void {
    this.entries = this.entries.slice(0, this.cursor + 1);
    this.entries.push({ id: id(), route }); this.cursor++; this.write(false);
  }
  private write(replace: boolean): void {
    this.host.write({ ironOrrery: 1, trail: this.trail, path: this.entries.slice(0, this.cursor + 1) }, navigationSearch(this.host.search(), this.route), replace);
  }
  private accept(state: HistoryState): void {
    const compatible = state.trail === this.trail && state.path.every((e, i) => this.entries[i]?.id === e.id);
    if (!compatible) this.entries = state.path;
    // Forward entries contain older copies of their ancestors. Only the actual
    // destination is authoritative; keep edits we made to earlier entries.
    else this.entries[state.path.length - 1] = state.path[state.path.length - 1];
    this.trail = state.trail; this.cursor = state.path.length - 1;
  }
  private pop(value: unknown): void {
    const state = readState(value);
    const owned = state?.trail === this.trail;
    const destination = state ? state.path[state.path.length - 1] : null;
    const index = owned ? state!.path.length - 1 : -1;
    if (this.returning || this.leaving) {
      if (owned && destination?.id === this.entries[this.cursor].id) {
        this.returning = false;
        if (this.leaving?.approved) this.completeLeave(); else this.requestLeave();
      } else if (owned) { this.returning = true; this.host.go(this.cursor - index); }
      return;
    }
    const permitted = destination?.id === this.permittedPop;
    this.permittedPop = null;
    if (owned && destination && index !== this.cursor && !permitted && this.needsGuard(destination.route)) {
      // Native traversal already moved history. Restore the original entry before asking, preserving Forward.
      this.pending = null; this.queued = null; this.returning = true;
      this.leaving = { route: destination.route, requested: false, approved: false, run: () => {
        this.pending = destination.route; this.permittedPop = destination.id; this.host.go(index - this.cursor);
      } };
      this.host.go(this.cursor - index); return;
    }
    this.direction = state?.trail === this.trail ? Math.sign(state.path.length - 1 - this.cursor) : 0;
    this.pending = null;
    if (state) this.accept(state);
    else {
      // Unowned same-document entries (e.g. a fragment link) use their URL. Never
      // push a sentinel here: the browser must still be able to leave the title.
      this.entries = [{ id: id(), route: { screen: menuFromSearch(this.host.search()) ?? 'title' } }];
      this.cursor = 0; this.trail = id(); this.write(true);
    }
    this.changed(this.route);
    const queued = this.queued; this.queued = null; queued?.();
  }
}

export function browserNavigation(changed: (route: NavigationRoute) => void, guard?: NavigationGuard): BrowserNavigation {
  return new BrowserNavigation({
    state: () => history.state, search: () => location.search,
    write: (state, search, replace) => history[replace ? 'replaceState' : 'pushState'](state, '', `${location.pathname}${search}${location.hash}`),
    go: delta => history.go(delta),
    listen: callback => { const pop = (event: PopStateEvent) => callback(event.state); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); },
  }, changed, guard);
}
