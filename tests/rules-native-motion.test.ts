import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VehicleWorld } from './helpers/vehicle-world';
import { SphereWorld } from './helpers/sphere-world';
import { NativeMatch } from '../src/game/native-match';
import { NativeCombat } from '../src/game/native-combat';
import { NativeBallistics } from '../src/game/native-ballistics';
import { GameSimulation, MatchReplay, FIXED_DT } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import type { ProjectileState } from '../src/game/contracts';
import type { SimContext, SimExtension } from '../src/game/api/extensions';
import type { BotObservation } from '../src/game/api/bot';

const worlds: VehicleWorld[] = [], sims: GameSimulation[] = [];
beforeEach(() => vi.stubEnv('TMT_NATIVE_PHYSICS', '1'));
afterEach(() => { for (const s of sims.splice(0)) s.dispose(); for (const v of worlds.splice(0)) v.dispose(); vi.unstubAllEnvs(); });
const setup = (mode: 'drive' | 'local' | 'bot' = 'drive') => practiceSetup({ seed: 19, mode, player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
const match = (s: GameSimulation) => (s as unknown as { nativeMatch: NativeMatch }).nativeMatch;
const handle = (s: GameSimulation) => (match(s) as unknown as { id: number }).id;
const combat = (s: GameSimulation) => (s as unknown as { nativeCombat: NativeCombat }).nativeCombat;
/** `latest` adds the v17+ resident tick head, chassis leg, solver leg and tick tail (analytic worlds: host-serviced
 * shots and contacts). */
async function world(native = true, linked = false, shots = false, canonical = false, queries = false, latest = false) {
  const v = await VehicleWorld.create(); worlds.push(v);
  v.addTrimesh([-200, 18, -200, 200, 18, -200, 200, 18, 200, -200, 18, 200], [0, 2, 1, 0, 3, 2]);
  const w = new SphereWorld(), core = v.physics.native!.core;
  w.createMatchLifecycle = (s, state) => {
    for (const t of state.tanks) { t.position = [0, 18.600000000001, t.id * 4]; t.rotation = [0, 0, 0, 1]; t.heading = 0; }
    const m = new NativeMatch(core, s, state, true, true, true, true, true, native, linked, shots, canonical, queries, latest, latest, latest, latest);
    if (native) v.bridge.bindMatch(m); return m;
  };
  w.createCombat = (s, state, kit) => new NativeCombat(core, s, state, kit);
  w.createBallistics = (s, gravity) => new NativeBallistics(core, s, gravity, w.radius);
  w.stepTanks = (tanks, inputs, dt) => { v.bridge.beforeStep(tanks, inputs, dt); v.physics.step(); v.bridge.afterStep(tanks, dt); };
  return { v, w, core };
}
async function game(native = true, mode: 'drive' | 'local' | 'bot' = 'drive') {
  const p = await world(native), sim = new GameSimulation(p.w, setup(mode)); sims.push(sim); return { ...p, sim };
}

it('continues a dead player body through bound native motion after the turn match finishes', async () => {
  const { v, w, sim } = await game(true, 'local');
  combat(sim).damage(0, 10000);
  const t = sim.state.tanks[0]; t.position = [0, 22, 0]; t.velocity = [0, 0, 0]; v.bridge.relocate(t);
  sim.state.phase = 'finished';
  const { tick, time } = sim.state;
  for (let i = 0; i < 180; i++) w.stepTanks(sim.state.tanks, [], FIXED_DT);
  expect(t.health).toBe(0); expect(t.position[1]).toBeLessThan(19); expect(t.position[1]).toBeGreaterThan(18);
  expect(Math.hypot(...t.velocity)).toBeLessThan(.1);
  expect(sim.state.tick).toBe(tick); expect(sim.state.time).toBe(time); expect(sim.state.phase).toBe('finished');
});
function close(a: unknown, b: unknown): void {
  if (typeof a === 'number' && typeof b === 'number') { expect(Math.abs(a - b)).toBeLessThan(1e-10); return; }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a)).toEqual(Object.keys(b)); for (const key of Object.keys(a)) close((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
  } else expect(a).toEqual(b);
}

it.each(['drive', 'local', 'bot'] as const)('matches the v11 body transport through native Rapier, weapons and irregular %s frames', async mode => {
  const a = await game(false, mode), b = await game(true, mode);
  for (let i = 0; i < 600; i++) {
    for (const { sim } of [a, b]) {
      if (match(sim).actionAllowed('aim', 0) && i % 79 === 0) sim.aim(0, i * .01, .6, .4);
      if (sim.canFire(0) && i % 113 === 0) sim.fire(0);
      sim.step([FIXED_DT * .51, FIXED_DT * .49, FIXED_DT * 2.5, 0, FIXED_DT * 1.5][i % 5], { throttle: i < 100 ? 0 : i < 400 ? .8 : -.6, steer: i > 250 ? -.7 : 0 });
      if (sim.stalledOn?.serial) sim.completeLegacyCarve();
    }
    if (i % 20 === 0) close(a.sim.state, b.sim.state);
  }
  close(a.sim.state, b.sim.state); expect(a.sim.commandLog()).toEqual(b.sim.commandLog());
});

it('uses admitted f64 spawn poses and ignores poisoned pose/velocity/animation mirrors for launch, sight and physics', async () => {
  const a = await game(), b = await game();
  const socket = match(a.sim).socket(0), points = match(a.sim).observations!.sightPoints(a.sim.state.tanks[0]);
  for (const t of b.sim.state.tanks) { t.position = [200, 300, 400]; t.rotation = [1, 0, 0, 0]; t.velocity = [50, 60, 70]; t.heading = 5; t.yawVelocity = 9; t.recoil = 20; t.trackPhase = 300; t.trackPhases = [88, 99]; }
  expect(match(b.sim).socket(0)).toEqual(socket); expect(match(b.sim).observations!.sightPoints(b.sim.state.tanks[0])).toEqual(points);
  match(a.sim).observations!.refresh(a.w); match(b.sim).observations!.refresh(b.w);
  expect(match(b.sim).observations!.knowledge(0)).toEqual(match(a.sim).observations!.knowledge(0));
  expect(a.sim.fire(0)).toBe(true); expect(b.sim.fire(0)).toBe(true); expect(b.sim.state.projectiles).toEqual(a.sim.state.projectiles);
  for (let i = 0; i < 150; i++) { a.sim.step(FIXED_DT); b.sim.step(FIXED_DT); }
  expect(b.sim.state).toEqual(a.sim.state);
});

it('keeps native blast impulses pending until the next solver tick and composes successive impulses', async () => {
  const a = await game(false), b = await game();
  for (let i = 0; i < 90; i++) { a.sim.step(FIXED_DT); b.sim.step(FIXED_DT); }
  const shot: ProjectileState = { id: 1, owner: 0, position: [0, 18.5, 4], velocity: [0, -2, 0], age: 1, munition: 'explosive' };
  for (let k = 0; k < 2; k++) for (const { sim } of [a, b]) combat(sim).impact(shot, { point: [0, 18.5, 4], normal: [0, 1, 0], material: 0, distance: 0 }, 1, undefined, () => false);
  close(a.sim.state, b.sim.state);
  b.sim.state.tanks[1].velocity = [900, 900, 900];
  for (let i = 0; i < 120; i++) { a.sim.step(FIXED_DT); b.sim.step(FIXED_DT); }
  close(a.sim.state, b.sim.state);
});

it('retains explicit placement and pre-fire kit replacement without applying an impulse twice', async () => {
  const a = await game(false), b = await game();
  for (let i = 0; i < 60; i++) { a.sim.step(FIXED_DT); b.sim.step(FIXED_DT); }
  for (const { sim, v } of [a, b]) {
    const t = sim.state.tanks[0]; t.position = [2, 19, 1]; t.velocity = [1, 0, .5]; t.rotation = [0, 0, 0, 1]; v.bridge.relocate(t);
    expect(sim.setLoadout(0, { tracks: 'grip', barrel: 'cannon', armor: 'heavy' })).toBe(true);
  }
  for (let i = 0; i < 120; i++) { a.sim.step(FIXED_DT, { throttle: .6, steer: .2 }); b.sim.step(FIXED_DT, { throttle: .6, steer: .2 }); }
  close(a.sim.state, b.sim.state);
});

it('admits only deliberate extension edits and preserves edits when a callback throws', async () => {
  const { sim } = await game(), m = match(sim).motion!, t = sim.state.tanks[0], old = structuredClone(t);
  t.position = [400, 500, 600]; t.recoil = 55;
  m.extension(() => { t.velocity[0] += 3; t.trackPhases[1] = 4; });
  expect(t.position).toEqual(old.position); expect(t.recoil).toBe(old.recoil); expect(t.velocity[0]).toBe(3); expect(t.trackPhases).toEqual([0, 4]);
  expect(() => m.extension(() => { t.velocity[2] = 7; throw new Error('fixture failure'); })).toThrow('fixture failure');
  m.refresh(); expect(t.velocity).toEqual([3, 0, 7]);
});

it('preserves ordered mutable extension hooks around startup, ticks, segment traces, impacts and terrain commits', async () => {
  const make = () => {
    const calls: string[] = [];
    const edit = (c: SimContext, name: string) => { calls.push(name); c.state.tanks[0].velocity[0] += .001; c.state.tanks[0].recoil += .01; };
    const extension: SimExtension = { id: 'motion-fixture', snapshot: () => [...calls], restore: () => {},
      onMatchStart: c => edit(c, 'start'), onTick: c => edit(c, 'tick'), onImpact: c => edit(c, 'impact'), onTerrainCommit: c => edit(c, 'commit'),
      traceSegment: c => { edit(c, 'trace'); return null; } };
    return { calls, extension };
  };
  const x = make(), y = make(), wa = await world(false), wb = await world();
  const a = new GameSimulation(wa.w, setup(), [x.extension]), b = new GameSimulation(wb.w, setup(), [y.extension]); sims.push(a, b);
  for (const s of [a, b]) { s.aim(0, 0, -.1, 0); s.fire(0); }
  for (let i = 0; i < 240; i++) { for (const s of [a, b]) { s.step(FIXED_DT); if (s.stalledOn?.serial) s.completeLegacyCarve(); } }
  expect(new Set(x.calls)).toEqual(new Set(['start', 'tick', 'trace', 'impact', 'commit'])); expect(y.calls).toEqual(x.calls); close(a.state, b.state);
});

it('queries sight, scan and combat directly against resident poses and fences edits during a pending callback', async () => {
  const { sim, core } = await game(), id = handle(sim), m = match(sim);
  combat(sim).restore(0, { charge: 3 });
  const before = core.matchCommand(id, 42);
  expect(core.matchCommand(id, 17, [0, 0, 1])[0]).toBe(1);
  expect(() => core.matchCommand(id, 45, [1, 0, 1, 99])).toThrow('Observation query is pending');
  expect(core.matchCommand(id, 42)).toEqual(before); core.matchCommand(id, 24);
  const scene = core.queryScene([]), query = { core, id: scene, kind: 1 as const, range: 100 };
  const nativeWorld = { radius: 18, version: 0, ballisticQuery: () => query, isSolid: () => false,
    surface: () => { throw new Error('host surface called'); }, raycast: () => { throw new Error('host ray called'); } };
  m.observations!.refresh(nativeWorld); expect(m.observations!.scan(nativeWorld, 0, false)).toBe(true);
  const target = [...sim.state.tanks[1].position] as [number, number, number];
  for (const t of sim.state.tanks) { t.position = [999, 999, 999]; t.velocity = [888, 888, 888]; }
  const resolved = combat(sim).resolve([target[0], target[1], target[2] - 2], [0, 0, 1], 3, 2, 0, true, undefined, null);
  expect(resolved.victim).toBe(1);
  const shot: ProjectileState = { id: 1, owner: 0, position: target, velocity: [0, -2, 0], age: 1, munition: 'explosive' };
  const hits = combat(sim).impact(shot, { point: target, normal: [0, 1, 0], material: 0, distance: 0 }, 1, query, () => { throw new Error('host obstruction called'); });
  expect(hits.some(h => h.tank === 1 && h.direct)).toBe(true);
  const saved = core.matchCommand(id, 42); core.releaseQuery(scene, true);
  expect(() => combat(sim).impact(shot, { point: target, normal: [0, 1, 0], material: 0, distance: 0 }, 1, query, () => false)).toThrow();
  expect(core.matchCommand(id, 42)).toEqual(saved);
});

it('rejects malformed edits and stale/duplicate bindings atomically, then remains usable', async () => {
  const { sim, core, v } = await game(), id = handle(sim);
  sim.step(FIXED_DT); const saved = core.matchCommand(id, 42);
  for (const words of [[2, 0, 1, 77, 1, 2], [1, 0, 65536], [1, 0, 1, NaN], [2, 0, 1, 77, 0, 2, 88]]) {
    expect(() => core.matchCommand(id, 45, words)).toThrow(); expect(core.matchCommand(id, 42)).toEqual(saved);
  }
  const body = v.bridge.bodyOf(0)!.handle;
  for (const words of [[2, 0, body, 1, body], [2, 0, body, 1, 9999999]]) expect(() => core.matchCommand(id, 38, words)).toThrow();
  sim.step(FIXED_DT); expect(sim.state.tick).toBe(2);
  const good = core.matchCommand(id, 42); v.physics.world.removeRigidBody(v.bridge.bodyOf(1)!);
  expect(() => core.matchCommand(id, 39, [FIXED_DT])).toThrow(); expect(core.matchCommand(id, 42)).toEqual(good);
});

it('replays actual resident chassis with a different cadence to an exact snapshot, hash and input log', async () => {
  const { sim } = await game();
  for (let i = 0; i < 400; i++) {
    if (i % 79 === 0) sim.aim(0, i * .01, .6, .4);
    if (i % 113 === 0 && sim.canFire(0)) sim.fire(0);
    sim.step([FIXED_DT * .51, FIXED_DT * .49, FIXED_DT * 2.5, 0, FIXED_DT * 1.5][i % 5], { throttle: i < 80 ? 0 : .8, steer: i > 200 ? -.7 : 0 });
    if (sim.stalledOn?.serial) sim.completeLegacyCarve();
  }
  const rw = await world(), replay = new MatchReplay(rw.w, JSON.parse(JSON.stringify(sim.checkpoint()))); sims.push(replay.simulation);
  for (let i = 0; i < 2000 && !replay.done; i++) { replay.advance(i % 9 + 1); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); }
  expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(sim.state); expect(replay.simulation.commandLog()).toEqual(sim.commandLog());
});

