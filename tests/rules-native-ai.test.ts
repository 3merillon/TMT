import { afterAll, beforeAll, expect, it } from 'vitest';
import { testMatchCore } from './helpers/native-match';
import { SphereWorld } from './helpers/sphere-world';
import { GameSimulation, FIXED_DT, MatchReplay } from '../src/game/simulation';
import { NativeMatch } from '../src/game/native-match';
import { NativeLegacyBrain } from '../src/game/ai/native-legacy';
import { LegacyBrain } from '../src/game/ai/legacy';
import { practiceSetup } from '../src/game/api/match';
import type { BotObservation } from '../src/game/api/bot';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { V3 } from '../src/game/contracts';

let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());
const setup = (seed = 11) => practiceSetup({ seed, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
function world(native: boolean) {
  const w = new SphereWorld(); w.createCombat = undefined; w.createBallistics = undefined;
  w.createMatchLifecycle = (s, state) => new NativeMatch(core, s, state, native); return w;
}
function random(seed: number) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; }
function baseObservation(sim: GameSimulation): BotObservation {
  return { tick: 0, phaseTime: 0, self: structuredClone(sim.state.tanks[1]), rules: sim.setup.rules, wind: null, visible: [], lastKnown: [], sounds: [],
    world: { radius: 18, raycast: () => { throw new Error('Unexpected world query'); }, surface: () => { throw new Error('Unexpected surface query'); }, isSolid: () => false },
    predict: () => { throw new Error('Unexpected unmetered trace'); } };
}
function tracer(o: BotObservation) {
  const meter = { left: 0, used: 0 }, calls: number[][] = [];
  o.trace = (yaw, pitch, power) => {
    calls.push([yaw, pitch, power]); let steps = 0;
    const duration = 12 + Math.round(pitch * 8 + power * 7), expire = power > .7;
    const point = (t: number): V3 => [t * .4, pitch * t * .2, power * t * .3];
    return { get done() { return steps === duration; }, get impact() { return steps === duration && !expire ? point(steps) : null; }, get steps() { return steps; },
      step() { const cost = steps === 0 ? 2 : 1; if (steps === duration || meter.left < cost) return null; meter.left -= cost; meter.used += cost;
        const from = point(steps++); return { from, to: point(steps), hit: steps === duration && !expire, expired: steps === duration && expire }; } };
  };
  return { meter, calls };
}
/** v7 records native transcendental arithmetic. Ordering, discrete state and
 * decisions stay exact; compare propagated floating pose/telemetry within 1e-10. */
function equivalent(a: unknown, b: unknown, path = 'snapshot'): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b) || Number.isInteger(a) || Number.isInteger(b)) expect(a, path).toBe(b);
    else expect(Math.abs(a - b), path).toBeLessThan(1e-10);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a), path).toEqual(Object.keys(b));
    for (const key of Object.keys(a)) equivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
  } else expect(a, path).toBe(b);
}

it.each([0, 7, 0x80000000, 0xffffffff])('matches shared RNG and observed-contact search under changing trace budgets (seed %s)', seed => {
  const sim = new GameSimulation(world(true), setup(seed)), m = (sim as unknown as { nativeMatch: NativeMatch }).nativeMatch;
  const a = sim.brainFor(1) as NativeLegacyBrain, draw = random(seed), b = new LegacyBrain(draw);
  const ao = baseObservation(sim), bo = structuredClone({ ...ao, world: undefined, predict: undefined }) as unknown as BotObservation;
  bo.world = ao.world; bo.predict = ao.predict;
  ao.self.position = bo.self.position = [0, 20, 0]; ao.self.rotation = bo.self.rotation = [0, 0, 0, 1];
  const am = tracer(ao), bm = tracer(bo);
  try {
    for (let turn = 0; turn < 4; turn++) {
      a.begin(); b.begin(); am.calls.length = bm.calls.length = 0;
      // Visible/known allies must never become the chosen enemy; tank-id ties
      // and recency have the same ordering despite intentionally shuffled input.
      ao.visible = turn === 0 ? [] : [{ tank: 8, team: 0, position: [8, 22, 3], observedAt: 1 }, { tank: 2, team: 1, position: [1, 20, 0], observedAt: 10 }, { tank: 3, team: 0, position: [8, 22, -3], observedAt: 1 }];
      ao.lastKnown = turn === 2 ? [{ tank: 0, team: 0, position: [5, 20, 2], observedAt: 9, uncertainty: 2 }] : [];
      if (turn === 2) ao.visible = [];
      bo.visible = structuredClone(ao.visible); bo.lastKnown = structuredClone(ao.lastKnown);
      ao.self.charge = bo.self.charge = turn === 0 || turn === 2 ? 3 : 0;
      let fired = false;
      for (let tick = 0; tick < 250 && !fired; tick++) {
        ao.tick = bo.tick = tick; ao.phaseTime = bo.phaseTime = tick / 60; ao.self.heading = bo.self.heading = tick * .001;
        am.meter.left = bm.meter.left = [0, 1, 2, 7, 48, 80][tick % 6]; am.meter.used = bm.meter.used = 0;
        if (tick % 13 === 0) expect(m.random()).toBe(draw()); // another user of the same stream
        const actual = a.step(ao), expected = b.step(bo);
        expect(actual, `turn ${turn} tick ${tick}`).toEqual(expected); expect(am.calls).toEqual(bm.calls); expect(am.meter.used).toBe(bm.meter.used);
        expect(am.meter.used).toBeLessThanOrEqual(34); // 32 integration steps plus launch guard charges
        if (actual?.kind === 'scan') ao.self.charge = bo.self.charge = 0;
        if (actual?.kind === 'fire') fired = true;
      }
      expect(fired).toBe(true); expect(a.heading).toBe(b.heading);
      (a as unknown as { moveHeading: number }).moveHeading = NaN;
      for (let tick = 0; tick < 120; tick++) { ao.self.heading = bo.self.heading = tick * .05; expect(a.drive(ao)).toEqual(b.drive(bo)); }
      expect(m.random()).toBe(draw());
    }
  } finally { sim.dispose(); }
});

