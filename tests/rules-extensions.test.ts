/** SIM_EXTENSIONS (plan §5.5): factories build the extensions of a setup in registration order; every extension
 * implements snapshot/restore; hooks run in order at their points of the fixed tick; segment hooks can detonate a
 * shell; extension state is part of checkpoints and the match hash. */
import { describe, expect, it } from 'vitest';
import { practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { SimContext, SimExtension } from '../src/game/api/extensions';
import type { GameEvent, ImpactEvent, V3 } from '../src/game/contracts';
import { add, mul, normalize } from '../src/game/math';
import { buildExtensions, SIM_EXTENSIONS, validateExtension, type SimExtensionFactory } from '../src/game/rules/extension-registry';
import { FIXED_DT, GameSimulation, MatchReplay } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const PLAYER = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
const setup = (): MatchSetup => practiceSetup({ seed: 6, mode: 'local', player: PLAYER });

/** Counts hooks into a shared log and keeps a seeded random walk as its state. */
function recorder(id: string, log: string[]): SimExtension {
  let state = { ticks: 0, walk: 0, impacts: 0, commits: 0 };
  return {
    id,
    onMatchStart: () => { log.push(`${id}:start`); },
    onTick: (c: SimContext) => { state.ticks++; state.walk += c.rng('walk')(); if (c.tick <= 2) log.push(`${id}:tick${c.tick}`); },
    onImpact: () => { state.impacts++; log.push(`${id}:impact`); },
    onTerrainCommit: () => { state.commits++; log.push(`${id}:commit`); },
    snapshot: () => ({ ...state }),
    restore: value => { state = { ...(value as typeof state) }; },
  };
}
function run(simulation: GameSimulation, ticks: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    events.push(...simulation.step(FIXED_DT));
    if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
  }
  return [...events, ...simulation.step(0)];
}

describe('the registry', () => {
  it('starts empty in Wave 1 and is a plain append-only array of factories', () => {
    expect(Array.isArray(SIM_EXTENSIONS)).toBe(true);
    expect(buildExtensions(setup())).toEqual([]);
  });
  it('builds in registration order, skips null factories and rejects duplicates or missing snapshot/restore', () => {
    const log: string[] = [];
    const factories: SimExtensionFactory[] = [() => recorder('trees', log), () => null, s => s.mode === 'local' ? recorder('water', log) : null];
    expect(buildExtensions(setup(), factories).map(extension => extension.id)).toEqual(['trees', 'water']);
    expect(() => buildExtensions(setup(), [() => recorder('a', log), () => recorder('a', log)])).toThrow(/registered twice/);
    expect(() => validateExtension({ id: 'lazy', onTick() {} })).toThrow(/snapshot\(\) and restore\(\)/);
    expect(() => new GameSimulation(new SphereWorld(), setup(), [{ id: 'lazy', snapshot: () => null } as SimExtension])).toThrow(/snapshot\(\) and restore\(\)/);
  });
});

describe('hooks', () => {
  it('run in registration order at match start, every tick, on impact and on terrain commit', () => {
    const log: string[] = [];
    const simulation = new GameSimulation(new SphereWorld(), setup(), buildExtensions(setup(), [() => recorder('trees', log), () => recorder('water', log)]));
    expect(log).toEqual(['trees:start', 'water:start']);
    simulation.aim(0, 0, 1.1, .3); simulation.fire(0);
    run(simulation, 400);
    expect(log.slice(2, 6)).toEqual(['trees:tick1', 'water:tick1', 'trees:tick2', 'water:tick2']);
    const impact = log.indexOf('trees:impact');
    expect(log.slice(impact, impact + 4)).toEqual(['trees:impact', 'water:impact', 'trees:commit', 'water:commit']);
  });

  it('lets a segment hook detonate the shell before the terrain, in previews and live shots alike', () => {
    // A 'canopy' sphere of radius 20 around the planet: a shell falling back through it detonates on it.
    const canopy = (radius: number): SimExtension => ({
      id: 'canopy', snapshot: () => null, restore: () => {},
      traceSegment: (_c, p0, p1) => {
        const r0 = Math.hypot(...p0) - radius, r1 = Math.hypot(...p1) - radius;
        if (r0 < 0 || r1 >= 0) return null;
        const t = r0 / (r0 - r1), point = add(p0, mul([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], t));
        return { point, normal: normalize(point), t, kind: 'canopy', detonate: true };
      },
    });
    const simulation = new GameSimulation(new SphereWorld(), setup(), [canopy(20)]);
    simulation.aim(0, 0, 1.2, .8);
    const preview = simulation.preview(0);
    expect(simulation.previewPrediction(0).hit).toBe(true);
    simulation.fire(0);
    const impact = run(simulation, 300).find((event): event is ImpactEvent => event.type === 'impact')!;
    expect(Math.hypot(...impact.position)).toBeCloseTo(20, 3); // the chord-linear crossing of the canopy sphere
    expect(preview.at(-1)).toEqual(impact.position);
  });

  it('gives extensions deterministic RNG streams, events and damage through the context', () => {
    const hazard: SimExtension & { draws: number[] } = {
      id: 'lava', draws: [], snapshot: () => null, restore: () => {},
      onTick(c) {
        if (c.tick === 5) { this.draws.push(c.rng('bubble')(), c.rng('bubble')(), c.rng('other')()); c.damage(1, 30, 'lava'); c.emit({ type: 'incoming', tank: 0, impactTick: 9, predicted: [0, 18, 0] as V3 }); }
        if (c.tick === 6) c.damage(1, 500, 'lava');
      },
    };
    const again = { ...hazard, draws: [] as number[] };
    const simulation = new GameSimulation(new SphereWorld(), setup(), [hazard]);
    const events = run(simulation, 8);
    expect(simulation.state.tanks[1].health).toBe(0);
    expect(events).toContainEqual({ type: 'incoming', tank: 0, impactTick: 9, predicted: [0, 18, 0] });
    expect(events).toContainEqual({ type: 'kill', tank: 1, by: null, cause: 'lava' });
    expect(hazard.draws[0]).not.toBe(hazard.draws[1]);
    run(new GameSimulation(new SphereWorld(), setup(), [again]), 8);
    expect(again.draws).toEqual(hazard.draws);
  });
});

describe('extension state in checkpoints', () => {
  it('snapshots every extension into the checkpoint and the hash, and replays to the same state', () => {
    const log: string[] = [];
    const simulation = new GameSimulation(new SphereWorld(), setup(), [recorder('trees', log)]);
    simulation.aim(0, 0, 1.1, .3); simulation.fire(0);
    run(simulation, 300);
    const checkpoint = simulation.checkpoint();
    expect(checkpoint.extensions).toEqual({ trees: simulation.extensionSnapshots().trees });
    expect((checkpoint.extensions!.trees as { ticks: number }).ticks).toBe(simulation.state.tick);
    const replay = new MatchReplay(new SphereWorld(), checkpoint, [recorder('trees', [])]);
    for (let guard = 0; guard < 10000 && replay.advance(100) !== 'done'; guard++) if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve();
    expect(replay.verified()).toBe(true);
    expect(replay.simulation.extensionSnapshots()).toEqual(simulation.extensionSnapshots());
    const hashBefore = replay.simulation.matchHash();
    replay.simulation.restoreExtensions({ trees: { ticks: 0, walk: 0, impacts: 0, commits: 0 } });
    expect(replay.simulation.matchHash()).not.toBe(hashBefore);
    expect(() => replay.simulation.restoreExtensions({ nope: 1 })).toThrow(/No sim extension/);
  });
});
