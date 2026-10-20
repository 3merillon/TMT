import { describe, expect, it } from 'vitest';
import { lensFovY, lensToScene, sceneToLens } from '../src/engine/passes/post/lens';

describe('fisheye projection and aiming', () => {
  it('round-trips rendered points and mouse picks across strengths and aspect ratios', () => {
    for (const size of [[1280, 720], [390, 844], [1024, 1024]] as const) {
      for (const strength of [-0.6, -0.15, 0, 0.15, 0.6]) for (const uv of [[0, 0], [0.5, 0.5], [0.2, 0.7], [1, 1]]) {
        const point: [number, number] = [uv[0] * size[0], uv[1] * size[1]];
        const scene = lensToScene(point, size, strength), projected = sceneToLens(scene, size, strength);
        expect(projected[0]).toBeCloseTo(point[0], 7); expect(projected[1]).toBeCloseTo(point[1], 7);
        expect(scene[0]).toBeGreaterThanOrEqual(-0.001); expect(scene[0]).toBeLessThanOrEqual(size[0] + 0.001);
        expect(scene[1]).toBeGreaterThanOrEqual(-0.001); expect(scene[1]).toBeLessThanOrEqual(size[1] + 0.001);
      }
    }
  });
  it('curves off-axis straight lines instead of merely zooming the image', () => {
    const size = [1000, 1000] as const;
    const middle = sceneToLens([700, 500], size, 0.6);
    const end = sceneToLens([700, 800], size, 0.6);
    expect(middle[0] - end[0]).toBeGreaterThan(15);
    expect(sceneToLens([700, 500], size, 0)).toEqual([700, 500]);
    expect(sceneToLens([500, 500], size, 0.6)).toEqual([500, 500]);
    expect(sceneToLens([700, 500], size, -0.6)[0]).toBeLessThan(sceneToLens([700, 800], size, -0.6)[0]);
    expect(lensFovY(Math.PI / 4, -0.6)).toBeGreaterThan(Math.PI / 4);
    expect(lensFovY(Math.PI / 4, 0)).toBeCloseTo(Math.PI / 4);
  });
});
