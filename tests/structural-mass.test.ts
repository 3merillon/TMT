import { expect, it } from 'vitest';
import { convexMassProperties } from '../src/game/structural-mass';

it('integrates tetrahedral COM and principal inertia independently of Rapier face merging', () => {
  const m = convexMassProperties(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]));
  expect(m.mass).toBeCloseTo(1 / 6, 12);
  expect(m.centerOfMass).toEqual({ x: .25, y: .25, z: .25 });
  expect(Object.values(m.principalAngularInertia).sort((a, b) => a - b)).toEqual([expect.closeTo(1 / 96, 12), expect.closeTo(1 / 96, 12), expect.closeTo(1 / 60, 12)]);
  const q = m.angularInertiaLocalFrame; expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
});
