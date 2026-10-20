import { afterAll, beforeAll, expect, it } from 'vitest';
import { testMatchCore } from './helpers/native-match';
import { SphereWorld } from './helpers/sphere-world';
import { NativeMatch } from '../src/game/native-match';
import { NativeCombat } from '../src/game/native-combat';
import { NativeBallistics } from '../src/game/native-ballistics';
import { GameSimulation, MatchReplay, FIXED_DT } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import type { BotObservation } from '../src/game/api/bot';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { ProjectileState, TankState, V3, WorldQuery } from '../src/game/contracts';
import { normalize, rotation } from '../src/game/math';

let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());
const setup = () => practiceSetup({ seed: 19, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
function world(native: boolean) {
  const w = new SphereWorld(); w.createMatchLifecycle = (s, state) => new NativeMatch(core, s, state, true, true, true, native);
  w.createCombat = (s, state, kit) => new NativeCombat(core, s, state, kit);
  w.createBallistics = (s, gravity) => new NativeBallistics(core, s, gravity, w.radius); return w;
}
const internals = (s: GameSimulation) => s as unknown as {
  nativeMatch: NativeMatch; updateContacts(): void; observe(id: number): BotObservation; hear(t: TankState, p: ProjectileState): void;
  heard: unknown[][]; ownImpacts: { tick: number; position: V3 }[][];
};
function equivalent(a: unknown, b: unknown, path = 'value'): void {
  if (typeof a === 'number' && typeof b === 'number') expect(Math.abs(a - b), path).toBeLessThan(1e-10);
  else if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a), path).toEqual(Object.keys(b));
    for (const key of Object.keys(a)) equivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
  } else expect(a, path).toBe(b);
}
const knowledge = (s: GameSimulation, id: number) => {
  const { visible, lastKnown, sounds, impacts } = internals(s).observe(id); return { visible, lastKnown, sounds, impacts };
};

it('reveals every live enemy to both AI observation backends when fog is disabled', () => {
  const s = setup(); s.rules.fog = false;
  s.tanks[0].spawn = { up: [0, 1, 0], heading: 0 }; s.tanks[1].spawn = { up: [0, -1, 0], heading: 0 };
  for (const native of [false, true]) {
    const sim = new GameSimulation(world(native), s);
    try {
      for (const id of [0, 1]) {
        const other = 1 - id, observed = knowledge(sim, id);
        expect(observed.lastKnown).toEqual([]);
        expect(observed.visible).toHaveLength(1);
        expect(observed.visible[0]).toMatchObject({ tank: other, position: sim.state.tanks[other].position });
      }
    } finally { sim.dispose(); }
  }
});

it.each(['mortar', 'cannon', 'rail'] as const)('preserves %s sight geometry and ordered early-out queries at varied poses', weapon => {
  const s = setup(); s.tanks[0].loadout.weapon = weapon; s.tanks[1].loadout.weapon = weapon;
  const worlds = [world(true), world(false)], sims = worlds.map(w => new GameSimulation(w, s));
  try {
    const logs: number[][][] = [[], []];
    worlds.forEach((w, i) => { const ray = w.raycast.bind(w); w.raycast = (o, d, r) => { logs[i].push([...o, ...d, r]); return ray(o, d, r); }; });
    for (let k = 0; k < 72; k++) {
      for (const sim of sims) {
        for (const t of sim.state.tanks) {
          const up = normalize([Math.sin(k * .13 + t.id), 1, Math.cos(k * .17 + t.id)]);
          t.position = up.map(v => v * 18.55) as V3; t.rotation = rotation(up, k * .31);
          internals(sim).nativeMatch.restoreActions(t.id, { turretYaw: k * .2 - 5, barrelPitch: .1 + k * .01 });
        }
        internals(sim).updateContacts();
      }
      for (let id = 0; id < 2; id++) equivalent(sims[0].sightPoints(sims[0].state.tanks[id]), sims[1].sightPoints(sims[1].state.tanks[id]));
      equivalent(logs[0], logs[1], `queries ${k}`); logs.forEach(l => l.splice(0)); equivalent(sims[0].state.observations, sims[1].state.observations);
    }
  } finally { sims.forEach(s => s.dispose()); }
});

