import type { Field, Scene, SurfaceMesh, TetMesh } from './types';
import { validateScene } from './fields';
import { compileMaterialEvaluator } from './evaluator';
import { type Rational, type Exact3, ZERO, ONE, rational, fromNumber, exact3, number3, pointKey,
  add, sub, mul, div, neg, sign, compare, vadd, vsub, scale, dot, cross, gcd } from './exact';

type Homogeneous = [bigint, bigint, bigint, bigint];
interface Vertex { p: Exact3; key: string; homogeneous?: Homogeneous }
interface Face { vertices: Vertex[]; source: number }
interface Cell { faces: Face[]; signs: number[] }
interface Plane { n: Exact3; d: Rational; source: number; coefficients?: Homogeneous }
interface LabeledFace extends Face { material: number }
interface GridGeometry { points: Vertex[]; min: Exact3; max: Exact3; orientations: number[] }

const vertex = (p: Exact3): Vertex => ({ p, key: pointKey(p) });
const lcm = (a: bigint, b: bigint): bigint => a === b ? a : (a / gcd(a, b)) * b;
/** Positive common denominator; cached exact coordinates are never rounded. */
function homogeneous(v: Vertex): Homogeneous {
  if (v.homogeneous) return v.homogeneous;
  const d = lcm(lcm(v.p[0].d, v.p[1].d), v.p[2].d);
  return v.homogeneous = [v.p[0].n * (d / v.p[0].d), v.p[1].n * (d / v.p[1].d), v.p[2].n * (d / v.p[2].d), d];
}
/** Clear positive denominators once per plane, so predicates require only integer arithmetic. */
function integerCoefficients(plane: Plane): Homogeneous {
  if (plane.coefficients) return plane.coefficients;
  const q = [...plane.n, plane.d], d = q.reduce((d, x) => lcm(d, x.d), 1n);
  const coefficients = q.map(x => x.n * (d / x.d)) as Homogeneous;
  const factor = coefficients.reduce((g, x) => gcd(g, x), 0n);
  return plane.coefficients = factor > 1n ? coefficients.map(x => x / factor) as Homogeneous : coefficients;
}
const atNumerator = (plane: Plane, v: Vertex): bigint => {
  const c = integerCoefficients(plane), h = homogeneous(v);
  return c[0] * h[0] + c[1] * h[1] + c[2] * h[2] + c[3] * h[3];
};
const unique = (vertices: Vertex[]): Vertex[] => [...new Map(vertices.map(v => [v.key, v])).values()];
function domainFace(vertices: Vertex[], geometry: GridGeometry): boolean {
  return [0, 1, 2].some(axis => vertices.every(v => compare(v.p[axis], geometry.min[axis]) === 0) || vertices.every(v => compare(v.p[axis], geometry.max[axis]) === 0));
}