it.each(['legacy', 'rusty', 'tosser', 'vex', 'cyborg'] as const)('binds %s to resident private state and ignores poisoned detached observations', async profile => {
  const wa = await world(), wb = await world(true, true, true, true, true, true), wc = await world(true, true, true, true, true, true), s = setup('bot'); s.tanks[1].brain = profile;
  const a = new GameSimulation(wa.w, s), b = new GameSimulation(wb.w, s);
  let wrapped = 0;
  const poison = (o: BotObservation): BotObservation => { wrapped++;
    return { ...o, tick: 999999, phaseTime: 900, self: { ...o.self, id: 63, health: 0, charge: 0, team: 99, munition: 'nuclear',
      position: [99, 99, 99], rotation: [1, 0, 0, 0], heading: -8, turretYaw: 10, barrelPitch: 3 },
      visible: [], lastKnown: [], sounds: [{ bearing: 0, tick: 99 }], impacts: [{ tick: 999, position: [99, 99, 99] }] };
  };
  const c = new GameSimulation(wc.w, s, [], { wrapObservation: poison }); sims.push(a, b, c);
  // Ordinary v13 play must never construct/transport detached knowledge.
  const knowledge = vi.spyOn(match(b).observations!, 'knowledge').mockImplementation(() => { throw new Error('Detached knowledge transport'); });
  for (const sim of [a, b, c]) sim.hold(0);
  for (let i = 0; i < 900; i++) {
    for (const sim of [a, b, c]) { if (sim.state.active === 0 && sim.state.phase === 'aim') sim.hold(0);
      sim.step([FIXED_DT * .5, FIXED_DT * 2.5, FIXED_DT, 0][i % 4]); if (sim.stalledOn?.serial) sim.completeLegacyCarve(); }
    if (i % 50 === 0) { close(a.state, b.state); expect(c.state).toEqual(b.state); }
  }
  expect(wrapped).toBeGreaterThan(0); expect(knowledge).not.toHaveBeenCalled(); expect(b.aiTelemetry().decisions).toBeGreaterThan(0);
  close(a.state, b.state); expect(c.state).toEqual(b.state); expect(b.commandLog()).toEqual(a.commandLog()); expect(b.aiTelemetry()).toEqual(a.aiTelemetry());
  const rw = await world(true, true, true, true, true, true), replay = new MatchReplay(rw.w, JSON.parse(JSON.stringify(b.checkpoint()))); sims.push(replay.simulation);
  for (let i = 0; i < 3000 && !replay.done; i++) { replay.advance(i % 7 + 1); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); }
  expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(b.state);
});

