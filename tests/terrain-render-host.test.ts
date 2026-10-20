/** The renderer-agnostic terrain seam (plan §5.1, I4) through the fake host: draw membership changes only in
 * host.commit, a transaction shows and hides together, staged pages stay invisible, and rollback shows nothing. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

async function world() {
  const fixture = structuralFixture(), gate = new GeometryGate(), host = new FakeTerrainHost(), physics = await StructuralPhysics.create(fixture.planetCenter);
  return { fixture, gate, host, physics, terrain: new ResidentTerrain(fixture, gate.pages, physics, host) };
}
const ids = (values: Iterable<number>) => [...values].sort((a, b) => a - b);

describe('terrain render host seam', () => {
  it('publishes each transaction as one commit that shows the new pages and hides the replaced ones', async () => {
    const { fixture, gate, host, terrain } = await world();
    try {
      await terrain.initialize();
      expect(host.commits).toHaveLength(1);
      expect(host.commits[0].hide).toEqual([]);
      expect(ids(host.commits[0].show)).toEqual(ids(host.visible));
      expect(host.visible.length).toBe(gate.live);
      expect(host.visible.every(id => host.pages.get(id)!.info.brick !== undefined && host.pages.get(id)!.info.bodyId === undefined)).toBe(true);

      const before = new Set(host.visible);
      await terrain.cut(fixture.cuts[0]);
      expect(host.commits).toHaveLength(2);
      const { show, hide } = host.commits[1];
      expect(show.length).toBeGreaterThan(0);
      expect(hide.length).toBeGreaterThan(0);
      // Replaced pages were drawn until this commit, retire in it, and are disposed only after it.
      expect(hide.every(id => before.has(id) && host.pages.get(id)!.disposed)).toBe(true);
      expect(show.every(id => !before.has(id) && host.pages.get(id)!.visible)).toBe(true);
      const brick = (id: number) => host.pages.get(id)!.info.brick;
      expect(new Set(show.map(brick))).toEqual(new Set(hide.map(brick)));
      expect(ids(host.visible)).toEqual(ids([...before].filter(id => !hide.includes(id)).concat(show)));
      expect(host.disposedWhileVisible).toBe(0);
    } finally { terrain.dispose(); }
    expect(host.visible).toEqual([]);
    expect(host.disposedWhileVisible).toBe(0);
    expect(gate.live).toBe(0);
  }, 60000);

  it('keeps staged pages invisible until the commit, including detached body pages posed before they show', async () => {
    const { fixture, gate, host, physics, terrain } = await world();
    try {
      await terrain.initialize();
      await terrain.cut(fixture.cuts[0]);
      const commits = host.commits.length, staged: number[] = [];
      gate.pageGate = async handle => {
        expect(host.pages.get(handle.id)!.visible).toBe(false);
        expect(host.commits).toHaveLength(commits);
        staged.push(handle.id);
      };
      const accepted = await terrain.cut(fixture.cuts[1]);
      expect(accepted?.bodies).toHaveLength(1);
      expect(host.commits).toHaveLength(commits + 1);
      const shown = host.commits.at(-1)!.show;
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every(id => staged.includes(id))).toBe(true);

      const bodyPage = [...host.pages.values()].find(page => page.info.bodyId === accepted!.bodies[0])!;
      expect(bodyPage.visible).toBe(true);
      expect(shown).toContain(bodyPage.id);
      const body = physics.bodies.get(accepted!.bodies[0])!.body, p = body.translation();
      expect(bodyPage.pose?.position).toEqual([p.x, p.y, p.z]);
      // Body pages are emitted relative to the body's source-space centre, which setPose then places.
      expect(bodyPage.info.origin).toEqual(physics.bodies.get(accepted!.bodies[0])!.candidate.center);

      terrain.step();
      const moved = body.translation();
      expect(bodyPage.pose?.position).toEqual([moved.x, moved.y, moved.z]);
      expect(host.commits).toHaveLength(commits + 1);
    } finally { terrain.dispose(); }
    expect(host.disposedWhileVisible).toBe(0);
    expect(gate.live).toBe(0);
  }, 60000);

  it('rolls back a failed transaction without showing or hiding anything', async () => {
    const { fixture, gate, host, terrain } = await world();
    try {
      await terrain.initialize();
      const commits = host.commits.length, visible = ids(host.visible), live = gate.live, created = host.pages.size;
      gate.failPage = gate.pageCalls + 2;
      await expect(terrain.cut(fixture.cuts[0])).rejects.toMatchObject({ code: 'validation' });
      expect(host.commits).toHaveLength(commits);
      expect(ids(host.visible)).toEqual(visible);
      expect(gate.live).toBe(live);
      const staged = [...host.pages.values()].slice(created);
      expect(staged.length).toBeGreaterThan(0);
      expect(staged.every(page => page.disposed && !page.visible)).toBe(true);

      gate.failPage = undefined;
      await terrain.cut(fixture.cuts[0]);
      expect(host.commits).toHaveLength(commits + 1);
    } finally { terrain.dispose(); }
    expect(host.disposedWhileVisible).toBe(0);
  }, 60000);

  it('rejects commits that would break atomic publication', () => {
    const host = new FakeTerrainHost(), buffer = {} as GPUBuffer;
    const buffers = { position: buffer, normal: buffer, surface: buffer, index: buffer, indirect: buffer, vertexCount: 3, indexCount: 3 };
    const a = host.createPage(buffers, { brick: '0,0,0', origin: [0, 0, 0], bounds: { min: [0, 0, 0], max: [6, 6, 6] } });
    expect(() => host.commit({ show: [], hide: [a] })).toThrow(/not visible/);
    host.commit({ show: [a], hide: [] });
    expect(() => host.commit({ show: [a], hide: [] })).toThrow(/already visible/);
    expect(() => host.commit({ show: [a], hide: [a] })).toThrow(/twice/);
    a.dispose();
    expect(host.disposedWhileVisible).toBe(1);
    expect(() => host.commit({ show: [a], hide: [] })).toThrow(/disposed/);
  });
});

describe('resident page draw bounds', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  async function bounds() {
    // gpu-pages reads WebGPU usage flags at module scope; the bounds helpers themselves are pure.
    vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32, INDEX: 16, INDIRECT: 256, UNIFORM: 64, MAP_READ: 1, QUERY_RESOLVE: 512 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    vi.stubGlobal('GPUShaderStage', { COMPUTE: 4 });
    return import('../src/gpu/terrain/gpu-pages');
  }
  it('gives a static page its own brick AABB, clamped to the lattice, never the whole lattice', async () => {
    const { brickBounds } = await bounds(), lattice = residentLattice({ min: [-12, 0, -9], max: [12, 9, 9] });
    for (const brick of lattice.bricks.keys()) {
      const box = brickBounds(lattice, brick), key = brick.split(',').map(Number);
      for (let a = 0; a < 3; a++) {
        expect(box.min[a]).toBeCloseTo(Math.max(key[a] * 6, lattice.bounds.min[a]) - 1e-3, 9);
        expect(box.max[a]).toBeCloseTo(Math.min(key[a] * 6 + 6, lattice.bounds.max[a]) + 1e-3, 9);
      }
      for (const tet of lattice.bricks.get(brick)!) for (const v of tet.vertices)
        expect(lattice.positions[v].every((x, a) => x >= box.min[a] && x <= box.max[a])).toBe(true);
    }
    expect(brickBounds(lattice, '-1,1,-2')).toEqual({ min: [-6 - 1e-3, 6 - 1e-3, -9 - 1e-3], max: [1e-3, 9 + 1e-3, -6 + 1e-3] });
    expect(() => brickBounds(lattice, '9,9,9')).toThrow(/Unknown resident brick/);
  });
  it('gives a body page the body-local AABB of its vertices', async () => {
    const { localBounds } = await bounds();
    expect(localBounds([[1, 2, 3], [4, -1, 5]], [2, 0, 4])).toEqual({ min: [-1 - 1e-3, -1 - 1e-3, -1 - 1e-3], max: [2 + 1e-3, 2 + 1e-3, 1 + 1e-3] });
    expect(() => localBounds([], [0, 0, 0])).toThrow(/empty/);
  });
});
