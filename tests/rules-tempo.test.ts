import { setCombatState } from './helpers/native-match';
/** Tempo timeline core (rules/tempo.ts): equal builds alternate exactly; ties go to the player team, then the lower id. */
import { describe, expect, it } from 'vitest';
import { ACTION_COST, advanceReady, nextActor, previewTimeline, type TimelineUnit } from '../src/game/rules/tempo';
import { legacyToKitIds, practiceSetup, type MatchSetup } from '../src/game/api/match';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const unit = (id: number, readyAt: number, playerTeam = false, alive = true): TimelineUnit => ({ id, readyAt, playerTeam, alive });

describe('nextActor', () => {
  it('picks the lowest readyAt, breaking ties by player team and then the lower id', () => {
    expect(nextActor([unit(0, 100), unit(1, 50), unit(2, 75)])).toBe(1);
    expect(nextActor([unit(0, 0), unit(1, 0, true), unit(2, 0)])).toBe(1);
    expect(nextActor([unit(2, 0), unit(1, 0), unit(3, 0)])).toBe(1);
    expect(nextActor([unit(0, 0, true), unit(1, 0, true)])).toBe(0);
    expect(nextActor([unit(0, 0, true, false), unit(1, 10)])).toBe(1);
    expect(nextActor([unit(0, 0, true, false)])).toBeNull();
  });
  it('charges cost × tempo, with a fire costing 100 TU', () => {
    expect(ACTION_COST.fire).toBe(100);
    expect(advanceReady(0, 'fire', 1)).toBe(100);
    expect(advanceReady(100, 'fire', 1.01)).toBeCloseTo(201, 12);
    expect(() => advanceReady(0, 'fire', 0)).toThrow(/Tempo/);
  });
  it('alternates equal builds exactly and lets a faster build act more often', () => {
    expect(previewTimeline([unit(0, 0, true), unit(1, 0)], () => 1, 8)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(previewTimeline([unit(0, 0), unit(1, 0), unit(2, 0)], () => 1, 6)).toEqual([0, 1, 2, 0, 1, 2]);
    // Tempo 0.5 acts twice per slow unit's once (ties at 100 go to the player team).
    expect(previewTimeline([unit(0, 0, true), unit(1, 0)], id => id === 1 ? .5 : 1, 7)).toEqual([0, 1, 1, 0, 1, 1, 0]);
  });
});

describe('the simulation follows the timeline', () => {
  /** Plays shots straight up (self-harmless misses are not guaranteed, so health is restored) and records who acted. */
  function actors(setup: MatchSetup, turns: number): number[] {
    const simulation = new GameSimulation(new SphereWorld(), setup);
    const order: number[] = [simulation.state.active];
    for (let tick = 0; tick < 200000 && order.length < turns; tick++) {
      const active = simulation.state.active;
      if (simulation.state.phase === 'aim' && simulation.brainOf(active) === null) {
        simulation.aim(active, 0, 1.2, .05); simulation.fire(active); simulation.endMove(active);
      }
      for (const event of simulation.step(FIXED_DT)) if (event.type === 'turn') order.push(event.player);
      if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
      // Isolate turn ordering from combat: restore both hull and machinery after self-inflicted hits.
      for (const tank of simulation.state.tanks) { setCombatState(simulation, tank.id, { health: tank.maxHealth! }); delete tank.machinery; }
    }
    return order;
  }

  it('reproduces strict alternation for two equal builds (bot duel and pass-and-play)', () => {
    expect(actors(practiceSetup({ seed: 5, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }), 8)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(actors(practiceSetup({ seed: 5, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }), 6)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('gives the player team the first turn even when an AI tank has the lower id', () => {
    const setup = practiceSetup({ seed: 5, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.teams = [{ id: 0, name: 'AI', ai: true }, { id: 1, name: 'You', ai: false }];
    setup.tanks = [
      { team: 0, loadout: legacyToKitIds({ tracks: 'scout', barrel: 'mortar', armor: 'light' }), spawn: 'auto', brain: 'legacy' },
      { team: 1, loadout: legacyToKitIds({ tracks: 'scout', barrel: 'mortar', armor: 'light' }), spawn: 'auto' },
    ];
    expect(actors(setup, 4)).toEqual([1, 0, 1, 0]);
  });

  it('rotates through every living tank of a four-way match in id order', () => {
    const player = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
    const setup: MatchSetup = { ...practiceSetup({ seed: 5, mode: 'local', player }), mode: 'skirmish',
      teams: [0, 1, 2, 3].map(id => ({ id, name: `P${id}`, ai: false })),
      tanks: [0, 1, 2, 3].map(team => ({ team, loadout: legacyToKitIds(player), spawn: 'auto' as const })) };
    expect(actors(setup, 8)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });
});
