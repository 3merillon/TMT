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
import type { MatchCommand } from '../src/game/rules/checkpoint';

let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());
const setup = (mode: 'local' | 'drive' | 'bot' = 'local') => practiceSetup({ seed: 19, mode, player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
function world(native: boolean, engine = core) {
  const w = new SphereWorld(); w.createMatchLifecycle = (s, state) => new NativeMatch(engine, s, state, true, true, true, true, native);
  w.createCombat = (s, state, kit) => new NativeCombat(engine, s, state, kit);
  w.createBallistics = (s, gravity) => new NativeBallistics(engine, s, gravity, w.radius); return w;
}
const match = (s: GameSimulation) => (s as unknown as { nativeMatch: NativeMatch }).nativeMatch;
const handle = (s: GameSimulation) => (match(s) as unknown as { id: number }).id;

it('records accepted original inputs atomically, omits internal/refused actions and ignores host log mutations', () => {
  const s = setup('drive'); s.rules.startCharge = 3;
  const sim = new GameSimulation(world(true), s), journal = match(sim).journal!;
  try {
    expect(sim.aim(0, 19, 2, 3)).toBe(true); expect(sim.aim(0, NaN, 1, .5)).toBe(false); expect(sim.fire(1)).toBe(false);
    expect(sim.selectMunition(0, 'heavy')).toBe(true); expect(sim.scan(0)).toBe(true);
    expect(sim.commandLog()).toEqual([
      { tick: 0, tank: 0, c: { k: 'aim', yaw: 19, pitch: 2, power: 3 } },
      { tick: 0, tank: 0, c: { k: 'munition', id: 'heavy' } },
      { tick: 0, tank: 0, c: { k: 'scan' } },
    ]);
    const expected = sim.commandLog(); (expected as MatchCommand[]).splice(0); expect(sim.commandLog()).toHaveLength(3);
    (sim as unknown as { commands: MatchCommand[] }).commands.push({ tick: 999, tank: 0, c: { k: 'fire' } });
    match(sim).admitAction('aim', 0, false, [0, .7, .5]); expect(sim.commandLog()).toHaveLength(3);
    expect(sim.fire(0)).toBe(true); expect(sim.commandLog().at(-1)?.c.k).toBe('fire');
    for (let i = 0; i < 6; i++) sim.step(FIXED_DT, { throttle: 99, steer: -99 });
    expect(sim.commandLog().filter(c => c.c.k === 'drive')).toEqual([{ tick: 0, tank: 0, c: { k: 'drive', throttle: 1, steer: -1 } }]);
    (sim as unknown as { loggedDrive: unknown }).loggedDrive = { throttle: NaN, steer: NaN };
    journal.drive({ throttle: 1, steer: -1 }); expect(sim.commandLog().filter(c => c.c.k === 'drive')).toHaveLength(1);
    expect(sim.checkpoint().commands).toEqual(sim.commandLog());
  } finally { sim.dispose(); }
});

it('does not journal a failed radar query and resets command origin before subsequent internal actions', () => {
  const w = world(true), s = setup(); s.rules.startCharge = 3;
  const sim = new GameSimulation(w, s);
  try {
    const surface = w.surface.bind(w); w.surface = () => { throw new Error('radar query failed'); };
    expect(() => sim.scan(0)).toThrow('radar query failed'); expect(sim.commandLog()).toEqual([]);
    expect(match(sim).journal!.recording).toBe(false);
    match(sim).admitAction('aim', 0, false, [0, .6, .4]); expect(sim.commandLog()).toEqual([]);
    w.surface = surface; expect(sim.scan(0)).toBe(true); expect(sim.commandLog()).toEqual([{ tick: 0, tank: 0, c: { k: 'scan' } }]);
  } finally { sim.dispose(); }
});

it('exports histories in bounded chunks and rejects malformed journal/replay packets without mutation', () => {
  const sim = new GameSimulation(world(true), setup()), id = handle(sim);
  try {
    const before = core.matchCommand(id, 0);
    expect(() => core.matchCommand(id, 10, [0, 0, 0, 0, .6, .5, 2])).toThrow('Invalid action origin');
    expect(core.matchCommand(id, 0)).toEqual(before); expect(sim.commandLog()).toEqual([]);
    expect(() => core.matchCommand(id, 32, [1, 1, 0, 0, 2, 0, 1, 0, 0, 0])).toThrow('out of order');
    expect(() => core.matchCommand(id, 32, [1, 1, 0, 0, 0, 0, 99, 0, 0, 0])).toThrow('Invalid replay command');
    expect(() => core.matchCommand(id, 35)).toThrow('Resident replay is absent');
    for (let i = 0; i < 4200; i++) expect(sim.aim(0, i * .1, .6, .4)).toBe(true);
    expect(core.matchCommand(id, 31, [0, 4096])).toHaveLength(1 + 4096 * 6);
    const log = sim.commandLog(); expect(log).toHaveLength(4200); expect(log[4199].c).toEqual({ k: 'aim', yaw: 419.90000000000003, pitch: .6, power: .4 });
    expect(() => core.matchCommand(id, 31, [0, 4097])).toThrow('Invalid journal read'); expect(sim.commandLog()).toEqual(log);
    expect(() => core.matchCommand(id, 32, [0, 0, 0, 0])).toThrow('Invalid replay admission');
  } finally { sim.dispose(); }
  expect(() => core.matchCommand(id, 31, [0, 1])).toThrow('Unknown resident match');
});

it.each(['local', 'drive', 'bot'] as const)('matches v10 %s gameplay/logs and replays from an immutable native plan', mode => {
  const s = setup(mode); if (mode === 'bot') s.tanks[1].brain = 'cyborg';
  const a = new GameSimulation(world(true), s), b = new GameSimulation(world(false), s);
  try {
    for (let frame = 0; frame < 900; frame++) {
      if (frame % 103 === 0) for (const sim of [a, b]) { const id = sim.state.active; sim.scan(id); sim.aim(id, .8, .8, .2); sim.fire(id); }
      const dt = [FIXED_DT / 2, FIXED_DT * 2.5, FIXED_DT, 0, NaN, Infinity, -.1, 5][frame % 8], drive = { throttle: frame % 7 ? .7 : 0, steer: -.3 };
      expect(a.step(dt, drive)).toEqual(b.step(dt, drive)); expect(a.state).toEqual(b.state);
      expect(a.commandLog()).toEqual(b.commandLog()); expect(a.aiTelemetry()).toEqual(b.aiTelemetry());
      for (const sim of [a, b]) if (sim.stalledOn?.serial) sim.completeLegacyCarve();
    }
    const checkpoint = JSON.parse(JSON.stringify(a.checkpoint())), replay = new MatchReplay(world(true), checkpoint);
    try {
      // Neither public checkpoint copies nor the legacy scheduler fields own it.
      const mirror = replay as unknown as { cursor: number; applied: number; drive: unknown; checkpoint: { tick: number; hash: string; commands: unknown[] } };
      mirror.cursor = 999999; mirror.applied = 999999; mirror.drive = { throttle: -1, steer: 1 }; mirror.checkpoint.tick = 0; mirror.checkpoint.hash = '0000000000000000'; mirror.checkpoint.commands.splice(0);
      expect(replay.done).toBe(false);
      for (let i = 0; i < 2000 && !replay.done; i++) { replay.advance(i % 3 + 1); if (replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve(); }
      expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.commandLog()).toEqual(a.commandLog());
    } finally { replay.simulation.dispose(); }
  } finally { a.dispose(); b.dispose(); }
});

it('retains the terrain-before-command fence and survives a different replay preparation latency', () => {
  let frame = 0; const w = world(true); w.transactions = new FakeTransactions(w, () => frame, { latency: 70 });
  const s = setup(); s.rules.aimSeconds = 4; s.rules.moveSeconds = .1;
  const sim = new GameSimulation(w, s); let stalls = 0;
  try {
    sim.aim(0, 0, -.1, 0); expect(sim.fire(0)).toBe(true);
    for (; frame < 240; frame++) { sim.step(FIXED_DT); if (sim.stalledOn) { stalls++; const log = sim.commandLog(); expect(sim.hold(0)).toBe(false); expect(sim.commandLog()).toEqual(log); } }
    expect(stalls).toBeGreaterThan(0);
    const rw = world(true); let rf = 0; rw.transactions = new FakeTransactions(rw, () => rf, { latency: 120 });
    const replay = new MatchReplay(rw, JSON.parse(JSON.stringify(sim.checkpoint())));
    try { for (; rf < 1000 && !replay.done; rf++) replay.advance(20); expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); }
    finally { replay.simulation.dispose(); }
  } finally { sim.dispose(); }
});

it('checks target-tick inputs before done and reports native replay refusal precisely', () => {
  const sim = new GameSimulation(world(true), setup());
  try {
    sim.aim(0, 1, .6, .4); const checkpoint = JSON.parse(JSON.stringify(sim.checkpoint()));
    const valid = new MatchReplay(world(true), checkpoint);
    try { expect(valid.done).toBe(false); expect(valid.advance()).toBe('done'); expect(valid.verified()).toBe(true); }
    finally { valid.simulation.dispose(); }
    checkpoint.commands.push({ tick: 0, tank: 1, c: { k: 'fire' } });
    const refused = new MatchReplay(world(true), checkpoint);
    try { expect(() => refused.advance()).toThrow('Replay diverged: command 1 (fire) was refused at tick 0'); expect(refused.done).toBe(false); }
    finally { refused.simulation.dispose(); }
  } finally { sim.dispose(); }
});

it('advances the replay cursor only after the requested command is admitted by the resident action owner', () => {
  const sim = new GameSimulation(world(true), setup()), id = handle(sim);
  try {
    core.matchCommand(id, 32, [0, 1, 0, 0, 0, 0, 0, 1, .6, .4]);
    expect(core.matchCommand(id, 33)).toEqual(new Float64Array([1])); core.matchCommand(id, 34, [1, 1]);
    const request = core.matchCommand(id, 33); expect(request[0]).toBe(2);
    expect(() => core.matchCommand(id, 34, [2, 1])).toThrow('not admitted by the resident match');
    expect(core.matchCommand(id, 33)).toEqual(request); expect(core.matchCommand(id, 35)[0]).toBe(0);
    expect(sim.aim(0, 1, .6, .4)).toBe(true); core.matchCommand(id, 34, [2, 1]);
    expect(core.matchCommand(id, 33)[0]).toBe(0); expect(core.matchCommand(id, 35)[0]).toBe(1);
  } finally { sim.dispose(); }
});

it('replays native Rapier chassis motion exactly from irregular presentation frames', async () => {
  vi.stubEnv('TMT_NATIVE_PHYSICS', '1'); const vehicles: VehicleWorld[] = [], sims: GameSimulation[] = [];
  const physicalWorld = async () => {
    const v = await VehicleWorld.create(); vehicles.push(v); v.addPlane(); const w = world(true, v.physics.native!.core);
    w.stepTanks = (tanks, inputs, dt) => { v.bridge.beforeStep(tanks, inputs, dt); v.physics.step(); v.bridge.afterStep(tanks, dt); }; return w;
  };
  const place = (s: GameSimulation) => { sims.push(s); for (const t of s.state.tanks) { t.position = [0, .6, t.id * 4]; t.rotation = [0, 0, 0, 1]; t.heading = 0; } };
  try {
    const sim = new GameSimulation(await physicalWorld(), setup('drive')); place(sim);
    for (let frame = 0; frame < 300; frame++) {
      if (frame % 79 === 0) expect(sim.aim(0, frame * .01, .6, .4)).toBe(true);
      sim.step([FIXED_DT * .51, FIXED_DT * .49, FIXED_DT * 2.5, 0, FIXED_DT * 1.5][frame % 5],
        { throttle: frame < 60 ? 0 : frame < 240 ? .8 : -.6, steer: frame > 150 ? -.7 : 0 });
    }
    expect(sim.state.tanks[0].position[2]).not.toBe(0);
    const replay = new MatchReplay(await physicalWorld(), JSON.parse(JSON.stringify(sim.checkpoint()))); place(replay.simulation);
    for (let i = 0; i < 1000 && !replay.done; i++) replay.advance(i % 9 + 1);
    expect(replay.done).toBe(true); expect(replay.verified()).toBe(true);
    expect(replay.simulation.state).toEqual(sim.state); expect(replay.simulation.commandLog()).toEqual(sim.commandLog());
  } finally { for (const s of sims) s.dispose(); for (const v of vehicles) v.dispose(); vi.unstubAllEnvs(); }
});
