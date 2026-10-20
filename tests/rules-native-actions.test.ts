import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { testMatchCore } from './helpers/native-match';
import { SphereWorld } from './helpers/sphere-world';
import { FakeTransactions } from './helpers/fake-transactions';
import { VehicleWorld } from './helpers/vehicle-world';
import { NativeMatch } from '../src/game/native-match';
import { NativeCombat } from '../src/game/native-combat';
import { NativeBallistics } from '../src/game/native-ballistics';
import { GameSimulation, MatchReplay, FIXED_DT } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { ProjectileState, V3 } from '../src/game/contracts';
import { normalize, rotation } from '../src/game/math';
import type { MunitionId } from '../src/game/munitions';

let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());
const setup = (mode: 'local' | 'drive' | 'bot' = 'local') => practiceSetup({ seed: 19, mode, player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
function world(native: boolean, engine = core) {
  const w = new SphereWorld(); w.createMatchLifecycle = (s, state) => new NativeMatch(engine, s, state, true, true, native);
  w.createCombat = (s, state, kit) => new NativeCombat(engine, s, state, kit);
  w.createBallistics = (s, gravity) => new NativeBallistics(engine, s, gravity, w.radius); return w;
}
const lifecycle = (s: GameSimulation) => (s as unknown as { nativeMatch: NativeMatch }).nativeMatch;
function equivalent(a: unknown, b: unknown, path = 'value'): void {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) expect(a, path).toBe(b);
    else expect(Math.abs(a - b), path).toBeLessThan(1e-10);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a), path).toEqual(Object.keys(b));
    for (const key of Object.keys(a)) equivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
  } else expect(a, path).toBe(b);
}
const launch = (s: GameSimulation) => (s as unknown as { makeProjectile(id: number, allocate: boolean): ProjectileState }).makeProjectile(0, false);

it.each(['mortar', 'cannon', 'rail'] as const)('matches %s envelope, wrapped aim, launch sockets, speed and ammunition at varied poses', weapon => {
  const s = setup('drive'); s.tanks[0].loadout.weapon = weapon;
  const a = new GameSimulation(world(true), s), b = new GameSimulation(world(false), s);
  try {
    for (const munition of ['explosive', 'heavy', 'incendiary', 'nuclear'] as MunitionId[]) for (let i = 0; i < 96; i++) {
      const yaw = -9 + i * .215, pitch = [-2, -.1, .4, .9, 2][i % 5], power = [-1, 0, .37, 1, 2][i % 5];
      const up = normalize([Math.sin(i * .3), 1, Math.cos(i * .2)]);
      for (const sim of [a, b]) {
        sim.state.tanks[0].position = up.map(v => v * 18.55) as V3; sim.state.tanks[0].rotation = rotation(up, i * .09);
        expect(sim.selectMunition(0, munition)).toBe(true); expect(sim.aim(0, yaw, pitch, power)).toBe(true);
      }
      equivalent(a.state, b.state, `aim ${i}`); equivalent(a.muzzle(0), b.muzzle(0), 'muzzle'); equivalent(launch(a), launch(b), 'launch');
    }
    for (const id of [-1, 9, NaN]) { expect(a.aim(id, 0, 0, .5)).toBe(false); expect(a.canFire(id)).toBe(false); }
    for (const value of [NaN, Infinity, -Infinity]) { expect(a.aim(0, value, 0, .5)).toBe(false); expect(a.aim(0, 0, value, .5)).toBe(false); expect(a.aim(0, 0, 0, value)).toBe(false); }
    equivalent(a.state, b.state);
  } finally { a.dispose(); b.dispose(); }
});

