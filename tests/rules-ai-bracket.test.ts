/** Bracketing memory (Experience §1.15 step 4): a Normal Tosser shooting at a static, visible target zeroes in:
 * by its third shot it lands within 1.5 u, and its spread shrinks shot by shot. */
import { beforeAll, describe, expect, it } from 'vitest';
import { legacyToKitIds, practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { ImpactEvent, V3 } from '../src/game/contracts';
import { distance, normalize } from '../src/game/math';
import type { ProfileBrain } from '../src/game/ai/brain';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const LOADOUT = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

/** The bot at +Y and a sturdy player tank 7–12 u away that holds every turn (a static target in the open). */
function staticTarget(seed: number): MatchSetup {
  const angle = (7 + seed % 6) / 18.55, bearing = seed * 1.7;
  const up: V3 = normalize([Math.sin(angle) * Math.cos(bearing), Math.cos(angle), Math.sin(angle) * Math.sin(bearing)]);
  const setup: MatchSetup = { ...practiceSetup({ seed, mode: 'bot', player: LOADOUT }), mode: 'skirmish',
    teams: [{ id: 0, name: 'Target', ai: false }, { id: 1, name: 'Tosser', ai: true }],
    tanks: [{ team: 0, loadout: legacyToKitIds(LOADOUT), spawn: { up, heading: 0 }, maxHealth: 100000 },
      { team: 1, loadout: legacyToKitIds(LOADOUT), spawn: { up: [0, 1, 0], heading: 0 }, brain: 'tosser', difficulty: 'normal' }] };
  setup.rules.fog = false;
  return setup;
}

function threeShots(seed: number): { misses: number[]; spreads: number[] } {
  const simulation = new GameSimulation(new SphereWorld(), staticTarget(seed));
  const misses: number[] = [], spreads: number[] = [];
  for (let tick = 0; tick < 20000 && misses.length < 3; tick++) {
    if (simulation.state.phase === 'aim' && simulation.state.active === 0) simulation.hold(0);
    for (const event of simulation.step(FIXED_DT)) {
      if (event.type === 'shot' && event.player === 1) spreads.push((simulation.brainFor(1) as ProfileBrain).lastDecision!.spreadScale);
      if (event.type === 'impact' && event.owner === 1) misses.push(distance((event as ImpactEvent).position, simulation.state.tanks[0].position));
    }
    if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
  }
  return { misses, spreads };
}

describe('bracket convergence', () => {
  let runs: { misses: number[]; spreads: number[] }[] = [];
  beforeAll(() => { runs = Array.from({ length: 20 }, (_, index) => threeShots(index + 1)); }, 120000);
  it('lands the third shot within 1.5 u of a static target (Normal Tosser, 18 of 20 seeds at least)', () => {
    for (const run of runs) expect(run.misses).toHaveLength(3);
    expect(runs.filter(run => run.misses[2] <= 1.5).length).toBeGreaterThanOrEqual(18);
  });
  it('zeroes in: the mean miss falls from the first shot to the third', () => {
    const mean = (shot: number) => runs.reduce((sum, run) => sum + run.misses[shot], 0) / runs.length;
    expect(mean(2)).toBeLessThan(mean(0));
    expect(mean(2)).toBeLessThan(1.2);
  });
  it('shrinks the personality spread as the bracket closes: ×1, ×0.5, ×0.25', () => {
    for (const run of runs) expect(run.spreads).toEqual([1, .5, .25]);
  });
});
