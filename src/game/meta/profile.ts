/**
 * Progress profile v2 (plan §3 Progression, §12): key `tmt.progress.v2`, migrated from the practice profile
 * `tmt.practice.v1`. Local progress only; it never feeds gameplay stats (those come from the kit).
 *
 * Robustness is the v1 contract: disabled, full or corrupt storage never throws and never blocks play.
 * A v1 profile whose saved build is invalid or over budget resets completely (saved progress never survives a
 * build the game would reject); a v2 profile is repaired field by field. Unknown fields are dropped.
 * The v1 key is left in place, so rolling back to a v1 build keeps its progress.
 */
import type { Loadout } from '../contracts';
import { legacyToKitIds, type KitLoadoutIds } from '../api/match';
import { validateKitLoadout } from '../kit';
import { DEFAULT_LOADOUT, validateLoadout } from '../modules';
import { sanitizeSettings, type ProgressSettings } from './settings';
import { crewBuild, type CrewBuild } from '../campaign/loadout';
import { sanitizeCosmetics, type CosmeticProfile, type Palette, type TankAppearance } from './cosmetics';
export type { Palette } from './cosmetics';

export const PROFILE_KEY = 'tmt.progress.v2';
export const LEGACY_PROFILE_KEY = 'tmt.practice.v1';
export const PROFILE_FORMAT = 'tmt-profile';
export const LOADOUT_SLOTS = 3;
export const MAX_RANK = 30;

export interface NamedLoadout { name: string; kit: KitLoadoutIds }
export interface ProgressProfile {
  crew?: CrewBuild;
  version: 2;
  /** Three named build slots; `activeLoadout` is the one matches use. */
  loadouts: NamedLoadout[];
  activeLoadout: number;
  settings: ProgressSettings;
  xp: number;
  /** Commander rank 1–30 (W3-META-UI: rank raises the fitting budget). */
  rank: number;
  scrap: number;
  unlocks: string[];
  /** Campaign level id → stars earned (0–3). */
  stars: Record<string, number>;
  cosmetics: CosmeticProfile;
  /** Part id → mastery points. */
  mastery: Record<string, number>;
  stats: { matches: number; wins: number };
}
/** The v1 practice profile (src/game/profile.ts before W1-SHELL). */
export interface PracticeProfileV1 { version: 1; loadout: Loadout; matches: number; wins: number; palette: Palette }

const DEFAULT_KIT: KitLoadoutIds = Object.freeze(legacyToKitIds(DEFAULT_LOADOUT));
const NAME_LIMIT = 24, LIST_LIMIT = 256, ID_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,63}$/i, FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const slotName = (index: number) => `Build ${index + 1}`;
const defaultLoadouts = (): NamedLoadout[] => Array.from({ length: LOADOUT_SLOTS }, (_, index) => ({ name: slotName(index), kit: { ...DEFAULT_KIT } }));

export function defaultProfile(): ProgressProfile {
  return {
    version: 2, loadouts: defaultLoadouts(), activeLoadout: 0, settings: sanitizeSettings(undefined),
    xp: 0, rank: 1, scrap: 0, unlocks: [], stars: {}, cosmetics: { palette: 'sage' }, mastery: {}, stats: { matches: 0, wins: 0 },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (source: Record<string, unknown>, key: string): unknown => Object.hasOwn(source, key) ? source[key] : undefined;
const count = (value: unknown): number => Number.isSafeInteger(value) ? Math.max(0, value as number) : 0;
const palette = (value: unknown): Palette => value === 'ochre' ? 'ochre' : 'sage';
function kitIds(value: unknown): KitLoadoutIds | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const kit = validateKitLoadout(value as unknown as KitLoadoutIds);
    return { hull: kit.hull, runningGear: kit.runningGear, turret: kit.turret, weapon: kit.weapon, utility: kit.utility, ...(kit.armor === 'reactive' ? { armor: 'reactive' as const } : {}) };
  } catch { return undefined; }
}
function name(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_LIMIT);
  return trimmed || fallback;
}
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && ID_PATTERN.test(id)))].slice(0, LIST_LIMIT);
}
function idRecord(value: unknown, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const key of Object.keys(value).slice(0, LIST_LIMIT)) {
    if (FORBIDDEN_KEYS.has(key) || !ID_PATTERN.test(key)) continue;
    const n = value[key];
    if (Number.isSafeInteger(n) && (n as number) > 0) out[key] = Math.min(max, n as number);
  }
  return out;
}

