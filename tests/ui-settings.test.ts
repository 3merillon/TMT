import { describe, expect, it } from 'vitest';
import { currentSettings, DEFAULT_SETTINGS, dispatchSettings, GRAPHICS_PRESETS, graphicsPreset, recommendedGraphicsPreset, sanitizeSettings, SETTINGS_EVENT, settingsEvent, updateSettings, type ProgressSettings } from '../src/game/meta/settings';

/** Explicit public shape, including backward-compatible planetary lighting preferences. */
const SHAPE = {
  graphics: ['tier', 'renderScale', 'miniature', 'fisheye', 'bloom', 'grain', 'clouds', 'grassDensity', 'volumetrics', 'lensFlare', 'godRays', 'shadows', 'cloudQuality', 'hazeQuality', 'ambientOcclusion', 'globalIllumination'],
  audio: ['master', 'music', 'sfx', 'ui', 'voice'],
  gameplay: ['difficulty', 'cinematics', 'reducedMotion', 'autoBrace', 'aimAssist', 'touchDrive', 'keyDrive', 'profanityFilter'],
  controls: ['bindings'],
};

describe('tmt:settings event', () => {
  it('dispatches a CustomEvent named tmt:settings whose detail has the plan §5.5 shape', () => {
    const target = new EventTarget();
    const seen: CustomEvent<ProgressSettings>[] = [];
    target.addEventListener('tmt:settings', event => seen.push(event as CustomEvent<ProgressSettings>));
    const returned = dispatchSettings(DEFAULT_SETTINGS, target);
    expect(SETTINGS_EVENT).toBe('tmt:settings');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(returned);
    expect(seen[0]).toBeInstanceOf(CustomEvent);
    expect(seen[0].type).toBe('tmt:settings');
    const detail = seen[0].detail;
    expect(Object.keys(detail).sort()).toEqual(Object.keys(SHAPE).sort());
    for (const [group, keys] of Object.entries(SHAPE)) expect(Object.keys(detail[group as keyof ProgressSettings]).sort()).toEqual([...keys].sort());
    expect(detail).toEqual(DEFAULT_SETTINGS);
    expect(typeof detail.graphics.tier).toBe('string');
    expect(typeof detail.graphics.clouds).toBe('boolean');
    for (const volume of Object.values(detail.audio)) expect(volume).toBeGreaterThanOrEqual(0);
    expect(['story', 'normal', 'hard', 'ace']).toContain(detail.gameplay.difficulty);
  });

  it('gives every listener a frozen copy, so one listener cannot change what the next one sees', () => {
    const settings = sanitizeSettings(DEFAULT_SETTINGS);
    const event = settingsEvent(settings);
    expect(event.detail).not.toBe(settings);
    expect(Object.isFrozen(event.detail)).toBe(true);
    expect(Object.isFrozen(event.detail.audio)).toBe(true);
    expect(() => { (event.detail.audio as { master: number }).master = 0; }).toThrow(TypeError);
    settings.audio.master = 0.1;
    expect(event.detail.audio.master).toBe(DEFAULT_SETTINGS.audio.master);
  });

  it('fires once per change with the clamped values', () => {
    const target = new EventTarget();
    const details: ProgressSettings[] = [];
    target.addEventListener('tmt:settings', event => details.push((event as CustomEvent<ProgressSettings>).detail));
    let settings = sanitizeSettings(undefined);
    dispatchSettings(settings, target); // on load
    settings = updateSettings(settings, { audio: { music: 0.3 } });
    dispatchSettings(settings, target);
    settings = updateSettings(settings, { graphics: { tier: 'low', renderScale: 0.1 }, gameplay: { reducedMotion: true } });
    dispatchSettings(settings, target);
    expect(details).toHaveLength(3);
    expect(details[1].audio.music).toBe(0.3);
    expect(details[2].graphics).toMatchObject({ tier: 'low', renderScale: 0.5 });
    expect(details[2].gameplay.reducedMotion).toBe(true);
    expect(details[2].audio.music).toBe(0.3);
  });

  it('keeps the latest broadcast for listeners that attach after the load event (the engine at view.initialize)', () => {
    const target = new EventTarget();
    const settings = updateSettings(sanitizeSettings(undefined), { graphics: { tier: 'medium', renderScale: 0.75 } });
    const event = dispatchSettings(settings, target);
    expect(currentSettings()).toBe(event.detail);
    expect(currentSettings().graphics).toMatchObject({ tier: 'medium', renderScale: 0.75 });
    expect(Object.isFrozen(currentSettings())).toBe(true);
    dispatchSettings(DEFAULT_SETTINGS, target);
    expect(currentSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('sanitises anything into a complete settings object without throwing', () => {
    for (const junk of [undefined, null, 7, 'x', [], { graphics: 'no' }, { audio: { master: Number.NaN, sfx: Infinity } }]) {
      const settings = sanitizeSettings(junk);
      expect(Object.keys(settings.graphics)).toHaveLength(SHAPE.graphics.length);
      expect(Number.isFinite(settings.audio.master)).toBe(true);
    }
    expect(sanitizeSettings({ audio: { sfx: Infinity } }).audio.sfx).toBe(DEFAULT_SETTINGS.audio.sfx);
    expect(sanitizeSettings({ audio: { sfx: 4 } }).audio.sfx).toBe(1);
    expect(sanitizeSettings({ graphics: { tier: 'potato' } }).graphics.tier).toBe('auto');
  });

  it('migrates old profiles and preserves independent lighting opt-outs across unrelated changes', () => {
    const old = sanitizeSettings({ graphics: { tier: 'high', clouds: false } });
    expect(old.graphics).toMatchObject({ clouds: false, volumetrics: true, lensFlare: true, godRays: true });
    const disabled = updateSettings(old, { graphics: { volumetrics: false, lensFlare: false, godRays: false } });
    expect(updateSettings(disabled, { audio: { music: 0.2 } }).graphics).toEqual(disabled.graphics);
    expect(sanitizeSettings({ graphics: { volumetrics: 'false', lensFlare: 0, godRays: null } }).graphics)
      .toMatchObject({ volumetrics: DEFAULT_SETTINGS.graphics.volumetrics, lensFlare: DEFAULT_SETTINGS.graphics.lensFlare, godRays: DEFAULT_SETTINGS.graphics.godRays });
    expect(sanitizeSettings({ graphics: { tier: 'low', clouds: true, volumetrics: true } }).graphics)
      .toMatchObject({ clouds: true, cloudQuality: 1, volumetrics: true, hazeQuality: 1 });
  });

  it('replaces every graphics control on preset selection, then keeps manual edits as Custom across reloads', () => {
    let settings = sanitizeSettings(undefined);
    for (const tier of ['ultra', 'low', 'medium', 'high'] as const) {
      settings = updateSettings(settings, { graphics: { tier } });
      expect(settings.graphics).toEqual({ tier, ...GRAPHICS_PRESETS[tier] });
    }
    expect(settings.graphics.renderScale).toBe(1);
    const edited = updateSettings(settings, { graphics: { shadows: 0, cloudQuality: 0, renderScale: 0.83 } });
    expect(edited.graphics).toMatchObject({ tier: 'custom', clouds: false, cloudQuality: 0, shadows: 0, renderScale: 0.83 });
    expect(sanitizeSettings(JSON.parse(JSON.stringify(edited)))).toEqual(edited);
    expect(updateSettings(edited, { audio: { music: 0.2 } }).graphics).toEqual(edited.graphics);
    expect(updateSettings(edited, { graphics: { tier: 'high' } }).graphics).toEqual(graphicsPreset('high'));
  });

  it('keeps Low minimal and chooses conservative Auto defaults for small devices', () => {
    expect(graphicsPreset('low')).toMatchObject({ renderScale: 0.5, shadows: 0, cloudQuality: 0, hazeQuality: 0, grassDensity: 0,
      globalIllumination: false, ambientOcclusion: false, bloom: 0, miniature: 0, fisheye: 0 });
    expect(recommendedGraphicsPreset({ hardwareConcurrency: 4, deviceMemory: 4 })).toBe('low');
    expect(recommendedGraphicsPreset({ hardwareConcurrency: 8, userAgent: 'Android' })).toBe('low');
    expect(recommendedGraphicsPreset({})).toBe('medium');
    expect(recommendedGraphicsPreset({ hardwareConcurrency: 12, deviceMemory: 8 })).toBe('high');
  });

  it('preserves negative lens settings across saves and disables depth of field in every preset', () => {
    const settings = updateSettings(sanitizeSettings(undefined), { graphics: { fisheye: -0.45 } });
    expect(sanitizeSettings(JSON.parse(JSON.stringify(settings))).graphics).toMatchObject({ tier: 'custom', fisheye: -0.45 });
    expect(sanitizeSettings({ graphics: { fisheye: -10 } }).graphics.fisheye).toBe(-0.6);
    for (const preset of Object.values(GRAPHICS_PRESETS)) expect(preset.miniature).toBe(0);
  });
});