it('validates complete trace batches before mutation and frees brains with their owning match', () => {
  const sims = [new GameSimulation(world(true), setup()), new GameSimulation(world(true), setup())];
  const ids = sims.map(s => (s.brainFor(1) as unknown as { id: number }).id);
  const observation = [1, 0, 3, 1, 0, 0, 20, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 8, 20, 2];
  try {
    const before = ids.map(id => core.aiCommand(id, 1, observation)); expect(before[0]).toEqual(before[1]);
    const row = [0, 20, 0, 1, 20, 0, 1, 0];
    expect(() => core.aiCommand(ids[0], 2, [0, 2, ...row, ...row])).toThrow('Invalid AI trace termination');
    expect(() => core.aiCommand(ids[0], 2, [1, 1, ...row])).toThrow('Stale AI trace batch');
    expect(() => core.aiCommand(ids[0], 2, [0, 1, NaN, ...row.slice(1)])).toThrow('Invalid AI descriptor');
    for (let candidate = 0; candidate < 18; candidate++) expect(core.aiCommand(ids[0], 2, [candidate, 1, ...row])).toEqual(core.aiCommand(ids[1], 2, [candidate, 1, ...row]));
    const a = (sims[0] as unknown as { nativeMatch: NativeMatch }).nativeMatch, b = (sims[1] as unknown as { nativeMatch: NativeMatch }).nativeMatch;
    expect(a.random()).toBe(b.random());
    a.dispose(); expect(() => core.aiCommand(ids[0], 3, [0])).toThrow('Unknown resident AI');
    expect(() => core.aiCommand(ids[1], 3, [0])).not.toThrow();
  } finally { sims.forEach(s => s.dispose()); }
});

it('matches complete duels and resumes an in-progress search from replay with the same shared random stream', () => {
  const s = setup(), a = new GameSimulation(world(true), s), b = new GameSimulation(world(false), s);
  expect(a.brainFor(1)).toBeInstanceOf(NativeLegacyBrain); expect(b.brainFor(1)).toBeInstanceOf(LegacyBrain);
  try {
    for (const sim of [a, b]) { sim.aim(0, 1, .5, .25); sim.fire(0); sim.endMove(0); }
    let replayed = false;
    for (let tick = 0; tick < 4000; tick++) {
      equivalent(a.step(FIXED_DT), b.step(FIXED_DT), `events ${tick}`); equivalent(a.state, b.state, `state ${tick}`); expect(a.aiTelemetry()).toEqual(b.aiTelemetry());
      if (!replayed && a.state.active === 1 && a.state.phase === 'aim' && a.state.phaseTime > .7) {
        const r = new MatchReplay(world(true), JSON.parse(JSON.stringify(a.checkpoint())));
        try { for (let i = 0; i < 1000 && !r.done; i++) { r.advance(20); if (r.simulation.stalledOn?.serial) r.simulation.completeLegacyCarve(); } expect(r.verified()).toBe(true); } finally { r.simulation.dispose(); }
        replayed = true;
      }
      for (const sim of [a, b]) {
        if (sim.stalledOn?.serial) sim.completeLegacyCarve();
        if (sim.state.phase === 'aim' && sim.state.active === 0 && sim.state.phaseTime > .3) { sim.aim(0, .6 + (sim.state.turn % 5) * .2, .7, .4); sim.fire(0); }
      }
    }
    expect(replayed).toBe(true);
  } finally { a.dispose(); b.dispose(); }
});