/** v1 → v2. Returns undefined when the value is not a usable v1 profile (then the caller falls back to defaults). */
export function migrateV1(value: unknown): ProgressProfile | undefined {
  if (!isRecord(value) || value.version !== 1 || !validateLoadout(value.loadout)) return undefined;
  const legacy = value.loadout as Loadout;
  const profile = defaultProfile();
  profile.loadouts[0] = { name: slotName(0), kit: legacyToKitIds({ tracks: legacy.tracks, barrel: legacy.barrel, armor: legacy.armor }) };
  profile.stats = { matches: count(value.matches), wins: count(value.wins) };
  profile.cosmetics = { palette: palette(value.palette) };
  return profile;
}

/** Repairs a v2 profile field by field. Returns undefined when the value is not a v2 profile at all. */
export function sanitizeProfile(value: unknown): ProgressProfile | undefined {
  if (!isRecord(value) || value.version !== 2) return undefined;
  const defaults = defaultProfile();
  const saved = Array.isArray(value.loadouts) ? value.loadouts : [];
  const loadouts = defaults.loadouts.map((fallback, index) => {
    const entry = saved[index];
    if (!isRecord(entry)) return fallback;
    const kit = kitIds(own(entry, 'kit'));
    return kit ? { name: name(own(entry, 'name'), fallback.name), kit } : fallback;
  });
  const active = value.activeLoadout;
  const rank = value.rank;
  const stats = isRecord(value.stats) ? value.stats : {};
  const cosmetics = isRecord(value.cosmetics) ? value.cosmetics : {};
  const matches = count(own(stats, 'matches'));
  const unlocks = idList(value.unlocks);
  return {
    version: 2, loadouts,
    activeLoadout: Number.isSafeInteger(active) && (active as number) >= 0 && (active as number) < LOADOUT_SLOTS ? active as number : 0,
    settings: sanitizeSettings(own(value, 'settings')),
    xp: count(value.xp),
    rank: Number.isSafeInteger(rank) ? Math.max(1, Math.min(MAX_RANK, rank as number)) : 1,
    scrap: count(value.scrap),
    unlocks,
    stars: idRecord(value.stars, 3),
    cosmetics: sanitizeCosmetics(cosmetics),
    mastery: idRecord(value.mastery, Number.MAX_SAFE_INTEGER),
    ...(isRecord(value.crew) ? { crew: crewBuild(value.crew, Number.isSafeInteger(rank) ? rank as number : 1, unlocks) } : {}),
    // Wins can never exceed matches.
    stats: { matches, wins: Math.min(matches, count(own(stats, 'wins'))) },
  };
}

function parse(text: string | null | undefined): unknown {
  if (typeof text !== 'string') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
/** Reads v2, else migrates v1 (also when the v2 entry is unreadable), else defaults. Never throws (disabled storage,
 * bad JSON, wrong shapes). */
export function readProgress(storage?: Pick<Storage, 'getItem'>): ProgressProfile {
  const get = (key: string) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  return sanitizeProfile(parse(get(PROFILE_KEY))) ?? migrateV1(parse(get(LEGACY_PROFILE_KEY))) ?? defaultProfile();
}
/** Stores the profile; false when storage is unavailable or full (play continues either way). */
export function saveProgress(profile: ProgressProfile, storage?: Pick<Storage, 'setItem'>): boolean {
  if (!storage) return false;
  try { storage.setItem(PROFILE_KEY, JSON.stringify(sanitizeProfile(profile) ?? defaultProfile())); return true; } catch { return false; }
}
/** window.localStorage when the browser allows it. */
export function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage ?? undefined; } catch { return undefined; }
}

