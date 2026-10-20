/** Serializable CSG structures. Collection size is limited by resources, never a global slot count. */
import { box, plane, intersection, leaf } from '../core/fields';
import type { Bounds, Expr, Field, Vec3 } from '../core/types';
import { createPlanetSampler, type PlanetType } from './planet-field';
import { TERRAIN_BOUND } from './terrain-config';

export interface TerrainStructure {
  id: string;
  center: Vec3;
  halfSize: Vec3;
  /** Orthonormal local x/y/z axes in planet coordinates. Omit for axis-aligned structures. */
  axes?: [Vec3, Vec3, Vec3];
  material: 1 | 2 | 3;
  /** Exact authored corners for axis-aligned boxes; avoids cancellation when reconstructing corners. */
  bounds?: Bounds;
}
export const validateStructures = (input: unknown): TerrainStructure[] => {
  if (!Array.isArray(input)) throw new Error('Invalid terrain structures.');
  const ids = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid terrain structure.');
    const s = raw as TerrainStructure;
    const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));
    if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id) || ids.has(s.id)
      || !vector(s.center) || !vector(s.halfSize) || s.halfSize.some(v => v <= 0)
      || ![1, 2, 3].includes(s.material)) throw new Error('Invalid or duplicate terrain structure.');
    ids.add(s.id);
    if (s.bounds && (s.axes || !vector(s.bounds.min) || !vector(s.bounds.max)
      || s.bounds.min.some((v, a) => v >= s.bounds!.max[a] || v <= -TERRAIN_BOUND || s.bounds!.max[a] >= TERRAIN_BOUND
        || Math.abs(v - (s.center[a] - s.halfSize[a])) > 1e-10
        || Math.abs(s.bounds!.max[a] - (s.center[a] + s.halfSize[a])) > 1e-10))) throw new Error('Invalid structure bounds.');
    let axes: TerrainStructure['axes'];
    if (s.axes !== undefined) {
      if (!Array.isArray(s.axes) || s.axes.length !== 3 || !s.axes.every(vector)) throw new Error('Invalid structure axes.');
      axes = s.axes.map(a => [...a]) as [Vec3, Vec3, Vec3];
      for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) {
        const dot = axes[a].reduce((sum, v, i) => sum + v * axes![b][i], 0);
        if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-8) throw new Error('Structure axes must be orthonormal.');
      }
    }
    const extent = s.halfSize.map((_, a) => axes ? axes.reduce((sum, axis, i) => sum + Math.abs(axis[a]) * s.halfSize[i], 0) : s.halfSize[a]);
    if (extent.some((v, a) => Math.abs(s.center[a]) + v + (axes ? 1e-6 : 0) >= TERRAIN_BOUND)) throw new Error('Structure exceeds the terrain domain.');
    return { id: s.id, center: [...s.center], halfSize: [...s.halfSize], material: s.material, ...(axes ? { axes } : {}),
      ...(s.bounds ? { bounds: { min: [...s.bounds.min] as Vec3, max: [...s.bounds.max] as Vec3 } } : {}) };
  });
};

export function structureVolume(structure: TerrainStructure): { fields: Field[]; expression: Expr; bounds: Bounds } {
  const { id, center, halfSize, axes, material } = structure;
  const extent = halfSize.map((_, a) => axes ? axes.reduce((sum, axis, i) => sum + Math.abs(axis[a]) * halfSize[i], 0) : halfSize[a]);
  const bounds: Bounds = structure.bounds ?? { min: center.map((v, a) => v - extent[a]) as Vec3, max: center.map((v, a) => v + extent[a]) as Vec3 };
  if (!axes) return { ...box(`structure.${id}`, bounds.min, bounds.max, material), bounds };
  // The admitted basis error is <= 1e-8 on a domain of radius 24. Enclose that
  // error and offset rounding in the finite-support index, never in the geometry.
  bounds.min = bounds.min.map(v => v - 1e-6) as Vec3;
  bounds.max = bounds.max.map(v => v + 1e-6) as Vec3;
  const fields = axes.flatMap((axis, a) => [-1, 1].map(sign => {
    const normal = axis.map(v => v * sign) as Vec3;
    return plane(`structure.${id}.${a}.${sign}`, normal, normal.reduce((sum, v, i) => sum + v * center[i], 0) + halfSize[a], material);
  }));
  return { fields, expression: fields.map(f => leaf(f.id)).reduce((a, b) => intersection(a, b)), bounds };
}

export function generatePlanetStructures(seed: number, count = 36 + (seed >>> 0) % 13, spherical = false, kind?: PlanetType): TerrainStructure[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid structure count.');
  const sample = createPlanetSampler(seed, spherical, kind);
  let state = seed >>> 0;
  const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const structures: TerrainStructure[] = [];
  const normalize = (v: Vec3): Vec3 => { const r = Math.hypot(...v); return v.map(x => x / r) as Vec3; };
  const clusters = Math.ceil(count / 6), rotation = random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    // Six irregular blocks around each settlement, with a central street. Latitude
    // and longitude cover the entire body; the north-pole tank spawn stays clear.
    const cluster = Math.floor(i / 6), block = i % 6;
    const y = .82 - 1.64 * cluster / Math.max(1, clusters - 1);
    const theta = rotation + cluster * 2.399963229728653;
    const anchor: Vec3 = [Math.cos(theta) * Math.sqrt(1 - y * y), y, Math.sin(theta) * Math.sqrt(1 - y * y)];
    const east: Vec3 = [-Math.sin(theta), 0, Math.cos(theta)];
    const north: Vec3 = [-y * Math.cos(theta), Math.sqrt(1 - y * y), -y * Math.sin(theta)];
    const u = (block % 3 - 1) * 3.1 + (random() - .5) * .5;
    const v = (block < 3 ? -1 : 1) * 2.0 + (random() - .5) * .4;
    const up = normalize(anchor.map((a, j) => a * 18 + east[j] * u + north[j] * v) as Vec3);
    // A settlement shares its street frame. Besides intentional alignment, parallel
    // construction planes avoid a quadratic web of almost-parallel exact CSG cuts.
    const x = east, z = north;
    const radius = sample(up).radius;
    // Warehouses, towers and squat bunkers share destructible oriented CSG boxes.
    const style = Math.floor(random() * 3);
    const halfSize: Vec3 = [style === 0 ? 1.15 : .65 + random() * .3,
      style === 1 ? 1.9 + random() * .5 : 1.1 + random() * .45, .65 + random() * .35];
    let center: Vec3;
    for (;;) {
      center = up.map((v, a) => v * (radius - 1.3) + anchor[a] * halfSize[1]) as Vec3;
      const fits = center.every((v, a) => Math.abs(v) + Math.abs(x[a]) * halfSize[0]
        + Math.abs(anchor[a]) * halfSize[1] + Math.abs(z[a]) * halfSize[2] < TERRAIN_BOUND - .05);
      if (fits) break;
      halfSize[1] *= .9;
    }
    structures.push({ id: `settlement-${cluster}-building-${block}`, center,
      halfSize, axes: [x, anchor, z], material: 3 });
  }
  return validateStructures(structures);
}
