/** Material-dependent craters (rust-engine-v22): the rules table and its shells, the arrangement rule (a material
 * cutter removes only cells owned by its materials) in the TS compiler and the Rust core at every worker count, the
 * per-material volume ledger against single-sphere references, closed boundaries, body recuts and version gating. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { craterProfile } from '../src/game/rules/crater';
import { craterScale, MATERIAL_CRATER_SCALE, materialCrater } from '../src/game/rules/material-craters';
import { cutShells, removesMaterial, sameCutShape, validCutShells, type SphereCut } from '../src/gpu/terrain/contracts';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { structuralFixture, type ResidentWorldInput } from '../src/gpu/terrain/fixtures';
import { packPages } from '../src/gpu/terrain/page-packet';
import { ResidentPageWorkers } from '../src/gpu/terrain/page-workers';
import { RustPageWorkerRuntime, type RustPageRequest } from '../src/gpu/terrain/rust-page-worker-runtime';
import type { PageWorkerRequest } from '../src/gpu/terrain/page-worker';
import type { RegionPage } from '../src/gpu/terrain/contracts';
import { replayResident, residentReplay, validateResidentCheckpoint } from '../src/game/resident-checkpoint';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import { packPendingCuts, PENDING_CUTS } from '../src/engine/frame/pending-cuts';
import { PendingCutSet } from '../src/engine/scene/pending-cuts';
import { setup } from './helpers/rust-resident';

type V3 = [number, number, number];
const module = WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
/** A building (concrete, 3) sunk 1.3 u into an unanchored soil layer (1) over an anchored rock base, as generated
 * buildings sit in the planet. No plane lies on the 1.5 u lattice or on another source's plane (the structural
 * fixture's coincident pillar-top/slab-bottom planes make some sphere cuts underdetermined even on v21). */
function buildingFixture(): ResidentWorldInput {
  const base = structuralFixture();
  return { ...base, name: 'two-supports', localConstruction: true, uniformRegions: true, cuts: [], sources: [
    { id: 'base', material: 2, anchor: 'fixed-base', bounds: { min: [-12, 0, -9], max: [12, .75, 9] } },
    { id: 'building', material: 3, bounds: { min: [-1.1, 1.3, -1.1], max: [1.1, 7.2, 1.1] } },
    { id: 'soil', material: 1, bounds: { min: [-12, .4, -9], max: [12, 2.6, 9] } },
  ] };
}
const fixture = buildingFixture();
const create = () => new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 2048, true, true);
/** A shot into the ground at the building's base: soil and the building's concrete both in reach. */
const HIT: V3 = [1.4, 2.6, 0.2], NORMAL: V3 = [0, 1, 0];
const crater = (): SphereCut => ({ id: 'material-crater', ...materialCrater(HIT, NORMAL, 2), repeat: 'impact' });

describe('material crater rules', () => {
  it('keeps one table: soil 1, rock 0.8, concrete 0.6; nuclear ignores it and heavy demolition halves it', () => {
    expect(MATERIAL_CRATER_SCALE).toEqual({ 1: 1, 2: 0.8, 3: 0.6 });
    expect([1, 2, 3, 7].map(m => craterScale(m))).toEqual([1, 0.8, 0.6, 1]);
    expect([1, 2, 3].map(m => craterScale(m, 'nuclear'))).toEqual([1, 1, 1]);
    expect([1, 2, 3].map(m => craterScale(m, 'heavy'))).toEqual([1, 0.9, 0.8]);
    expect(() => { (MATERIAL_CRATER_SCALE as Record<number, number>)[2] = 1; }).toThrow();
  });
  it('scales each shell about the impact point and keeps the full shell exactly at craterProfile', () => {
    const profile = craterProfile(HIT, NORMAL, 2), c = materialCrater(HIT, NORMAL, 2);
    expect({ center: c.center, radius: c.radius }).toEqual(profile);
    expect(c.shells!.map(s => s.materials)).toEqual([(~0b1100) >>> 0, 0b100, 0b1000]);
    expect(c.shells![0]).toEqual({ materials: (~0b1100) >>> 0, center: profile.center, radius: profile.radius });
    for (const [i, scale] of [[1, 0.8], [2, 0.6]] as const) {
      const s = c.shells![i];
      expect(s.radius).toBeCloseTo(profile.radius * scale, 12);
      // Same shape about the hit point: its depth below the surface (radius minus lift) scales too.
      expect(s.radius - (s.center[1] - HIT[1])).toBeCloseTo((profile.radius - (profile.center[1] - HIT[1])) * scale, 12);
    }
    expect(validCutShells(c)).toBe(true);
    expect([1, 2, 3].map(m => c.shells!.filter(s => removesMaterial(s.materials, m)).length)).toEqual([1, 1, 1]);
    expect(materialCrater(HIT, NORMAL, 2, 'nuclear')).toEqual(craterProfile(HIT, NORMAL, 2));
    materialCrater(HIT, NORMAL, 2, 'heavy').shells!.forEach((s, i) => expect(s.radius / profile.radius).toBeCloseTo([1, 0.9, 0.8][i], 12));
  });
  it('expands a cut into material cutters and rejects shells that leave the bounding sphere or overlap masks', () => {
    const cut = crater(), shells = cutShells(cut);
    expect(shells.map(s => s.id)).toEqual(['material-crater#fffffff3', 'material-crater#4', 'material-crater#8']);
    expect(shells.every(s => s.repeat === 'impact' && s.shells === undefined)).toBe(true);
    expect(cutShells({ id: 'plain', center: [0, 0, 0], radius: 2 })).toEqual([{ id: 'plain', center: [0, 0, 0], radius: 2 }]);
    expect(sameCutShape(cut, structuredClone(cut))).toBe(true);
    expect(sameCutShape(cut, { ...cut, shells: cut.shells!.slice(0, 2) })).toBe(false);
    expect(sameCutShape(cut, { id: cut.id, center: cut.center, radius: cut.radius })).toBe(false);
    expect(validCutShells({ ...cut, shells: [{ ...cut.shells![1], radius: cut.radius * 2 }] })).toBe(false);
    expect(validCutShells({ ...cut, shells: [cut.shells![1], cut.shells![1]] })).toBe(false);
    expect(validCutShells({ ...cut, shells: [{ ...cut.shells![1], materials: 0 }] })).toBe(false);
    expect(validCutShells({ ...cut, shells: [] })).toBe(false);
  });
});

