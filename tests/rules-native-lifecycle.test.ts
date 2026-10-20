import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { testMatchCore } from './helpers/native-match';
import { SphereWorld } from './helpers/sphere-world';
import { FakeTransactions } from './helpers/fake-transactions';
import { NativeMatch } from '../src/game/native-match';
import { FIXED_DT, GameSimulation, MatchReplay } from '../src/game/simulation';
import { practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { SimExtension } from '../src/game/api/extensions';
import { VehicleWorld } from './helpers/vehicle-world';

let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); });
afterAll(() => core?.dispose());
const loadout = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
function setup(mode: 'bot' | 'local' | 'drive' = 'local'): MatchSetup {
  const s = practiceSetup({ seed: 23, mode, player: loadout });
  s.rules.moveSeconds = 1; s.rules.aimSeconds = .7; s.rules.maxTurns = 12; s.rules.suddenDeathTurn = 6;
  return s;
}
function world(native = true) {
  const w = new SphereWorld(); w.createCombat = undefined; w.createMatchLifecycle = native ? (s, state) => new NativeMatch(core, s, state) : undefined; return w;
}
function drain(sim: GameSimulation, dt: number) {
  const e = sim.step(dt, { throttle: .7, steer: -.3 });
  if (sim.stalledOn?.serial) sim.completeLegacyCarve(); return e;
}

it.each(['local', 'bot', 'drive'] as const)('matches every legacy snapshot/event in %s through fire, motion, expiry and turns', mode => {
  const s = setup(mode), a = new GameSimulation(world(), s), b = new GameSimulation(world(false), s);
  try {
    for (let f = 0; f < 900; f++) {
      if (f % 103 === 0) for (const sim of [a, b]) { const id = sim.state.active; sim.aim(id, .8, .8, .2); sim.fire(id); }
      const dt = [FIXED_DT / 2, FIXED_DT * 2.5, FIXED_DT, 0, NaN, Infinity, -.1, 5][f % 8];
      expect(drain(a, dt), `events at frame ${f}`).toEqual(drain(b, dt));
      expect(a.state, `state at frame ${f}`).toEqual(b.state);
      expect(a.interpolation()).toEqual(b.interpolation());
      expect(a.commandLog()).toEqual(b.commandLog());
    }
  } finally { a.dispose(); b.dispose(); }
});

it('does not hand over before a pending crater commits; replay at another preparation latency reproduces the hash', () => {
  let frame = 0;
  const w = world(); w.transactions = new FakeTransactions(w, () => frame, { latency: 80 });
  const s = setup(); s.rules.aimSeconds = 4; s.rules.moveSeconds = .1;
  const sim = new GameSimulation(w, s);
  sim.aim(0, 0, -.1, 0); expect(sim.fire(0)).toBe(true);
  let stalls = 0;
  for (; frame < 220; frame++) {
    const events = sim.step(FIXED_DT);
    if (sim.stalledOn) { stalls++; expect(sim.state.turn).toBe(1); expect(events.some(e => e.type === 'turn')).toBe(false); }
  }
  expect(stalls).toBeGreaterThan(0); expect(sim.state.turn).toBeGreaterThan(1);
  const rw = world(); let rf = 0; rw.transactions = new FakeTransactions(rw, () => rf, { latency: 120 });
  const replay = new MatchReplay(rw, JSON.parse(JSON.stringify(sim.checkpoint())));
  for (; rf < 1000 && !replay.done; rf++) replay.advance(20);
  expect(replay.done).toBe(true); expect(replay.verified()).toBe(true);
  sim.dispose(); replay.simulation.dispose();
});

it.each([false, true])('preserves extension kills and turn-limit team outcomes (draw %s)', draw => {
  const s = setup(); s.rules.maxTurns = 3;
  const extension = (): SimExtension => ({ id: 'damage', snapshot: () => null, restore() {}, onTick(c) { if (c.tick === 2 && !draw) c.damage(1, 1, 'test'); } });
  const a = new GameSimulation(world(), s, [extension()]), b = new GameSimulation(world(false), s, [extension()]);
  try {
    for (let i = 0; i < 200 && a.state.phase !== 'finished'; i++) expect(a.step(FIXED_DT)).toEqual(b.step(FIXED_DT));
    expect(a.state).toEqual(b.state); expect(a.state.phase).toBe('finished'); expect(a.state.winner).toBe(draw ? null : 0);
  } finally { a.dispose(); b.dispose(); }
});

it('retains independent clocks and tempo in Rust, rejects malformed commands atomically, and releases handles', () => {
  const a = new GameSimulation(world(), setup()), b = new GameSimulation(world(), setup());
  const native = (a as unknown as { nativeMatch: NativeMatch }).nativeMatch;
  const id = (native as unknown as { id: number }).id;
  a.step(FIXED_DT); expect(b.state.tick).toBe(0);
  const snapshot = core.matchCommand(id, 0);
  expect(() => core.matchCommand(id, 5, [0, 10, 1, 0, 1, 10, 1, 0, 0])).toThrow('Invalid match settle');
  expect(core.matchCommand(id, 0)).toEqual(snapshot);
  expect(() => core.matchCommand(id, 3, [0, 99])).toThrow('Invalid match action');
  expect(core.matchCommand(id, 0)).toEqual(snapshot);
  a.state.tick = 900; a.state.time = NaN; a.state.phaseTime = NaN; a.state.tanks[0].readyAt = NaN;
  a.step(FIXED_DT); expect(a.state.tick).toBe(2); expect(a.state.time).toBe(2 * FIXED_DT); expect(a.state.tanks[0].readyAt).toBe(0);
  a.dispose(); expect(() => core.matchCommand(id, 0)).toThrow('Unknown resident match'); b.dispose();
});

it('drives interacting native Rapier chassis identically under the Rust and host clocks at irregular frame boundaries', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1');
  const fixtures: { v: VehicleWorld; sim: GameSimulation }[] = [];
  try {
    for (const native of [true, false]) {
      const v = await VehicleWorld.create(); v.addPlane();
      const w = world(false);
      if (native) w.createMatchLifecycle = (s, state) => new NativeMatch(v.physics.native!.core, s, state);
      w.stepTanks = (tanks, inputs, dt) => { v.bridge.beforeStep(tanks, inputs, dt); v.physics.step(); v.bridge.afterStep(tanks, dt); };
      const sim = new GameSimulation(w, setup('drive')); fixtures.push({ v, sim });
      for (const tank of sim.state.tanks) { tank.position = [0, .6, tank.id * 4]; tank.rotation = [0, 0, 0, 1]; tank.heading = 0; }
    }
    const [a, b] = fixtures;
    for (let f = 0; f < 700; f++) {
      const dt = [FIXED_DT * .51, FIXED_DT * .49, FIXED_DT * 2.5, 0, FIXED_DT * 1.5][f % 5];
      const drive = { throttle: f < 150 ? 0 : f < 500 ? 1 : -.7, steer: f > 350 && f < 600 ? -.8 : 0 };
      expect(a.sim.step(dt, drive)).toEqual(b.sim.step(dt, drive));
      expect(a.sim.state, `native chassis frame ${f}`).toEqual(b.sim.state);
      expect(a.v.physics.tick).toBe(b.v.physics.tick);
    }
    expect(a.sim.state.tanks[0].position[2]).not.toBe(0);
  } finally { for (const f of fixtures) { f.sim.dispose(); f.v.dispose(); } vi.unstubAllEnvs(); }
});
