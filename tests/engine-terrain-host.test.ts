// W1-ENG-SCENE: EngineTerrainHost (plan §4.7, §5.1) with a fake device — atomic commit (I4), newUntilFrame, prevModel,
// setPose, page hooks, deferred destruction (N6, ≥ 3 frames) — and page bounds that contain every vertex of real resident
// pages (static bricks and detached bodies of the structural fixtures).
import { describe, expect, it, vi } from 'vitest';
import { DeferredDestroyQueue, DESTROY_SLACK_TICKS } from '../src/engine/gpu/context';
import { EngineTerrainHost } from '../src/engine/scene/terrain-host';
import { localBounds, NEW_GEOMETRY_FRAMES, poseMatrix, TerrainPageTable } from '../src/engine/scene/terrain-pages';
import { PAGE_RECORD_FLOATS } from '../src/engine/materials/terrain/surface.wgsl';
import type { PageBuffers, PageDrawInfo } from '../src/gpu/terrain/render-host';
import type { PageHook } from '../src/gpu/terrain/page-hooks';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { terrainConnectivity } from '../src/game/terrain-connectivity';

type Vec3 = [number, number, number];

function fakeBuffer(label: string) {
  const buffer = { label, destroyed: 0, destroy() { buffer.destroyed++; } };
  return buffer as unknown as GPUBuffer & { destroyed: number };
}
function buffers(tag: string, indexCount = 36): PageBuffers {
  return { position: fakeBuffer(`${tag}.pos`), normal: fakeBuffer(`${tag}.nrm`), surface: fakeBuffer(`${tag}.srf`), index: fakeBuffer(`${tag}.idx`),
    indirect: fakeBuffer(`${tag}.ind`), vertexCount: 24, indexCount };
}
const staticInfo = (brick = '0,0,0'): PageDrawInfo => ({ brick, origin: [0, 0, 0], bounds: { min: [-1, 17, -1], max: [2, 20, 3] } });
const bodyInfo = (): PageDrawInfo => ({ bodyId: 7, origin: [0, 19, 0], bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] } });

function host() {
  const destroyed: unknown[] = [];
  const device = { label: 'fake device' } as unknown as GPUDevice;
  const h = new EngineTerrainHost({ device, deferDestroy: r => { if (r) destroyed.push(r); } });
  return { h, destroyed, device };
}
const visibleIds = (h: EngineTerrainHost) => h.table.visible().map(p => p.id).sort((a, b) => a - b);

describe('EngineTerrainHost: atomic commit (I4)', () => {
  it('pages are invisible until commit; one commit shows and hides together', () => {
    const { h } = host();
    const a = h.createPage(buffers('a'), staticInfo('0,0,0')), b = h.createPage(buffers('b'), staticInfo('1,0,0'));
    expect(visibleIds(h)).toEqual([]);
    h.commit({ show: [a, b], hide: [] });
    expect(visibleIds(h)).toEqual([a.id, b.id]);
    const c = h.createPage(buffers('c'), staticInfo('0,0,0'));
    expect(visibleIds(h)).toEqual([a.id, b.id]);
    h.commit({ show: [c], hide: [a] });
    expect(visibleIds(h)).toEqual([b.id, c.id]);
  });

  it('a rejected commit publishes nothing (validated before any change)', () => {
    const { h } = host();
    const a = h.createPage(buffers('a'), staticInfo()), b = h.createPage(buffers('b'), staticInfo()), c = h.createPage(buffers('c'), staticInfo());
    h.commit({ show: [a], hide: [] });
    const epoch = h.table.epoch;
    // Hiding an invisible page after a valid show: the valid part must not be applied either.
    expect(() => h.commit({ show: [b], hide: [c] })).toThrow(/not visible/);
    expect(() => h.commit({ show: [a], hide: [] })).toThrow(/already visible/);
    expect(() => h.commit({ show: [b, b], hide: [] })).toThrow(/twice/);
    const foreign = { id: a.id, setPose() {}, dispose() {} };
    expect(() => h.commit({ show: [], hide: [foreign] })).toThrow(/another host/);
    c.dispose();
    expect(() => h.commit({ show: [c], hide: [] })).toThrow(/disposed/);
    expect(visibleIds(h)).toEqual([a.id]);
    expect(h.table.epoch).toBe(epoch);
  });

  it('stamps newUntilFrame = next frame + 3 on shown pages (GB3 TAA reject) and reports dirty bounds', () => {
    const { h } = host();
    h.table.beginFrame(41); // frame 41 drawn; the next frame is 42
    const a = h.createPage(buffers('a'), staticInfo());
    const records: { dirty: unknown; epoch: number }[] = [];
    h.onCommitted((r, epoch) => records.push({ dirty: r.dirty, epoch }));
    h.commit({ show: [a], hide: [] });
    const page = h.table.page(a.id)!;
    expect(page.newUntilFrame).toBe(42 + NEW_GEOMETRY_FRAMES);
    const u32 = new Uint32Array(h.table.records.buffer);
    expect(u32[page.slot * PAGE_RECORD_FLOATS + 42]).toBe(45);
    expect(records).toHaveLength(1);
    const dirty = records[0].dirty as { min: Vec3; max: Vec3 };
    for (let k = 0; k < 3; k++) {
      expect(dirty.min[k]).toBeLessThanOrEqual(staticInfo().bounds.min[k] + 1e-9);
      expect(dirty.max[k]).toBeGreaterThanOrEqual(staticInfo().bounds.max[k] - 1e-9);
    }
  });
});