it('owns private knowledge despite poisoned contact, hearing, impact and health output mirrors', () => {
  const w = world(true), sim = new GameSimulation(w, setup()), native = internals(sim).nativeMatch;
  try {
    sim.state.tanks[1].position = [0, -18.55, 0]; internals(sim).updateContacts();
    const expected = knowledge(sim, 0); expect(expected.lastKnown).toHaveLength(1);
    sim.state.observations![0][1] = { position: [123, 456, 789], observedAt: 999, visible: true, source: 'scan' };
    sim.state.contacts[0] = sim.state.observations![0][1]; internals(sim).heard[0].push({ bearing: 123, tick: 9 });
    internals(sim).ownImpacts[0].push({ tick: 999, position: [999, 999, 999] }); sim.state.tanks[1].health = 0;
    expect(knowledge(sim, 0)).toEqual(expected);
    // Native aim also supplies sight geometry, even when the mirror is corrupt.
    const points = sim.sightPoints(sim.state.tanks[0]); sim.state.tanks[0].turretYaw = NaN; expect(sim.sightPoints(sim.state.tanks[0])).toEqual(points);
    native.observations!.refresh(w); expect(sim.state.observations![0][1]?.visible).toBe(false);
    expect(sim.state.contacts[0]).toBe(sim.state.observations![0][1]);
  } finally { sim.dispose(); }
});

it('rolls back a partially answered radar scan including RNG and charge, then retries identically', () => {
  const s = setup(); s.rules.startCharge = 3;
  s.tanks.push({ ...s.tanks[1], spawn: { up: [0, -1, 0], heading: 0 } });
  const aWorld = world(true), bWorld = world(true), a = new GameSimulation(aWorld, s), b = new GameSimulation(bWorld, s);
  try {
    const before = structuredClone(a.state), surface = aWorld.surface.bind(aWorld); let calls = 0;
    aWorld.surface = up => { if (++calls === 2) throw new Error('query failed'); return surface(up); };
    expect(() => a.scan(0)).toThrow('query failed'); expect(calls).toBe(2); expect(a.state).toEqual(before);
    aWorld.surface = surface; expect(a.scan(0)).toBe(true); expect(b.scan(0)).toBe(true); expect(a.state).toEqual(b.state);
    expect(internals(a).nativeMatch.random()).toBe(internals(b).nativeMatch.random());
    expect(a.scan(0)).toBe(false); expect(a.scan(1)).toBe(false);
  } finally { a.dispose(); b.dispose(); }
});

it.each([19, 4294967297, Number.MAX_SAFE_INTEGER])('preserves same-tick uncertainty and four-entry hearing/impact histories for seed %s', seed => {
  const s = setup(); s.seed = seed;
  const worlds = [world(true), world(false)], sims = worlds.map(w => new GameSimulation(w, s));
  try {
    worlds.forEach(w => { w.kinematic = false; w.raycast = o => ({ point: o, normal: [0, 1, 0], distance: .001, material: 1 }); });
    sims.forEach(s => internals(s).updateContacts());
    for (let k = 0; k < 10; k++) {
      for (const [i, sim] of sims.entries()) {
        sim.hold(sim.state.active);
        internals(sim).hear(sim.state.tanks[1], { id: k + 1 } as ProjectileState);
        const position: V3 = [k, 2, 3];
        if (i === 0) internals(sim).nativeMatch.observations!.impact(0, position);
        else { const impacts = internals(sim).ownImpacts[0]; impacts.push({ tick: sim.state.tick, position }); if (impacts.length > 4) impacts.shift(); }
      }
      equivalent(knowledge(sims[0], 0), knowledge(sims[1], 0), `turn ${k}`);
      if (k === 4) sims.forEach(s => s.step(FIXED_DT));
    }
    const o = knowledge(sims[0], 0); expect(o.sounds).toHaveLength(4); expect(o.impacts).toHaveLength(4); expect(o.lastKnown[0].uncertainty).toBe(20);
  } finally { sims.forEach(s => s.dispose()); }
});

