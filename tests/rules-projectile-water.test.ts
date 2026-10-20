import { afterAll, beforeAll, expect, it } from 'vitest';
import { advanceFlight, FIXED_DT, type Flight } from '../src/game/rules/ballistics';
import { projectileWater, PROJECTILE_WATER_DRAG } from '../src/game/rules/projectile-water';
import type { BasinSolution } from '../src/world/basins';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import { NativeBallistics } from '../src/game/native-ballistics';
import { GameSimulation, MatchReplay } from '../src/game/simulation';
import { RealtimeMatch } from '../src/game/realtime/match';
import { practiceSetup } from '../src/game/api/match';
import { validateRules } from '../src/game/rules/setup';
import { SphereWorld } from './helpers/sphere-world';
import { testMatchCore } from './helpers/native-match';
import './helpers/realtime';
import { sampleWind } from '../src/world/weather';

const basins = (level = 25): BasinSolution => ({ n: 4, labels: new Uint8Array(96).fill(1), seaLevel: level,
  basins: [{ id: 1, kind: 'sea', material: 'water', level, floor: 18, spill: level, cells: 96, area: 1, volume: 1 }] });
const flight = (position: [number, number, number] = [0, 20, 0], velocity = [30, 0, 0]): Flight => ({ position, vx: velocity[0], vy: velocity[1], vz: velocity[2], age: 0 });
const speed = (f: Flight) => Math.hypot(f.vx, f.vy, f.vz);
const setup = () => practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());

it('uses the quadratic-drag solution without reversing or adding energy at high speed', () => {
  for (const v of [1, 30, 300, 1200]) {
    const f = flight([0, 20, 0], [v, 0, 0]);
    advanceFlight(f, { gravity: 0, wind: null, windFactor: 0, water: projectileWater(basins(90)) });
    expect(f.vx).toBeCloseTo(v / (1 + PROJECTILE_WATER_DRAG * v * FIXED_DT), 9);
    expect(f.position[0]).toBeCloseTo(Math.log1p(PROJECTILE_WATER_DRAG * v * FIXED_DT) / PROJECTILE_WATER_DRAG, 10);
    expect(f.vx).toBeGreaterThan(0); expect(speed(f)).toBeLessThan(v);
  }
});

it('handles entry, grazing and exit within a tick and retains lost speed in air', () => {
  const water = projectileWater(basins(20));
  const entering = flight([0, 20.1, 0], [0, -60, 0]);
  advanceFlight(entering, { gravity: 0, wind: null, windFactor: 0, water });
  expect(entering.position[1]).toBeGreaterThan(19.1); expect(speed(entering)).toBeLessThan(40);
  const exiting = flight([0, 19.9, 0], [0, 60, 0]);
  advanceFlight(exiting, { gravity: 0, wind: null, windFactor: 0, water });
  expect(exiting.position[1]).toBeGreaterThan(20);
  const lost = speed(exiting); expect(lost).toBeLessThan(60);
  advanceFlight(exiting, { gravity: 0, wind: null, windFactor: 0, water }); expect(speed(exiting)).toBeCloseTo(lost, 12);
  const grazing = flight([-1, 19.999, 0], [120, 0, 0]);
  advanceFlight(grazing, { gravity: 0, wind: null, windFactor: 0, water }); expect(speed(grazing)).toBeLessThan(120);
});

it('keeps dry arithmetic exact, excludes lava and suppresses atmospheric wind underwater', () => {
  const a = flight([0, 30, 0]), b = structuredClone(a);
  const env = { gravity: 9.8, wind: null, windFactor: 0 };
  advanceFlight(a, env); advanceFlight(b, { ...env, water: projectileWater(basins()) }); expect(a).toEqual(b);
  const lava = basins(); expect(projectileWater({ ...lava, basins: lava.basins.map(b => ({ ...b, material: 'lava' })) })).toBeUndefined();
  const wet = flight(), still = structuredClone(wet);
  const water = projectileWater(basins());
  advanceFlight(still, { ...env, water });
  advanceFlight(wet, { ...env, water, windFactor: 1, wind: tick => ({ tick, strength: 20, bars: 5, heading: 0, axis: [1, 0, 0] }) });
  expect(wet).toEqual(still);
});