it('owns action admission, shot IDs, selected ammo, recoil and fuel despite poisoned output mirrors', () => {
  const s = setup(); s.rules.startCharge = 3; s.rules.ammo.heavy = 1;
  const a = new GameSimulation(world(true), s), b = new GameSimulation(world(true), s);
  try {
    for (const sim of [a, b]) { expect(sim.selectMunition(0, 'heavy')).toBe(true); expect(sim.aim(0, .2, .7, .6)).toBe(true); }
    const tank = a.state.tanks[0]; tank.turretYaw = NaN; tank.barrelPitch = NaN; tank.power = NaN; tank.munition = 'nuclear'; tank.ammo!.heavy = 99; tank.health = 0; tank.charge = 0;
    (a as unknown as { nextShot: number }).nextShot = 999;
    expect(a.canFire(0)).toBe(true); expect(a.fire(1)).toBe(false);
    expect(a.fire(0)).toBe(true); expect(b.fire(0)).toBe(true); equivalent(a.state, b.state); expect(a.state.projectiles[0].id).toBe(1);
    expect(tank.ammo!.heavy).toBe(0); expect(tank.munition).toBe('heavy');
    const fuel = tank.movement; tank.movement = 0; expect(lifecycle(a).actionAllowed('move', 0)).toBe(true);
    for (let i = 0; i < 30; i++) equivalent(a.step(FIXED_DT, { throttle: 1, steer: .2 }), b.step(FIXED_DT, { throttle: 1, steer: .2 }));
    equivalent(a.state, b.state); expect(tank.movement).toBeLessThan(fuel);
    expect(a.endMove(1)).toBe(false); expect(a.endMove(0)).toBe(true); expect(b.endMove(0)).toBe(true); tank.movement = 999;
    expect(lifecycle(a).actionAllowed('move', 0)).toBe(false);
    for (let i = 0; i < 500 && a.state.turn < 3; i++) for (const sim of [a, b]) {
      sim.step(FIXED_DT); if (sim.stalledOn?.serial) sim.completeLegacyCarve(); if (sim.state.active === 1 && sim.state.phase === 'aim') sim.hold(1);
    }
    expect(a.state.turn).toBe(3); equivalent(a.state, b.state);
    tank.ammo!.heavy = 99; expect(a.selectMunition(0, 'heavy')).toBe(false); expect(a.canFire(0)).toBe(false);
    expect(a.selectMunition(0, 'nuclear')).toBe(true); tank.charge = 0; expect(a.canFire(0)).toBe(true);
  } finally { a.dispose(); b.dispose(); }
});

it('validates kit, pose and action packets atomically and releases armament with its match', () => {
  const s = new GameSimulation(world(true), setup()), n = lifecycle(s), id = (n as unknown as { id: number }).id;
  try {
    const before = core.matchCommand(id, 0);
    expect(() => core.matchCommand(id, 15, [0, 0])).toThrow('Invalid armament');
    expect(() => core.matchCommand(id, 12, [1, ...Array(28).fill(NaN)])).toThrow('Invalid match descriptor');
    expect(() => core.matchCommand(id, 10, [1, 0, 0])).toThrow('Invalid action length');
    expect(() => core.matchCommand(id, 3, [0, 0])).toThrow('Resident actions require admission');
    expect(core.matchCommand(id, 0)).toEqual(before);
    const t = s.state.tanks[0];
    expect(core.matchCommand(id, 10, [1, 0, 0, 0, 0, NaN, ...t.position.slice(1), ...t.rotation, ...t.velocity])[13]).toBe(0);
    expect(core.matchCommand(id, 0)).toEqual(before);
    expect(s.setLoadout(0, { tracks: 'scout', barrel: 'cannon', armor: 'light' })).toBe(true); expect(s.fire(0)).toBe(true);
    expect(s.setLoadout(0, { tracks: 'scout', barrel: 'mortar', armor: 'light' })).toBe(false);
  } finally { s.dispose(); }
  expect(() => core.matchCommand(id, 13, Array(13).fill(0))).toThrow('Unknown resident match');
});