/** The extraction domain is a box tiled by tetrahedra, as produced by the octree. */
function validateGrid(grid: TetMesh): GridGeometry {
  if (!grid.vertices.length || !grid.tets.length) throw new Error('The tetrahedral domain must be a nonempty box');
  if (grid.vertices.some(p => p.length !== 3 || !p.every(Number.isFinite))) throw new Error('Invalid input vertex coordinates');
  let points: Vertex[];
  if (grid.lattice) {
    const lattice = grid.lattice;
    if (lattice.vertices.length !== grid.vertices.length || !Number.isFinite(lattice.resolution) || lattice.resolution <= 0) throw new Error('Invalid authoritative lattice geometry');
    const lo = exact3(lattice.bounds.min), span = vsub(exact3(lattice.bounds.max), lo), resolution = fromNumber(lattice.resolution);
    points = lattice.vertices.map(p => vertex(p.map((v, a) => add(lo[a], mul(div(fromNumber(v), resolution), span[a]))) as Exact3));
  } else points = grid.vertices.map(p => vertex(exact3(p)));
  if (new Set(points.map(p => p.key)).size !== points.length) throw new Error('Duplicate input vertex coordinates: use shared vertex indices');
  const min = grid.lattice ? exact3(grid.lattice.bounds.min) : exact3([0, 1, 2].map(a => grid.vertices.reduce((v, p) => Math.min(v, p[a]), Infinity)));
  const max = grid.lattice ? exact3(grid.lattice.bounds.max) : exact3([0, 1, 2].map(a => grid.vertices.reduce((v, p) => Math.max(v, p[a]), -Infinity)));
  const geometry: GridGeometry = { points, min, max, orientations: [] };
  if ([0, 1, 2].some(a => compare(min[a], max[a]) >= 0)) throw new Error('The tetrahedral domain must have positive extent');
  const facets = new Map<string, { vertices: Vertex[]; owners: number; side: number }>();
  for (const tet of grid.tets) {
    if (tet.length !== 4 || new Set(tet).size !== 4 || tet.some(i => !Number.isInteger(i) || i < 0 || i >= points.length)) throw new Error('Invalid tetrahedron indices');
    const p = tet.map(i => points[i].p);
    const orientation = sign(dot(vsub(p[1], p[0]), cross(vsub(p[2], p[0]), vsub(p[3], p[0]))));
    if (!orientation) throw new Error('Degenerate input tetrahedron');
    geometry.orientations.push(orientation);
    for (let opposite = 0; opposite < 4; opposite++) {
      const ids = tet.filter((_, i) => i !== opposite).sort((a, b) => a - b);
      const permutation = [...ids, tet[opposite]].map(id => tet.indexOf(id));
      let inversions = 0;
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) if (permutation[a] > permutation[b]) inversions++;
      const side = orientation * (inversions % 2 ? -1 : 1), key = ids.join(',');
      const previous = facets.get(key);
      if (previous) {
        previous.owners++;
        if (previous.owners > 2 || previous.side === side) throw new Error('Overlapping or non-manifold tetrahedron facet ownership');
      } else facets.set(key, { vertices: ids.map(i => points[i]), owners: 1, side });
    }
  }
  for (const face of facets.values()) if (face.owners === 1 && !domainFace(face.vertices, geometry)) {
    throw new Error('Unmatched interior tetrahedron facet: the grid is not a conforming box domain');
  }
  return geometry;
}
function hasArea(vertices: Vertex[]): boolean {
  if (vertices.length < 3) return false;
  const a = homogeneous(vertices[0]);
  for (let i = 1; i + 1 < vertices.length; i++) {
    const b = homogeneous(vertices[i]), c = homogeneous(vertices[i + 1]);
    // Positive denominators cannot change whether these cross products vanish.
    const x = [0, 1, 2].map(axis => b[axis] * a[3] - a[axis] * b[3]);
    const y = [0, 1, 2].map(axis => c[axis] * a[3] - a[axis] * c[3]);
    if (x[0] * y[1] !== x[1] * y[0] || x[1] * y[2] !== x[2] * y[1] || x[2] * y[0] !== x[0] * y[2]) return true;
  }
  return false;
}
function centroid(vertices: Vertex[]): Exact3 {
  return scale(vertices.reduce<Exact3>((sum, v) => vadd(sum, v.p), [ZERO, ZERO, ZERO]), rational(1n, BigInt(vertices.length)));
}

/** Deterministic cyclic sort on a plane, using only exact signs. */
function orderCap(vertices: Vertex[], normal: Exact3): Vertex[] {
  const points = unique(vertices), center = centroid(points);
  const drop = normal.findIndex(x => x.n !== 0n);
  if (drop < 0) throw new Error('Cannot sort a cap with zero normal');
  const u = (drop + 1) % 3, v = (drop + 2) % 3;
  const ch = homogeneous(vertex(center));
  // Cache unnormalized projected offsets. Sorting needs signs and comparisons,
  // so repeatedly reducing their rational coordinates adds no information.
  const offsets = new Map(points.map(point => {
    const h = homogeneous(point);
    return [point, [h[u] * ch[3] - ch[u] * h[3], h[v] * ch[3] - ch[v] * h[3], h[3]] as const];
  }));
  const half = (p: readonly bigint[]): number => p[1] > 0n || (p[1] === 0n && p[0] >= 0n) ? 0 : 1;
  points.sort((a, b) => {
    const pa = offsets.get(a)!, pb = offsets.get(b)!;
    const ha = half(pa), hb = half(pb);
    if (ha !== hb) return ha - hb;
    const turn = pa[0] * pb[1] - pa[1] * pb[0];
    if (turn) return turn < 0n ? 1 : -1;
    const distance = (pa[0] * pa[0] + pa[1] * pa[1]) * pb[2] * pb[2] - (pb[0] * pb[0] + pb[1] * pb[1]) * pa[2] * pa[2];
    return distance < 0n ? -1 : distance > 0n ? 1 : 0;
  });
  if (sign(normal[drop]) < 0) points.reverse();
  return points;
}

