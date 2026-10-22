import type { V3, WorldQuery } from '../contracts';
import type { WaterHull } from '../../engine/passes/fluids/water';
import { WATER_MAX_CHUNK_HULLS } from '../../engine/passes/fluids/liquid-params';
import { structuralLiquidBox, type LiquidBox } from '../structural-liquid';
import { add, dot, normalize, rotate } from '../math';
import { cellOfDir } from '../../world/cube-grid';

type Body = ReturnType<NonNullable<WorldQuery['collisionBodies']>>[number];
const envelopes = new WeakMap<Body['shapes'], LiquidBox>();
/** One conservative oriented envelope per chunk; geometry is cached across pose updates. */
function envelope(shapes: Body['shapes']): LiquidBox {
  const cached = envelopes.get(shapes); if (cached) return cached;
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const shape of shapes) {
    const b = structuralLiquidBox(shape);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.center[a] - b.half[a]); hi[a] = Math.max(hi[a], b.center[a] + b.half[a]); }
  }
  const box = { center: lo.map((v, a) => (v + hi[a]) / 2) as V3, half: lo.map((v, a) => (hi[a] - v) / 2) as V3 };
  envelopes.set(shapes, box); return box;
}

export function structuralWaterHulls(world?: WorldQuery): WaterHull[] {
  const hulls: WaterHull[] = [];
  for (const body of world?.collisionBodies?.() ?? []) {
    if (!body.shapes.length) continue;
    const box = envelope(body.shapes);
    hulls.push({ id: `chunk:${body.id}`, centre: add(body.position, rotate(box.center, body.rotation)), half: box.half,
      axes: ([ [1, 0, 0], [0, 1, 0], [0, 0, 1] ] as V3[]).map(v => rotate(v, body.rotation)) });
  }
  return hulls;
}

/** Structures and cosmetic debris share the existing sixteen non-tank slots.
 * Prefer large surface contacts; retain near-equal choices to avoid history churn.
 * The GPU decides actual wet contact, including water redistributed outside saved basins. */
export function selectWaterHulls(hulls: readonly WaterHull[], world?: WorldQuery, retained: ReadonlySet<string> = new Set()): WaterHull[] {
  const basins = world?.liquidBasins?.(), candidates: { rank: number; hull: WaterHull }[] = [];
  for (const hull of hulls) {
    const radius = Math.hypot(...hull.half);
    if (!Number.isFinite(radius) || radius <= 0 || !hull.centre.every(Number.isFinite)) continue;
    const centre = hull.centre as V3, up = normalize(centre);
    const halfHeight = hull.half.reduce((sum, h, i) => sum + h * Math.abs(dot(hull.axes[i] as V3, up)), 0);
    const basin = basins?.basins[(basins.labels[cellOfDir(basins.n, centre)] ?? 0) - 1];
    const gap = basin ? Math.abs(Math.hypot(...centre) - basin.level) : 0;
    if (basin && gap > halfHeight + 1) continue;
    const volume = 8 * hull.half[0] * hull.half[1] * hull.half[2];
    candidates.push({ hull, rank: (basin ? gap / Math.max(halfHeight, .05) : 10)
      - Math.min(volume, 8) * .1 - (hull.id && retained.has(hull.id) ? .2 : 0) });
  }
  const identity = (a: WaterHull, b: WaterHull) => (a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0;
  return candidates.sort((a, b) => a.rank - b.rank || identity(a.hull, b.hull)).slice(0, WATER_MAX_CHUNK_HULLS)
    .map(c => c.hull).sort(identity);
}
