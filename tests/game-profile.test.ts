import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeKit, defaultProfile, exportProfile, importProfile, LEGACY_PROFILE_KEY, migrateV1, PROFILE_KEY, readProgress, recordMatch, sanitizeProfile,
  saveProgress, withActiveLoadout, withLoadout, withSettings,
} from '../src/game/meta/profile';
import { DEFAULT_SETTINGS, GRAPHICS_PRESETS } from '../src/game/meta/settings';

/** A Storage stand-in over a Map. */
function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}
const v1 = (fields: Record<string, unknown>) => JSON.stringify({ version: 1, loadout: { tracks: 'grip', barrel: 'cannon', armor: 'heavy' }, matches: 12, wins: 5, palette: 'ochre', ...fields });

describe('progress profile v2 boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps play available when storage is disabled, corrupt or full', () => {
    expect(readProgress({ getItem() { throw new Error('disabled'); } })).toEqual(defaultProfile());
    expect(readProgress(undefined)).toEqual(defaultProfile());
    for (const broken of ['{broken', 'null', '42', '"text"', '[]', '{"version":3}']) {
      const profile = readProgress(memory({ [PROFILE_KEY]: broken }));
      expect(profile).toEqual(defaultProfile());
      expect(activeKit(profile).hull).toBe('warden');
    }
    expect(saveProgress(defaultProfile(), { setItem() { throw new Error('quota'); } })).toBe(false);
    expect(saveProgress(defaultProfile(), undefined)).toBe(false);
  });

  it.each([
    { preset: 'low', device: { hardwareConcurrency: 2 } },
    { preset: 'medium', device: { hardwareConcurrency: 6, deviceMemory: 8 } },
    { preset: 'high', device: { hardwareConcurrency: 8, deviceMemory: 8 } },
  ] as const)('migrates a v1 practice profile with its stats, palette and $preset auto graphics', ({ preset, device }) => {
    // A v1 save has no settings: migration chooses defaults for this device, not the test runner's host.
    vi.stubGlobal('navigator', device);
    const storage = memory({ [LEGACY_PROFILE_KEY]: v1({}) });
    const profile = readProgress(storage);
    expect(profile.version).toBe(2);
    expect(profile.loadouts[0]).toEqual({ name: 'Build 1', kit: { hull: 'bastion', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' } });
    expect(profile.loadouts.slice(1)).toEqual(defaultProfile().loadouts.slice(1));
    expect(profile.activeLoadout).toBe(0);
    expect(profile.stats).toEqual({ matches: 12, wins: 5 });
    expect(profile.cosmetics.palette).toBe('ochre');
    expect(profile.settings).toEqual({ ...DEFAULT_SETTINGS, graphics: { tier: 'auto', ...GRAPHICS_PRESETS[preset] } });
    // Saving writes v2 and leaves the v1 entry in place for a rollback.
    expect(saveProgress(profile, storage)).toBe(true);
    expect(JSON.parse(storage.map.get(PROFILE_KEY)!)).toEqual(profile);
    expect(storage.map.get(LEGACY_PROFILE_KEY)).toBe(v1({}));
    expect(readProgress(storage)).toEqual(profile);
  });

  it('keeps the v1 semantics: an invalid saved build resets everything and saved progress never derives stats', () => {
    // grip + rail + heavy costs 11 > 10: the whole profile resets, the 50 saved matches do not survive.
    expect(readProgress(memory({ [LEGACY_PROFILE_KEY]: v1({ loadout: { tracks: 'grip', barrel: 'rail', armor: 'heavy' }, matches: 50, wins: 100, damage: 999 }) })))
      .toEqual(defaultProfile());
    expect(migrateV1(JSON.parse(v1({ loadout: { tracks: 'hover', barrel: 'rail', armor: 'light' } })))).toBeUndefined();
    const value = readProgress(memory({ [LEGACY_PROFILE_KEY]: v1({ matches: -5, wins: null, damage: 999 }) }));
    expect(value.stats).toEqual({ matches: 0, wins: 0 });
    expect(value).not.toHaveProperty('damage');
    expect(value).not.toHaveProperty('loadout');
  });

  it('prefers v2 over v1, and falls back to v1 only when the v2 entry is unreadable', () => {
    const v2 = recordMatch(defaultProfile(), true);
    expect(readProgress(memory({ [PROFILE_KEY]: JSON.stringify(v2), [LEGACY_PROFILE_KEY]: v1({}) })).stats).toEqual({ matches: 1, wins: 1 });
    expect(readProgress(memory({ [PROFILE_KEY]: '{broken', [LEGACY_PROFILE_KEY]: v1({}) })).stats).toEqual({ matches: 12, wins: 5 });
  });

  it('repairs a corrupt v2 profile field by field and drops unknown fields', () => {
    const repaired = sanitizeProfile(JSON.parse(JSON.stringify({
      version: 2, extra: 'dropped',
      loadouts: [{ name: '  Siege   ', kit: { hull: 'bastion', runningGear: 'crawler', turret: 'wedge', weapon: 'rail', utility: 'smoke' } }, // valid under kit v2 sockets (a Cradle needs an S ring)
        { name: 'Bad', kit: { hull: 'zeppelin', runningGear: 'grip', turret: 'dome', weapon: 'rail', utility: 'antenna' } }, 'nope'],
      activeLoadout: 7, xp: -3, rank: 99, scrap: 1.5, unlocks: ['part:rail', 'part:rail', 42, '../../etc', 'x'.repeat(80)],
      stars: { 'w1-1': 3, 'w1-2': 9, 'w1-3': -1, constructor: 2 }, mastery: { rail: 40, bad: 'x' },
      cosmetics: { palette: 'neon' }, stats: { matches: 3, wins: 8 },
      settings: { graphics: { tier: 'ultra', renderScale: 7, clouds: 'yes' }, audio: { master: -1 }, gameplay: { difficulty: 'impossible', aimAssist: true } },
    }).replace('"constructor"', '"__proto__":3,"constructor"')))!;
    expect(repaired.loadouts[0]).toEqual({ name: 'Siege', kit: { hull: 'bastion', runningGear: 'crawler', turret: 'wedge', weapon: 'rail', utility: 'smoke' } });
    expect(repaired.loadouts[1]).toEqual(defaultProfile().loadouts[1]);
    expect(repaired.loadouts[2]).toEqual(defaultProfile().loadouts[2]);
    expect(repaired.activeLoadout).toBe(0);
    expect([repaired.xp, repaired.rank, repaired.scrap]).toEqual([0, 30, 0]);
    expect(repaired.unlocks).toEqual(['part:rail']);
    expect(repaired.stars).toEqual({ 'w1-1': 3, 'w1-2': 3 });
    expect(Object.getPrototypeOf(repaired.stars)).toBe(Object.prototype);
    expect(repaired.mastery).toEqual({ rail: 40 });
    expect(repaired.cosmetics).toEqual({ palette: 'sage' });
    expect(repaired.stats).toEqual({ matches: 3, wins: 3 });
    expect(repaired.settings.graphics).toMatchObject({ tier: 'ultra', renderScale: 1, clouds: true });
    expect(repaired.settings.audio.master).toBe(0);
    expect(repaired.settings.gameplay).toMatchObject({ difficulty: 'normal', aimAssist: true });
    expect(repaired).not.toHaveProperty('extra');
    expect(sanitizeProfile({ version: 1 })).toBeUndefined();
    expect(sanitizeProfile(null)).toBeUndefined();
  });

  it('round-trips JSON export and import, and rejects what it cannot read', () => {
    let profile = withLoadout(defaultProfile(), 2, { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'rail', utility: 'antenna' }, 'Sniper');
    profile = withActiveLoadout(recordMatch(recordMatch(profile, true), false), 2);
    profile = withSettings(profile, { ...profile.settings, audio: { ...profile.settings.audio, music: 0.25 } });
    const text = exportProfile(profile);
    expect(JSON.parse(text).format).toBe('tmt-profile');
    expect(importProfile(text)).toEqual({ ok: true, profile, migrated: false });
    expect(activeKit(profile)).toEqual({ hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'rail', utility: 'antenna' });
    expect(profile.loadouts[2].name).toBe('Sniper');
    expect(profile.stats).toEqual({ matches: 2, wins: 1 });

    const legacy = importProfile(v1({}));
    expect(legacy.ok && legacy.migrated && legacy.profile.stats).toEqual({ matches: 12, wins: 5 });
    expect(importProfile('{broken')).toEqual({ ok: false, error: expect.stringMatching(/JSON/) });
    expect(importProfile('[1,2]').ok).toBe(false);
    expect(importProfile(JSON.stringify({ format: 'other-game', version: 2 })).ok).toBe(false);
    expect(importProfile(JSON.stringify({ version: 3 })).ok).toBe(false);
    expect(importProfile(v1({ loadout: { tracks: 'grip', barrel: 'rail', armor: 'heavy' } })).ok).toBe(false);
  });

  it('only stores builds the kit validates', () => {
    expect(() => withLoadout(defaultProfile(), 0, { hull: 'zeppelin', runningGear: 'grip', turret: 'dome', weapon: 'rail', utility: 'antenna' })).toThrow(/Invalid kit/);
    expect(() => withLoadout(defaultProfile(), 3, activeKit(defaultProfile()))).toThrow(/slot/);
    expect(withActiveLoadout(defaultProfile(), 5).activeLoadout).toBe(0);
  });
});
