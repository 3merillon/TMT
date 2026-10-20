import { afterAll, beforeAll, expect, it } from 'vitest';
import { testMatchCore } from './helpers/native-match';
import { SphereWorld } from './helpers/sphere-world';
import { GameSimulation, FIXED_DT, MatchReplay } from '../src/game/simulation';
import { NativeMatch } from '../src/game/native-match';
import { NativeProfileBrain } from '../src/game/ai/native-profile';
import { ProfileBrain } from '../src/game/ai/brain';
import { brainSeed } from '../src/game/ai/random';
import { resolveProfile, type W1Profile } from '../src/game/ai/profiles';
import { practiceSetup, type Difficulty } from '../src/game/api/match';
import type { BotObservation } from '../src/game/api/bot';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { V3 } from '../src/game/contracts';
import { mul, normalize } from '../src/game/math';

let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());
const profiles: W1Profile[] = ['rusty', 'tosser', 'vex', 'cyborg'];
function setup(profile: W1Profile, difficulty: Difficulty = 'normal') {
  const s = practiceSetup({ seed: 11, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
  s.tanks[1].brain = profile; s.tanks[1].difficulty = difficulty; return s;
}
function world(native: boolean) {
  const w = new SphereWorld(); w.createCombat = undefined; w.createBallistics = undefined;
  w.createMatchLifecycle = (s, state) => new NativeMatch(core, s, state, true, native); return w;
}
/** Transcendentals are explicitly engine-versioned; all discrete outcomes,
 * request ordering and consumed budgets must agree. */
function equivalent(a: unknown, b: unknown, path = 'value'): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) expect(a, path).toBe(b);
    else expect(Math.abs(a - b), path).toBeLessThan(1e-10);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a), path).toEqual(Object.keys(b));
    for (const key of Object.keys(a)) equivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
  } else expect(a, path).toBe(b);
}
function observation(sim: GameSimulation) {
  const budget = { traceSteps: 0 }, calls: unknown[] = [];
  let unsafe = false;
  const o: BotObservation = { tick: 0, phaseTime: 0, self: structuredClone(sim.state.tanks[1]), rules: sim.setup.rules, wind: null,
    visible: [], lastKnown: [], sounds: [], impacts: [],
    world: { radius: 18, isSolid: () => { throw new Error('Unexpected solid query'); },
      surface: direction => {
        expect(budget.traceSteps).toBeGreaterThan(0); budget.traceSteps--; calls.push(['surface', ...direction]);
        const normal = normalize(direction); return { point: mul(normal, 18), normal, distance: 0, material: 1 };
      },
      raycast: (origin, direction, extent) => {
        expect(budget.traceSteps).toBeGreaterThan(0); budget.traceSteps--; calls.push(['ray', ...origin, ...direction, extent]);
        return direction[0] > 0 ? { point: [...origin], normal: [0, 1, 0], distance: 0, material: 1 } : null;
      } }, predict: () => { throw new Error('Unexpected unmetered trace'); },
    trace: (yaw, pitch, power, munition, launch) => {
      calls.push(['trace', yaw, pitch, power, munition, launch, o.tick]); let steps = 0;
      const duration = 8 + Math.round(pitch * 3 + power * 3), expire = power > .93;
      const impact: V3 = unsafe ? [...o.self.position] : [7 + 8 * (power - .55), 17 + Math.sin(pitch), 2 + Math.sin(yaw) * 3];
      return { get done() { return steps === duration; }, get impact() { return steps === duration && !expire ? impact : null; }, get steps() { return steps; },
        step() { const cost = steps === 0 ? 2 : 1; if (steps === duration || budget.traceSteps < cost) return null;
          budget.traceSteps -= cost; steps++; return { from: [0, 20, 0], to: impact, hit: steps === duration && !expire, expired: steps === duration && expire }; } };
    } };
  o.self.position = [0, 20, 0]; o.self.rotation = [0, 0, 0, 1];
  return { o, budget, calls, danger: (value: boolean) => { unsafe = value; } };
}

