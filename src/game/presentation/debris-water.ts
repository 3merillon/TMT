import type { WaterHull } from '../../engine/passes/fluids/water';
import type { V3 } from '../contracts';
import { add, rotate } from '../math';
import { structuralLiquidBox, type LiquidBox } from '../structural-liquid';
import type { RigidShard } from './debris-dynamics';

const bounds = new WeakMap<Float32Array, LiquidBox>();
/** Use the actual mesh extent, not the deliberately smaller collision/splash radius.
 * Geometry stays cached while worker poses change; IDs survive reordered frame results. */
export function debrisWaterHulls(pieces: readonly (RigidShard & { id: number })[]): WaterHull[] {
  return pieces.map(p => {
    let box = bounds.get(p.positions);
    if (!box) { box = structuralLiquidBox({ vertices: p.positions }); bounds.set(p.positions, box); }
    return { id: `debris:${p.id}`, centre: add(p.body.position, rotate(box.center, p.rotation)), half: box.half,
      axes: ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]).map(v => rotate(v, p.rotation)) };
  });
}
