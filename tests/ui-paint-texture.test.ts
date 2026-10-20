import { describe, expect, it } from 'vitest';
import { defaultAppearance, equippedAppearance, sanitizeCosmetics } from '../src/game/meta/cosmetics';
import { decodePaintPixels, encodePaintPixels } from '../src/game/meta/paint-texture';
import { activeKit, defaultProfile, exportProfile, importProfile, readProgress, saveProgress, withAppearance } from '../src/game/meta/profile';
import { componentPaintGeometry } from '../src/game/presentation/paint-geometry';
import { paintTextureBytes, paintTextureTiles } from '../src/game/presentation/paint-raster';
import { DEFAULT_BRUSH, PaintSession } from '../src/game/workshop/paint';

const kit = activeKit(defaultProfile());
const geometry = componentPaintGeometry(kit).find(g => g.slot === 'hull' && g.lod === 0)!;
const chart = geometry.charts.filter(c => c.width > 25 && c.height > 25).sort((a, b) => b.width * b.height - a.width * a.height)[0];
const hit = { slot: geometry.slot, partId: geometry.partId, group: geometry.group,
  position: [0, 1, 2].map(k => chart.points.reduce((s, p) => s + p[k] / 3, 0)) as [number, number, number], normal: chart.normals[0] };

describe('compressed custom paint', () => {
  it('tracks actual unsaved edits, undo to saved state, clearing, finishes and legacy migration', () => {
    const session = new PaintSession(defaultAppearance(), kit);
    expect(session.dirty).toBe(false);
    session.reset(); expect(session.dirty).toBe(false); expect(session.canUndo).toBe(false);
    session.begin(); session.dab(hit, DEFAULT_BRUSH); session.end(); expect(session.dirty).toBe(true);
    session.undo(); expect(session.dirty).toBe(false);
    session.redo(); expect(session.dirty).toBe(true);
    const saved = new PaintSession(session.value, kit); expect(saved.dirty).toBe(false);
    saved.reset(); expect(saved.dirty).toBe(true); saved.undo(); expect(saved.dirty).toBe(false);
    saved.change({ ...saved.value, lights: false }); expect(saved.dirty).toBe(true);
    saved.undo(); expect(saved.dirty).toBe(false);
    saved.change({ ...saved.value, finish: { pattern: 'solid', colors: ['#ff0000', '#000000', '#ffffff'], scale: 1 } }); expect(saved.dirty).toBe(true);
    const legacy = new PaintSession({ ...defaultAppearance(), paint: [{ ...hit, ...DEFAULT_BRUSH }] }, kit);
    expect(legacy.dirty).toBe(false); expect(paintTextureTiles(legacy.value)).toBeGreaterThan(0);
  });
  it('losslessly handles transparent runs, gradients and a full 512-square noise tile', () => {
    for (const width of [1, 32, 512]) {
      const pixels = new Uint8Array(width * width * 4); let seed = 17;
      for (let i = 0; i < pixels.length; i++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; pixels[i] = seed >>> 24; }
      const data = encodePaintPixels(pixels);
      expect(decodePaintPixels({ width, height: width, data })).toEqual(pixels);
    }
    const clear = new Uint8Array(128 * 128 * 4);
    expect(encodePaintPixels(clear).length).toBeLessThan(1000);
    expect(decodePaintPixels({ width: 128, height: 128, data: encodePaintPixels(clear) })).toEqual(clear);
    expect(decodePaintPixels({ width: 1, height: 1, data: '////' })).toBeNull();
    expect(decodePaintPixels({ width: 513, height: 1, data: '' })).toBeNull();
  });

  it('keeps painting past 192 gestures, overwrites texels without growing the artwork, and round trips saves', () => {
    const session = new PaintSession(defaultAppearance(), kit);
    let tiles = 0;
    for (let i = 0; i < 240; i++) {
      session.begin();
      expect(session.dab(hit, { ...DEFAULT_BRUSH, color: i % 2 ? '#ff0000' : '#0000ff' })).toBe(true);
      session.end();
      if (i === 0) tiles = paintTextureTiles(session.value);
      expect(paintTextureTiles(session.value)).toBe(tiles);
    }
    expect(session.value.paint?.length ?? 0).toBe(0);
    expect(session.value.paintTextures?.some(layer => layer.lod === 0)).toBe(true);
    expect(session.value.paintTextures?.some(layer => layer.lod === 1)).toBe(true);
    expect(session.value.paintTextures?.some(layer => layer.lod === 2)).toBe(true);
    expect(paintTextureBytes(session.value)).toBeLessThan(100_000);
    const profile = withAppearance(defaultProfile(), session.value), imported = importProfile(exportProfile(profile));
    expect(imported.ok).toBe(true); if (!imported.ok) return;
    expect(equippedAppearance(imported.profile.cosmetics)).toEqual(session.value);
    const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(saveProgress(profile, storage)).toBe(true);
    const reopened = new PaintSession(equippedAppearance(readProgress(storage).cosmetics), kit);
    expect(reopened.value).toEqual(session.value);
    reopened.begin(); expect(reopened.dab(hit, { ...DEFAULT_BRUSH, color: '#00ff00' })).toBe(true); reopened.end();
    reopened.undo(); expect(reopened.value).toEqual(session.value); reopened.redo(); expect(reopened.value).not.toEqual(session.value);
    let undos = 0; while (session.canUndo) { session.undo(); undos++; } expect(undos).toBe(32);
  });

  it('migrates old dabs and keeps other components and unknown geometry archived without clipping valid tiles', () => {
    const legacy = { ...defaultAppearance(), paint: [{ ...hit, ...DEFAULT_BRUSH }] };
    const session = new PaintSession(legacy, kit);
    expect(session.value.paint).toEqual([]); expect(paintTextureTiles(session.value)).toBeGreaterThan(0);
    expect(session.original).toEqual(legacy);
    const tile = session.value.paintTextures![0].tiles[0];
    const archive = { ...session.value, paintTextures: [...session.value.paintTextures!, { ...session.value.paintTextures![0], partId: 'old-hull', tiles: [tile] }] };
    expect(sanitizeCosmetics({ appearance: archive }).appearance).toEqual(archive);
    const after = new PaintSession(archive, kit); after.begin(); after.dab(hit, { ...DEFAULT_BRUSH, color: '#00ff00' }); after.end();
    expect(after.value.paintTextures?.find(layer => layer.partId === 'old-hull')).toEqual(archive.paintTextures.at(-1));
    expect(saveProgress(withAppearance(defaultProfile(), after.value), { setItem() { throw Error('quota'); } })).toBe(false);
    expect(after.value.paintTextures?.find(layer => layer.partId === 'old-hull')).toBeDefined();
  });
  it('consumes covered duplicate legacy dabs so reopening cannot paint over newer edits', () => {
    const old = { ...hit, ...DEFAULT_BRUSH, color: '#ff0000' }, original = { ...defaultAppearance(), paint: [old, old] };
    const session = new PaintSession(original, kit);
    expect(session.value.paint).toEqual([]);
    session.begin(); session.dab(hit, { ...DEFAULT_BRUSH, color: '#0000ff' }); session.end();
    const reopened = new PaintSession(session.value, kit);
    expect(reopened.value).toEqual(session.value);
    const missing = { ...old, position: [9, 9, 9] as [number, number, number] };
    expect(new PaintSession({ ...defaultAppearance(), paint: [missing] }, kit).value.paint).toEqual([missing]);
  });
});