function splitCell(cell: Cell, plane: Plane, values: Map<string, bigint>): Cell[] {
  const all = unique(cell.faces.flatMap(f => f.vertices));
  let negative = false, positive = false;
  for (const v of all) {
    let value = values.get(v.key);
    if (value === undefined) { value = atNumerator(plane, v); values.set(v.key, value); }
    negative ||= value < 0n; positive ||= value > 0n;
  }
  if (!negative || !positive) {
    // A zero plateau occupies the whole cell under the declared closed-set convention.
    cell.signs[plane.source] = negative ? -1 : positive ? 1 : 0;
    return [cell];
  }
  const caps: Vertex[] = [], crossing = new Map<string, Vertex>();
  function edgeIntersection(a: Vertex, b: Vertex, fa: bigint, fb: bigint): Vertex {
    const edge = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    let result = crossing.get(edge);
    if (!result) {
      // Homogeneous line-plane meet. The two evaluations share one plane scale;
      // vertex denominators are retained explicitly, so no intermediate GCD is needed.
      const ha = homogeneous(a), hb = homogeneous(b), d = fa * hb[3] - fb * ha[3];
      result = vertex([0, 1, 2].map(i => rational(fa * hb[i] - fb * ha[i], d)) as Exact3);
      crossing.set(edge, result);
    }
    return result;
  }
  const sides: Cell[] = [-1, 1].map(side => ({ faces: [], signs: [...cell.signs] }));
  for (const face of cell.faces) {
    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
      const side = sideIndex === 0 ? -1 : 1, clipped: Vertex[] = [];
      for (let i = 0; i < face.vertices.length; i++) {
        const a = face.vertices[i], b = face.vertices[(i + 1) % face.vertices.length];
        const fa = values.get(a.key)!, fb = values.get(b.key)!;
        const sa = fa < 0n ? -1 : fa > 0n ? 1 : 0, sb = fb < 0n ? -1 : fb > 0n ? 1 : 0;
        if (sa * side >= 0) clipped.push(a);
        if (sa === 0) caps.push(a);
        if (sa * sb < 0) {
          const c = edgeIntersection(a, b, fa, fb); clipped.push(c); caps.push(c);
        }
      }
      const polygon = unique(clipped);
      if (hasArea(polygon)) sides[sideIndex].faces.push({ vertices: polygon, source: face.source });
    }
  }
  const cap = orderCap(caps, plane.n);
  if (!hasArea(cap)) throw new Error('A strict volume split produced a degenerate cap');
  sides[0].faces.push({ vertices: cap, source: plane.source });
  sides[1].faces.push({ vertices: [...cap].reverse(), source: plane.source });
  sides[0].signs[plane.source] = -1; sides[1].signs[plane.source] = 1;
  return sides;
}

function planeBasis(points: Vertex[]) {
  const a = vsub(points[1].p, points[0].p), b = vsub(points[2].p, points[0].p), c = vsub(points[3].p, points[0].p);
  const bc = cross(b, c), ca = cross(c, a), ab = cross(a, b), det = dot(a, bc);
  if (!sign(det)) throw new Error('Degenerate input tetrahedron');
  return { bc, ca, ab, det };
}
function makePlane(points: Vertex[], samples: Rational[], source: number, basis: ReturnType<typeof planeBasis>): Plane {
  const { bc, ca, ab, det } = basis;
  let n = vadd(vadd(scale(bc, sub(samples[1], samples[0])), scale(ca, sub(samples[2], samples[0]))), scale(ab, sub(samples[3], samples[0])));
  let d = sub(mul(samples[0], det), dot(n, points[0].p));
  if (sign(det) < 0) { n = scale(n, neg(ONE)); d = neg(d); }
  return { n, d, source };
}
function tetrahedron(points: Vertex[], signs: number[], facetSources: number[], orientation: number): Cell {
  const faces: Face[] = [];
  for (let opposite = 0; opposite < 4; opposite++) {
    const vertices = points.filter((_, i) => i !== opposite);
    // The validated tetrahedron orientation determines all four outward windings.
    if (orientation * (opposite % 2 ? 1 : -1) > 0) vertices.reverse();
    faces.push({ vertices, source: facetSources[opposite] });
  }
  return { faces, signs };
}

