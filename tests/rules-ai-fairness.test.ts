/** AI fairness (Experience §1.15): brains see observations only. The harness wraps every observation and its world
 * in throwing proxies (any read outside the observation API throws) and plays full matches with every profile; the
 * observation itself never carries a hidden tank's true position. */
import { describe, expect, it } from 'vitest';
import { legacyToKitIds, practiceSetup, type BotProfileId, type MatchSetup } from '../src/game/api/match';
import type { BotObservation } from '../src/game/api/bot';
import type { V3 } from '../src/game/contracts';
import { distance } from '../src/game/math';
import { bearingTo } from '../src/game/ai/shot-search';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const LOADOUT = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
const OBSERVATION_KEYS = ['tick', 'self', 'rules', 'wind', 'visible', 'lastKnown', 'sounds', 'world', 'predict', 'trace', 'phaseTime', 'impacts'];
const WORLD_KEYS = ['radius', 'raycast', 'surface', 'isSolid'];

/** Any property outside the allow-list throws: a brain that reached for hidden state would crash the match. */
function guard<T extends object>(target: T, allowed: readonly string[], label: string): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string' && !allowed.includes(key)) throw new Error(`fairness: a brain read ${label}.${key}`);
      return Reflect.get(object, key, receiver);
    },
    set(_object, key) { throw new Error(`fairness: a brain wrote ${label}.${String(key)}`); },
    ownKeys() { throw new Error(`fairness: a brain enumerated ${label}`); },
  });
}
const harness = (o: BotObservation): BotObservation => guard({ ...o, world: guard(o.world, WORLD_KEYS, 'world') }, OBSERVATION_KEYS, 'observation');

function botMatch(brains: [BotProfileId, BotProfileId], seed: number, change: (setup: MatchSetup) => void = () => {}): MatchSetup {
  const setup: MatchSetup = { ...practiceSetup({ seed, mode: 'bot', player: LOADOUT }), mode: 'skirmish',
    teams: [{ id: 0, name: 'A', ai: true }, { id: 1, name: 'B', ai: true }],
    tanks: brains.map((brain, team) => ({ team, loadout: legacyToKitIds(LOADOUT), spawn: 'auto' as const, brain, difficulty: 'normal' as const })) };
  change(setup);
  return setup;
}

describe('the fairness harness', () => {
  it.each([['rusty', 'tosser'], ['vex', 'cyborg'], ['legacy', 'tosser']] as const)('never throws in a full %s vs %s match', (a, b) => {
    const simulation = new GameSimulation(new SphereWorld(), botMatch([a, b], 13), [], { wrapObservation: harness });
    let shots = 0;
    for (let tick = 0; tick < 60 * 60 * 3 && simulation.state.phase !== 'finished'; tick++) {
      for (const event of simulation.step(FIXED_DT)) if (event.type === 'shot') shots++;
      if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
    }
    expect(shots).toBeGreaterThanOrEqual(2);
    expect(simulation.state.phase === 'finished' || shots >= 6).toBe(true);
  }, 60000);

  it('holds only permitted information: no hidden position, a detached self and a four-member world', () => {
    const seen: BotObservation[] = [];
    const setup = practiceSetup({ seed: 4, mode: 'bot', player: LOADOUT });
    setup.tanks[1].brain = 'tosser';
    const simulation = new GameSimulation(new SphereWorld(), setup, [], { wrapObservation: o => { seen.push(o); return o; } });
    const sighting = [...simulation.state.observations![1][0]!.position] as V3;
    // The player drives out of sight: the brain keeps the last sighting, never the live position.
    simulation.state.tanks[0].position = [0, -18.55, 0];
    simulation.hold(0);
    for (let tick = 0; tick < 240 && !seen.length; tick++) simulation.step(FIXED_DT);
    for (let tick = 0; tick < 10; tick++) simulation.step(FIXED_DT);
    const o = seen.at(-1)!;
    expect(Object.keys(o).sort()).toEqual([...OBSERVATION_KEYS].sort());
    expect(Object.keys(o.world).sort()).toEqual([...WORLD_KEYS].sort());
    expect(o.visible.some(entry => entry.tank === 0)).toBe(false);
    const known = o.lastKnown.find(entry => entry.tank === 0)!;
    expect(known.position).toEqual(sighting);
    expect(distance(known.position, simulation.state.tanks[0].position)).toBeGreaterThan(10);
    expect(known.uncertainty).toBeGreaterThan(0);
    (o.self.position as number[])[0] = 1234;
    expect(simulation.state.tanks[1].position[0]).not.toBe(1234);
  });

  it('predicts and traces terrain only: a tank parked on the path changes nothing', () => {
    let observation: BotObservation | null = null;
    const setup = practiceSetup({ seed: 4, mode: 'bot', player: LOADOUT });
    setup.tanks[1].brain = 'cyborg';
    const simulation = new GameSimulation(new SphereWorld(), setup, [], { wrapObservation: o => (observation ??= o) });
    simulation.hold(0);
    for (let tick = 0; tick < 5 && !observation; tick++) simulation.step(FIXED_DT);
    const o = observation!, target = o.visible.find(entry => entry.tank === 0)!.position;
    const yaw = bearingTo(o.self, target);
    const first = o.predict(yaw, .7, .5, 'explosive');
    expect(first.impact).not.toBeNull();
    simulation.state.tanks[0].position = [...first.path[Math.floor(first.path.length / 2)]];
    expect(o.predict(yaw, .7, .5, 'explosive')).toEqual(first);
    // The metered trace pauses when a tick's 48 steps are spent and resumes on the next tick.
    const trace = o.trace!(yaw, .7, .5, 'explosive');
    for (let guardSteps = 0; guardSteps < 5000 && !trace.done; guardSteps++) if (!trace.step()) simulation.step(FIXED_DT);
    expect(trace.impact).toEqual(first.impact);
    expect(trace.steps).toBe(first.flightTicks);
  });
});