it.each(['legacy', 'cyborg'] as const)('keeps %s decisions invariant under unobserved enemy truth', async profile => {
  const make = async (x: number) => {
    const p = await world(true, true), factory = p.w.createMatchLifecycle!;
    p.w.createMatchLifecycle = (s, state) => { const m = factory(s, state); state.tanks[0].position = [x, 18.6, 0]; return m; };
    const s = setup('bot'); s.rules.startCharge = 0; s.tanks[1].brain = profile;
    const sim = new GameSimulation(p.w, s); sims.push(sim); sim.hold(0); return sim;
  };
  const a = await make(-50), b = await make(50);
  expect(match(a).observations!.knowledge(1).visible).toEqual([]); expect(match(b).observations!.knowledge(1).visible).toEqual([]);
  for (let i = 0; i < 350; i++) {
    for (const sim of [a, b]) { sim.step(FIXED_DT); if (sim.stalledOn?.serial) sim.completeLegacyCarve(); }
    expect(b.state.tanks[1]).toEqual(a.state.tanks[1]); expect(b.state.projectiles).toEqual(a.state.projectiles); expect(b.aiTelemetry()).toEqual(a.aiTelemetry());
  }
  expect(a.aiTelemetry().decisions).toBeGreaterThan(0);
});

it('validates bound bot identity, short packets and observation fences before changing controller state', async () => {
  const p = await world(true, true), sim = new GameSimulation(p.w, setup('bot')); sims.push(sim);
  const id = handle(sim), brain = p.core.createAI([2, id, 1]);
  try {
    for (const unit of [-1, 99, NaN, .5]) expect(() => p.core.createAI([2, id, unit])).toThrow();
    const before = p.core.aiCommand(brain, 3);
    expect(() => p.core.aiCommand(brain, 1, [99])).toThrow('Invalid AI descriptor');
    expect(() => p.core.matchCommand(id, 47, [1, -1, 1, 1, 1, 1, 1, 1, 1])).toThrow();
    expect(p.core.aiCommand(brain, 3)).toEqual(before);
    expect(p.core.matchCommand(id, 17, [0, 0, 1])[0]).toBe(1);
    expect(() => p.core.aiCommand(brain, 0)).toThrow('Observation query is pending'); p.core.matchCommand(id, 24);
    expect(p.core.aiCommand(brain, 3)).toEqual(before);
    sim.dispose(); expect(() => p.core.aiCommand(brain, 3)).toThrow('Unknown resident AI');
  } finally { p.core.disposeAI(brain); }
});

