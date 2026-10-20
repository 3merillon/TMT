/** Composes saved triangle tiles into one texture per rigid mesh. Strokes are never submitted to the shader. */
import type { MeshDesc } from '../../engine/contracts';
import type { KitLoadoutIdsLike, SlotId } from '../kit';
import type { TankAppearance } from '../meta/cosmetics';
import { decodePaintPixels } from '../meta/paint-texture';
import { paintChart, type PaintChart } from './paint-geometry';
import { migratePaint } from './paint-raster';

interface PlacedChart { chart: PaintChart; triangle: number; x: number; y: number }
interface AtlasLayout { width: number; height: number; charts: PlacedChart[]; mesh: MeshDesc; uv: Float32Array }
const layouts = new WeakMap<MeshDesc, Map<string, AtlasLayout>>();
const migrated = new WeakMap<TankAppearance, Map<string, TankAppearance>>();
const nextPower = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

function layout(mesh: MeshDesc, lod: 0 | 1 | 2, scale: number, source: MeshDesc): AtlasLayout {
  let entries = layouts.get(mesh); if (!entries) layouts.set(mesh, entries = new Map());
  const key = `${lod}:${scale}`, cached = entries.get(key); if (cached) return cached;
  const charts: PlacedChart[] = [];
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) { const chart = paintChart(source, triangle, lod, scale); if (chart) charts.push({ chart, triangle, x: 0, y: 0 }); }
  // Tall charts first reduce shelf waste. All charts are reserved, so later strokes never repack existing UVs.
  charts.sort((a, b) => b.chart.height - a.chart.height || a.triangle - b.triangle);
  const area = charts.reduce((n, c) => n + c.chart.width * c.chart.height, 0);
  const width = nextPower(Math.max(32, Math.ceil(Math.sqrt(area)), ...charts.map(c => c.chart.width)));
  let x = 0, y = 0, row = 0;
  for (const place of charts) {
    if (x + place.chart.width > width) { x = 0; y += row; row = 0; }
    place.x = x; place.y = y; x += place.chart.width; row = Math.max(row, place.chart.height);
  }
  const height = nextPower(y + row);
  if (width > 4096 || height > 4096) throw Error('Paint atlas exceeds the supported mesh texture size. The saved design is unchanged.');
  const uv = new Float32Array(mesh.indices.length * 2);
  for (const place of charts) for (let k = 0; k < 3; k++) {
    const point = place.chart.uv[place.chart.order[k]];
    uv[(place.triangle + k) * 2] = (place.x + point[0] + .5) / width;
    uv[(place.triangle + k) * 2 + 1] = (place.y + point[1] + .5) / height;
  }
  // Independent chart corners require independent vertices, while triangle and draw counts stay identical.
  const floats = (data: Float32Array | undefined, stride: number) => {
    if (!data) return undefined;
    const out = new Float32Array(mesh.indices.length * stride);
    mesh.indices.forEach((v, i) => out.set(data.subarray(v * stride, (v + 1) * stride), i * stride)); return out;
  };
  const integers = (data: Uint32Array | undefined) => data ? Uint32Array.from(mesh.indices, v => data[v]) : undefined;
  const result: AtlasLayout = { width, height, charts, uv, mesh: { ...mesh, positions: floats(mesh.positions, 3)!, normals: floats(mesh.normals, 3)!,
    partLocal: floats(mesh.partLocal, 3), attrs: integers(mesh.attrs), primAxis: integers(mesh.primAxis), indices: Uint32Array.from(mesh.indices, (_, i) => i) } };
  entries.set(key, result); return result;
}

export function paintAppearance(appearance: TankAppearance, ids: KitLoadoutIdsLike): TankAppearance {
  if (!appearance.paint?.length) return appearance;
  let variants = migrated.get(appearance); if (!variants) migrated.set(appearance, variants = new Map());
  const key = JSON.stringify(ids), cached = variants.get(key); if (cached) return cached;
  const result = migratePaint(appearance, ids); variants.set(key, result); return result;
}

export function paintedMesh(mesh: MeshDesc, appearance: TankAppearance, ids: KitLoadoutIdsLike, group: string, lod: 0 | 1 | 2, slot?: SlotId, scale = 1, source = mesh): MeshDesc {
  const clean = paintAppearance(appearance, ids);
  const layers = (clean.paintTextures ?? []).filter(layer => layer.group === group && layer.lod === lod && (!slot || slot === layer.slot) && ids[layer.slot] === layer.partId);
  if (!layers.length || mesh.instances?.length) return mesh;
  const tiles = new Map(layers.flatMap(layer => layer.tiles.map(tile => [tile.key, tile] as const))), atlas = layout(mesh, lod, scale, source);
  const pixels = new Uint8Array(atlas.width * atlas.height * 4); let painted = false;
  for (const place of atlas.charts) {
    const tile = tiles.get(place.chart.key); if (!tile || tile.width !== place.chart.width || tile.height !== place.chart.height) continue;
    const data = decodePaintPixels(tile); if (!data) continue;
    painted = true;
    for (let y = 0; y < tile.height; y++) pixels.set(data.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), ((place.y + y) * atlas.width + place.x) * 4);
  }
  if (!painted) return mesh;
  return { ...atlas.mesh, tankSurface: mesh.tankSurface, paintTexture: { width: atlas.width, height: atlas.height, pixels, uv: atlas.uv } };
}
