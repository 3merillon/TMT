/** Checkpoint v2 (plan §6 I9): {format 'tmt-match', version 2, setup, commands [{tick, tank, c}], terrain}. It survives
 * a JSON round trip, and replaying it on the same build reproduces the snapshot hash, mid-flight and mid-commit. */
import { describe, expect, it } from 'vitest';
import { practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { DriveInput, GameEvent } from '../src/game/contracts';
import { FIXED_DT, GameSimulation, MatchReplay } from '../src/game/simulation';
import { validateMatchCheckpoint, type MatchCheckpointV2 } from '../src/game/rules/checkpoint';
import { snapshotHash } from '../src/game/rules/hash';
import { SphereWorld } from './helpers/sphere-world';
import { FakeTransactions } from './helpers/fake-transactions';

const PLAYER = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

/** A world with fake transactions on a frame clock; `pump` advances that clock (the host's asynchronous work). */
function transactional(latency: number) {
  const world = new SphereWorld();
  let frames = 0;
  world.transactions = new FakeTransactions(world, () => frames, { latency });
  return { world, pump: () => { frames++; } };
}
/** Replay to the end, pumping the host on every stall (a serial carve commits immediately in analytic worlds). */
function replayAll(replay: MatchReplay, pump: () => void = () => {}): MatchReplay {
  for (let guard = 0; guard < 200000; guard++) {
    pump();
    const status = replay.advance(50);
    if (status === 'done') return replay;
    if (status === 'stalled' && replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve();
  }
  throw new Error('replay never finished');
}

/** A scripted human-vs-bot match: aims, munition swaps, scans and scoot driving, one frame per tick. */
function playScript(input: MatchSetup, world: SphereWorld, pump: () => void, until: number): GameSimulation {
  const setup = structuredClone(input);
  setup.rules.startCharge = 3; // lets the script scan on its second turn
  const simulation = new GameSimulation(world, setup);
  let turnShots = 0;
  for (let frame = 0; frame < 100000 && simulation.state.tick < until && simulation.state.phase !== 'finished'; frame++) {
    pump();
    const tick = simulation.state.tick;
    if (simulation.state.phase === 'aim' && simulation.state.active === 0 && simulation.state.phaseTime > .4) {
      turnShots++;
      simulation.command(0, { k: 'aim', yaw: .7 + turnShots * .31, pitch: .6 + (turnShots % 3) * .2, power: .45 + (turnShots % 2) * .15 });
      simulation.command(0, { k: 'munition', id: turnShots % 2 ? 'explosive' : 'heavy' });
      if (turnShots === 2) simulation.command(0, { k: 'scan' });
      simulation.command(0, { k: 'fire' });
    }
    const drive: DriveInput = simulation.state.phase === 'resolving' && simulation.state.active === 0
      ? { throttle: tick % 90 < 60 ? 1 : -.5, steer: tick % 40 < 20 ? .4 : -.2 } : { throttle: 0, steer: 0 };
    simulation.step(FIXED_DT, drive);
    if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
  }
  return simulation;
}

describe('checkpoint v2 format', () => {
  it('holds exactly the setup, the command log, the save tick and its hash, and survives JSON', () => {
    const simulation = playScript(practiceSetup({ seed: 5, mode: 'bot', player: PLAYER }), new SphereWorld(), () => {}, 700);
    const checkpoint = simulation.checkpoint();
    expect(checkpoint).toMatchObject({ format: 'tmt-match', version: 2, tick: simulation.state.tick, terrain: null });
    expect(checkpoint.setup).toEqual(simulation.setup);
    expect(checkpoint.hash).toBe(simulation.matchHash());
    expect(checkpoint.commands.length).toBeGreaterThan(5);
    expect(new Set(checkpoint.commands.map(entry => entry.c.k))).toEqual(new Set(['aim', 'munition', 'fire', 'drive', 'scan']));
    for (const [index, entry] of checkpoint.commands.entries()) if (index) expect(entry.tick).toBeGreaterThanOrEqual(checkpoint.commands[index - 1].tick);
    const json = JSON.parse(JSON.stringify(checkpoint));
    expect(validateMatchCheckpoint(json)).toEqual(checkpoint);
  });

  it('rejects malformed checkpoints explicitly', () => {
    const checkpoint = playScript(practiceSetup({ seed: 5, mode: 'bot', player: PLAYER }), new SphereWorld(), () => {}, 300).checkpoint();
    const broken = (change: (value: Record<string, unknown>) => void) => { const value = structuredClone(checkpoint) as unknown as Record<string, unknown>; change(value); return value; };
    expect(() => validateMatchCheckpoint(broken(value => { value.version = 1; }))).toThrow(/v2 checkpoint/);
    expect(() => validateMatchCheckpoint(broken(value => { value.format = 'tmt-simulation'; }))).toThrow(/v2 checkpoint/);
    expect(() => validateMatchCheckpoint(broken(value => { value.hash = 'nope'; }))).toThrow(/hash/);
    expect(() => validateMatchCheckpoint(broken(value => { value.tick = -1; }))).toThrow(/tick/);
    expect(() => validateMatchCheckpoint(broken(value => { (value.commands as { tick: number }[]).reverse(); }))).toThrow(/out of order/);
    expect(() => validateMatchCheckpoint(broken(value => { (value.commands as { tank: number }[])[0].tank = 9; }))).toThrow(/unknown tank/);
    expect(() => validateMatchCheckpoint(broken(value => { (value.commands as { c: unknown }[])[0].c = { k: 'teleport' }; }))).toThrow(/not replayable/);
    expect(() => validateMatchCheckpoint(broken(value => { (value.commands as { c: { k: string; yaw?: number } }[]).find(entry => entry.c.k === 'aim')!.c.yaw = NaN; }))).toThrow(/finite/);
    expect(() => validateMatchCheckpoint(broken(value => { (value.setup as MatchSetup).tanks.pop(); }))).toThrow(/2 to 8 tanks/);
  });
});

describe('replay on the same build gives an identical snapshot hash', () => {
  it.each([180, 431, 900, 1500])('serial terrain path, saved at tick %i', tick => {
    const setup = practiceSetup({ seed: 5, mode: 'bot', player: PLAYER });
    const original = playScript(setup, new SphereWorld(), () => {}, tick);
    const checkpoint = original.checkpoint();
    const replay = replayAll(new MatchReplay(new SphereWorld(), JSON.parse(JSON.stringify(checkpoint))));
    expect(replay.verified()).toBe(true);
    expect(replay.simulation.state).toEqual(original.state);
    expect(snapshotHash(replay.simulation.state)).toBe(snapshotHash(original.state));
    expect(replay.simulation.commandLog()).toEqual(checkpoint.commands);
  });

  it('transactions path: saved mid-flight and during a commit stall, replayed with a different preparer latency', () => {
    const setup = practiceSetup({ seed: 5, mode: 'bot', player: PLAYER });
    for (const until of [120, 360, 1100]) {
      const live = transactional(90);
      const original = playScript(setup, live.world, live.pump, until);
      const checkpoint = original.checkpoint();
      const fresh = transactional(3);
      const replay = replayAll(new MatchReplay(fresh.world, checkpoint), fresh.pump);
      expect(replay.verified()).toBe(true);
      expect(replay.simulation.state).toEqual(original.state);
      expect(fresh.world.craters).toEqual(live.world.craters.filter((_, index) => index < fresh.world.craters.length));
    }
  });

  it('transactions path: a command issued before the first step() follows the tick-0 initial cuts, live and in replay', () => {
    const setup = practiceSetup({ seed: 5, mode: 'local', player: PLAYER });
    setup.rules.startCharge = 3;
    // The opponent spawns under the initial crater, hidden by curvature: its scan estimate reads the carved surface.
    setup.tanks[1].spawn = { up: [0, -1, 0], heading: 0 };
    setup.initialCuts = [{ id: 'init:0', center: [0, -18, 0], radius: 3 }];
    for (const latency of [0, 4]) {
      const live = transactional(latency);
      const original = new GameSimulation(live.world, setup);
      // Ready at once: the command commits the due initial cut first. Not ready yet: the match is stalled at tick 0
      // and refuses input until the cut commits, exactly like a stall later in the match.
      const accepted = original.scan(0);
      expect(accepted).toBe(latency === 0);
      if (accepted) expect(live.world.craters).toEqual([{ center: [0, -18, 0], radius: 3 }]);
      else expect(original.stalledOn).toMatchObject({ commitTick: 0, cutIds: ['init:0'], serial: false });
      const events: GameEvent[] = [];
      for (let frame = 0; frame < 40; frame++) {
        live.pump();
        if (!accepted && original.state.tick > 0 && !original.commandLog().length) expect(original.scan(0)).toBe(true);
        events.push(...original.step(FIXED_DT));
      }
      expect(events.filter(event => event.type === 'terrain-commit')).toEqual([{ type: 'terrain-commit', cutIds: ['init:0'], version: 1 }]);
      const scanned = original.state.observations?.[0][1];
      expect(scanned?.position).toHaveLength(3);
      const checkpoint = original.checkpoint();
      expect(checkpoint.commands.map(entry => entry.c.k)).toEqual(['scan']);
      const fresh = transactional(2);
      const replay = replayAll(new MatchReplay(fresh.world, JSON.parse(JSON.stringify(checkpoint))), fresh.pump);
      expect(replay.verified()).toBe(true);
      expect(replay.simulation.state.observations?.[0][1]).toEqual(scanned);
    }
  });

  it('keeps the replayed match in lock step with the original afterwards', () => {
    const setup = practiceSetup({ seed: 8, mode: 'local', player: PLAYER });
    const original = playScript(setup, new SphereWorld(), () => {}, 500);
    const replay = replayAll(new MatchReplay(new SphereWorld(), original.checkpoint()));
    const resumed = replay.simulation;
    resumed.step(0); original.step(0);
    for (const simulation of [original, resumed]) {
      for (let tick = 0; tick < 600; tick++) {
        if (simulation.state.phase === 'aim') { simulation.command(simulation.state.active, { k: 'aim', yaw: 2, pitch: .9, power: .5 }); simulation.command(simulation.state.active, { k: 'fire' }); }
        simulation.step(FIXED_DT, { throttle: .5, steer: .1 });
        if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
      }
    }
    expect(resumed.matchHash()).toBe(original.matchHash());
  });

  it('replays a drive test too', () => {
    const setup = practiceSetup({ seed: 2, mode: 'drive', player: PLAYER });
    const original = new GameSimulation(new SphereWorld(), setup);
    for (let tick = 0; tick < 240; tick++) {
      original.step(FIXED_DT, { throttle: tick < 120 ? 1 : 0, steer: tick > 60 ? .5 : 0 });
      if (tick === 150) { original.command(0, { k: 'aim', yaw: .4, pitch: .5, power: .3 }); original.command(0, { k: 'fire' }); }
      if (original.stalledOn?.serial) original.completeLegacyCarve();
    }
    const replay = replayAll(new MatchReplay(new SphereWorld(), original.checkpoint()));
    expect(replay.verified()).toBe(true);
  });

  it('detects a tampered log', () => {
    const setup = practiceSetup({ seed: 5, mode: 'bot', player: PLAYER });
    const checkpoint = playScript(setup, new SphereWorld(), () => {}, 900).checkpoint();
    const moved = structuredClone(checkpoint) as MatchCheckpointV2 & { commands: { c: { k: string; yaw?: number } }[] };
    // The last aim still sets the turret at save time, so a changed bearing must change the replayed hash.
    const aim = moved.commands.filter(entry => entry.c.k === 'aim').at(-1)!.c as { yaw: number };
    aim.yaw += .5;
    expect(replayAll(new MatchReplay(new SphereWorld(), moved)).verified()).toBe(false);
    // A second shot logged one tick after the first cannot be fired: the replay refuses it and says so.
    const early = structuredClone(checkpoint) as unknown as { commands: { tick: number; tank: number; c: { k: string } }[] };
    const fires = early.commands.filter(entry => entry.c.k === 'fire');
    fires[1].tick = fires[0].tick + 1;
    early.commands.sort((a, b) => a.tick - b.tick);
    expect(() => replayAll(new MatchReplay(new SphereWorld(), early))).toThrow(/Replay diverged/);
  });
});
