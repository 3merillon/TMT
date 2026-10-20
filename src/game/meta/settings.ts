/**
 * Player settings (plan §5.5): graphics, audio and gameplay preferences, stored in the progress profile and
 * broadcast as `window.dispatchEvent(new CustomEvent('tmt:settings', { detail: ProgressSettings }))` on load and on
 * every change. W1-AUDIO and the engine listen; they must treat missing fields as defaults.
 *
 * Pure except `dispatchSettings`, which takes its EventTarget (window by default). Sanitising never throws.
 */
import type { Difficulty } from '../api/match';
import { defaultKeyBindings, sanitizeKeyBindings, type KeyboardBindings } from '../ui/input/bindings';

export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra';
export type GraphicsTier = 'auto' | GraphicsPreset | 'custom';
export interface GraphicsSettings {
  tier: GraphicsTier; renderScale: number; miniature: number; fisheye: number; bloom: number; grain: number; clouds: boolean; grassDensity: number;
  volumetrics: boolean; lensFlare: boolean; godRays: boolean;
  /** 0 = off, 1–4 = low/medium/high/ultra. Independent of the protected simulation/render tier. */
  shadows: number; cloudQuality: number; hazeQuality: number; ambientOcclusion: boolean; globalIllumination: boolean;
}
export interface AudioSettings { master: number; music: number; sfx: number; ui: number; voice: number }
/** How a drive input is read: 'tank' (up = hull forward, sideways = turn) or 'camera' (point where you want to go on screen). */
export type DriveScheme = 'tank' | 'camera';
export interface GameplaySettings {
  difficulty: Difficulty; cinematics: boolean; reducedMotion: boolean; autoBrace: boolean;
  /** Legacy profile field. The full shot arc is now always enabled. */
  aimAssist: boolean;
  /** The on-screen joystick (default 'camera') and the keyboard and gamepad (default 'tank'). */
  touchDrive: DriveScheme; keyDrive: DriveScheme;
  profanityFilter: boolean;
}
export interface ProgressSettings { graphics: GraphicsSettings; audio: AudioSettings; gameplay: GameplaySettings; controls: { bindings: KeyboardBindings } }

export const SETTINGS_EVENT = 'tmt:settings';
export const GRAPHICS_TIERS: readonly GraphicsTier[] = Object.freeze(['auto', 'low', 'medium', 'high', 'ultra', 'custom']);
export const DIFFICULTIES: readonly Difficulty[] = Object.freeze(['story', 'normal', 'hard', 'ace']);
export const DRIVE_SCHEMES: readonly DriveScheme[] = Object.freeze(['camera', 'tank']);

/**
 * The render scales the settings offer: native, then frames rendered at fewer pixels and rebuilt to display resolution by
 * the temporal upscaler (FSR 2's quality ratios). Any value in SETTING_RANGES.renderScale stays valid for older profiles.
 */
export const RENDER_SCALE_STEPS: readonly { scale: number; label: string; title: string }[] = Object.freeze([
  { scale: 1, label: 'Native', title: 'Every display pixel rendered' },
  { scale: 0.77, label: '77%', title: 'Upscaled from 77% of the pixels per axis' },
  { scale: 0.67, label: '67%', title: 'Upscaled from 67% of the pixels per axis' },
  { scale: 0.5, label: '50%', title: 'Upscaled from half the pixels per axis' },
]);

/** [min, max, step] of every numeric setting. Audio volumes are linear gains in [0, 1]. */
export const SETTING_RANGES = Object.freeze({
  renderScale: [0.5, 1, 0.05], miniature: [0, 1, 0.05], fisheye: [-0.6, 0.6, 0.05], bloom: [0, 1, 0.05], grain: [0, 1, 0.05], grassDensity: [0, 1, 0.05],
  volume: [0, 1, 0.05],
  shadows: [0, 4, 1], cloudQuality: [0, 4, 1], hazeQuality: [0, 4, 1],
} as const);