/**
 * Exact boundary of the Boolean expression over per-primitive piecewise affine fields.
 * No epsilon classification, coordinate tolerance welding, or perturbation is used.
 * The final conversion to floating point is for rendering; it is not a geometric certificate.
 */
export function meshArrangement(grid: TetMesh, scene: Scene): SurfaceMesh {
  return meshArrangementMany(grid, [scene])[0];
}

function sampleExactly(field: Field, grid: TetMesh, geometry: GridGeometry): Rational[] {
  if (field.affine) {
    const normal = exact3(field.affine.normal), offset = fromNumber(field.affine.offset);
    return geometry.points.map(v => sub(dot(normal, v.p), offset));
  }
  return grid.vertices.map(p => fromNumber(field.sample(p)));
}

/** One exact arrangement is shared by all requested Boolean/material labelings. */
export function meshArrangementMany(grid: TetMesh, scenes: Scene[]): SurfaceMesh[] {
  if (!scenes.length) return [];
  const started = performance.now();
  const fields = scenes[0].fields;
  for (const scene of scenes) {
    validateScene(scene);
    if (scene.fields.length !== fields.length || scene.fields.some((field, i) => field.id !== fields[i].id || field.sample !== fields[i].sample ||
      JSON.stringify(field.affine) !== JSON.stringify(fields[i].affine))) {
      throw new Error('Paired extraction requires the same ordered primitive fields and sampler functions');
    }
  }
  const geometry = validateGrid(grid);
  const validated = performance.now();
  const samples = fields.map(field => sampleExactly(field, grid, geometry));
  const sampled = performance.now();
  const points = geometry.points;
  const evaluators = scenes.map(compileMaterialEvaluator);
  const pending = new Map<string, { face: Face; materials: number[] }>();
  const outputs = scenes.map(() => ({ boundary: [] as LabeledFace[], interfaces: [] as { a: LabeledFace; b: LabeledFace }[], domainBoundaryPolygons: 0 }));
  const affinePlanes = fields.map((field, source): Plane | undefined => field.affine
    ? { n: exact3(field.affine.normal), d: neg(fromNumber(field.affine.offset)), source } : undefined);
  let cells = 0, maxRegions = 0, pairedFaces = 0, constructedPlanes = 0, uniformFieldTets = 0;

  for (let tetIndex = 0; tetIndex < grid.tets.length; tetIndex++) {
    const tet = grid.tets[tetIndex];
    const p = tet.map(i => points[i]);
    const signs = Array<number>(fields.length).fill(0), facetSources = [-1, -1, -1, -1];
    const planes: Plane[] = [];
    let basis: ReturnType<typeof planeBasis> | undefined;
    for (let source = 0; source < fields.length; source++) {
      const values = tet.map(i => samples[source][i]);
      const localSigns = values.map(sign);
      const negative = localSigns.some(s => s < 0), positive = localSigns.some(s => s > 0);
      // For an affine function, one-sided vertex values imply no interior volume split.
      signs[source] = negative ? -1 : positive ? 1 : 0;
      if (negative && positive) {
        planes.push(affinePlanes[source] ?? makePlane(p, values, source, basis ??= planeBasis(p)));
        constructedPlanes++;
      } else uniformFieldTets++;
      // A nonzero affine restriction coincides with a tetrahedron face iff its three
      // original samples are zero. Clipping cannot create a different area-bearing
      // coincident plane on that face. Retain the earliest primitive's provenance.
      if (negative || positive) for (let opposite = 0; opposite < 4; opposite++) {
        if (facetSources[opposite] < 0 && localSigns.every((s, i) => i === opposite || s === 0)) facetSources[opposite] = source;
      }
    }
    let regions = [tetrahedron(p, signs, facetSources, geometry.orientations[tetIndex])];
    for (const plane of planes) {
      const values = new Map<string, bigint>();
      regions = regions.flatMap(cell => splitCell(cell, plane, values));
    }
    cells += regions.length; maxRegions = Math.max(maxRegions, regions.length);
    for (const cell of regions) {
      const materials = evaluators.map(evaluate => evaluate(cell.signs));
      for (const face of cell.faces) {
        const key = face.vertices.map(v => v.key).sort().join('|');
        const previous = pending.get(key);
        if (!previous) pending.set(key, { face, materials });
        else {
          pending.delete(key); pairedFaces++;
          for (let i = 0; i < scenes.length; i++) {
            const a = previous.materials[i], b = materials[i];
            if (a === b) continue;
            if (!a) outputs[i].boundary.push({ ...face, material: b });
            else if (!b) outputs[i].boundary.push({ ...previous.face, material: a });
            else outputs[i].interfaces.push({ a: { ...previous.face, material: a }, b: { ...face, material: b } });
          }
        }
      }
    }
  }
  // Unpaired solid faces occur only on the domain boundary for a conforming grid.
  for (const { face, materials } of pending.values()) {
    if (!domainFace(face.vertices, geometry)) throw new Error('Unmatched interior arrangement polygon: inconsistent neighboring partitions');
    for (let i = 0; i < scenes.length; i++) if (materials[i]) {
      outputs[i].boundary.push({ ...face, material: materials[i] }); outputs[i].domainBoundaryPolygons++;
    }
  }
  const partitioned = performance.now();
  const sharedStats = { tetrahedra: grid.tets.length, regions: cells, maxRegionsPerTet: maxRegions, pairedFaces,
    constructedPlanes, uniformFieldTets, arrangementPasses: 1, outputCount: scenes.length,
    validationMilliseconds: validated - started, samplingMilliseconds: sampled - validated, partitionMilliseconds: partitioned - sampled };
  return outputs.map(({ boundary, interfaces, domainBoundaryPolygons }, i) => {
    const outputStart = performance.now();
    const output = emitMesh(boundary, interfaces, scenes[i]);
    output.stats = { ...sharedStats, boundaryPolygons: boundary.length, domainBoundaryPolygons, unexpectedUnpairedFaces: 0,
      interfaces: interfaces.length, vertices: output.positions.length, triangles: output.triangles.length,
      outputMilliseconds: performance.now() - outputStart, milliseconds: performance.now() - started };
    return output;
  });
}

