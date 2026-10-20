import { describe, expect, it } from 'vitest';
import { damageStage, wreckPresence } from '../src/game/presentation/vehicle-damage';
import { campaignModel } from '../src/game/presentation/campaign-models';
import type { TankState } from '../src/game/contracts';
describe('damage and campaign silhouettes', () => {
  it('makes light, heavy, burning and destroyed damage distinct', () => {
    expect([100, 75, 50, 25, 0].map(hp => damageStage(hp, 100))).toEqual([0, 1, 2, 3, 4]);
    const wreck = { health: 0, destroyedAt: 60 } as TankState;
    expect(wreckPresence(wreck, 60)).toBe(1); expect(wreckPresence(wreck, 1500)).toBe(.5);
    expect(wreckPresence(wreck, 1560)).toBe(0); expect(wreckPresence({ ...wreck, retired: true }, 61)).toBe(0);
  });
  for (const model of ['dragonfly', 'rustling', 'spire', 'skimmer', 'relay', 'watchtower'] as const) it(`${model} has finite, indexed geometry at every LOD`, () => {
    for (const lod of [0, 1, 2] as const) for (const part of campaignModel(model, lod)) {
      expect(part.positions.length).toBeGreaterThan(30); expect(part.indices.length % 3).toBe(0);
      expect([...part.positions, ...part.normals].every(Number.isFinite)).toBe(true);
      expect(Math.max(...part.indices)).toBeLessThan(part.positions.length / 3);
    }
  });
  it('grounds authored fixtures and bounds distant swarm geometry', () => {
    for (const model of ['rustling', 'spire', 'relay', 'watchtower'] as const) {
      const triangles = [0, 1, 2].map(lod => {
        const parts = campaignModel(model, lod as 0 | 1 | 2), hull = parts.find(p => p.joint === 'hull')!;
        const floor = Math.min(...Array.from(hull.positions).filter((_, i) => i % 3 === 1));
        // Simulation roots sit .5 above the surface: grounded fixtures may not hover over their feet.
        expect(floor, `${model} LOD ${lod}`).toBeGreaterThanOrEqual(-.51);
        expect(floor, `${model} LOD ${lod}`).toBeLessThanOrEqual(-.48);
        return parts.reduce((n, p) => n + p.indices.length / 3, 0);
      });
      expect(triangles[0]).toBeLessThan(10_000);
      expect(triangles[1]).toBeLessThan(triangles[0]);
      expect(triangles[2]).toBeLessThan(triangles[0] * .4);
    }
  });
});