it.each(['explosive', 'heavy', 'incendiary', 'nuclear'] as const)('owns live %s shots with v13 wind, impact, event and replay parity', async ammo => {
  const wa = await world(true, true), wb = await world(true, true, true), s = setup();
  s.rules.wind = { mean: 3, gust: 2, period: 4 }; s.rules.startCharge = 3;
  const a = new GameSimulation(wa.w, s), b = new GameSimulation(wb.w, s); sims.push(a, b);
  let impacts = 0, flying = 0;
  for (let i = 0; i < 450; i++) {
    for (const sim of [a, b]) if (i % 113 === 0 && sim.canFire(0)) { sim.selectMunition(0, ammo); sim.aim(0, i * .01, .45, .2); expect(sim.fire(0)).toBe(true); }
    const dt = [FIXED_DT * .51, FIXED_DT * .49, FIXED_DT * 2.5, 0, FIXED_DT * 1.5][i % 5];
    const ae = a.step(dt), be = b.step(dt); close(ae, be); close(a.state, b.state);
    impacts += be.filter(e => e.type === 'impact').length; flying += b.state.projectiles.length;
    for (const sim of [a, b]) if (sim.stalledOn?.serial) sim.completeLegacyCarve();
  }
  expect(impacts).toBeGreaterThan(0); expect(flying).toBeGreaterThan(0); expect(b.commandLog()).toEqual(a.commandLog());
  const rw = await world(true, true, true), replay = new MatchReplay(rw.w, JSON.parse(JSON.stringify(b.checkpoint()))); sims.push(replay.simulation);
  for (let i = 0; i < 2000 && !replay.done; i++) { replay.advance(i % 9 + 1); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); }
  expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(b.state);
});

