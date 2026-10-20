/**
 * The rail / arc cannon contact-arc flicker (rail-energy.ts): with the partMeshes facet the three variants stay instanced
 * and switch by visibility, drawing exactly what the add/remove path (no facet) draws: the shown variant has that path's
 * model and visibility, starts its motion history afresh on every switch (as that path's new instance does), and the
 * others are at visibility 0, which discards every fragment.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceInit, MeshDesc, SceneRegistry } from '../src/engine';
import { RailEnergy } from '../src/game/presentation/rail-energy';
import type { WeaponId } from '../src/game/kit/types';

function harness(weapon: WeaponId, facet: boolean) {
  let serial = 0, adds = 0, removes = 0;
  const meshes = new Map<number, MeshDesc>(), instances = new Map<number, { mesh: number; init: InstanceInit }>(), restarts: number[] = [];
  const scene = {
    meshes: { create: (d: MeshDesc) => { const h = { id: serial++ }; meshes.set(h.id, d); return h; }, destroy: (h: { id: number }) => meshes.delete(h.id) },
    instances: {
      add: (m: { id: number }, init: InstanceInit) => { adds++; const h = { id: serial++ }; instances.set(h.id, { mesh: m.id, init: { ...init, model: init.model.slice() } }); return h; },
      set: (h: { id: number }, model: Float32Array) => { instances.get(h.id)!.init.model = model.slice(); },
      setVisibility: (h: { id: number }, visibility: number) => { instances.get(h.id)!.init.visibility = visibility; },
      remove: (h: { id: number }) => { removes++; instances.delete(h.id); },
    },
    lights: { add: () => ({ id: serial++ }), update() {}, remove() {} },
    ...(facet ? { get: (k: string) => k === 'partMeshes' ? { restart: (h: { id: number }) => restarts.push(h.id) } : undefined } : {}),
  } as unknown as SceneRegistry;
  const arcs = () => [...instances.entries()].filter(([, i]) => meshes.get(i.mesh)?.label?.startsWith('weapon:contact-arcs:'))
    .map(([id, i]) => ({ id, variant: Number(meshes.get(i.mesh)!.label!.slice(-1)), model: [...i.init.model], visibility: i.init.visibility ?? 1 }));
  return { effects: new RailEnergy(scene, weapon), arcs, restarts, counts: () => ({ adds, removes }) };
}

describe('weapon contact-arc flicker', () => {
  for (const weapon of ['rail', 'arc_cannon'] as const) it(`${weapon}: switches variants by visibility, as the add/remove path draws them`, () => {
    const kept = harness(weapon, true), swapped = harness(weapon, false);
    const model = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 20, 30, 1]);
    let previous = -1, membership = { adds: 0, removes: 0 }, switches = 0;
    for (let frame = 0; frame < 400; frame++) {
      model[12] = 10 + frame * 0.01;
      const dt = frame % 7 === 0 ? 1 / 30 : 1 / 120;
      kept.effects.update(model, dt, true, true, 10); swapped.effects.update(model, dt, true, true, 10);
      const reference = swapped.arcs();
      expect(reference).toHaveLength(1);
      const shown = kept.arcs().filter(a => a.visibility > 0), all = kept.arcs();
      expect(all.map(a => a.variant).sort()).toEqual([0, 1, 2]);
      expect(shown).toHaveLength(1);
      expect(shown[0].variant).toBe(reference[0].variant);
      expect(shown[0].model).toEqual(reference[0].model);
      expect(shown[0].visibility).toBe(reference[0].visibility);
      if (frame === 0) membership = kept.counts();
      else {
        expect(kept.counts()).toEqual(membership);
        // A switch restarts the shown instance's motion history, as the replacing instance of the add/remove path starts it.
        if (shown[0].variant !== previous) { switches++; expect(kept.restarts.at(-1)).toBe(shown[0].id); }
      }
      expect(kept.restarts).toHaveLength(switches);
      previous = shown[0].variant;
    }
    expect(switches).toBeGreaterThan(20);
    kept.effects.update(model, 1, false, true, 10);
    expect(kept.arcs()).toHaveLength(0);
  });
});
