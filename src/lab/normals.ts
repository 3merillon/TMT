import type { Field, FieldDefinition, SurfaceMesh, Vec3 } from '../core/types';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return length > 0 && Number.isFinite(length) ? v.map(x => x / length) as Vec3 : [0, 0, 0];
};

/** Iso-level offsets change density but leave its gradient unchanged. */
export function gradientDefinition(definition: FieldDefinition): Exclude<FieldDefinition, { kind: 'offset' }> {
  while (definition.kind === 'offset') definition = definition.child;
  return definition;
}

export function definitionGradient(definition: FieldDefinition, position: Vec3): Vec3 {
  const source = gradientDefinition(definition);
  if (source.kind === 'affine') return [...source.normal];
  const delta = subtract(position, source.center);
  const gradient = delta.map(v => 2 * v) as Vec3;
  if (source.kind === 'terrain') for (const wave of source.waves) {
    const amplitude = wave.amplitude * Math.cos(dot(wave.k, delta) + wave.phase);
    for (let axis = 0; axis < 3; ++axis) gradient[axis] += amplitude * wave.k[axis];
  }
  return gradient;
}

export interface SurfaceNormals {
  /** Nonindexed corner attributes. Geometry and volume material labels are untouched. */
  normals: number[];
  sourceIndices: number[];
  orientations: number[];
  definitions: FieldDefinition[];
}

/** Smooth each source separately and orient it once per edge-connected patch.
 * A local analytic gradient can oppose an underresolved triangle; choosing its sign
 * per triangle would introduce a discontinuity on an otherwise continuous source.
 */
export function buildSurfaceNormals(mesh: SurfaceMesh, fields: readonly Field[], smooth: boolean): SurfaceNormals {
  const bySource = new Map(fields.map(field => [field.id, field]));
  const definitions: FieldDefinition[] = [];
  const sourceIndex = new Map<string, number>();
  for (const source of new Set(mesh.faceSources)) {
    const definition = bySource.get(source)?.definition;
    if (definition) { sourceIndex.set(source, definitions.length); definitions.push(definition); }
  }
  const weighted = mesh.triangles.map(([a, b, c]) => cross(subtract(mesh.positions[b], mesh.positions[a]), subtract(mesh.positions[c], mesh.positions[a])));
  const faceNormals = weighted.map(unit);
  const parents = mesh.triangles.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; }
    return i;
  };
  const edges = new Map<string, number>();
  mesh.triangles.forEach((triangle, face) => {
    for (let corner = 0; corner < 3; ++corner) {
      const a = triangle[corner], b = triangle[(corner + 1) % 3];
      const key = JSON.stringify([mesh.faceSources[face], Math.min(a, b), Math.max(a, b)]);
      const previous = edges.get(key);
      if (previous === undefined) edges.set(key, face);
      else parents[root(face)] = root(previous);
    }
  });
  const evidence = new Map<number, number>();
  const sums = new Map<string, Vec3>();
  const cornerKey = (face: number, vertex: number) => `${root(face)}/${vertex}/${mesh.faceMaterials[face]}`;
  mesh.triangles.forEach((triangle, face) => {
    const field = bySource.get(mesh.faceSources[face]);
    const center = [0, 1, 2].map(axis => triangle.reduce((sum, id) => sum + mesh.positions[id][axis] / 3, 0)) as Vec3;
    const gradient = field?.gradient?.(center) ?? (field?.definition ? definitionGradient(field.definition, center) : undefined);
    if (gradient?.every(Number.isFinite)) evidence.set(root(face), (evidence.get(root(face)) ?? 0) + dot(weighted[face], unit(gradient)));
    for (const id of triangle) {
      const key = cornerKey(face, id), sum = sums.get(key) ?? [0, 0, 0];
      for (let axis = 0; axis < 3; ++axis) sum[axis] += weighted[face][axis];
      sums.set(key, sum);
    }
  });
  const normals: number[] = [], sourceIndices: number[] = [], orientations: number[] = [];
  const cache = new Map<string, Vec3>();
  mesh.triangles.forEach((triangle, face) => {
    const field = bySource.get(mesh.faceSources[face]);
    const orientation = (evidence.get(root(face)) ?? 0) < 0 ? -1 : 1;
    for (const id of triangle) {
      let normal = faceNormals[face];
      if (smooth && field) {
        const key = cornerKey(face, id);
        let cached = cache.get(key);
        if (!cached) {
          const gradient = field.gradient?.(mesh.positions[id]) ?? (field.definition ? definitionGradient(field.definition, mesh.positions[id]) : undefined);
          cached = gradient?.every(Number.isFinite) && Math.hypot(...gradient) > 0
            ? unit(gradient).map(v => v * orientation) as Vec3 : unit(sums.get(key)!);
          cache.set(key, cached);
        }
        normal = cached;
      }
      normals.push(...normal);
      sourceIndices.push(smooth ? sourceIndex.get(mesh.faceSources[face]) ?? -1 : -1);
      orientations.push(orientation);
    }
  });
  return { normals, sourceIndices, orientations, definitions };
}