it('ignores poisoned and erased projectile output for fire admission, flight and settlement', async () => {
  const make = async () => { const p = await world(true, true, true), sim = new GameSimulation(p.w, setup()); sims.push(sim); return sim; };
  const a = await make(), b = await make(); for (const sim of [a, b]) { sim.aim(0, .8, .5, .2); sim.fire(0); }
  for (let i = 0; i < 220; i++) {
    if (i % 2) b.state.projectiles = [];
    else if (b.state.projectiles[0]) Object.assign(b.state.projectiles[0], { id: 999, owner: 63, munition: 'nuclear', position: [900, 900, 900], velocity: [800, 800, 800], age: 99, origin: [200, 200, 200], peakAltitude: 999 });
    expect(b.canFire(0)).toBe(a.canFire(0)); close(a.step(FIXED_DT), b.step(FIXED_DT)); expect(b.state).toEqual(a.state);
    for (const sim of [a, b]) if (sim.stalledOn?.serial) sim.completeLegacyCarve();
  }
});

it('preserves ordered live shot edits in tick, trace, impact and commit extensions', async () => {
  const make = async (native: boolean) => {
    const p = await world(true, true, native), calls: string[] = [];
    const extension: SimExtension = { id: 'shot-edits', snapshot: () => [...calls], restore: () => {},
      onTick(c) { const s = c.state.projectiles[0]; if (!s) return; calls.push('tick');
        if (c.tick === 2) { s.velocity = [1, 2, 3]; s.age = .25; s.origin = [1, 19, 0]; }
        if (c.tick === 3) s.peakAltitude = 15;
        if (c.tick === 4) c.state.projectiles = [{ ...s, id: s.id + 100, position: [0, 20, 0], velocity: [0, -3, 1] }, { ...s, id: 99 }];
      },
      traceSegment(c, _from, _to, s) { calls.push('trace'); if (c.tick > 4) { s.peakAltitude = 23; s.munition = 'heavy'; } return null; },
      onImpact() { calls.push('impact'); }, onTerrainCommit() { calls.push('commit'); } };
    const sim = new GameSimulation(p.w, setup(), [extension]); sims.push(sim); sim.aim(0, .8, .5, .2); sim.fire(0); return { sim, calls };
  };
  const a = await make(false), b = await make(true);
  for (let i = 0; i < 200; i++) { close(a.sim.step(FIXED_DT), b.sim.step(FIXED_DT)); close(a.sim.state, b.sim.state);
    for (const { sim } of [a, b]) if (sim.stalledOn?.serial) sim.completeLegacyCarve(); }
  expect(b.calls).toEqual(a.calls); expect(new Set(b.calls)).toEqual(new Set(['tick', 'trace', 'impact', 'commit']));
});