describe('EngineTerrainHost: poses, records and hooks', () => {
  it('setPose updates model; prevModel follows at the next frame start (zero velocity once parked)', () => {
    const { h } = host();
    const body = h.createPage(buffers('b'), bodyInfo());
    const page = h.table.page(body.id)!;
    const o = page.slot * PAGE_RECORD_FLOATS;
    h.table.beginFrame(0);
    expect(Array.from(h.table.records.subarray(o, o + 16))).toEqual(Array.from(h.table.records.subarray(o + 16, o + 32)));
    body.setPose([0, 19.5, 0], [0, 0, Math.sin(0.1), Math.cos(0.1)]);
    const model = Array.from(h.table.records.subarray(o, o + 16));
    expect(model[13]).toBeCloseTo(19.5);
    h.table.beginFrame(1); // prev = the model drawn in frame 0
    expect(h.table.records[o + 16 + 13]).toBeCloseTo(19);
    h.table.beginFrame(2); // parked: prev = model
    expect(Array.from(h.table.records.subarray(o + 16, o + 32))).toEqual(model);
    expect(() => body.setPose([Number.NaN, 0, 0], [0, 0, 0, 1])).toThrow(/invalid pose/);
    expect(h.table.records[o + 35]).toBe(1); // body flag
  });

  it('the world bounding sphere follows the pose and always contains the page bounds', () => {
    const { h } = host();
    const body = h.createPage(buffers('b'), bodyInfo());
    const page = h.table.page(body.id)!;
    for (const [p, q] of [[[1, 20, 2], [0, 0, 0, 1]], [[-3, 18, 4], [0.3, 0.2, -0.1, 0.92]]] as [Vec3, [number, number, number, number]][]) {
      body.setPose(p, q);
      const m = poseMatrix(p, q);
      const lb = localBounds(page.info);
      for (const x of [lb.min[0], lb.max[0]]) for (const y of [lb.min[1], lb.max[1]]) for (const z of [lb.min[2], lb.max[2]]) {
        const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        const c = page.worldSphere.center;
        expect(Math.hypot(w[0] - c[0], w[1] - c[1], w[2] - c[2])).toBeLessThanOrEqual(page.worldSphere.radius + 1e-9);
      }
    }
  });

  it('grows the record table and reuses freed slots', () => {
    const table = new TerrainPageTable({ release: () => undefined }, 2);
    const handles = Array.from({ length: 5 }, (_, i) => table.create(buffers(`p${i}`), staticInfo()));
    expect(table.capacity).toBeGreaterThanOrEqual(5);
    const freed = table.page(handles[1].id)!.slot;
    handles[1].dispose();
    const again = table.create(buffers('again'), staticInfo());
    expect(table.page(again.id)!.slot).toBe(freed);
  });

  it('addPageHook registers once and unregisters', () => {
    const { h } = host();
    const hook: PageHook = { name: 'veg', statusWords: 2, encode: () => undefined };
    const remove = h.addPageHook(hook);
    expect(h.pageHooks).toEqual([hook]);
    expect(() => h.addPageHook(hook)).toThrow(/already registered/);
    remove();
    expect(h.pageHooks).toEqual([]);
  });
});

