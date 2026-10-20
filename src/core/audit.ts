/** Topology is measured on shared mesh indices, never on tolerance-welded coordinates. */
import type { MeshAudit, SurfaceMesh, Vec3 } from './types';
export function auditMesh(mesh: SurfaceMesh): MeshAudit {
  const edges = new Map<string, { count: number; direction: number; faces: number[] }>();
  const used = new Set<number>(), seen = new Set<string>();
  const links = new Map<number, [number, number][]>();
  const faceNeighbors = mesh.triangles.map(() => new Set<number>());
  let degenerateTriangles = 0, duplicateTriangles = 0, signedVolume = 0, volumeCorrection = 0;
  const sub = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v - b[i]) as Vec3;
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const origin: Vec3 = mesh.triangles.length ? mesh.positions[mesh.triangles[0][0]] : [0, 0, 0];
  mesh.triangles.forEach((triangle, face) => {
    const key = [...triangle].sort((a, b) => a - b).join(',');
    if (seen.has(key)) duplicateTriangles++; seen.add(key);
    const points = triangle.map(i => mesh.positions[i]);
    if (points.some(p => !p || !p.every(Number.isFinite))) throw new Error('Invalid triangle vertex.');
    const [a, b, c] = points;
    if (new Set(triangle).size < 3 || cross(sub(b, a), sub(c, a)).every(v => v === 0)) degenerateTriangles++;
    const value = dot(sub(a, origin), cross(sub(b, origin), sub(c, origin))) / 6 - volumeCorrection;
    const next = signedVolume + value; volumeCorrection = (next - signedVolume) - value; signedVolume = next;
    for (let j = 0; j < 3; j++) {
      const u = triangle[j], v = triangle[(j + 1) % 3], w = triangle[(j + 2) % 3]; used.add(u);
      const ekey = u < v ? `${u},${v}` : `${v},${u}`;
      const edge = edges.get(ekey) ?? { count: 0, direction: 0, faces: [] };
      edge.count++; edge.direction += u < v ? 1 : -1; edge.faces.push(face); edges.set(ekey, edge);
      const list = links.get(u) ?? []; list.push([v, w]); links.set(u, list);
    }
  });
  let boundaryEdges = 0, nonManifoldEdges = 0, orientationErrors = 0, nonManifoldVertices = 0;
  for (const e of edges.values()) {
    if (e.count === 1) boundaryEdges++;
    if (e.count > 2) nonManifoldEdges++;
    if (e.count === 2 && e.direction !== 0) orientationErrors++;
    for (const a of e.faces) for (const b of e.faces) if (a !== b) faceNeighbors[a].add(b);
  }
  for (const pairs of links.values()) {
    const adjacency = new Map<number, number[]>();
    for (const [a, b] of pairs) {
      adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
      adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
    }
    const visited = new Set<number>(), stack = [adjacency.keys().next().value!];
    while (stack.length) { const v = stack.pop()!; if (visited.has(v)) continue; visited.add(v); stack.push(...adjacency.get(v)!); }
    if (visited.size !== adjacency.size || [...adjacency.values()].some(n => n.length !== 2)) nonManifoldVertices++;
  }
  let components = 0;
  const visited = new Set<number>();
  for (let face = 0; face < mesh.triangles.length; face++) {
    if (visited.has(face)) continue;
    components++; const stack = [face];
    while (stack.length) { const f = stack.pop()!; if (visited.has(f)) continue; visited.add(f); stack.push(...faceNeighbors[f]); }
  }
  return {
    vertices: used.size, triangles: mesh.triangles.length, edges: edges.size, boundaryEdges,
    nonManifoldEdges, orientationErrors, degenerateTriangles, duplicateTriangles, nonManifoldVertices,
    components, eulerCharacteristic: used.size - edges.size + mesh.triangles.length, signedVolume,
    valid: boundaryEdges + nonManifoldEdges + orientationErrors + degenerateTriangles + duplicateTriangles + nonManifoldVertices === 0,
  };
}