it('admits only changed shot fields and rejects malformed edits and stale query steps atomically', async () => {
  const p = await world(true, true, true), sim = new GameSimulation(p.w, setup()); sims.push(sim); sim.fire(0);
  const id = handle(sim), shots = match(sim).shots!, before = p.core.matchCommand(id, 49), old = structuredClone(sim.state.projectiles[0]);
  sim.state.projectiles[0].position = [999, 999, 999];
  expect(() => shots.extension(() => { sim.state.projectiles[0].peakAltitude = 12; throw new Error('edited'); })).toThrow('edited');
  expect(shots.current()).toEqual({ ...old, peakAltitude: 12 });
  const saved = p.core.matchCommand(id, 49), flight = p.core.matchCommand(id, 57);
  for (const words of [[1, 0, 262144], [1, 0, 1, NaN], [2, 0, 1, 77, 0, 2, 88], [1, 0, 2, 63]]) {
    expect(() => p.core.matchCommand(id, 58, words)).toThrow(); expect(p.core.matchCommand(id, 49)).toEqual(saved);
  }
  expect(() => p.core.matchCommand(id, 54, [1, ...before.slice(1, -1)])).toThrow(); expect(p.core.matchCommand(id, 49)).toEqual(saved);
  const scene = p.core.queryScene([]); p.core.releaseQuery(scene, true);
  expect(() => p.core.matchCommand(id, 50, [1, scene, 100])).toThrow(); expect(p.core.matchCommand(id, 57)).toEqual(flight);
  expect(p.core.matchCommand(id, 17, [0, 0, 1])[0]).toBe(1);
  expect(() => p.core.matchCommand(id, 50, [0, 0, 1])).toThrow('Observation query is pending'); p.core.matchCommand(id, 24);
  p.core.matchCommand(id, 50, [0, 0, 1]); const advanced = p.core.matchCommand(id, 57);
  expect(() => p.core.matchCommand(id, 50, [0, 0, 1])).toThrow('Live shot step is pending');
  expect(() => p.core.matchCommand(id, 51, [-1, 0, 0, 0, 0, 1, 0, 0])).toThrow(); expect(p.core.matchCommand(id, 49)).toEqual(saved);
  p.core.matchCommand(id, 56); expect(p.core.matchCommand(id, 57)).toEqual(advanced);
  p.core.matchCommand(id, 52); expect(p.core.matchCommand(id, 49)).toEqual(new Float64Array([0])); expect(() => p.core.matchCommand(id, 57)).toThrow('No live shot');
  sim.dispose(); sim.dispose(); expect(() => p.core.matchCommand(id, 49)).toThrow();
});

