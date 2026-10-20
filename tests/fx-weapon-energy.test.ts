import { describe, expect, it } from 'vitest';
import type { InstanceInit, MeshDesc, SceneRegistry } from '../src/engine';
import { RailEnergy, WEAPON_SPARK_LIMIT } from '../src/game/presentation/rail-energy';
import type { WeaponId } from '../src/game/kit/types';

function harness(weapon: WeaponId = 'rail') {
  let serial = 0; const meshes = new Map<number, MeshDesc>(), instances = new Map<number, { mesh: number; init: InstanceInit }>(), lights = new Set<number>();
  const scene = { meshes: { create: (d: MeshDesc) => { const h = { id: serial++ }; meshes.set(h.id, d); return h; }, destroy: (h: { id: number }) => meshes.delete(h.id) },
    instances: { add: (m: { id: number }, init: InstanceInit) => { const h = { id: serial++ }; instances.set(h.id, { mesh: m.id, init: { ...init, model: init.model.slice() } }); return h; },
      set: (h: { id: number }, model: Float32Array) => { instances.get(h.id)!.init.model = model.slice(); }, setVisibility: (h: { id: number }, visibility: number) => { instances.get(h.id)!.init.visibility = visibility; }, remove: (h: { id: number }) => instances.delete(h.id) },
    lights: { add: () => { const h = { id: serial++ }; lights.add(h.id); return h; }, update() {}, remove: (h: { id: number }) => lights.delete(h.id) } } as unknown as SceneRegistry;
  return { effects: new RailEnergy(scene, weapon), meshes, instances, lights };
}
const model = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 10, 20, 30, 1]);
describe('articulated weapon energy', () => {
  it('moves particles along the rotated barrel with fixed resources and fades them when inactive', () => {
    const h = harness();
    for (let i = 0; i < 240; i++) { h.effects.update(model, 1 / 60, true, true, 10); expect(h.instances.size).toBeLessThanOrEqual(WEAPON_SPARK_LIMIT + 2); expect(h.meshes.size).toBe(5); expect(h.lights.size).toBe(1); }
    const sparks = [...h.instances.values()].filter(i => h.meshes.get(i.mesh)?.label === 'weapon:charged-particle');
    expect(sparks).toHaveLength(WEAPON_SPARK_LIMIT);
    for (const p of sparks) { expect(p.init.model[12]).toBeGreaterThan(10.3); expect(Math.abs(p.init.model[14] - 30)).toBeLessThan(.15); expect(p.init.castShadow).toBe(false); }
    h.effects.update(model, 1, false, true, 10); expect(h.instances.size).toBe(0); expect(h.lights.size).toBe(0);
    h.effects.dispose(); expect(h.meshes.size).toBe(0);
  });
  it('emits the pressure ring only after an accepted fire notification and retires all hidden effects', () => {
    const h = harness('arc_cannon'); h.effects.update(model, .1, true, true, 10);
    const rings = () => [...h.instances.values()].filter(i => h.meshes.get(i.mesh)?.label === 'weapon:muzzle-pressure-ring');
    expect(rings()).toHaveLength(0); h.effects.fire(); h.effects.update(model, .016, false, true, 10); expect(rings()).toHaveLength(1);
    h.effects.update(model, .4, false, true, 10); expect(h.instances.size).toBe(0);
    h.effects.fire(); h.effects.update(model, .016, true, false, 10); expect(h.instances.size).toBe(0); expect(h.lights.size).toBe(0); h.effects.dispose();
  });
  it('does not allocate electrical geometry for conventional guns', () => {
    const h = harness('cannon'); h.effects.fire(); h.effects.update(model, .016, true, true, 10); expect(h.meshes.size).toBe(0); expect(h.instances.size).toBe(0);
  });
});
