/** Keep primitive identity through CSG; scalar min/max destroys the cut arrangement. */
import type { Bounds, Expr, Field, MaterialPreference, Scene, Vec3 } from './types';

export const leaf = (id: string): Expr => ({ op: 'leaf', id });
export const union = (left: Expr, right: Expr, materialPreference: MaterialPreference = 'left'): Expr => ({ op: 'union', left, right, materialPreference });
export const intersection = (left: Expr, right: Expr, materialPreference: MaterialPreference = 'left'): Expr => ({ op: 'intersection', left, right, materialPreference });
export const difference = (left: Expr, right: Expr): Expr => ({ op: 'difference', left, right });
export const withMaterial = (child: Expr, material: number): Expr => ({ op: 'material', child, material });

/** Overlap uses the selected operand. Difference always retains the left volume material. */
export function evaluateSigns(scene: Scene, signs: number[]): number {
  const byId = new Map(scene.fields.map((f, i) => [f.id, i]));
  function visit(e: Expr): number {
    if (e.op === 'leaf') {
      const i = byId.get(e.id);
      if (i === undefined) throw new Error(`Unknown field: ${e.id}`);
      return signs[i] <= 0 ? scene.fields[i].material : 0;
    }
    if (e.op === 'material') return visit(e.child) ? e.material : 0;
    const a = visit(e.left), b = visit(e.right);
    if (e.op === 'union') return e.materialPreference === 'right' ? b || a : a || b;
    if (e.op === 'intersection') return a && b ? (e.materialPreference === 'right' ? b : a) : 0;
    return a && !b ? a : 0;
  }
  return visit(scene.expression);
}

export function validateScene(scene: Scene): void {
  const validMaterial = (id: number): void => {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Solid materials must be positive integers.');
  };
  const ids = new Set<string>();
  for (const f of scene.fields) {
    if (!f.id.trim()) throw new Error('Field ids must not be empty.');
    if (ids.has(f.id)) throw new Error(`Duplicate field id: ${f.id}`);
    validMaterial(f.material);
    ids.add(f.id);
  }
  const materials = new Set<number>();
  for (const material of scene.materials) {
    validMaterial(material.id);
    if (materials.has(material.id)) throw new Error(`Duplicate material id: ${material.id}`);
    materials.add(material.id);
  }
  function visit(e: Expr): void {
    if (e.op === 'leaf') {
      if (!ids.has(e.id)) throw new Error(`Unknown field: ${e.id}`);
    } else if (e.op === 'material') {
      validMaterial(e.material); visit(e.child);
    } else {
      if (e.materialPreference !== undefined && e.materialPreference !== 'left' && e.materialPreference !== 'right') throw new Error('Unknown material preference.');
      visit(e.left); visit(e.right);
    }
  }
  visit(scene.expression);
}

export function evaluateScene(scene: Scene, p: Vec3): number {
  return evaluateSigns(scene, scene.fields.map(f => f.sample(p)));
}

// Outward rounding keeps interval pruning from dropping a surface at a box boundary.
const buffer = new ArrayBuffer(8);
const floats = new Float64Array(buffer);
const bits = new BigUint64Array(buffer);
export function nextUp(x: number): number {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  floats[0] = x; bits[0] += x > 0 ? 1n : -1n;
  return floats[0];
}
export const nextDown = (x: number): number => -nextUp(-x);

/** Quadratic sphere field: analytic ranges and a rigorous curvature bound are simple. */
export function sphere(id: string, center: Vec3, radius: number, material = 1): Field {
  if (!(radius > 0) || !Number.isFinite(radius) || center.some(x => !Number.isFinite(x))) throw new Error('Invalid sphere.');
  return {
    id, name: id, material,
    definition: { kind: 'sphere', center: [...center], radius },
    sample: p => (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 + (p[2] - center[2]) ** 2 - radius ** 2,
    gradient: p => p.map((v, i) => 2 * (v - center[i])) as Vec3,
    range: b => {
      let lo = 0, hi = 0;
      for (let i = 0; i < 3; i++) {
        const a = nextDown(b.min[i] - center[i]), z = nextUp(b.max[i] - center[i]);
        const near = a <= 0 && z >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(z));
        const far = Math.max(Math.abs(a), Math.abs(z));
        lo = nextDown(lo + Math.max(0, nextDown(near * near)));
        hi = nextUp(hi + nextUp(far * far));
      }
      return [nextDown(lo - nextUp(radius * radius)), nextUp(hi - nextDown(radius * radius))];
    },
    interpolationError: b => nextUp(b.min.reduce((sum, v, i) => sum + (b.max[i] - v) ** 2 / 4, 0) + 64 * Number.EPSILON * (1 + radius ** 2 + center.reduce((s, v) => s + v * v, 0))),
  };
}

/** Half-space normal dot p <= offset. Use separate planes for exact polyhedral corners. */
export function plane(id: string, normal: Vec3, offset: number, material = 1): Field {
  if (normal.every(v => v === 0) || !Number.isFinite(offset) || normal.some(v => !Number.isFinite(v))) throw new Error('Invalid plane.');
  return {
    id, name: id, material,
    affine: { normal: [...normal], offset },
    definition: { kind: 'affine', normal: [...normal], offset },
    sample: p => normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] - offset,
    gradient: () => [...normal],
    range: b => {
      let lo = 0, hi = 0;
      for (let i = 0; i < 3; i++) {
        const a = normal[i] * b.min[i], z = normal[i] * b.max[i];
        lo = nextDown(lo + nextDown(Math.min(a, z)));
        hi = nextUp(hi + nextUp(Math.max(a, z)));
      }
      return [nextDown(lo - offset), nextUp(hi - offset)];
    },
    interpolationError: b => 32 * Number.EPSILON * (1 + Math.abs(offset) + normal.reduce((s, v, i) => s + Math.abs(v) * Math.max(Math.abs(b.min[i]), Math.abs(b.max[i])), 0)),
  };
}

export function box(id: string, min: Vec3, max: Vec3, material = 1): { fields: Field[]; expression: Expr } {
  if (min.some((v, i) => v >= max[i])) throw new Error('Box must have positive extent.');
  const fields: Field[] = [];
  for (let i = 0; i < 3; i++) {
    const n: Vec3 = [0, 0, 0]; n[i] = 1;
    fields.push(plane(`${id}.${i}+`, n, max[i], material));
    const m: Vec3 = [0, 0, 0]; m[i] = -1;
    fields.push(plane(`${id}.${i}-`, m, -min[i], material));
  }
  return { fields, expression: fields.map(f => leaf(f.id)).reduce((a, b) => intersection(a, b)) };
}

export function fieldRange(field: Field, bounds: Bounds): [number, number] {
  const r = field.range?.(bounds) ?? [-Infinity, Infinity];
  if (Number.isNaN(r[0]) || Number.isNaN(r[1]) || r[0] > r[1]) throw new Error(`Invalid interval from ${field.id}`);
  return r;
}
