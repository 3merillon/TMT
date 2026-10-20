/**
 * Launch options from the page URL (pure). The plain URL boots to the title. `?mode=drive|bot|local` or `?seed=<n>`
 * is a deep link that starts a match immediately, as before the front end existed: every capture plan relies on
 * them. `?dev` shows the developer chrome (the drive test shows it too).
 */
import type { PracticeMode } from '../app/dev-flags';
import { MISSION_IDS, type MissionId } from '../campaign/mission';

export interface DeepLink { mode: PracticeMode; seed: number | null }
export interface LaunchOptions { deepLink: DeepLink | null; dev: boolean; /** `?mode=campaign&mission=p1`: start that mission. */ mission?: MissionId | null }
const MODES: readonly PracticeMode[] = ['bot', 'local', 'drive'];
/** Query keys that describe the running match; the flow strips them when the player returns to the menu. */
export const MATCH_QUERY_KEYS: readonly string[] = Object.freeze(['mode', 'seed', 'mission']);
const MISSIONS = MISSION_IDS;

export function parseLaunch(search: string): LaunchOptions {
  const params = new URLSearchParams(search);
  const mode = params.get('mode'), seedText = params.get('seed');
  if (mode === 'campaign') {
    const mission = params.get('mission');
    return { deepLink: null, dev: params.has('dev'), mission: mission && (MISSIONS as readonly string[]).includes(mission) ? mission as MissionId : 'p1' };
  }
  const knownMode = mode === 'dev' ? 'drive' : mode !== null && (MODES as readonly string[]).includes(mode) ? mode as PracticeMode : null;
  const seed = seedText !== null && /^\d+$/.test(seedText.trim()) ? Number(seedText) : null;
  const deepLink = knownMode || seedText !== null ? { mode: knownMode ?? 'bot', seed: seed !== null && Number.isSafeInteger(seed) ? seed : null } : null;
  if (mode === 'dev' && deepLink && deepLink.seed === null) deepLink.seed = 7;
  return { deepLink, dev: params.has('dev') || mode === 'dev' };
}

/** Query tokens as written (`?dev` stays `?dev`, not `?dev=`), minus the `drop` keys, plus `add`. */
export function rewriteSearch(search: string, drop: readonly string[], add: readonly string[] = []): string {
  const key = (token: string) => { try { return decodeURIComponent(token.split('=')[0].replace(/\+/g, ' ')); } catch { return token; } };
  const tokens = search.replace(/^\?/, '').split('&').filter(token => token && !drop.includes(key(token)));
  const all = [...tokens, ...add];
  return all.length ? `?${all.join('&')}` : '';
}
/** The search string without the match keys (`?dev` and diagnostics flags survive). */
export function menuSearch(search: string): string { return rewriteSearch(search, MATCH_QUERY_KEYS); }
/** The search string after switching the drive test on or off (`?mode=drive` survives a reload). */
export function driveTestSearch(search: string, driving: boolean): string {
  if (driving) return rewriteSearch(search, ['mode'], ['mode=drive']);
  return new URLSearchParams(search).get('mode') === 'drive' ? rewriteSearch(search, ['mode']) : rewriteSearch(search, []);
}
