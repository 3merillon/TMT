import { describe, expect, it } from 'vitest';
import type { MeshDesc, Vec3 } from '../src/engine';
import { transform } from '../src/game/workshop/geometry';
import { meshesIntersect, meshesIntersectWithoutBroadphase } from './workshop-geometry-audit';

const cube: MeshDesc = {
  positions: Float32Array.of(-.5, -.5, -.5, .5, -.5, -.5, .5, .5, -.5, -.5, .5, -.5, -.5, -.5, .5, .5, -.5, .5, .5, .5, .5, -.5, .5, .5),
  normals: new Float32Array(24),
  indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2),
};
const triangle: MeshDesc = { positions: Float32Array.of(-.8, -.2, 0, .8, -.2, .1, 0, .9, -.1), normals: new Float32Array(9), indices: Uint32Array.of(0, 1, 2) };
const identity = transform([0, 0, 0]);

describe('workshop triangle audit broadphase', () => {
  it('preserves face contact and the existing one-microunit touching tolerance', () => {
    for (const [x, touching] of [[.8, true], [1, true], [1 + 5e-7, true], [1 + 2e-6, false], [5, false]] as const) {
      const moved = transform([x, 0, 0]);
      expect(meshesIntersect(cube, identity, cube, moved), `x=${x}`).toBe(touching);
      expect(meshesIntersect(cube, identity, cube, moved)).toBe(meshesIntersectWithoutBroadphase(cube, identity, cube, moved));
    }
  });

  it('matches every original triangle query across rotated, scaled and mirrored rigid frames', () => {
    const sizes: Vec3[] = [[1, 1, 1], [.2, 2, .7], [-1, .4, 1.3]];
    const rotations: Vec3[] = [[0, 0, 0], [.3, .7, -.2], [Math.PI / 2, .2, .9]];
    for (const a of [cube, triangle]) for (const b of [cube, triangle]) for (const size of sizes) for (const rotation of rotations) {
      const am = transform([.3, -.4, .2], size, rotation);
      for (let i = -8; i <= 8; i++) {
        const bm = transform([i * .21, i * .07, -.15], [.7, 1.2, .6], [-.2, .4, .3]);
        expect(meshesIntersect(a, am, b, bm), `offset=${i} size=${size} rotation=${rotation}`).toBe(meshesIntersectWithoutBroadphase(a, am, b, bm));
      }
    }
  });

  it('reads an in-place transform update instead of caching stale separation', () => {
    const model = transform([5, 0, 0]);
    expect(meshesIntersect(cube, identity, cube, model)).toBe(false);
    model[12] = .9;
    expect(meshesIntersect(cube, identity, cube, model)).toBe(true);
    model[12] = -5;
    expect(meshesIntersect(cube, identity, cube, model)).toBe(false);
  });
});
