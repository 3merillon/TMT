import { afterAll, beforeAll, expect, it } from 'vitest';
import { testMatchCore } from './helpers/native-match';
import { SphereWorld } from './helpers/sphere-world';
import { NativeBallistics } from '../src/game/native-ballistics';
import { GameSimulation, FIXED_DT, MatchReplay } from '../src/game/simulation';
import { advanceFlight, type Flight } from '../src/game/rules/ballistics';
import { practiceSetup } from '../src/game/api/match';
import { sampleWind } from '../src/world/weather';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { BotObservation } from '../src/game/api/bot';
let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());
const setup = () => practiceSetup({ seed: 19, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
const close = (a: number[], b: number[], tolerance = 1e-10) => { expect(a.length).toBe(b.length); a.forEach((v, i) => expect(Math.abs(v - b[i]), `word ${i}`).toBeLessThan(tolerance)); };
const words = (f: Flight) => [...f.position, f.vx, f.vy, f.vz, f.age];

it.each([0, 7, 0x80000000, 0xffffffff])('matches weather and 480-step flight arithmetic for seed %s', seed => {
  const s = setup(); s.seed = seed; s.rules.wind = { mean: 3, gust: 1.5, period: 5 };
  const n = new NativeBallistics(core, s, 9.8, 18);
  try {
    for (const tick of [0, 1, 59, 600, 12345, 1e12]) {
      const a = n.windAt(tick)!, b = sampleWind(seed, tick, s.rules.wind); close([a.strength, a.bars, a.heading, ...a.axis], [b.strength, b.bars, b.heading, ...b.axis], 1e-12);
    }
    for (const factor of [0, .2, .6, 1, 2]) {
      const a: Flight = { position: [1, 19, -2], vx: 1, vy: 14, vz: 8, age: 0, launchTick: 379 };
      const b = structuredClone(a);
      for (let tick = 0; tick < 480; tick++) {
        n.advance(a, 2, factor); advanceFlight(b, { gravity: 9.8, wind: t => sampleWind(seed, t, s.rules.wind!), windFactor: factor }); close(words(a), words(b));
      }
      n.release(a);
    }
    expect(n.retainedFlights()).toBe(0);
  } finally { n.dispose(); }
});

it('keeps flight state resident and a bad/stale query cannot advance it', () => {
  const n = new NativeBallistics(core, setup(), 9.8, 18), a: Flight = { position: [0, 20, 0], vx: 1, vy: 2, vz: 3, age: 0 }, b = structuredClone(a);
  try {
    n.advance(a, 1, 0); n.advance(b, 1, 0); const before = words(a);
    expect(() => n.advance(a, 1, 0, { core, id: 0xffffffff, kind: 1, range: 100 })).toThrow('Unknown query snapshot');
    expect(words(a)).toEqual(before);
    a.position = [NaN, NaN, NaN]; a.vx = a.vy = a.vz = a.age = NaN;
    n.advance(a, 1, 0); n.advance(b, 1, 0); expect(a).toEqual(b);
    n.release(a); n.release(b); expect(n.retainedFlights()).toBe(0);
  } finally { n.dispose(); }
});

it('releases previews, partial traces, aim searches and live flights; a windy save replays exactly', () => {
  const s = setup(); s.rules.wind = { mean: 3, gust: 2, period: 4 }; s.rules.moveSeconds = .1;
  let n!: NativeBallistics;
  const w = new SphereWorld(); w.createBallistics = (s, g) => n = new NativeBallistics(core, s, g, w.radius);
  const sim = new GameSimulation(w, s);
  try {
    sim.state.tanks[1].position = [0, -18.55, 0];
    for (let i = 0; i < 20; i++) { sim.aim(0, i * .1, .7, .4); sim.previewPrediction(0, false); expect(n.retainedFlights()).toBe(0); }
    sim.solveAimTarget(0, [1, 18, 1]); expect(n.retainedFlights()).toBe(0);
    const o = (sim as unknown as { observe(id: number): BotObservation }).observe(0);
    const trace = o.trace!(1, .8, .4, 'explosive'); expect(trace.step()).not.toBeNull(); expect(n.retainedFlights()).toBe(1);
    sim.hold(0); expect(trace.done).toBe(true); expect(n.retainedFlights()).toBe(0);
  } finally { sim.dispose(); }
  const fresh = new SphereWorld(); fresh.createBallistics = (s, g) => n = new NativeBallistics(core, s, g, fresh.radius);
  const live = new GameSimulation(fresh, s);
  live.aim(0, .7, .8, .3); live.fire(0);
  for (let i = 0; i < 300; i++) { live.step(FIXED_DT); if (live.stalledOn?.serial) live.completeLegacyCarve(); }
  expect(n.retainedFlights()).toBe(0);
  const rw = new SphereWorld(); rw.createBallistics = (s, g) => new NativeBallistics(core, s, g, rw.radius);
  const replay = new MatchReplay(rw, live.checkpoint());
  for (let i = 0; i < 500 && !replay.done; i++) { replay.advance(10); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); }
  expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); live.dispose(); replay.simulation.dispose();
});
