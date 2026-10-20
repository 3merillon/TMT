/** A closed, bumpy, radius-18 planet (icosphere, 20480 triangles) for the debris tests: as one collision world, and
 * as collision pages of `cell`-unit bricks keyed like the resident lattice. */
import { TerrainCollision } from '../../src/game/terrain-collision';
import type { V3, WorldQuery } from '../../src/game/contracts';

export function bumpyPlanet(cell: number) {
  const t = (1 + Math.sqrt(5)) / 2;
  let vertices: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let level = 0; level < 5; level++) {
    const cache = new Map<string, number>(), next: number[][] = [];
    const mid = (a: number, b: number) => { const k = a < b ? `${a},${b}` : `${b},${a}`; let i = cache.get(k); if (i === undefined) { i = vertices.length; vertices.push(vertices[a].map((v, j) => (v + vertices[b][j]) / 2)); cache.set(k, i); } return i; };
    for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    faces = next;
  }
  vertices = vertices.map(v => { const l = Math.hypot(...v), u = v.map(x => x / l), h = 18 + .35 * Math.sin(u[0] * 9) * Math.cos(u[2] * 7) + .2 * Math.sin(u[1] * 13 + u[0] * 5); return u.map(x => x * h); });
  const pages = new Map<string, { positions: number[]; indices: number[]; map: Map<number, number> }>();
  for (const f of faces) {
    const key = [0, 1, 2].map(a => Math.floor((vertices[f[0]][a] + vertices[f[1]][a] + vertices[f[2]][a]) / 3 / cell)).join(',');
    let page = pages.get(key); if (!page) pages.set(key, page = { positions: [], indices: [], map: new Map() });
    for (const v of f) { let i = page.map.get(v); if (i === undefined) { i = page.map.size; page.map.set(v, i); page.positions.push(...vertices[v]); } page.indices.push(i); }
  }
  const chunks = new Map([...pages].map(([id, p]) => [id, { mesh: { positions: new Float32Array(p.positions), indices: new Uint32Array(p.indices) } }]));
  const all = { positions: new Float32Array(vertices.flat()), indices: new Uint32Array(faces.flat()), materials: new Uint16Array(faces.length).fill(1) };
  const collision = new TerrainCollision().apply({ version: 1, removed: [], milliseconds: 0, triangles: faces.length, rebuilt: 1,
    chunks: [{ id: 'planet', ...all, normals: new Float32Array(all.positions.length), colors: new Float32Array(all.positions.length) }] });
  const whole: WorldQuery = { radius: 18, version: 1, surface: (d: V3) => collision.surface(d), raycast: collision.raycast.bind(collision), isSolid: collision.isSolid.bind(collision),
    queryTriangles: collision.queryTriangles.bind(collision), visibilityTriangles: () => collision.visibilityTriangles() };
  return { collision, whole, pages: { ...whole, fixedChunks: () => chunks } as WorldQuery, count: chunks.size };
}
