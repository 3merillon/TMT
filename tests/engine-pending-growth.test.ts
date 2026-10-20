import { expect, it } from 'vitest';
import { PENDING_CUT_GROW, PendingCutSet, pendingCutGrowth } from '../src/engine/scene/pending-cuts';

it('opens a pending crater with the blast: the radius eases out from nothing to full over PENDING_CUT_GROW', () => {
  const set = new PendingCutSet();
  set.add('a', [0, 18, 0], 2, 10);
  const radius = (t: number) => set.frameInput(t)[0].radius;
  expect(radius(10)).toBeCloseTo(0.02, 6);
  let last = 0;
  for (let k = 0; k <= 20; k++) { const r = radius(10 + PENDING_CUT_GROW * k / 20); expect(r).toBeGreaterThanOrEqual(last); last = r; }
  expect(radius(10 + PENDING_CUT_GROW)).toBe(2);
  expect(radius(12)).toBe(2);
  // Ease-out: most of the bowl opens early, with the fireball.
  expect(pendingCutGrowth(PENDING_CUT_GROW / 2)).toBeGreaterThan(0.85);
});
