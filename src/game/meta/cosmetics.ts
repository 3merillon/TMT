/** Presentation-only account data. Kit ids, fitting costs and gameplay stats never depend on this module. */
import { sanitizePaintTextures, type PaintTextureLayer } from './paint-texture';
export type Palette = 'sage' | 'ochre';
export type PaintPattern = 'solid' | 'woodland' | 'geometric' | 'stripe';
export interface PaintFinish { pattern: PaintPattern; colors: [string, string, string]; scale: number }
/** A surface dab, in its rigid mesh's unscaled joint frame. Never a world-space decal. */
export interface PaintDab {
  slot: 'hull' | 'runningGear' | 'turret' | 'weapon' | 'utility'; partId: string; group: string;
  position: [number, number, number]; normal: [number, number, number];
  radius: number; opacity: number; softness: number; color: string;
}
export const MAX_PAINT_DABS = 192;
export const PAINT_FINISHES: readonly { name: string; finish: PaintFinish }[] = [
  { name: 'Workshop sage', finish: { pattern: 'solid', colors: ['#739269', '#394638', '#b8ac83'], scale: 1 } },
  { name: 'Foundry ochre', finish: { pattern: 'solid', colors: ['#b59047', '#594c34', '#d9c696'], scale: 1 } },
  { name: 'Slate enamel', finish: { pattern: 'solid', colors: ['#607581', '#303c43', '#b4c2c5'], scale: 1 } },
  { name: 'Winter enamel', finish: { pattern: 'solid', colors: ['#cad0c5', '#69777b', '#404d4a'], scale: 1 } },
  { name: 'Forest camouflage', finish: { pattern: 'woodland', colors: ['#71835b', '#394638', '#b8ac83'], scale: 1 } },
  { name: 'Desert geometry', finish: { pattern: 'geometric', colors: ['#b69f6a', '#79694d', '#d7c496'], scale: 1 } },
  { name: 'Field identification', finish: { pattern: 'stripe', colors: ['#667b56', '#d4ccb0', '#363e31'], scale: 1 } },
];
export interface TankAppearance {
  version: 1;
  paintId: string;
  materialId: string;
  decalIds: string[];
  skinId: string | null;
  finish?: PaintFinish;
  paint?: PaintDab[];
  /** Composited custom paint; legacy dabs above are converted when their component is displayed or edited. */
  paintTextures?: PaintTextureLayer[];
  lights?: boolean;
}
export interface CosmeticProfile {
  /** Legacy palette remains readable by existing presentation adapters. */
  palette: Palette;
  /** Entitlements are deliberately independent of gameplay unlocks. No purchase API is implemented. */
  owned?: string[];
  appearance?: TankAppearance;
}
const BUILTIN = new Set(['paint:sage', 'paint:ochre', 'material:field-enamel']);
const ID = /^(paint|material|decal|skin):[a-z0-9][a-z0-9._-]{0,55}$/;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hex = (value: unknown): value is string => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
const finite = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function sanitizePaintDabs(value: unknown): PaintDab[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PAINT_DABS).flatMap(raw => {
    const d = record(raw);
    if (!['hull', 'runningGear', 'turret', 'weapon', 'utility'].includes(String(d.slot)) || typeof d.partId !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(d.partId)
      || typeof d.group !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(d.group) || !hex(d.color)
      || !Array.isArray(d.position) || d.position.length !== 3 || !d.position.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 12)
      || !Array.isArray(d.normal) || d.normal.length !== 3 || !d.normal.every(v => typeof v === 'number' && Number.isFinite(v))) return [];
    const n = Math.hypot(...d.normal as number[]); if (n < .001) return [];
    return [{ slot: d.slot as PaintDab['slot'], partId: d.partId, group: d.group, position: [...d.position] as PaintDab['position'],
      normal: d.normal.map(v => v / n) as PaintDab['normal'], color: d.color.toLowerCase(), radius: finite(d.radius, .12, .02, .5),
      opacity: finite(d.opacity, 1, .05, 1), softness: finite(d.softness, .35, 0, 1) }];
  });
}
export function appearanceFinish(appearance: TankAppearance): PaintFinish {
  return appearance.finish ?? PAINT_FINISHES[appearance.paintId === 'paint:ochre' ? 1 : 0].finish;
}
export function defaultAppearance(palette: Palette = 'sage'): TankAppearance {
  return { version: 1, paintId: `paint:${palette}`, materialId: 'material:field-enamel', decalIds: [], skinId: null };
}
export function sanitizeCosmetics(value: unknown): CosmeticProfile {
  const input = record(value), palette: Palette = input.palette === 'ochre' ? 'ochre' : 'sage';
  const result: CosmeticProfile = { palette };
  const owned = Array.isArray(input.owned) ? [...new Set(input.owned.filter((id): id is string => typeof id === 'string' && ID.test(id)))].slice(0, 256) : [];
  if (Array.isArray(input.owned)) result.owned = owned;
  if (input.appearance !== undefined) {
    const appearance = record(input.appearance), fallback = defaultAppearance(palette);
    const allowed = (id: unknown, category: string): id is string => typeof id === 'string' && id.startsWith(`${category}:`) && ID.test(id) && (BUILTIN.has(id) || owned.includes(id));
    result.appearance = {
      version: 1, paintId: allowed(appearance.paintId, 'paint') ? appearance.paintId : fallback.paintId,
      materialId: allowed(appearance.materialId, 'material') ? appearance.materialId : fallback.materialId,
      decalIds: Array.isArray(appearance.decalIds) ? [...new Set(appearance.decalIds.filter((id): id is string => allowed(id, 'decal')))].slice(0, 8) : [],
      skinId: allowed(appearance.skinId, 'skin') ? appearance.skinId : null,
    };
    if (appearance.finish !== undefined) {
      const f = record(appearance.finish), fallbackFinish = PAINT_FINISHES[palette === 'ochre' ? 1 : 0].finish;
      result.appearance.finish = { pattern: ['solid', 'woodland', 'geometric', 'stripe'].includes(String(f.pattern)) ? f.pattern as PaintPattern : 'solid',
        colors: [0, 1, 2].map(i => Array.isArray(f.colors) && hex(f.colors[i]) ? f.colors[i].toLowerCase() : fallbackFinish.colors[i]) as PaintFinish['colors'], scale: finite(f.scale, 1, .4, 2.5) };
    }
    if (appearance.paint !== undefined) result.appearance.paint = sanitizePaintDabs(appearance.paint);
    if (appearance.paintTextures !== undefined) result.appearance.paintTextures = sanitizePaintTextures(appearance.paintTextures);
    if (typeof appearance.lights === 'boolean') result.appearance.lights = appearance.lights;
    if (result.appearance.paintId === 'paint:sage' || result.appearance.paintId === 'paint:ochre') result.palette = result.appearance.paintId.slice(6) as Palette;
  }
  return result;
}
export function equippedAppearance(cosmetics: CosmeticProfile): TankAppearance {
  const clean = sanitizeCosmetics(cosmetics);
  return clean.appearance ?? defaultAppearance(clean.palette);
}