it.each(['expiry', 'launch-guard', 'entity'] as const)('matches %s timing and releases live state without registering preview flights', async kind => {
  const make = async (native: boolean) => {
    const p = await world(true, true, native), s = setup(); s.rules.projectileAge = kind === 'expiry' ? FIXED_DT * 2 : 30;
    const extension: SimExtension = { id: 'shot-placement', snapshot: () => null, restore: () => {}, onTick(c) {
      if (c.tick !== 1) return;
      c.state.projectiles = [{ id: 40, owner: 0,
        position: kind === 'launch-guard' ? [0, 17, 0] : kind === 'entity' ? [0, 18.6, 2] : [0, 30, 0], velocity: kind === 'entity' ? [0, 0, 120] : [0, 1, 0], age: kind === 'entity' ? 1 : 0 }];
    } };
    const sim = new GameSimulation(p.w, s, [extension]); sims.push(sim); let scene: number | undefined;
    if (kind === 'entity') { scene = p.core.queryScene([]); Object.assign(p.w, { ballisticQuery: () => ({ core: p.core, id: scene!, kind: 1, range: 100 }) });
      const runner = sim as unknown as { advance: (...args: unknown[]) => unknown }, advance = runner.advance.bind(sim), raycast = p.w.raycast.bind(p.w), isSolid = p.w.isSolid.bind(p.w); let tracing = false;
      runner.advance = (...args) => { tracing = true; try { return advance(...args); } finally { tracing = false; } };
      p.w.raycast = (...args) => { if (tracing) throw new Error('Detached live ray'); return raycast(...args); };
      p.w.isSolid = (...args) => { if (tracing) throw new Error('Detached inside query'); return isSolid(...args); }; }
    sim.fire(0); return { ...p, sim, scene };
  };
  const a = await make(false), b = await make(true); let impact = false;
  for (let i = 0; i < 4; i++) {
    const ae = a.sim.step(FIXED_DT), be = b.sim.step(FIXED_DT); close(ae, be); close(a.sim.state, b.sim.state);
    for (const e of be) if (e.type === 'impact') { impact = true; if (kind === 'entity') expect(e.hits?.some(h => h.tank === 1 && h.direct)).toBe(true); }
    for (const { sim } of [a, b]) if (sim.stalledOn?.serial) sim.completeLegacyCarve();
  }
  expect(impact).toBe(kind !== 'expiry'); expect(b.sim.state.projectiles).toEqual([]);
  expect((b.sim as unknown as { nativeBallistics: NativeBallistics }).nativeBallistics.retainedFlights()).toBe(0);
  expect(() => b.core.matchCommand(handle(b.sim), 57)).toThrow('No live shot');
  for (const p of [a, b]) if (p.scene !== undefined) p.core.releaseQuery(p.scene, true);
});

it.each(['drive', 'bot'] as const)('serializes and hashes resident %s state independently of cadence and replays exactly', async mode => {
  const p = await world(true, true, true, true), s = setup(mode); s.tanks[0].name = 'Pilot 🌒 \ud800';
  const sim = new GameSimulation(p.w, s); sims.push(sim); const canonical = match(sim).canonical!;
  for (let i = 0; i < 420; i++) {
    if (sim.canFire(0) && i % 113 === 0) { sim.aim(0, .4, .5, .3); sim.fire(0); }
    if (mode === 'bot' && sim.state.phase === 'aim' && sim.state.active === 0) sim.hold(0);
    sim.step([FIXED_DT * .5, FIXED_DT * 2.5, 0, FIXED_DT][i % 4], { throttle: i > 200 ? .7 : 0, steer: i > 250 ? -.2 : 0 });
    if (sim.stalledOn?.serial) sim.completeLegacyCarve();
  }
  const before = canonical.snapshot(), hash = sim.matchHash();
  expect(new TextDecoder().decode(before.subarray(0, 16))).toBe('TMT-ENGINE-STATE');
  expect(canonical.checkpoint({}).bytes).toBe(before.length);
  sim.previewPrediction(0, true); expect(canonical.snapshot()).toEqual(before); expect(sim.matchHash()).toBe(hash);
  const rw = await world(true, true, true, true), replay = new MatchReplay(rw.w, JSON.parse(JSON.stringify(sim.checkpoint()))); sims.push(replay.simulation);
  for (let i = 0; i < 2000 && !replay.done; i++) { replay.advance(i % 7 + 1); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); }
  expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(sim.state);
  expect(match(replay.simulation).canonical!.snapshot()).toEqual(before);
});