/** Pretty JSON with a format marker, for the settings screen's export. */
export function exportProfile(profile: ProgressProfile): string {
  return JSON.stringify({ format: PROFILE_FORMAT, ...(sanitizeProfile(profile) ?? defaultProfile()) }, null, 2);
}
export type ProfileImport = { ok: true; profile: ProgressProfile; migrated: boolean } | { ok: false; error: string };
/** Accepts an exported v2 profile (with or without the marker) or a raw v1 profile. Never throws. */
export function importProfile(text: string): ProfileImport {
  const value = parse(text);
  if (value === undefined) return { ok: false, error: 'That is not valid JSON.' };
  if (!isRecord(value)) return { ok: false, error: 'A profile is a JSON object.' };
  if (value.format !== undefined && value.format !== PROFILE_FORMAT) return { ok: false, error: `Unknown profile format ${JSON.stringify(value.format)}.` };
  if (value.version === 2) return { ok: true, profile: sanitizeProfile(value)!, migrated: false };
  if (value.version === 1) {
    const migrated = migrateV1(value);
    return migrated ? { ok: true, profile: migrated, migrated: true } : { ok: false, error: 'This v1 profile holds a build the game no longer accepts.' };
  }
  return { ok: false, error: `Unsupported profile version ${JSON.stringify(value.version)}.` };
}

/** The kit ids of the active build. */
export function activeKit(profile: ProgressProfile): KitLoadoutIds {
  return { ...(profile.loadouts[profile.activeLoadout] ?? profile.loadouts[0]).kit };
}
/** A copy with one build slot replaced (the kit is validated; an invalid kit throws, as the workshop never offers one). */
export function withLoadout(profile: ProgressProfile, index: number, kit: KitLoadoutIds, label?: string): ProgressProfile {
  if (!Number.isSafeInteger(index) || index < 0 || index >= LOADOUT_SLOTS) throw new Error(`No build slot ${index}`);
  const valid = kitIds(kit);
  if (!valid) throw new Error(`Invalid kit ${JSON.stringify(kit)}`);
  const loadouts = profile.loadouts.map((entry, i) => i === index ? { name: name(label ?? entry.name, slotName(i)), kit: valid } : { ...entry, kit: { ...entry.kit } });
  return { ...profile, loadouts };
}
export function withActiveLoadout(profile: ProgressProfile, index: number): ProgressProfile {
  return Number.isSafeInteger(index) && index >= 0 && index < LOADOUT_SLOTS ? { ...profile, activeLoadout: index } : profile;
}
export function withSettings(profile: ProgressProfile, settings: ProgressSettings): ProgressProfile {
  return { ...profile, settings: sanitizeSettings(settings) };
}
/** Equip only built-in or owned appearances; this cannot alter any build or match stats. */
export function withAppearance(profile: ProgressProfile, appearance: TankAppearance): ProgressProfile {
  return { ...profile, cosmetics: sanitizeCosmetics({ ...profile.cosmetics, appearance }) };
}
/** A finished (or forfeited) match: one more match, and a win when the player's side won. */
export function recordMatch(profile: ProgressProfile, won: boolean, completed = true): ProgressProfile {
  const matches = Math.min(Number.MAX_SAFE_INTEGER, profile.stats.matches + 1);
  const xp = Math.min(Number.MAX_SAFE_INTEGER, profile.xp + (completed ? won ? 100 : 45 : 0));
  const scrap = Math.min(Number.MAX_SAFE_INTEGER, profile.scrap + (completed ? won ? 150 : 60 : 0));
  const rank = Math.max(profile.rank, Math.min(MAX_RANK, 1 + Math.floor(xp / 100)));
  return { ...profile, xp, scrap, rank, stats: { matches, wins: Math.min(matches, profile.stats.wins + (won && completed ? 1 : 0)) } };
}