describe('EngineTerrainHost: deferred destruction (N6)', () => {
  it('dispose hands the page buffers to deferDestroy and never destroys them itself', () => {
    const { h, destroyed } = host();
    const b = buffers('a');
    const a = h.createPage(b, staticInfo());
    h.commit({ show: [a], hide: [] });
    h.commit({ show: [], hide: [a] });
    a.dispose();
    a.dispose(); // idempotent
    expect(destroyed).toEqual([b.position, b.normal, b.surface, b.index, b.indirect]);
    for (const buf of [b.position, b.normal, b.surface, b.index, b.indirect]) expect((buf as unknown as { destroyed: number }).destroyed).toBe(0);
    expect(h.stats().disposedWhileVisible).toBe(0);
  });

  it('through the engine queue, the buffers survive at least 3 frames', () => {
    const queue = new DeferredDestroyQueue(DESTROY_SLACK_TICKS);
    const device = {} as GPUDevice;
    const h = new EngineTerrainHost({ device, deferDestroy: r => queue.push(r) });
    const b = buffers('a');
    h.createPage(b, staticInfo()).dispose();
    const pos = b.position as unknown as { destroyed: number };
    for (let frame = 1; frame < DESTROY_SLACK_TICKS; frame++) { queue.tick(); expect(pos.destroyed).toBe(0); }
    queue.tick();
    expect(pos.destroyed).toBe(1);
  });

  it('a page disposed while visible is dropped from the draw set and counted', () => {
    const { h } = host();
    const a = h.createPage(buffers('a'), staticInfo());
    h.commit({ show: [a], hide: [] });
    a.dispose();
    expect(visibleIds(h)).toEqual([]);
    expect(h.stats().disposedWhileVisible).toBe(1);
  });
});

describe('page bounds contain every vertex (real resident pages)', () => {
  it('static brick pages (brickBounds) and detached bodies (localBounds) of the structural fixtures', async () => {
    vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32, INDEX: 16, INDIRECT: 256, UNIFORM: 64, MAP_READ: 1, QUERY_RESOLVE: 512 });
    vi.stubGlobal('GPUMapMode', { READ: 1, WRITE: 2 });
    try {
      const pages = await import('../src/gpu/terrain/gpu-pages');
      let checkedStatic = 0, checkedBodies = 0;
      for (const name of ['two-supports', 'arch'] as const) {
        const fixture = structuralFixture(name), arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
        const built = new Map([...arrangement.lattice.bricks.keys()].map(key => [key, arrangement.rebuild(key, 0)]));
        for (let i = 0; i < fixture.cuts.length; i++) {
          const field = arrangement.addCut(fixture.cuts[i]);
          for (const brick of arrangement.dirtyBricks(field)) built.set(brick, arrangement.rebuild(brick, i + 1));
        }
        const graph = terrainConnectivity([...built.values()].flatMap(p => [...p.regions]), arrangement);
        const table = new TerrainPageTable({ release: () => undefined });
        const detachedIds = new Set(graph.detached.flat().map(r => r.id));
        const byBrick = new Map<string, Vec3[]>();
        for (const { region, face } of graph.boundary) {
          if (detachedIds.has(region.id)) continue;
          const list = byBrick.get(region.brick) ?? [];
          for (const id of face.vertices) list.push(arrangement.vertices[id].position as Vec3);
          byBrick.set(region.brick, list);
        }
        for (const [brick, points] of byBrick) {
          const bounds = pages.brickBounds(arrangement.lattice, brick);
          const page = table.page(table.create(buffers(brick), { brick, origin: [0, 0, 0], bounds }).id)!;
          for (const p of points) {
            for (let k = 0; k < 3; k++) { expect(p[k]).toBeGreaterThanOrEqual(bounds.min[k]); expect(p[k]).toBeLessThanOrEqual(bounds.max[k]); }
            const c = page.worldSphere.center;
            expect(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).toBeLessThanOrEqual(page.worldSphere.radius + 1e-6);
          }
          checkedStatic++;
        }
        for (const body of graph.detached) {
          const ids = new Set(body.map(r => r.id));
          const points = graph.boundary.filter(f => ids.has(f.region.id)).flatMap(f => f.face.vertices.map(id => arrangement.vertices[id].position as Vec3));
          const center: Vec3 = [0, 1, 2].map(k => points.reduce((s, p) => s + p[k], 0) / points.length) as Vec3;
          const bounds = pages.localBounds(points, center);
          const handle = table.create(buffers('body'), { bodyId: 1, origin: center, bounds });
          const page = table.page(handle.id)!;
          for (const p of points) {
            const c = page.worldSphere.center; // rest pose: model = T(origin); vertices sit at their rest world position
            expect(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).toBeLessThanOrEqual(page.worldSphere.radius + 1e-6);
          }
          checkedBodies++;
        }
      }
      expect(checkedStatic).toBeGreaterThan(0);
      expect(checkedBodies).toBeGreaterThan(0);
    } finally { vi.unstubAllGlobals(); }
  }, 120000);
});