it('matches native integration through water, cube seams and surface transitions', () => {
  const s = setup(); s.rules.wind = { mean: 3, gust: 1, period: 5 };
  // Non-uniform map exercises face ownership and both wet/dry basin edges.
  const solution = basins(20); solution.labels.fill(0, 0, 32);
  const water = projectileWater(solution), native = new NativeBallistics(core, s, 9.8, 18); native.configureWater(water);
  try {
    for (const p of [[0, 20.1, 0], [14, 14, .1], [-14, -14, .1], [.1, 14, -14], [0, 19, 0]] as [number, number, number][]) {
      const a = flight(p, [20, -4, 17]), b = structuredClone(a);
      for (let tick = 0; tick < 180; tick++) {
        native.advance(a, 1, .8); advanceFlight(b, { gravity: 9.8, wind: tick => sampleWind(s.seed, tick, s.rules.wind!), windFactor: .8, water });
        [...a.position, a.vx, a.vy, a.vz, a.age].forEach((v, i) => expect(v).toBeCloseTo([...b.position, b.vx, b.vy, b.vz, b.age][i], 8));
      }
      native.release(a);
    }
  } finally { native.dispose(); }
});

it.each([false, true])('keeps preview, live underwater shots and replay identical (native=%s)', native => {
  const world = () => {
    const w = new SphereWorld(); Object.assign(w, { liquidBasins: () => basins() });
    if (native) w.createBallistics = (s, g) => new NativeBallistics(core, s, g, w.radius);
    return w;
  };
  const s = setup(), sim = new GameSimulation(world(), s);
  sim.state.tanks[1].position = [0, -18.55, 0];
  sim.aim(0, .7, .3, .8); const preview = sim.preview(0);
  const trace = (sim as unknown as { trace(id: number, aim: { yaw: number; pitch: number; power: number }, unmetered: boolean): import('../src/game/api/bot').BallisticTrace }).trace(0, { yaw: .7, pitch: .3, power: .8 }, true);
  for (let i = 0; i < 1000 && trace.step(); i++);
  expect(trace.impact).toEqual(preview.at(-1)); expect(sim.fire(0)).toBe(true);
  const initial = Math.hypot(...sim.state.projectiles[0].velocity);
  sim.step(FIXED_DT); expect(Math.hypot(...sim.state.projectiles[0].velocity)).toBeLessThan(initial);
  let impact;
  for (let i = 0; i < 600 && !impact; i++) impact = sim.step(FIXED_DT).find(e => e.type === 'impact');
  expect(impact?.position).toEqual(preview.at(-1)); sim.dispose();
  // Replay fixture uses only logged commands; no direct snapshot edits.
  const saved = new GameSimulation(world(), s); saved.command(0, { k: 'aim', yaw: .7, pitch: .3, power: .8 }); saved.command(0, { k: 'fire' });
  for (let i = 0; i < 30; i++) saved.step(FIXED_DT);
  const replay = new MatchReplay(world(), saved.checkpoint());
  while (!replay.done) replay.advance(1);
  expect(replay.verified()).toBe(true); saved.dispose(); replay.simulation.dispose();
});

it.each([false, true])('slows realtime shots on the same preview path (native=%s)', native => {
  const w = new SphereWorld(); Object.assign(w, { liquidBasins: () => basins() });
  if (native) w.createBallistics = (s, g) => new NativeBallistics(core, s, g, w.radius);
  const s = setup(); s.rules.turnModel = 'realtime';
  const sim = new RealtimeMatch(w, s);
  sim.command(0, { k: 'aim', yaw: .7, pitch: .3, power: .8 });
  const prediction = sim.previewPrediction(0, true).points; expect(sim.command(0, { k: 'fire' })).toBe(true);
  const initial = Math.hypot(...sim.state.projectiles[0].velocity);
  for (let i = 0; i < 3; i++) sim.step(FIXED_DT);
  expect(Math.hypot(...sim.state.projectiles[0].velocity)).toBeLessThan(initial);
  let impact;
  for (let i = 0; i < 600 && !impact; i++) impact = sim.step(FIXED_DT).find(e => e.type === 'impact');
  expect(impact?.position).toEqual(prediction.at(-1)); sim.dispose();
});

it('validates the opt-in and leaves pre-update saved rules absent', () => {
  const s = setup(); expect(s.rules.projectileWater).toBe(true); delete s.rules.projectileWater;
  expect(validateRules(s.rules).projectileWater).toBeUndefined();
  expect(() => validateRules({ ...s.rules, projectileWater: 'yes' } as never)).toThrow(/projectileWater/);
  const wetWorld = new SphereWorld(); Object.assign(wetWorld, { liquidBasins: () => basins() });
  const old = new GameSimulation(wetWorld, s), air = new GameSimulation(new SphereWorld(), s);
  old.aim(0, .7, .5, .8); air.aim(0, .7, .5, .8);
  expect(old.preview(0)).toEqual(air.preview(0)); old.dispose(); air.dispose();
});