// Real WASM behind the production worker protocol, as in terrain-rust-integration.test.ts.
class WorkerStub {
  private readonly rust = new RustPageWorkerRuntime(); private readonly ts = new Map<number, ResidentArrangement>();
  private queue = Promise.resolve(); private closed = false; onmessage?: Worker['onmessage'];
  postMessage(request: RustPageRequest | PageWorkerRequest) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      let data;
      try {
        if ('input' in request) data = await this.rust.run(request);
        else {
          const shard = request.shard!; if (request.init) this.ts.set(shard, create()); const a = this.ts.get(shard)!;
          a.rollbackFields(request.truncate, request.cutCount); for (const field of request.fields) a.appendPreparedField(field);
          data = { id: request.id, packet: packPages(a.compileTets(request.requests, request.revision, request.masks)), milliseconds: 0, cacheHit: false }; a.releaseCaches();
        }
      } catch (error) { data = { id: request.id, error: String(error) }; }
      if (!this.closed) this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent);
    });
  }
  terminate() { this.closed = true; void this.queue.then(() => this.rust.dispose()); }
}
const volumes = (pages: readonly RegionPage[]) => {
  const byMaterial = new Map<number, number>();
  for (const page of pages) for (const r of page.regions) byMaterial.set(r.material, (byMaterial.get(r.material) ?? 0) + r.volume);
  return byMaterial;
};

it('compiles material cutters identically in TypeScript and Rust at 1, 4 and 8 workers, with each material losing exactly its own sphere', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  try {
    const compile = async (count: number, cuts: readonly SphereCut[]) => {
      const a = create(), compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v3', false, count || 8, undefined, count ? { module: await module, generator: '' } : undefined);
      try {
        for (const cut of cuts) a.addCut(cut);
        const pages = await compiler.compile(a, a.lattice.brickOrder.map(brick => ({ brick, tets: null })), 1, []);
        expect(compiler.metrics.backend).toBe(count ? 'rust-wasm' : 'typescript');
        return { packet: packPages({ vertices: a.vertices.filter(v => v.edge), pages }), pages };
      } finally { compiler.dispose(); }
    };
    const shells = cutShells(crater()), expected = await compile(0, shells);
    for (const count of [1, 4, 8]) expect((await compile(count, shells)).packet).toEqual(expected.packet);
    const intact = volumes((await compile(0, [])).pages), cut = volumes(expected.pages);
    // Per-material ledger: what remains of each material equals a world cut by that material's sphere alone.
    for (const shell of shells) {
      const reference = volumes((await compile(0, [{ id: 'reference', center: shell.center, radius: shell.radius }])).pages);
      for (const material of [1, 3]) if (removesMaterial(shell.materials, material)) {
        // Extra cutters split regions further; split vertices are f32, so sums agree to ~1e-9 relative, not bitwise.
        expect(Math.abs(cut.get(material)! - reference.get(material)!)).toBeLessThan(1e-7 * intact.get(material)!);
        expect(cut.get(material)!).toBeLessThan(intact.get(material)!);
      }
    }
    // The anchored base is never cut; concrete loses less than a full-size cut would remove.
    expect(cut.get(2)).toBe(intact.get(2));
    const full = volumes((await compile(0, [{ id: 'full', center: shells[0].center, radius: shells[0].radius }])).pages);
    expect(intact.get(3)! - cut.get(3)!).toBeLessThan(intact.get(3)! - full.get(3)!);
  } finally { vi.unstubAllGlobals(); }
}, 60000);

