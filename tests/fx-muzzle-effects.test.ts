import { describe, expect, it, vi } from 'vitest';
import type { InstanceInit, MeshDesc, SceneRegistry, Vec3 } from '../src/engine';
import { MAX_MUZZLE_FLASHES, MuzzleEffects, muzzleTransform } from '../src/game/presentation/muzzle-effects';
import type { MuzzleEmission } from '../src/engine/passes/fluids/muzzle';

const shot: MuzzleEmission = { position: [3, 20, 4], direction: [0, 0, 1], up: [0, 1, 0], munition: 'explosive', weapon: 'cannon', seed: 7 };

function harness() {
  let id = 1;
  const meshes = new Map<number, MeshDesc>(), instances = new Map<number, InstanceInit>(), lights = new Set<number>();
  const muzzle = vi.fn();
  const scene = {
    meshes: { create: (d: MeshDesc) => { const h = { id: id++ }; meshes.set(h.id, d); return h; }, destroy: (h: { id: number }) => meshes.delete(h.id) },
    instances: {
      add: (_mesh: unknown, init: InstanceInit) => { const h = { id: id++ }; instances.set(h.id, { ...init, model: init.model.slice() }); return h; },
      set: (h: { id: number }, model: Float32Array) => { instances.get(h.id)!.model = model.slice(); },
      remove: (h: { id: number }) => instances.delete(h.id),
      setVisibility: (h: { id: number }, visibility: number) => { instances.get(h.id)!.visibility = visibility; },
    },
    lights: { add: () => { const h = { id: id++ }; lights.add(h.id); return h; }, update: () => {}, remove: (h: { id: number }) => lights.delete(h.id) },
    get: () => ({ muzzle }),
  } as unknown as SceneRegistry;
  return { effects: new MuzzleEffects(scene), meshes, instances, lights, muzzle };
}

describe('muzzle flash presentation', () => {
  it('emits once per call, retains the original pose, and cleans up after elapsed presentation time', () => {
    const h = harness(), mutable = { ...shot, position: [3, 20, 4], direction: [0, 0, 1] };
    h.effects.fire(mutable);
    expect(h.muzzle).toHaveBeenCalledExactlyOnceWith(mutable);
    mutable.position[0] = 99; mutable.direction[2] = -1;
    h.effects.update(.03);
    const transform = [...h.instances.values()][0].model;
    expect(transform[12]).toBe(3); expect(transform[10]).toBeGreaterThan(0);
    expect(h.effects.total).toBe(1); expect(h.effects.active).toBe(1);
    h.effects.update(.5);
    expect(h.instances.size).toBe(0); expect(h.lights.size).toBe(0); expect(h.effects.active).toBe(0);
  });

  it('bounds simultaneous flashes across all ammunition and weapon variants and releases meshes on disposal', () => {
    const h = harness();
    for (let i = 0; i < 500; i++) {
      h.effects.fire({ ...shot, munition: (['explosive', 'heavy', 'incendiary', 'nuclear'] as const)[i % 4],
        weapon: (['mortar', 'cannon', 'rail'] as const)[i % 3] });
      expect(h.instances.size).toBeLessThanOrEqual(MAX_MUZZLE_FLASHES * 2);
      expect(h.lights.size).toBeLessThanOrEqual(MAX_MUZZLE_FLASHES);
      expect(h.meshes.size).toBe(2);
    }
    h.effects.clear();
    expect(h.instances.size).toBe(0); expect(h.lights.size).toBe(0);
    h.effects.fire(shot); h.effects.dispose();
    expect(h.meshes.size).toBe(0); expect(h.instances.size).toBe(0); expect(h.lights.size).toBe(0);
    expect(h.effects.total).toBe(501);
  });

  it('rejects invalid source poses before creating presentation or gas resources', () => {
    const h = harness();
    for (const direction of [[0, 0, 0], [0, NaN, 1], [Infinity, 0, 0]]) h.effects.fire({ ...shot, direction });
    h.effects.fire({ ...shot, position: [0, NaN, 0] });
    expect(h.effects.total).toBe(0); expect(h.muzzle).not.toHaveBeenCalled(); expect(h.instances.size).toBe(0);
  });

  it('keeps a finite right-handed direction frame for vertical, grazing and antipodal shots', () => {
    const poses: [Vec3, Vec3][] = [[[0, 1, 0], [0, 1, 0]], [[0, -1, 0], [0, 1, 0]], [[1e-8, 1, 0], [0, 1, 0]],
      [[1, 0, 0], [1, 0, 0]], [[.4, -.8, .1], [-.6, .2, .3]]];
    for (const [direction, up] of poses) {
      const m = muzzleTransform([3, 20, 4], direction, up, .2, 2, .76, new Float32Array(16));
      expect([...m].every(Number.isFinite)).toBe(true);
      const dot = (a: number, b: number) => m[a] * m[b] + m[a + 1] * m[b + 1] + m[a + 2] * m[b + 2];
      expect(dot(0, 4)).toBeCloseTo(0, 6); expect(dot(0, 8)).toBeCloseTo(0, 6); expect(dot(4, 8)).toBeCloseTo(0, 6);
      const determinant = (m[1] * m[6] - m[2] * m[5]) * m[8] + (m[2] * m[4] - m[0] * m[6]) * m[9] + (m[0] * m[5] - m[1] * m[4]) * m[10];
      expect(determinant).toBeCloseTo(.08, 6);
    }
  });
});
