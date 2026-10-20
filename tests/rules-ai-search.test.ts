/** Shot search (Experience §1.15 step 3): scored by expected splash damage minus self-damage, the search lobs over a
 * wall standing right in front of the bot instead of blowing itself up on it, even for a low-arc personality. */
import { describe, expect, it } from 'vitest';
import { legacyToKitIds, practiceSetup, type BotProfileId, type MatchSetup } from '../src/game/api/match';
import type { ImpactEvent, TerrainHit, V3 } from '../src/game/contracts';
import { add, distance, mul, normalize } from '../src/game/math';
import { assembleKit, kitLoadoutFromLegacy } from '../src/game/kit';
import { scoreImpact, type SearchInput } from '../src/game/ai/shot-search';
import { resolveProfile } from '../src/game/ai/profiles';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const LOADOUT = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

/** The analytic planet plus an axis-aligned slab (a wall 4 u tall, 2 u in front of a bot standing at +Y). */
class WallWorld extends SphereWorld {
  constructor(readonly min: V3 = [1.9, 16, -3], readonly max: V3 = [2.3, 22.5, 3]) { super(); }
  override isSolid(point: V3): boolean { return super.isSolid(point) || point.every((value, axis) => value >= this.min[axis] && value <= this.max[axis]); }
  override raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    const ground = super.raycast(origin, direction, maxDistance);
    let near = 0, far = maxDistance, normal: V3 = [0, 1, 0];
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(direction[axis]) < 1e-12) { if (origin[axis] < this.min[axis] || origin[axis] > this.max[axis]) return ground; continue; }
      const a = (this.min[axis] - origin[axis]) / direction[axis], b = (this.max[axis] - origin[axis]) / direction[axis];
      if (Math.min(a, b) > near) { near = Math.min(a, b); normal = [0, 0, 0]; normal[axis] = -Math.sign(direction[axis]); }
      far = Math.min(far, Math.max(a, b));
      if (near > far) return ground;
    }
    return near <= maxDistance && (!ground || near < ground.distance) ? { point: add(origin, mul(direction, near)), normal, distance: near, material: 3 } : ground;
  }
}

function walled(brain: BotProfileId): MatchSetup {
  const angle = 10 / 18.55, up: V3 = [Math.sin(angle), Math.cos(angle), 0];
  const setup: MatchSetup = { ...practiceSetup({ seed: 3, mode: 'bot', player: LOADOUT }), mode: 'skirmish',
    teams: [{ id: 0, name: 'Target', ai: false }, { id: 1, name: 'Bot', ai: true }],
    tanks: [{ team: 0, loadout: legacyToKitIds(LOADOUT), spawn: { up, heading: 0 }, maxHealth: 1000 },
      { team: 1, loadout: legacyToKitIds(LOADOUT), spawn: { up: [0, 1, 0], heading: 0 }, brain, difficulty: 'ace' }] };
  setup.rules.fog = false;
  return setup;
}

describe('self-damage avoidance', () => {
  it('scores a shot that lands on the shooter below one that misses the target', () => {
    const kit = assembleKit(kitLoadoutFromLegacy(LOADOUT));
    const self = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 1, mode: 'local', player: LOADOUT })).state.tanks[0];
    const target: V3 = [9, 15.8, 0];
    const input: SearchInput = { self, kit, munition: 'explosive', params: resolveProfile('cyborg'), aimPoint: target,
      target: { tank: 1, team: 1, visible: true, observedAt: 0, centroid: target, spread: 0, hypotheses: [{ position: target, weight: 1 }] }, allies: [] };
    const onSelf = scoreImpact(input, add(self.position, [1, -.5, 0])), wide = scoreImpact(input, add(target, [4, 0, 0])), direct = scoreImpact(input, target);
    expect(direct.score).toBeGreaterThan(wide.score);
    expect(wide.score).toBeGreaterThan(onSelf.score);
    expect(scoreImpact(input, null).score).toBeLessThan(onSelf.score);
  });

  it.each(['cyborg', 'vex'] as const)('%s lobs over a wall in front of it instead of hitting the wall', brain => {
    const world = new WallWorld();
    const simulation = new GameSimulation(world, walled(brain));
    expect(simulation.state.tanks[1].position[0]).toBeCloseTo(0, 9);
    expect(world.raycast(simulation.state.tanks[1].position, normalize([1, 0, 0]), 5)?.material).toBe(3);
    simulation.hold(0);
    let impact: ImpactEvent | undefined;
    for (let tick = 0; tick < 3000 && !impact; tick++) {
      impact = simulation.step(FIXED_DT).find((event): event is ImpactEvent => event.type === 'impact' && event.owner === 1);
      if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
    }
    expect(impact).toBeDefined();
    expect(impact!.hits!.find(hit => hit.tank === 1)?.damage ?? 0).toBe(0);
    expect(impact!.position[0]).toBeGreaterThan(2.3);
    expect(distance(impact!.position, simulation.state.tanks[0].position)).toBeLessThan(brain === 'cyborg' ? 2 : 4.5);
  }, 30000);
});
