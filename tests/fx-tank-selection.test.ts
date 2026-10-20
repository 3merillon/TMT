import { expect, it } from 'vitest';
import type { V3 } from '../src/game/contracts';
import { practiceSetup } from '../src/game/api/match';
import { GameSimulation } from '../src/game/simulation';
import { TankViews, transformPoint } from '../src/game/presentation/tank-view';
import { SphereWorld } from './helpers/sphere-world';

it('frames all rendered tank vertices through movement, turret rotation and zoom, and drops hidden tanks', () => {
  let next = 0;
  const meshes = new Map<number, { positions: Float32Array }>();
  const instances = new Map<number, { mesh: number; model: Float32Array; visibility: number }>();
  const scene = {
    meshes: { create: (mesh: { positions: Float32Array }) => { const id = next++; meshes.set(id, mesh); return { id }; }, destroy: () => {} },
    instances: {
      add: (mesh: { id: number }, init: { model: Float32Array; visibility: number }) => {
        const id = next++; instances.set(id, { mesh: mesh.id, model: Float32Array.from(init.model), visibility: init.visibility }); return { id };
      },
      set: (handle: { id: number }, model: Float32Array) => instances.get(handle.id)!.model.set(model),
      setVisibility: (handle: { id: number }, visibility: number) => { instances.get(handle.id)!.visibility = visibility; },
      remove: (handle: { id: number }) => { instances.delete(handle.id); },
    },
    lights: { add: () => ({ id: next++ }), update: () => {}, remove: () => {} },
    get: () => undefined,
  };
  const sim = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
  const state = structuredClone(sim.state); state.tanks = [state.tanks[0]];
  const tank = state.tanks[0], views = new TankViews(scene as never);
  views.prebuild(state);
  let previous: ReturnType<TankViews['screenBounds']> = null;
  for (const zoom of [20, 40, 60]) {
    tank.position[0] += 2; tank.turretYaw += .6;
    views.beginFrame(state); views.update(state, 1 / 60, () => true, () => 150);
    const project = (point: V3): [number, number] => [400 + (point[0] + point[2] * .6) * zoom, 300 - (point[1] - point[2] * .3) * zoom];
    const box = views.screenBounds(tank.id, project)!;
    expect(box.width).toBeGreaterThan(28); expect(box.height).toBeGreaterThan(28);
    expect(box).not.toEqual(previous); previous = box;
    let checked = 0, outside = 0;
    // Compare with the geometry/matrices actually submitted for rendering, not selection's cached AABBs.
    for (const instance of instances.values()) {
      if (instance.visibility <= 0) continue;
      const positions = meshes.get(instance.mesh)!.positions;
      for (let i = 0; i < positions.length; i += 3) {
        const [x, y] = project(transformPoint(instance.model, [positions[i], positions[i + 1], positions[i + 2]]));
        if (x < box.x + 5.9 || x > box.x + box.width - 5.9 || y < box.y + 5.9 || y > box.y + box.height - 5.9) outside++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100); expect(outside).toBe(0);
  }
  views.update(state, 1 / 60, () => false, () => 150);
  expect(views.screenBounds(tank.id, () => [400, 300])).toBeNull();
  expect(views.screenBounds(999, () => [400, 300])).toBeNull();
  views.dispose();
});