/** Optional effects only. Terrain relief, liquids, explosion pools and visibility stay at the same quality. */
export const GRAPHICS_PRESETS: Readonly<Record<GraphicsPreset, Omit<GraphicsSettings, 'tier'>>> = deepFreeze({
  low: { renderScale: 0.5, shadows: 0, cloudQuality: 0, hazeQuality: 0, grassDensity: 0,
    ambientOcclusion: false, globalIllumination: false, clouds: false, volumetrics: false,
    miniature: 0, fisheye: 0, bloom: 0, grain: 0, lensFlare: false, godRays: false },
  medium: { renderScale: 0.67, shadows: 1, cloudQuality: 1, hazeQuality: 0, grassDensity: 0.25,
    ambientOcclusion: true, globalIllumination: false, clouds: true, volumetrics: false,
    miniature: 0, fisheye: 0.1, bloom: 0.25, grain: 0, lensFlare: false, godRays: false },
  high: { renderScale: 1, shadows: 3, cloudQuality: 3, hazeQuality: 2, grassDensity: 0.7,
    ambientOcclusion: true, globalIllumination: true, clouds: true, volumetrics: true,
    miniature: 0, fisheye: 0.15, bloom: 0.5, grain: 0.1, lensFlare: true, godRays: true },
  ultra: { renderScale: 1, shadows: 4, cloudQuality: 4, hazeQuality: 4, grassDensity: 1,
    ambientOcclusion: true, globalIllumination: true, clouds: true, volumetrics: true,
    miniature: 0, fisheye: 0.15, bloom: 0.5, grain: 0.2, lensFlare: true, godRays: true },
});
/** Conservative starting point, not an FPS promise or a GPU benchmark. */
export function recommendedGraphicsPreset(device: { hardwareConcurrency?: number; deviceMemory?: number; userAgent?: string } = typeof navigator === 'undefined' ? {} : navigator): GraphicsPreset {
  if ((device.deviceMemory !== undefined && device.deviceMemory <= 4) || (device.hardwareConcurrency !== undefined && device.hardwareConcurrency <= 4)
    || /Android|iPad|iPhone|Mobile/i.test(device.userAgent ?? '')) return 'low';
  if ((device.deviceMemory ?? 0) >= 8 && (device.hardwareConcurrency ?? 0) >= 8) return 'high';
  return 'medium';
}
export function graphicsPreset(tier: Exclude<GraphicsTier, 'custom'>): GraphicsSettings {
  return { tier, ...GRAPHICS_PRESETS[tier === 'auto' ? recommendedGraphicsPreset() : tier] };
}

