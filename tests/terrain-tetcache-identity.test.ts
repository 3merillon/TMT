/** Gate (W1-TER step 6): the tet-granular recompile is bit-identical to a full rebuild over a 64-impact fixture.
 * A (tet cache) recompiles only the tets a cut can change and reuses every other tet's previous output; after each
 * impact a full, uncached rebuild of each dirty brick must reproduce its page exactly and create no vertex. B replays
 * the same impacts from scratch with whole-brick rebuilds (the pre-cache path): the vertex arrays (keys, positions,
 * recipes) and every page must match A bit for bit, so vertex ids and triangulation are unchanged. */
import { expect, it } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import type { RegionPage, SphereCut } from '../src/gpu/terrain/contracts';

const pageWords = (page: RegionPage) => JSON.stringify({ regions: page.regions, removed: page.removedVolume, tets: [...(page.tetRemoved ?? [])] });
const vertexWords = (a: ResidentArrangement) => JSON.stringify(a.vertices.map(v => [v.key, v.position, v.edge, v.values, v.basis, v.barycentric, v.planes, v.level]));
/** Forty overlapping impacts around the north pole, then 24 around the equator (enduranceCut's pattern), r 2.6 / 4.8. */
function impacts(): SphereCut[] {
  return Array.from({ length: 64 }, (_, i) => {
    const angle = i * 2.399963229728653, d = i < 40 ? [3 * Math.cos(angle), 18, 3 * Math.sin(angle)] : [18 * Math.cos(angle), 2 * Math.sin(angle * .7), 18 * Math.sin(angle)];
    const n = Math.hypot(...d), radius = i % 9 === 8 ? 4.8 : 2.6;
    return { id: `impact-${i}`, center: d.map(v => v / n * 17.4) as [number, number, number], radius, repeat: 'impact' as const };
  });
}

it('recompiles only dirty tets, bit-identical to full rebuilds, over 64 impacts', () => {
  const input = residentPlanet(7), lattice = residentLattice(input.bounds);
  const a = new ResidentArrangement(lattice, input.sources, 2048, true, input.uniformRegions);
  const b = new ResidentArrangement(lattice, input.sources, 2048, true, input.uniformRegions);
  const pagesA = new Map<string, RegionPage>(), pagesB = new Map<string, RegionPage>();
  for (const brick of lattice.brickOrder) { pagesA.set(brick, a.rebuild(brick, 1)); pagesB.set(brick, b.rebuild(brick, 1)); }
  let tets = 0, brickTets = 0;
  impacts().forEach((cut, i) => {
    const fieldA = a.addCut(cut), requests = a.tetRequests(a.dirtyTets(fieldA));
    for (const { brick, tets: local } of requests) pagesA.set(brick, a.rebuildTets(brick, new Set(local), pagesA.get(brick), i + 2));
    tets += requests.reduce((sum, r) => sum + r.tets!.length, 0); brickTets += requests.reduce((sum, r) => sum + lattice.bricks.get(r.brick)!.length, 0);
    // A full, uncached rebuild of every dirty brick reproduces the cached page and creates no vertex.
    const before = a.vertices.length;
    for (const { brick } of requests) expect(pageWords(a.rebuild(brick, i + 2)), `impact ${i} brick ${brick}`).toBe(pageWords(pagesA.get(brick)!));
    expect(a.vertices.length, `impact ${i}: the full rebuild created vertices`).toBe(before);
    // The pre-cache path: whole dirty bricks.
    const fieldB = b.addCut(cut);
    expect([...b.dirtyBricks(fieldB)]).toEqual(requests.map(r => r.brick));
    for (const brick of b.dirtyBricks(fieldB)) pagesB.set(brick, b.rebuild(brick, i + 2));
  });
  expect(tets).toBeLessThan(brickTets * 0.4);
  expect(vertexWords(a)).toBe(vertexWords(b));
  for (const brick of lattice.brickOrder) expect(pageWords(pagesA.get(brick)!), brick).toBe(pageWords(pagesB.get(brick)!));
  // And the whole planet, rebuilt from scratch in the cached arrangement, is unchanged.
  const before = a.vertices.length;
  for (const brick of lattice.brickOrder) expect(pageWords(a.rebuild(brick, 99)).replace(/"revision":\d+/g, '')).toBe(pageWords(pagesA.get(brick)!).replace(/"revision":\d+/g, ''));
  expect(a.vertices.length).toBe(before);
}, 300000);
