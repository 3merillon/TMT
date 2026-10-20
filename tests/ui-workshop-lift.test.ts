import { describe, expect, it } from 'vitest';
import type { InstanceInit, MeshDesc, SceneRegistry } from '../src/engine';
import { WorkshopGeometry } from '../src/game/workshop/geometry';
import { SCISSOR_LENGTH, SCISSOR_TOP_Y, solveScissorLift, WorkshopLift } from '../src/game/workshop/lift';
import { meshesIntersect } from './workshop-geometry-audit';
import { liftDeckMesh } from '../src/game/workshop/fixtures';
import { gaugeFaceMesh, gaugeNeedleMesh } from '../src/game/workshop/gauge';
import { WORKSHOP_LIFT_MAX } from '../src/game/workshop/dimensions';

function sceneMock() {
  let id = 0;
  const meshes = new Map<number, MeshDesc>(), instances = new Map<number, { mesh: number; model: Float32Array }>();
  const scene = { meshes: {
    create(mesh: MeshDesc) { const h = { id: ++id }; meshes.set(h.id, mesh); return h; },
    destroy(h: { id: number }) { meshes.delete(h.id); },
  }, instances: {
    add(h: { id: number }, init: InstanceInit) { const handle = { id: ++id }; instances.set(handle.id, { mesh: h.id, model: init.model }); return handle; },
    set(h: { id: number }, model: Float32Array) { instances.get(h.id)!.model = model; },
    remove(h: { id: number }) { instances.delete(h.id); },
  } } as unknown as SceneRegistry;
  return { scene, meshes, instances };
}

describe('constrained scissor lift', () => {
  it('keeps real rendered links rigid, nonintersecting and below the deck throughout travel', () => {
    const mock = sceneMock(), geometry = new WorkshopGeometry(mock.scene), lift = new WorkshopLift(geometry);
    const links = [...mock.instances.values()].filter(i => mock.meshes.get(i.mesh)!.label === 'workshop:fixed-length-scissor-link');
    expect(links).toHaveLength(4);
    const deck = liftDeckMesh();
    for (let step = 0; step <= WORKSHOP_LIFT_MAX * 100; step++) {
      const height = step / 100, solution = solveScissorLift(height); lift.update(height);
      expect(Math.hypot(solution.span, solution.rise)).toBeCloseTo(SCISSOR_LENGTH, 12);
      const deckTransform = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, height, 0, 1);
      for (const link of links) {
        const m = link.model;
        for (const at of [0, 4, 8]) expect(Math.hypot(m[at], m[at + 1], m[at + 2])).toBeCloseTo(1, 6);
        expect(m[13] + m[9] * SCISSOR_LENGTH).toBeCloseTo(SCISSOR_TOP_Y + height, 6);
        expect(meshesIntersect(mock.meshes.get(link.mesh)!, m, deck, deckTransform), `link/deck at height ${height}`).toBe(false);
      }
      for (let a = 0; a < links.length; a++) for (let b = a + 1; b < links.length; b++) {
        expect(meshesIntersect(mock.meshes.get(links[a].mesh)!, links[a].model, mock.meshes.get(links[b].mesh)!, links[b].model), `links ${a}/${b} at height ${height}`).toBe(false);
      }
    }
    geometry.dispose(); expect(mock.instances.size).toBe(0); expect(mock.meshes.size).toBe(0);
  });
  it('moves the guided rollers inward as the fixed-length linkage opens and rejects impossible travel', () => {
    const lo = solveScissorLift(0), hi = solveScissorLift(WORKSHOP_LIFT_MAX);
    expect(hi.sliderX).toBeLessThan(lo.sliderX); expect(hi.screwAngle).toBeGreaterThan(0);
    expect(hi.sliderX).toBeGreaterThan(.35); expect(lo.sliderX).toBeLessThan(1.1);
    expect(() => solveScissorLift(-.01)).toThrow(); expect(() => solveScissorLift(Infinity)).toThrow();
  });
  it('docks the grated track surface flush with the floor and preserves the pit datum through repeated motion', () => {
    const mock = sceneMock(), geometry = new WorkshopGeometry(mock.scene, [0, -.65, 0]), lift = new WorkshopLift(geometry);
    const deck = liftDeckMesh(), handle = geometry.addMesh(deck);
    for (const height of [0, WORKSHOP_LIFT_MAX, .17, .5, 0]) {
      lift.update(height);
      geometry.setTransform(handle, Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, height, 0, 1));
      expect(geometry.modelOf(handle)[13]).toBeCloseTo(height, 6);
      expect(mock.instances.get(handle.id)!.model[13] + .65).toBeCloseTo(height, 6);
      const links = [...mock.instances.values()].filter(i => mock.meshes.get(i.mesh)!.label === 'workshop:fixed-length-scissor-link');
      for (const { model: m } of links) expect(m[13] + m[9] * SCISSOR_LENGTH).toBeCloseTo(SCISSOR_TOP_Y + height - .65, 6);
    }
    geometry.dispose(); expect(mock.instances.size).toBe(0);
  });
});

describe('replacement pressure dial', () => {
  it('keeps its independent hand above the original-image replacement plane', () => {
    const face = gaugeFaceMesh(.238), needle = gaugeNeedleMesh(.238);
    expect([...face.attrs!].every(a => (a >>> 16 & 255) === 14)).toBe(true);
    for (let i = 0; i < face.partLocal!.length; i += 3) {
      expect(face.partLocal![i]).toBeGreaterThanOrEqual(0); expect(face.partLocal![i]).toBeLessThanOrEqual(1);
      expect(face.partLocal![i + 1]).toBeGreaterThanOrEqual(0); expect(face.partLocal![i + 1]).toBeLessThanOrEqual(1);
    }
    for (let i = 2; i < needle.positions.length; i += 3) expect(needle.positions[i]).toBeGreaterThan(.006);
  });
});