it.each(profiles.flatMap(p => (['story', 'normal', 'hard', 'ace'] as Difficulty[]).map(d => [p, d] as const)))('matches %s/%s decisions, learning, requests and pursuit across budget pauses', (profile, difficulty) => {
  const sim = new GameSimulation(world(true), setup(profile, difficulty));
  const a = sim.brainFor(1) as NativeProfileBrain, b = new ProfileBrain(resolveProfile(profile, difficulty), brainSeed(sim.setup.seed, 1, profile));
  const ah = observation(sim), bh = observation(sim); expect(a).toBeInstanceOf(NativeProfileBrain);
  try {
    for (let turn = 0; turn < 7; turn++) {
      for (const h of [ah, bh]) {
        const o = h.o; h.danger(turn === 6); o.self.charge = turn === 3 || turn === 4 || turn === 5 ? 3 : 0;
        o.visible = turn < 3 || turn === 6 ? [{ tank: 8, team: 0, position: [8, 18, 3], observedAt: 1 },
          { tank: 2, team: 1, position: [-7, 18, 2], observedAt: 10 }, { tank: 3, team: 0, position: [8, 18, -3], observedAt: 1 }] : [];
        o.lastKnown = turn === 3 ? [{ tank: 0, team: 0, position: [6, 18, 2], observedAt: 9, uncertainty: 2 },
          { tank: 7, team: 0, position: [6, 18, 2], observedAt: 12, uncertainty: 100 }] : [];
        o.sounds = turn === 4 ? [{ bearing: .4, tick: turn * 1000 }] : [];
        o.impacts = turn > 0 ? [{ tick: turn * 1000 - 1, position: [8.3, 18, -3.2] }] : [];
      }
      a.begin(ah.o); b.begin(bh.o); let fired = false;
      for (let tick = 0; tick < 1000 && !fired; tick++) {
        for (const h of [ah, bh]) { h.o.tick = turn * 1000 + tick; h.o.phaseTime = tick / 60; h.budget.traceSteps = [0, 1, 2, 7, 48, 80][tick % 6]; h.calls.length = 0; }
        const actual = a.step(ah.o, ah.budget), expected = b.step(bh.o, bh.budget);
        equivalent(actual, expected, `${profile}/${difficulty} turn ${turn} tick ${tick}`); equivalent(ah.calls, bh.calls, 'requests'); expect(ah.budget).toEqual(bh.budget);
        if (actual?.kind === 'scan') for (const h of [ah, bh]) h.o.self.charge = 0;
        if (actual?.kind === 'aim' || actual?.kind === 'fire') for (const h of [ah, bh]) { h.o.self.turretYaw = actual.yaw; h.o.self.barrelPitch = actual.pitch; }
        if (actual?.kind === 'fire') { fired = true; equivalent(a.lastDecision, b.lastDecision); }
      }
      expect(fired).toBe(true);
      // Both moving approaches and stationary throttle (45 ticks -> reverse) retain the same state.
      a.lastDecision?.relocation?.fill(NaN); // Presentation cannot overwrite the resident pursuit target.
      for (let tick = 0; tick < 200; tick++) {
        for (const h of [ah, bh]) h.o.tick = turn * 1000 + 500 + tick;
        const actual = a.drive(ah.o), expected = b.drive(bh.o); equivalent(actual, expected, `pursuit ${tick}`);
        for (const h of [ah, bh]) h.o.self.heading -= actual.steer * 1.6 / 60;
      }
    }
  } finally { sim.dispose(); }
});

it('rejects malformed and stale responses without losing the pending request; destroys profiles with the owner', () => {
  const sims = [new GameSimulation(world(true), setup('cyborg')), new GameSimulation(world(true), setup('cyborg'))];
  const ids = sims.map(s => (s.brainFor(1) as unknown as { id: number }).id);
  const input = [0, 0, 48, 1, 0, 3, 0, 20, 0, 0, 0, 0, 1, 0, 0, .75, 18, 8, 20, 9.81, 2, 20, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 8, 18, 2];
  try {
    const requests = ids.map(id => core.profileCommand(id, 1, input)); expect(requests[0]).toEqual(requests[1]); expect(requests[0][0]).toBe(5);
    const serial = requests[0][1];
    expect(() => core.profileCommand(ids[0], 2, [serial + 1, 47, 1, 8, 18, 2, 0, 1, 0])).toThrow('Stale');
    expect(() => core.profileCommand(ids[0], 2, [serial, 47, 2, 8, 18, 2, 0, 1, 0])).toThrow('Invalid surface');
    expect(() => core.profileCommand(ids[0], 2, [serial, 47, 1, NaN, 18, 2, 0, 1, 0])).toThrow('Invalid personality');
    expect(() => core.profileCommand(ids[0], 1, input)).toThrow('pending');
    const pitch = ids.map(id => core.profileCommand(id, 2, [serial, 47, 1, 8, 18, 2, 0, 1, 0])); expect(pitch[0]).toEqual(pitch[1]);
    expect(() => core.profileCommand(ids[0], 2, [pitch[0][1], 47, 1, 0])).toThrow('Invalid elevation');
    expect(core.profileCommand(ids[0], 2, [pitch[0][1], 47, 0, 1.4])).toEqual(core.profileCommand(ids[1], 2, [pitch[1][1], 47, 0, 1.4]));
    (sims[0] as unknown as { nativeMatch: NativeMatch }).nativeMatch.dispose();
    expect(() => core.profileCommand(ids[0], 3, [0, 0, 20, 0, 0])).toThrow('Unknown resident personality');
    expect(() => core.profileCommand(ids[1], 3, [0, 0, 20, 0, 0])).not.toThrow();
  } finally { sims.forEach(s => s.dispose()); }
});

it.each(profiles)('matches full %s duels and reconstructs an unfinished native search from JSON replay', profile => {
  const s = setup(profile), a = new GameSimulation(world(true), s), b = new GameSimulation(world(false), s); let replayed = false, shots = 0;
  try {
    for (let tick = 0; tick < 4000; tick++) {
      const ae = a.step(FIXED_DT), be = b.step(FIXED_DT); equivalent(ae, be, `events ${tick}`); equivalent(a.state, b.state, `state ${tick}`); expect(a.aiTelemetry()).toEqual(b.aiTelemetry());
      shots += ae.filter(e => e.type === 'shot' && e.player === 1).length;
      if (!replayed && a.state.active === 1 && a.state.phase === 'aim' && a.state.phaseTime > .2) {
        const replay = new MatchReplay(world(true), JSON.parse(JSON.stringify(a.checkpoint())));
        try { for (let i = 0; i < 1000 && !replay.done; i++) { replay.advance(20); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); } expect(replay.verified()).toBe(true); }
        finally { replay.simulation.dispose(); } replayed = true;
      }
      for (const sim of [a, b]) { if (sim.stalledOn?.serial) sim.completeLegacyCarve(); if (sim.state.phase === 'aim' && sim.state.active === 0) sim.hold(0); }
    }
    expect(replayed).toBe(true); expect(shots).toBeGreaterThan(1);
  } finally { a.dispose(); b.dispose(); }
});
