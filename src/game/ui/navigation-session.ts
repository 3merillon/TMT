/** Small per-tab launch records. Terrain/state are owned by the campaign checkpoint store. */
import type { MatchSetup } from '../api/match';
import { validateMatchSetup } from '../rules/setup';
import type { MatchResult } from './flow';
import type { MatchSummary } from './screens/context';

export interface NavigationGame {
  setup: MatchSetup;
  workshop: boolean;
  sandbox: boolean;
  result?: MatchResult;
  summary?: MatchSummary | null;
}
interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const KEY = 'iron-orrery-navigation-v1';
export class NavigationGames {
  private readonly games = new Map<string, NavigationGame>();
  constructor(private readonly storage: Storage | null) {
    try {
      const records: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]');
      if (!Array.isArray(records)) return;
      for (const entry of records.slice(-8)) {
        try {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
          const game = entry[1] as NavigationGame;
          if (typeof game?.workshop !== 'boolean' || typeof game.sandbox !== 'boolean') continue;
          const setup = validateMatchSetup(game.setup);
          if (game.result && (typeof game.result.forfeited !== 'boolean' || (game.result.winner !== null && !Number.isSafeInteger(game.result.winner)))) continue;
          if (game.summary && (!['title', 'eyebrow', 'detail', 'outcome'].every(k => typeof (game.summary as unknown as Record<string, unknown>)[k] === 'string')
            || !Array.isArray(game.summary.stats) || game.summary.stats.length > 32
            || !game.summary.stats.every(s => typeof s?.label === 'string' && typeof s.value === 'string'))) continue;
          this.games.set(entry[0], { ...game, setup });
        } catch { /* A stale build/setup does not make navigation unusable. */ }
      }
    } catch { /* Storage can be disabled or full. Live navigation still works. */ }
  }
  get(key: string): NavigationGame | undefined { return this.games.get(key); }
  set(key: string, game: NavigationGame): void {
    this.games.delete(key); this.games.set(key, game);
    while (this.games.size > 8) this.games.delete(this.games.keys().next().value!);
    try { this.storage?.setItem(KEY, JSON.stringify([...this.games])); } catch { /* Same-tab in-memory records remain available. */ }
  }
}
export function navigationGames(): NavigationGames {
  try { return new NavigationGames(sessionStorage); } catch { return new NavigationGames(null); }
}