it.each(['local', 'drive', 'bot'] as const)('matches %s action/physics/AI flow and exact native JSON replay', mode => {
  const s = setup(mode); if (mode === 'bot') s.tanks[1].brain = 'cyborg';
  const a = new GameSimulation(world(true), s), b = new GameSimulation(world(false), s);
  try {
    for (let frame = 0; frame < 1100; frame++) {
      if (frame % 103 === 0) for (const sim of [a, b]) { const id = sim.state.active; sim.selectMunition(id, frame % 2 ? 'heavy' : 'explosive'); sim.aim(id, .8, .8, .2); sim.fire(id); }
      const dt = [FIXED_DT / 2, FIXED_DT * 2.5, FIXED_DT, 0, NaN, Infinity, -.1, 5][frame % 8], drive = { throttle: .7, steer: -.3 };
      equivalent(a.step(dt, drive), b.step(dt, drive), `events ${frame}`); equivalent(a.state, b.state, `state ${frame}`);
      expect(a.commandLog()).toEqual(b.commandLog()); expect(a.aiTelemetry()).toEqual(b.aiTelemetry());
      for (const sim of [a, b]) if (sim.stalledOn?.serial) sim.completeLegacyCarve();
    }
    const replay = new MatchReplay(world(true), JSON.parse(JSON.stringify(a.checkpoint())));
    try { for (let i = 0; i < 2000 && !replay.done; i++) { replay.advance(20); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); } expect(replay.verified()).toBe(true); }
    finally { replay.simulation.dispose(); }
  } finally { a.dispose(); b.dispose(); }
});

it('does not admit actions before terrain commits and replays at a different preparation latency', () => {
  let frame = 0; const w = world(true); w.transactions = new FakeTransactions(w, () => frame, { latency: 80 });
  const s = setup(); s.rules.aimSeconds = 4; s.rules.moveSeconds = .1;
  const sim = new GameSimulation(w, s); let stalls = 0;
  try {
    sim.aim(0, 0, -.1, 0); expect(sim.fire(0)).toBe(true);
    for (; frame < 220; frame++) { sim.step(FIXED_DT); if (sim.stalledOn) { stalls++; expect(sim.hold(0)).toBe(false); expect(sim.state.turn).toBe(1); } }
    expect(stalls).toBeGreaterThan(0); expect(sim.state.turn).toBeGreaterThan(1);
    const rw = world(true); let rf = 0; rw.transactions = new FakeTransactions(rw, () => rf, { latency: 120 });
    const replay = new MatchReplay(rw, JSON.parse(JSON.stringify(sim.checkpoint())));
    try { for (; rf < 1000 && !replay.done; rf++) replay.advance(20); expect(replay.verified()).toBe(true); } finally { replay.simulation.dispose(); }
  } finally { sim.dispose(); }
});

it('preserves native Rapier chassis behavior while retaining aim and movement in Rust', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1'); const fixtures: { v: VehicleWorld; sim: GameSimulation }[] = [];
  try {
    for (const native of [true, false]) {
      const v = await VehicleWorld.create(); v.addPlane(); const w = world(native, v.physics.native!.core);
      w.stepTanks = (tanks, inputs, dt) => { v.bridge.beforeStep(tanks, inputs, dt); v.physics.step(); v.bridge.afterStep(tanks, dt); };
      const sim = new GameSimulation(w, setup('drive')); fixtures.push({ v, sim });
      for (const tank of sim.state.tanks) { tank.position = [0, .6, tank.id * 4]; tank.rotation = [0, 0, 0, 1]; tank.heading = 0; }
    }
    const [a, b] = fixtures;
    for (let frame = 0; frame < 700; frame++) {
      const dt = [FIXED_DT * .51, FIXED_DT * .49, FIXED_DT * 2.5, 0, FIXED_DT * 1.5][frame % 5];
      const drive = { throttle: frame < 150 ? 0 : frame < 500 ? 1 : -.7, steer: frame > 350 && frame < 600 ? -.8 : 0 };
      equivalent(a.sim.step(dt, drive), b.sim.step(dt, drive)); equivalent(a.sim.state, b.sim.state, `Rapier ${frame}`); expect(a.v.physics.tick).toBe(b.v.physics.tick);
    }
    expect(a.sim.state.tanks[0].position[2]).not.toBe(0);
  } finally { for (const f of fixtures) { f.sim.dispose(); f.v.dispose(); } vi.unstubAllEnvs(); }
});