export const DEFAULT_SETTINGS: ProgressSettings = deepFreeze({
  graphics: { tier: 'auto', ...GRAPHICS_PRESETS.medium },
  audio: { master: 0.8, music: 0.6, sfx: 0.9, ui: 0.7, voice: 0.8 },
  // aimAssist is retained only for compatibility with exported profiles.
  gameplay: { difficulty: 'normal', cinematics: true, reducedMotion: false, autoBrace: false, aimAssist: false, touchDrive: 'camera', keyDrive: 'tank', profanityFilter: true },
  controls: { bindings: defaultKeyBindings() },
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const own = (source: Record<string, unknown>, key: string): unknown => Object.hasOwn(source, key) ? source[key] : undefined;
function unit(value: unknown, fallback: number, [min, max]: readonly [number, number, number]): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;
function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback;
}

/** A fresh, fully populated settings object: every field is typed and clamped, unknown fields are dropped. Never throws. */
export function sanitizeSettings(value: unknown): ProgressSettings {
  const source = record(value), g = record(own(source, 'graphics')), a = record(own(source, 'audio')), p = record(own(source, 'gameplay'));
  const tier = choice(own(g, 'tier'), GRAPHICS_TIERS, 'auto');
  const G = tier === 'custom' ? DEFAULT_SETTINGS.graphics : graphicsPreset(tier), A = DEFAULT_SETTINGS.audio, P = DEFAULT_SETTINGS.gameplay, R = SETTING_RANGES;
  const quality = (key: 'shadows' | 'cloudQuality' | 'hazeQuality') => Math.round(unit(own(g, key), G[key], R[key]));
  const clouds = own(g, 'clouds'), volumetrics = own(g, 'volumetrics');
  const cloudQuality = own(g, 'cloudQuality') === undefined && typeof clouds === 'boolean' ? (clouds ? Math.max(1, G.cloudQuality) : 0) : quality('cloudQuality');
  const hazeQuality = own(g, 'hazeQuality') === undefined && typeof volumetrics === 'boolean' ? (volumetrics ? Math.max(1, G.hazeQuality) : 0) : quality('hazeQuality');
  return {
    graphics: {
      tier, renderScale: unit(own(g, 'renderScale'), G.renderScale, R.renderScale),
      miniature: unit(own(g, 'miniature'), G.miniature, R.miniature), fisheye: unit(own(g, 'fisheye'), G.fisheye, R.fisheye),
      bloom: unit(own(g, 'bloom'), G.bloom, R.bloom), grain: unit(own(g, 'grain'), G.grain, R.grain),
      clouds: cloudQuality > 0, cloudQuality, shadows: quality('shadows'), hazeQuality,
      ambientOcclusion: flag(own(g, 'ambientOcclusion'), G.ambientOcclusion), globalIllumination: flag(own(g, 'globalIllumination'), G.globalIllumination),
      grassDensity: unit(own(g, 'grassDensity'), G.grassDensity, R.grassDensity),
      volumetrics: hazeQuality > 0, lensFlare: flag(own(g, 'lensFlare'), G.lensFlare),
      godRays: flag(own(g, 'godRays'), G.godRays),
    },
    audio: {
      master: unit(own(a, 'master'), A.master, R.volume), music: unit(own(a, 'music'), A.music, R.volume), sfx: unit(own(a, 'sfx'), A.sfx, R.volume),
      ui: unit(own(a, 'ui'), A.ui, R.volume), voice: unit(own(a, 'voice'), A.voice, R.volume),
    },
    gameplay: {
      difficulty: choice(own(p, 'difficulty'), DIFFICULTIES, P.difficulty), cinematics: flag(own(p, 'cinematics'), P.cinematics),
      reducedMotion: flag(own(p, 'reducedMotion'), P.reducedMotion), autoBrace: flag(own(p, 'autoBrace'), P.autoBrace), aimAssist: flag(own(p, 'aimAssist'), P.aimAssist),
      touchDrive: choice(own(p, 'touchDrive'), DRIVE_SCHEMES, P.touchDrive), keyDrive: choice(own(p, 'keyDrive'), DRIVE_SCHEMES, P.keyDrive),
      profanityFilter: flag(own(p, 'profanityFilter'), true),
    },
    controls: { bindings: sanitizeKeyBindings(own(record(own(source, 'controls')), 'bindings')) },
  };
}

export type SettingsPatch = { [G in keyof ProgressSettings]?: Partial<ProgressSettings[G]> };
/** Applies a partial change and re-sanitises, so an out-of-range value from a control is clamped, never stored. */
export function updateSettings(current: ProgressSettings, patch: SettingsPatch): ProgressSettings {
  const g = patch.graphics;
  let graphics = { ...current.graphics };
  if (g) {
    const selected = g.tier && g.tier !== 'custom' ? graphicsPreset(g.tier) : undefined;
    graphics = { ...(selected ?? graphics), ...g };
    // Legacy callers may still send the old effect toggles.
    if (g.clouds !== undefined && g.cloudQuality === undefined) graphics.cloudQuality = g.clouds ? Math.max(1, graphics.cloudQuality) : 0;
    if (g.volumetrics !== undefined && g.hazeQuality === undefined) graphics.hazeQuality = g.volumetrics ? Math.max(1, graphics.hazeQuality) : 0;
    if (!selected && Object.keys(g).some(key => key !== 'tier')) graphics.tier = 'custom';
  }
  return sanitizeSettings({
    graphics, audio: { ...current.audio, ...patch.audio }, gameplay: { ...current.gameplay, ...patch.gameplay },
    controls: { ...current.controls, ...patch.controls },
  });
}

/** The `tmt:settings` event: `detail` is a frozen copy, so one listener can never change what the next one sees. */
export function settingsEvent(settings: ProgressSettings): CustomEvent<ProgressSettings> {
  return new CustomEvent<ProgressSettings>(SETTINGS_EVENT, { detail: deepFreeze(sanitizeSettings(settings)) });
}
let latest: ProgressSettings | undefined;
/** Broadcasts the settings (on load and after every change). Returns the dispatched event. */
export function dispatchSettings(settings: ProgressSettings, target: EventTarget = window): CustomEvent<ProgressSettings> {
  const event = settingsEvent(settings);
  latest = event.detail;
  target.dispatchEvent(event);
  return event;
}
/** The settings of the latest broadcast (frozen), or the defaults before the first one. The load event fires while the
 * UI controller is constructed, so a listener that attaches later (the engine during view.initialize) reads this first. */
export function currentSettings(): ProgressSettings {
  return latest ?? DEFAULT_SETTINGS;
}