function emitMesh(boundary: LabeledFace[], interfaces: { a: LabeledFace; b: LabeledFace }[], scene: Scene): SurfaceMesh {
  const output: SurfaceMesh = { positions: [], exactPositionKeys: [], triangles: [], faceMaterials: [], faceSourceMaterials: [], faceSources: [], faceOtherMaterials: [], interfaces: [], stats: {} };
  const ids = new Map<string, number>(), rounded = new Map<string, string>();
  function index(v: Vertex): number {
    const old = ids.get(v.key); if (old !== undefined) return old;
    const p = number3(v.p), roundedKey = p.join(',');
    if (!p.every(Number.isFinite)) throw new Error('Exact geometry cannot be represented as finite rendering coordinates');
    const prior = rounded.get(roundedKey);
    if (prior !== undefined && prior !== v.key) throw new Error('Distinct exact vertices collapse in floating-point output; rescale the model');
    const id = output.positions.length; ids.set(v.key, id); rounded.set(roundedKey, v.key); output.positions.push(p); output.exactPositionKeys!.push(v.key); return id;
  }
  for (const face of boundary) {
    const vertices = face.vertices;
    const indices = vertices.map(index);
    const center = index(vertex(centroid(vertices)));
    const source = face.source >= 0 ? scene.fields[face.source] : undefined;
    for (let i = 0; i < indices.length; i++) {
      output.triangles.push([center, indices[i], indices[(i + 1) % indices.length]]);
      output.faceMaterials.push(face.material);
      output.faceSourceMaterials.push(source?.material ?? face.material);
      output.faceSources.push(source?.id ?? '__domain__');
      output.faceOtherMaterials!.push(0);
    }
  }
  for (const { a, b } of interfaces) output.interfaces!.push({ vertices: a.vertices.map(index), materials: [a.material, b.material], source: a.source >= 0 ? scene.fields[a.source].id : '__grid__' });
  return output;
}
