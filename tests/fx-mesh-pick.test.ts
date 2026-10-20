import { describe, expect, it } from 'vitest';
import type { SceneRegistry } from '../src/engine';
import { rayMeshDistance } from '../src/game/presentation/mesh-pick';
import { composeTRS, TankViews } from '../src/game/presentation/tank-view';
import { GameSimulation } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import { SphereWorld } from './helpers/sphere-world';

describe('rendered mesh picking', () => {
  const mesh = { positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };

  it('retains world distance through a translated, rotated and nonuniformly scaled affine transform', () => {
    const model = composeTRS([0, 2, 3], [0, Math.sin(.3), 0, Math.cos(.3)]);
    for (let axis = 0; axis < 3; axis++) for (let row = 0; row < 3; row++) model[axis * 4 + row] *= [2, .5, 3][axis];
    expect(rayMeshDistance(mesh, model, [0, 2, -10], [0, 0, 1], 30)).toBeCloseTo(13, 9);
    expect(rayMeshDistance(mesh, model, [0, 2, -10], [0, 0, 1], 12)).toBeNull();
    expect(rayMeshDistance(mesh, model, [0, 2, 10], [0, 0, 1], 30)).toBeNull();
  });

  it('rejects part bounds before visiting triangles, then rejects a point outside the actual triangle', () => {
    const model = composeTRS([0, 0, 0], [0, 0, 0, 1]), work = { parts: 0, bounds: 0, triangles: 0 };
    expect(rayMeshDistance(mesh, model, [2, 0, -10], [0, 0, 1], 30, work)).toBeNull();
    expect(work).toEqual({ parts: 1, bounds: 0, triangles: 0 });
    expect(rayMeshDistance(mesh, model, [.9, .9, -10], [0, 0, 1], 30, work)).toBeNull();
    expect(work).toEqual({ parts: 2, bounds: 1, triangles: 1 });
    expect(rayMeshDistance(mesh, model, [0, 0, -10], [0, 0, 1], 30, work)).toBe(10);
  });

  it('picks the active tank mesh and animation pose without admitting an unobserved tank', () => {
    let id = 0;
    const scene = { meshes: { create: () => ({ id: id++ }), destroy() {} },
      instances: { add: () => ({ id: id++ }), set() {}, setVisibility() {}, remove() {} }, get: () => undefined } as unknown as SceneRegistry;
    const views = new TankViews(scene);
    const simulation = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    const state = structuredClone(simulation.state), tank = state.tanks[1];
    tank.position = [0, 0, 0]; tank.rotation = [0, 0, 0, 1];
    views.update(state, 1 / 60, candidate => candidate.id === tank.id, () => 100);
    views.beginAimPick();
    const hit = views.pickSurface(tank.id, [0, 6, 0], [0, -1, 0], 12);
    expect(hit).not.toBeNull(); expect(hit).toBeGreaterThan(4); expect(hit).toBeLessThan(6);
    const work = views.aimPickStats();
    expect(work.parts).toBeGreaterThan(20); expect(work.bounds).toBeLessThan(work.parts / 2);
    expect(work.triangles).toBeGreaterThan(0);
    expect(views.pickSurface(999, [0, 6, 0], [0, -1, 0], 12)).toBeNull();
    views.update(state, 1 / 60, () => false, () => 100);
    expect(views.pickSurface(tank.id, [0, 6, 0], [0, -1, 0], 12)).toBeNull();
    views.dispose();
  });
});