it('v22 publishes a closed boundary, recuts bodies per material, replays across worker counts and v21 refuses shells', async () => {
  const a = await setup(1, true, 22, buildingFixture()), b = await setup(4, true, 22, buildingFixture()), old = await setup(1, true, 21, buildingFixture());
  const ref = await setup(1, true, 22, buildingFixture());
  try {
    expect(a.terrain.engine).toBe('rust-engine-v22'); expect(old.terrain.engine).toBe('rust-engine-v21');
    await a.terrain.initialize(); await old.terrain.initialize(); await ref.terrain.initialize();
    await expect(old.terrain.cut(crater())).rejects.toThrow('Invalid material crater shells');
    const first = (await a.terrain.cut(crater()))!;
    expect(first.seam.unpaired).toBe(0); expect(first.seam.orientationErrors).toBe(0); expect(Math.abs(first.ledger.error)).toBeLessThan(1e-4);
    expect(first.ledger.removed).toBeGreaterThan(0); expect(a.terrain.verifyOracle()).toEqual([]);
    // Sever the building above the ground (a plain cut): its top detaches as a concrete body. A material crater on
    // that body removes only its concrete shell, exactly what a plain cut by that shell removes from the same body.
    const sever: SphereCut = { id: 'sever', center: [0, 4.2, 0], radius: 1.9, repeat: 'impact' };
    await a.terrain.cut(sever); await ref.terrain.cut(crater()); await ref.terrain.cut(sever);
    expect(a.physics.bodies.size).toBe(1); expect(ref.physics.bodies.size).toBe(1);
    const recut: SphereCut = { id: 'body-crater', ...materialCrater([0.2, 5.5, 0.1], [0, 1, 0], 2), repeat: 'impact' };
    const concrete = recut.shells!.find(s => removesMaterial(s.materials, 3))!;
    const shelled = (await a.terrain.cut(recut))!, plain = (await ref.terrain.cut({ id: 'body-plain', center: concrete.center, radius: concrete.radius, repeat: 'impact' }))!;
    expect(shelled.bodies.length).toBeGreaterThan(0); expect(shelled.ledger.removed).toBeGreaterThan(1);
    expect(Math.abs(shelled.ledger.removed - plain.ledger.removed)).toBeLessThan(1e-7 * plain.ledger.removed);
    expect(shelled.seam.unpaired).toBe(0); expect(shelled.seam.orientationErrors).toBe(0); expect(a.terrain.verifyOracle()).toEqual([]);
    const game = ResidentGameTerrain.adopt(a.terrain); game.initialized = true; for (let i = 0; i < a.terrain.epoch; i++) game.bump();
    const checkpoint = await game.saveCheckpoint(); expect(checkpoint.engine).toBe('rust-engine-v22');
    expect(checkpoint.edits.filter(e => e.cut?.shells).length).toBe(2);
    const restored = validateResidentCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    await replayResident(b.terrain, restored.edits, restored.bodies, restored.tick);
    expect(b.physics.motions()).toEqual(a.physics.motions());
    expect(b.terrain.history.map(e => e.ledger)).toEqual(a.terrain.history.map(e => e.ledger));
    const meshes = (t: typeof a.terrain) => [...t.queries.fixed.chunks].map(([id, c]) => [id, c.mesh.positions, c.mesh.indices, c.mesh.materials]);
    expect(meshes(b.terrain)).toEqual(meshes(a.terrain)); expect(residentReplay(b.terrain)).toEqual(residentReplay(a.terrain));
    // Shells are a v22 record: an older engine's save cannot carry them.
    expect(() => validateResidentCheckpoint({ ...checkpoint, engine: 'rust-engine-v21' })).toThrow('Invalid checkpoint cut');
  } finally { a.terrain.dispose(); b.terrain.dispose(); old.terrain.dispose(); ref.terrain.dispose(); }
}, 120000);

it('packs pending material shells with their masks and keeps whole cuts, newest first', () => {
  const pending = new PendingCutSet(), shells = crater().shells!;
  pending.add('plain', [0, 0, 0], 3, 0);
  pending.add('crater', crater().center, crater().radius, 0, shells);
  const input = pending.frameInput(1), view = new DataView(packPendingCuts(input));
  expect(input[1].shells!.map(s => s.radius)).toEqual(shells.map(s => s.radius));
  const u32 = (offset: number) => view.getUint32(offset, true), f32 = (offset: number) => view.getFloat32(offset, true);
  expect(u32(0)).toBe(4);
  const masks = PENDING_CUTS.size - 32;
  expect([0, 1, 2, 3].map(i => u32(masks + i * 4))).toEqual([0, ...shells.map(s => s.materials)]);
  expect(f32(16 + 3 * 4)).toBe(3); expect(f32(16 + 16 * 2 + 12)).toBeCloseTo(shells[1].radius, 5);
  // Seven more plain cuts: the crater (three spheres) no longer fits and is dropped whole; the newest cuts stay.
  const many = [...input, ...Array.from({ length: 7 }, (_, i) => ({ center: [i, 0, 0] as V3, radius: 1, t0: 0 }))];
  const packed = new DataView(packPendingCuts(many));
  expect(packed.getUint32(0, true)).toBe(8);
  expect([0, 1, 2, 3, 4, 5, 6, 7].map(i => packed.getUint32(masks + i * 4, true)).every(m => m === 0)).toBe(true);
});
