/** Brush compositing is an editing operation. Gameplay receives only the resulting fixed-resolution texture. */
import type { KitLoadoutIdsLike } from '../kit';
import type { PaintDab, TankAppearance } from '../meta/cosmetics';
import { decodePaintPixels, encodePaintPixels, type PaintTextureLayer, type PaintTextureTile } from '../meta/paint-texture';
import { chartPoint, chartTexel, chartWeights, componentPaintGeometry, type ComponentPaintGeometry } from './paint-geometry';

const linear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const srgb = (v: number) => Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
export const samePaintLayer = (a: Pick<PaintTextureLayer, 'slot' | 'partId' | 'group' | 'lod'>, b: Pick<PaintTextureLayer, 'slot' | 'partId' | 'group' | 'lod'>) =>
  a.slot === b.slot && a.partId === b.partId && a.group === b.group && a.lod === b.lod;

export function rasterPaintDab(appearance: TankAppearance, geometry: readonly ComponentPaintGeometry[], dab: PaintDab, eraser = false, coverage?: { matched: boolean }): TankAppearance {
  const color = [1, 3, 5].map(at => linear(parseInt(dab.color.slice(at, at + 2), 16) / 255));
  const layers = [...appearance.paintTextures ?? []]; let changed = false;
  for (const component of geometry) {
    if (component.slot !== dab.slot || component.partId !== dab.partId || component.group !== dab.group) continue;
    const index = layers.findIndex(layer => samePaintLayer(layer, component)), previous = index >= 0 ? layers[index] : undefined;
    const tiles = new Map((previous?.tiles ?? []).map(tile => [tile.key, tile])); let layerChanged = false;
    for (const chart of component.charts) {
      const nearest = chartPoint(chart, chartWeights(chart, dab.position)), radius = Math.max(dab.radius, .7 / chart.density);
      if (Math.hypot(...nearest.map((v, k) => v - dab.position[k])) > radius + 1 / chart.density) continue;
      const old = tiles.get(chart.key); if (eraser && !old) continue;
      const pixels = old ? decodePaintPixels(old)?.slice() : new Uint8Array(chart.width * chart.height * 4); if (!pixels) continue;
      let tileChanged = false;
      const offsetFromOrigin = dab.position.map((v, k) => v - chart.points[0][k]);
      const center = [dot(offsetFromOrigin, chart.x) - chart.minimum[0], dot(offsetFromOrigin, chart.y) - chart.minimum[1]].map(v => v * chart.density + 2);
      const reach = radius * chart.density + 3;
      const x0 = Math.max(0, Math.floor(center[0] - reach)), x1 = Math.min(chart.width, Math.ceil(center[0] + reach));
      const y0 = Math.max(0, Math.floor(center[1] - reach)), y1 = Math.min(chart.height, Math.ceil(center[1] + reach));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const sample = chartTexel(chart, x, y), delta = sample.point.map((v, k) => v - dab.position[k]);
        // Lower LODs approximate the fine mesh; a small projection allowance keeps the same painted surface.
        if (Math.abs(dot(delta, dab.normal)) > Math.max(.003, radius * .12) + component.lod * .012 || dot(sample.normal, dab.normal) < .62) continue;
        const alpha = (1 - smooth(radius * (1 - Math.max(.02, dab.softness)), radius, Math.hypot(...delta))) * dab.opacity;
        if (alpha <= 0) continue;
        if (coverage) coverage.matched = true;
        const offset = (y * chart.width + x) * 4, before = pixels.slice(offset, offset + 4), oldAlpha = before[3] / 255;
        const nextAlpha = eraser ? oldAlpha * (1 - alpha) : alpha + oldAlpha * (1 - alpha);
        for (let k = 0; k < 3; k++) pixels[offset + k] = srgb(linear(before[k] / 255) * (1 - alpha) + (eraser ? 0 : color[k] * alpha));
        pixels[offset + 3] = Math.round(nextAlpha * 255);
        if (!pixels[offset + 3]) pixels.fill(0, offset, offset + 4);
        if (before.some((v, k) => v !== pixels[offset + k])) tileChanged = true;
      }
      if (!tileChanged) continue;
      layerChanged = true;
      if (pixels.some((v, i) => i % 4 === 3 && v !== 0)) tiles.set(chart.key, { key: chart.key, width: chart.width, height: chart.height, data: encodePaintPixels(pixels) });
      else tiles.delete(chart.key);
    }
    if (!layerChanged) continue;
    changed = true;
    const layer: PaintTextureLayer = { version: 1, slot: component.slot, partId: component.partId, group: component.group, lod: component.lod, tiles: [...tiles.values()] };
    if (index >= 0) layers[index] = layer; else layers.push(layer);
  }
  return changed ? { ...appearance, paintTextures: layers.filter(layer => layer.tiles.length) } : appearance;
}

/** Old saves remain readable. Only dabs for currently fitted parts are baked; other parts' designs stay archived. */
export function migratePaint(appearance: TankAppearance, ids: KitLoadoutIdsLike, geometry = componentPaintGeometry(ids)): TankAppearance {
  if (!appearance.paint?.length) return appearance;
  let result = appearance;
  const remaining: PaintDab[] = [];
  for (const dab of appearance.paint) {
    if (ids[dab.slot] !== dab.partId || !geometry.some(g => g.slot === dab.slot && g.group === dab.group)) remaining.push(dab);
    else { const coverage = { matched: false }; result = rasterPaintDab(result, geometry, dab, false, coverage); if (!coverage.matched) remaining.push(dab); }
  }
  return { ...result, paint: remaining };
}

export function unmatchedPaintTiles(appearance: TankAppearance, geometry: readonly ComponentPaintGeometry[]): number {
  let count = 0;
  for (const component of geometry) {
    const keys = new Set(component.charts.map(chart => chart.key));
    for (const layer of appearance.paintTextures ?? []) if (samePaintLayer(component, layer)) count += layer.tiles.filter(tile => !keys.has(tile.key)).length;
  }
  return count;
}

export function paintTextureTiles(appearance: TankAppearance): number { return (appearance.paintTextures ?? []).reduce((sum, layer) => sum + layer.tiles.length, 0); }
export function paintTextureBytes(appearance: TankAppearance): number { return (appearance.paintTextures ?? []).reduce((sum, layer) => sum + layer.tiles.reduce((n, tile) => n + tile.data.length, 0), 0); }
export type { PaintTextureTile };