it('rejects malformed resumes without partial publication and cancels pending requests', () => {
  const sim = new GameSimulation(world(true), setup()), m = internals(sim).nativeMatch, id = (m as unknown as { id: number }).id;
  try {
    const snapshot = core.matchCommand(id, 26), pose = sim.state.tanks.flatMap(t => [...t.position, ...t.rotation]);
    expect(core.matchCommand(id, 17, [0, 0, 1, ...pose])[0]).toBe(1);
    expect(() => core.matchCommand(id, 18, [2])).toThrow('Invalid sight answer'); expect(core.matchCommand(id, 26)).toEqual(snapshot);
    expect(() => m.frame(FIXED_DT)).toThrow('Observation query is pending'); expect(() => m.random()).toThrow('Observation query is pending');
    core.matchCommand(id, 24); expect(core.matchCommand(id, 26)).toEqual(snapshot);
    expect(() => core.matchCommand(id, 17, [0, 0, 1, ...pose.map(() => NaN)])).toThrow('Invalid match descriptor');
    expect(() => core.matchCommand(id, 21, [99, 1, 2, 3])).toThrow('Invalid observer'); expect(core.matchCommand(id, 26)).toEqual(snapshot);
    internals(sim).updateContacts(); expect(core.matchCommand(id, 26)).toEqual(snapshot);
  } finally { sim.dispose(); }
  expect(() => core.matchCommand(id, 26)).toThrow('Unknown resident match');
});

it.each([1, 2] as const)('uses a resident query kind %s for sight and radar without host callbacks; stale leases do not publish', kind => {
  const s = setup(); s.rules.startCharge = 3;
  const w = world(true) as SphereWorld & Pick<WorldQuery, 'ballisticQuery'>, sim = new GameSimulation(w, s);
  const scene = core.queryScene([]); if (kind === 2) core.enablePhysics();
  const id = kind === 2 ? core.queryWorld([scene, 100]) : scene;
  w.ballisticQuery = () => ({ core, id, kind, range: 100 });
  try {
    w.surface = () => { throw new Error('host surface called'); }; w.raycast = () => { throw new Error('host ray called'); };
    internals(sim).updateContacts(); expect(sim.state.observations![0][1]?.visible).toBe(true);
    expect(sim.scan(0)).toBe(true); expect(sim.state.observations![0][1]?.source).toBe('scan');
    const before = structuredClone(sim.state); core.releaseQuery(id, kind);
    expect(() => internals(sim).updateContacts()).toThrow(kind === 2 ? 'Unknown composed query snapshot' : 'Unknown query snapshot'); expect(sim.state).toEqual(before);
  } finally { if (kind === 2) { core.releaseQuery(scene, true); core.disposePhysics(); } sim.dispose(); }
});

it.each(['local', 'bot'] as const)('matches v9 %s gameplay, private knowledge and exact native JSON replay', mode => {
  const s = setup(); s.mode = mode; if (mode === 'bot') { s.teams[1].ai = true; s.tanks[1].brain = 'cyborg'; }
  const a = new GameSimulation(world(true), s), b = new GameSimulation(world(false), s);
  try {
    for (let frame = 0; frame < 1000; frame++) {
      if (frame % 103 === 0) for (const sim of [a, b]) { const id = sim.state.active; sim.scan(id); sim.aim(id, .8, .8, .2); sim.fire(id); }
      const dt = [FIXED_DT / 2, FIXED_DT * 2.5, FIXED_DT, 0][frame % 4], drive = { throttle: .7, steer: -.3 };
      equivalent(a.step(dt, drive), b.step(dt, drive), `events ${frame}`); equivalent(a.state, b.state, `state ${frame}`);
      for (let id = 0; id < 2; id++) equivalent(knowledge(a, id), knowledge(b, id), `observation ${frame}/${id}`);
      expect(a.commandLog()).toEqual(b.commandLog()); expect(a.aiTelemetry()).toEqual(b.aiTelemetry());
      for (const sim of [a, b]) if (sim.stalledOn?.serial) sim.completeLegacyCarve();
    }
    const replay = new MatchReplay(world(true), JSON.parse(JSON.stringify(a.checkpoint())));
    try { for (let i = 0; i < 2000 && !replay.done; i++) { replay.advance(20); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); } expect(replay.verified()).toBe(true); }
    finally { replay.simulation.dispose(); }
  } finally { a.dispose(); b.dispose(); }
});
