/** Bounded liquid approximation for the compatibility solver and visual chunk envelopes. */
import type { V3, Q4 } from './contracts';
import { add, dot, rotate, sub, normalize } from './math';

type Shape = { vertices: Float32Array; offset?: V3 };
export interface LiquidBox { center: V3; half: V3 }
const boxes = new WeakMap<Shape, LiquidBox>();
export function structuralLiquidBox(shape: Shape): LiquidBox {
  const cached = boxes.get(shape); if (cached) return cached;
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < shape.vertices.length; i++) { const a = i % 3, v = shape.vertices[i] + (shape.offset?.[a] ?? 0); lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v); }
  const box = { center: lo.map((v, a) => (v + hi[a]) * .5) as V3, half: lo.map((v, a) => (hi[a] - v) * .5) as V3 };
  boxes.set(shape, box); return box;
}
/** Oriented collider bounds, weighted by occupied volume, against a resting radial surface. */
export function structuralImmersion(shapes: readonly (Shape & { volume: number })[], position: V3, rotation: Q4, center: V3, level: number): number {
  let total = 0, wet = 0;
  const axes = ([ [1, 0, 0], [0, 1, 0], [0, 0, 1] ] as V3[]).map(v => rotate(v, rotation));
  for (const shape of shapes) {
    const box = structuralLiquidBox(shape), p = sub(add(position, rotate(box.center, rotation)), center), up = normalize(p);
    const half = box.half.reduce((sum, h, a) => sum + h * Math.abs(dot(axes[a], up)), 0);
    const fraction = Math.max(0, Math.min(1, (level - Math.hypot(...p) + half) / Math.max(2 * half, 1e-6)));
    total += shape.volume; wet += shape.volume * fraction;
  }
  return total > 0 ? wet / total : 0;
}
