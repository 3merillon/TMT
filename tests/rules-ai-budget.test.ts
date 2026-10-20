/** AI budget (plan §3 amendments): brains are time-sliced at ≤ 48 trace steps per tick (one raycast each), counted
 * independently through the observation, and every personality still decides within 6 s of its turn. */
import { describe, expect, it } from 'vitest';
import { legacyToKitIds, practiceSetup, type BotProfileId, type Difficulty, type MatchSetup } from '../src/game/api/match';
import type { BallisticTrace, BotObservation } from '../src/game/api/bot';
import type { V3 } from '../src/game/contracts';
import { AI_TRACE_BUDGET, FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const LOADOUT = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

function duel(brain: BotProfileId, difficulty: Difficulty, seed: number): MatchSetup {
  return { ...practiceSetup({ seed, mode: 'bot', player: LOADOUT }), mode: 'skirmish',
    teams: [{ id: 0, name: 'A', ai: true }, { id: 1, name: 'B', ai: true }],
    tanks: [0, 1].map(team => ({ team, loadout: legacyToKitIds(LOADOUT), spawn: 'auto' as const, brain, difficulty })) };
}

/** Counts every ray a brain spends through its observation, per simulation tick (a trace made in one tick may be
 * stepped in later ones, so the tick is read at each call). */
function counter() {
  const perTick = new Map<number, number>();
  const clock = { now: () => 0 };
  const spend = (_created: number, amount: number) => { const tick = clock.now(); perTick.set(tick, (perTick.get(tick) ?? 0) + amount); };
  const wrap = (o: BotObservation): BotObservation => ({
    ...o,
    world: { get radius() { return o.world.radius; }, isSolid: (p: V3) => o.world.isSolid(p),
      raycast: (origin: V3, direction: V3, max: number) => { spend(o.tick, 1); return o.world.raycast(origin, direction, max); },
      surface: (direction: V3) => { spend(o.tick, 1); return o.world.surface(direction); } },
    trace: (yaw, pitch, power, munition, launchTick) => {
      const trace = o.trace!(yaw, pitch, power, munition, launchTick);
      let first = true;
      return { get done() { return trace.done; }, get impact() { return trace.impact; }, get steps() { return trace.steps; },
        step: () => { const step = trace.step(); if (step) { spend(o.tick, first ? 2 : 1); first = false; } return step; } } satisfies BallisticTrace;
    },
  });
  return { perTick, wrap, clock };
}

describe('time slicing', () => {
  it.each([['rusty', 'ace'], ['tosser', 'ace'], ['vex', 'ace'], ['cyborg', 'ace'], ['legacy', 'normal']] as const)(
    '%s (%s) never spends more than 48 trace steps in a tick and decides within 6 s', (brain, difficulty) => {
      const { perTick, wrap, clock } = counter();
      const simulation = new GameSimulation(new SphereWorld(), duel(brain, difficulty, 17), [], { wrapObservation: wrap });
      clock.now = () => simulation.state.tick;
      let turnTick = 0, longest = 0, decisions = 0;
      for (let tick = 0; tick < 60 * 60 * 2 && simulation.state.phase !== 'finished'; tick++) {
        for (const event of simulation.step(FIXED_DT)) {
          if (event.type === 'turn') turnTick = simulation.state.tick;
          if (event.type === 'shot') { longest = Math.max(longest, simulation.state.tick - turnTick); decisions++; }
        }
        if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
      }
      expect(AI_TRACE_BUDGET).toBe(48);
      expect(decisions).toBeGreaterThanOrEqual(2);
      expect(Math.max(...perTick.values())).toBeLessThanOrEqual(48);
      expect(simulation.aiTelemetry().peakStepsPerTick).toBeLessThanOrEqual(48);
      expect(longest).toBeLessThanOrEqual(6 * 60);
    }, 60000);

  it('never queries the ground past a spent budget, even for a heard-shot guess', () => {
    // The brain only heard a shot (no sighting): its belief is a guess along the bearing, which needs a ground query,
    // and so does the aim point. With the tick's budget spent, both fall back to the planet radius instead.
    const simulation = new GameSimulation(new SphereWorld(), duel('tosser', 'normal', 3));
    let o: BotObservation | undefined;
    const spy = new GameSimulation(new SphereWorld(), duel('tosser', 'normal', 3), [], { wrapObservation: (observation, tank) => { if (tank === 0) o ??= observation; return observation; } });
    for (let tick = 0; tick < 60 && !o; tick++) spy.step(FIXED_DT);
    expect(o).toBeDefined();
    let queries = 0;
    const observation: BotObservation = { ...o!, visible: [], lastKnown: [], sounds: [{ bearing: .4, tick: o!.tick }],
      world: { get radius() { return o!.world.radius; }, isSolid: p => o!.world.isSolid(p),
        raycast: (origin, direction, max) => { queries++; return o!.world.raycast(origin, direction, max); },
        surface: direction => { queries++; return o!.world.surface(direction); } },
      trace: () => ({ done: false, impact: null, steps: 0, step: () => null }) };
    const brain = simulation.brainFor(0)!, heard = { ...observation, self: { ...observation.self, charge: 0 } }; // no radar
    brain.begin(heard);
    expect(brain.step(heard, { traceSteps: 0 })).toBeNull(); // still thinking: the search waits for the next tick
    expect(queries).toBe(0);
    brain.begin(heard);
    expect(brain.step(heard, { traceSteps: 5 })).toBeNull();
    expect(queries).toBe(2); // with budget left: the heard-shot guess and the aim point
  });

  it('spreads a search over many ticks instead of spending it at once', () => {
    const { perTick, wrap, clock } = counter();
    const simulation = new GameSimulation(new SphereWorld(), duel('cyborg', 'ace', 5), [], { wrapObservation: wrap });
    clock.now = () => simulation.state.tick;
    for (let tick = 0; tick < 400 && !simulation.aiTelemetry().decisions; tick++) simulation.step(FIXED_DT);
    const busy = [...perTick.values()].filter(steps => steps >= 40).length;
    expect(busy).toBeGreaterThan(20);
    expect([...perTick.values()].reduce((sum, steps) => sum + steps, 0)).toBeGreaterThan(48 * 20);
  });
});
