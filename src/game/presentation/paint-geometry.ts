/** Stable component-local UV charts. Each triangle has a padded tile, independent of other fitted parts. */
import type { MeshDesc } from '../../engine/contracts';
import { assembleKit, buildKitMesh, validateKitLoadout, type KitLoadoutIdsLike, type SlotId } from '../kit';
import { kitContext, kitGeometry } from '../kit/build';
import type { GroupId } from '../kit/parts/types';
import { PAINT_TILE_SIZE } from '../meta/paint-texture';
import { reactiveArmorMeshes } from './reactive-armor-mesh';

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const n = Math.hypot(...a); return a.map(v => v / n) as V3; };
const quantize = (v: number) => Math.round(v * 100000) / 100000;
export const PAINT_DENSITY = [96, 48, 24] as const;
export const PAINT_GUTTER = 2;
export interface PaintChart {
  key: string; width: number; height: number;
  points: V3[]; normals: V3[];
  /** Original triangle corner -> canonical corner. */
  order: number[];
  uv: [number, number][];
  x: V3; y: V3; density: number; minimum: [number, number];
}

/** Two independent 32-bit hashes include quantized points, normals and LOD; no array/kit ordering enters the key. */
function chartKey(values: number[]): string {
  let a = 2166136261, b = 0x9e3779b9;
  for (const c of values.join(',')) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b ^ c.charCodeAt(0), 2246822519); }
  return `p1-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function paintChart(mesh: Pick<MeshDesc, 'positions' | 'normals' | 'indices' | 'attrs' | 'matId' | 'instances'>, triangle: number, lod: 0 | 1 | 2, scale = 1): PaintChart | null {
  const vertices = [0, 1, 2].map(k => mesh.indices[triangle + k]);
  if (mesh.instances?.length || vertices.some(v => ((mesh.attrs?.[v] ?? ((mesh.matId ?? 0) << 16)) >>> 16 & 255) !== 0)) return null;
  const corners = vertices.map((v, corner) => ({ corner,
    point: [0, 1, 2].map(k => quantize(mesh.positions[v * 3 + k] / scale)) as V3,
    normal: [0, 1, 2].map(k => quantize(mesh.normals[v * 3 + k])) as V3 }));
  corners.sort((a, b) => { for (let k = 0; k < 3; k++) if (a.point[k] !== b.point[k]) return a.point[k] - b.point[k]; return a.corner - b.corner; });
  const points = corners.map(c => c.point), normals = corners.map(c => c.normal), a = sub(points[1], points[0]), b = sub(points[2], points[0]);
  const n = cross(a, b); if (Math.hypot(...a) < 1e-6 || Math.hypot(...n) < 1e-10) return null;
  const x = unit(a), y = unit(cross(unit(n), x));
  const coordinates = points.map(p => { const q = sub(p, points[0]); return [dot(q, x), dot(q, y)] as [number, number]; });
  const minimum = [Math.min(...coordinates.map(p => p[0])), Math.min(...coordinates.map(p => p[1]))] as [number, number];
  const extent = [Math.max(...coordinates.map(p => p[0])) - minimum[0], Math.max(...coordinates.map(p => p[1])) - minimum[1]];
  const density = Math.min(PAINT_DENSITY[lod], (PAINT_TILE_SIZE - PAINT_GUTTER * 2 - 1) / Math.max(...extent));
  const width = Math.ceil(extent[0] * density) + PAINT_GUTTER * 2 + 1, height = Math.ceil(extent[1] * density) + PAINT_GUTTER * 2 + 1;
  return { key: chartKey([lod, ...points.flat(), ...normals.flat()]), width, height, points, normals,
    order: [0, 1, 2].map(k => corners.findIndex(c => c.corner === k)), x, y, density, minimum,
    uv: coordinates.map(p => [(p[0] - minimum[0]) * density + PAINT_GUTTER, (p[1] - minimum[1]) * density + PAINT_GUTTER]) };
}

/** Closest point barycentrics also extend edge texels into the chart's gutters. */
export function chartWeights(chart: PaintChart, point: V3): V3 {
  const [a, b, c] = chart.points, ab = sub(b, a), ac = sub(c, a), ap = sub(point, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(point, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = sub(point, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const denominator = 1 / (va + vb + vc), v = vb * denominator, w = vc * denominator; return [1 - v - w, v, w];
}
export const chartPoint = (chart: PaintChart, weights: V3): V3 => [0, 1, 2].map(k => chart.points.reduce((v, p, i) => v + p[k] * weights[i], 0)) as V3;
export function chartTexel(chart: PaintChart, x: number, y: number): { point: V3; normal: V3 } {
  const u = (x - PAINT_GUTTER) / chart.density + chart.minimum[0], v = (y - PAINT_GUTTER) / chart.density + chart.minimum[1];
  const plane = chart.points[0].map((p, k) => p + chart.x[k] * u + chart.y[k] * v) as V3, weights = chartWeights(chart, plane);
  return { point: chartPoint(chart, weights), normal: unit([0, 1, 2].map(k => chart.normals.reduce((n, p, i) => n + p[k] * weights[i], 0)) as V3) };
}

export interface ComponentPaintGeometry { slot: SlotId; partId: string; group: string; lod: 0 | 1 | 2; charts: PaintChart[] }
const geometryCache = new Map<string, ComponentPaintGeometry[]>();
/** The same builder ownership boundaries as the workshop; geometry stays in unscaled rigid-joint coordinates. */
export function componentPaintGeometry(ids: KitLoadoutIdsLike): ComponentPaintGeometry[] {
  const assembly = assembleKit(validateKitLoadout(ids)), cached = geometryCache.get(assembly.key); if (cached) return cached;
  const result: ComponentPaintGeometry[] = [];
  for (const lod of [0, 1, 2] as const) {
    const source = kitGeometry(kitContext(assembly.loadout), lod);
    for (const mesh of buildKitMesh(assembly, lod).parts) {
      if (mesh.instances?.length) continue;
      let first = 0;
      const bySlot = new Map<SlotId, PaintChart[]>();
      for (const shape of source.groups.get(mesh.part as GroupId) ?? []) {
        const slot = source.owners.get(shape)!; let charts = bySlot.get(slot); if (!charts) bySlot.set(slot, charts = []);
        if (slot !== 'runningGear') for (let i = first; i < first + shape.mb.idx.length; i += 3) { const chart = paintChart(mesh, i, lod); if (chart) charts.push(chart); }
        first += shape.mb.idx.length;
      }
      for (const [slot, charts] of bySlot) if (charts.length) result.push({ slot, partId: String(ids[slot]), group: mesh.part, lod, charts });
    }
    for (const { mesh } of reactiveArmorMeshes(assembly, lod)) {
      const charts: PaintChart[] = [];
      for (let i = 0; i < mesh.indices.length; i += 3) { const chart = paintChart(mesh, i, lod); if (chart) charts.push(chart); }
      if (charts.length) result.push({ slot: 'hull', partId: String(ids.hull), group: mesh.part, lod, charts });
    }
  }
  if (geometryCache.size >= 8) geometryCache.delete(geometryCache.keys().next().value!);
  geometryCache.set(assembly.key, result); return result;
}