it('hashes authoritative state despite poisoned output, includes accepted edits and canonicalizes extension JSON', async () => {
  const p = await world(true, true, true, true), sim = new GameSimulation(p.w, setup()); sims.push(sim);
  sim.fire(0); sim.step(FIXED_DT); const c = match(sim).canonical!, bytes = c.snapshot(), checkpoint = sim.checkpoint();
  sim.state.tick = 999; sim.state.phaseTime = 999; sim.state.wind = null; sim.state.projectiles = [];
  sim.state.contacts = []; sim.state.observations = [];
  for (const t of sim.state.tanks) { t.health = 0; t.team = 99; t.position = [99, 99, 99]; t.turretYaw = 7; t.velocity = [88, 88, 88]; t.trackSpeeds = [99, 99]; }
  expect(c.snapshot()).toEqual(bytes); expect(sim.checkpoint()).toEqual(checkpoint);
  expect(c.checkpoint({ b: [0, '🌒'], a: { z: 3, y: -0 } }).hash).toBe(c.checkpoint({ a: { y: 0, z: 3 }, b: [0, '🌒'] }).hash);
  expect(c.checkpoint({ changed: true }).hash).not.toBe(checkpoint.hash);
  const t = sim.state.tanks[0]; match(sim).motion!.extension(() => { t.velocity[0] += 1; }); expect(c.snapshot()).not.toEqual(bytes);
});

it('rejects malformed canonical input and pending observations without changing the snapshot', async () => {
  const p = await world(true, true, true, true), sim = new GameSimulation(p.w, setup()); sims.push(sim); const id = handle(sim), c = match(sim).canonical!, bytes = c.snapshot();
  for (const d of [[], [2, 65], [1, NaN], [1, 65536], [1, .5], [-1], [1_048_577]]) expect(() => p.core.matchCommand(id, 60, d)).toThrow('Invalid canonical text');
  expect(() => p.core.matchCommand(id, 59, [1, 0])).toThrow('Invalid canonical admission'); expect(c.snapshot()).toEqual(bytes);
  expect(p.core.matchCommand(id, 17, [0, 0, 1])[0]).toBe(1); expect(() => c.checkpoint({})).toThrow('Observation query is pending'); p.core.matchCommand(id, 24);
  expect(c.snapshot()).toEqual(bytes); sim.dispose(); expect(() => c.checkpoint({})).toThrow('Unknown resident match');
});

it.each(['legacy', 'cyborg'] as const)('checksums %s controller state during a decision and replays the unfinished search', async profile => {
  const p = await world(true, true, true, true), s = setup('bot'); s.tanks[1].brain = profile;
  const sim = new GameSimulation(p.w, s); sims.push(sim); sim.hold(0);
  for (let i = 0; i < 100; i++) { sim.step(FIXED_DT); if (sim.stalledOn?.serial) sim.completeLegacyCarve(); }
  const checkpoint = sim.checkpoint(), bytes = match(sim).canonical!.snapshot();
  const rw = await world(true, true, true, true), replay = new MatchReplay(rw.w, JSON.parse(JSON.stringify(checkpoint))); sims.push(replay.simulation);
  for (let i = 0; i < 500 && !replay.done; i++) { replay.advance(i % 7 + 1); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); }
  expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(match(replay.simulation).canonical!.snapshot()).toEqual(bytes);
  // Restarting a resident controller changes hidden decision state even when no
  // presentation/gameplay field has yet changed.
  const before = structuredClone(sim.state); match(sim).residentBrain(1)!.begin(); expect(sim.state).toEqual(before); expect(sim.matchHash()).not.toBe(checkpoint.hash);
});

it('normalizes negative zero and excludes engine allocation handles and presentation frame clocks', async () => {
  const a = await world(true, true, true, true), b = await world(true, true, true, true);
  const extra = b.core.createMatch([1, 1, 3, -1, -1, -1, 3, 1, 0, 1, 1]); b.core.matchCommand(extra, 7, [7]);
  const brain = b.core.createAI([1, extra]), flight = b.core.createFlights([1, 10, 18, 30, 19, 0, 0, 0, 1]);
  b.core.disposeAI(brain); b.core.disposeMatch(extra); b.core.disposeFlights(flight);
  b.v.addTrimesh([1000, 0, 1000, 1001, 0, 1000, 1001, 0, 1001], [0, 1, 2]);
  const sa = new GameSimulation(a.w, setup()), sb = new GameSimulation(b.w, setup()); sims.push(sa, sb);
  b.core.matchCommand(handle(sb), 45, [1, 0, 128, -0]);
  expect(sb.matchHash()).toBe(sa.matchHash());
  match(sb).frame(FIXED_DT * .4); expect(sb.matchHash()).toBe(sa.matchHash()); match(sb).frame(0, true);
  for (let i = 0; i < 30; i++) { sa.step(FIXED_DT); sb.step(FIXED_DT); }
  expect(sb.matchHash()).toBe(sa.matchHash()); expect(match(sb).canonical!.snapshot()).toEqual(match(sa).canonical!.snapshot());
});
