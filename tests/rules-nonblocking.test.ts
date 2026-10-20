/** Non-blocking terrain (plan §4.3 steps 5–6, I9): with fake transactions the crater commits exactly at impactTick + K
 * whatever the preparer latency, a slow preparer only stalls frames (never ticks) so the final state is identical, a
 * speculative prepare that matches the impact commits with zero stall, a mispredicted one is cancelled, and a failed
 * edit keeps the old world. */
import { describe, expect, it } from 'vitest';
import type { GameEvent, ImpactEvent } from '../src/game/contracts';
import { practiceSetup, type MatchSetup } from '../src/game/api/match';
import { add, mul } from '../src/game/math';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { snapshotHash } from '../src/game/rules/hash';
import { SphereWorld } from './helpers/sphere-world';
import { FakeTransactions, type FakeTransactionOptions } from './helpers/fake-transactions';

const PLAYER = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

interface Run { simulation: GameSimulation; world: SphereWorld; transactions: FakeTransactions; events: GameEvent[]; frames: number; commitTicks: number[]; versions: { tick: number; version: number }[] }

/** One tick per presented frame; the frame clock drives the fake preparer, so stalls cost frames, not ticks. */
function harness(options: FakeTransactionOptions & { setup?: MatchSetup; open?: (s: GameSimulation) => void } = {}): Run & { until(tick: number, onFrame?: (run: Run) => void): Run } {
  const world = new SphereWorld();
  const run = { world, events: [] as GameEvent[], frames: 0, commitTicks: [] as number[], versions: [] as { tick: number; version: number }[] } as Run;
  run.transactions = new FakeTransactions(world, () => run.frames, options);
  world.transactions = run.transactions;
  const commitReady = run.transactions.commitReady.bind(run.transactions);
  run.transactions.commitReady = (ticket, tick) => {
    const result = commitReady(ticket, tick);
    if (result.status !== 'not-ready') run.commitTicks.push(run.simulation.state.tick);
    return result;
  };
  run.simulation = new GameSimulation(world, options.setup ?? practiceSetup({ seed: 11, mode: 'bot', player: PLAYER }));
  (options.open ?? (s => { s.aim(0, 1, .5, .25); s.fire(0); s.endMove(0); }))(run.simulation);
  return Object.assign(run, {
    until(tick: number, onFrame?: (run: Run) => void): Run {
      for (let guard = 0; run.simulation.state.tick < tick && guard < 100000 && run.simulation.state.phase !== 'finished'; guard++) {
        run.frames++;
        run.events.push(...run.simulation.step(FIXED_DT));
        run.versions.push({ tick: run.simulation.state.tick, version: world.version });
        onFrame?.(run);
      }
      return run;
    },
  });
}
const impacts = (run: Run) => run.events.filter((event): event is ImpactEvent => event.type === 'impact');
const impactTick = (event: ImpactEvent) => Number(event.cut!.id.split(':')[0]);

describe('commit at impactTick + K', () => {
  it('commits exactly at T+K with fast and slow preparers and ends in identical states', () => {
    const fast = harness({ latency: 1 }).until(1500);
    const slow = harness({ latency: 420 }).until(1500);
    for (const run of [fast, slow]) {
      const shots = impacts(run);
      expect(shots.length).toBeGreaterThanOrEqual(2);
      for (const event of shots) expect(event.commitTick).toBe(impactTick(event) + 12);
      // Every commit happened at the boundary right after its commit tick (a frame ending on the commit tick may show
      // either world), and nothing changed the world earlier.
      expect(run.commitTicks).toEqual(shots.slice(0, run.commitTicks.length).map(event => event.commitTick));
      for (const event of shots.slice(0, run.commitTicks.length)) {
        const before = run.versions.filter(entry => entry.tick < event.commitTick!).map(entry => entry.version);
        const after = run.versions.filter(entry => entry.tick > event.commitTick!).map(entry => entry.version);
        expect(Math.max(...before)).toBeLessThan(Math.min(...after));
      }
      expect(run.events.filter(event => event.type === 'terrain-commit')).toHaveLength(run.commitTicks.length);
    }
    expect(fast.simulation.stalledFrames).toBe(0);
    expect(slow.simulation.stalledFrames).toBeGreaterThan(0);
    expect(slow.frames).toBeGreaterThan(fast.frames);
    expect(snapshotHash(slow.simulation.state)).toBe(snapshotHash(fast.simulation.state));
    expect(slow.world.craters).toEqual(fast.world.craters);
  });

  it('reports what a stalled step waits for and drops the stalled wall time', () => {
    const run = harness({ latency: 10000 });
    let seen = false;
    run.until(400, current => {
      const stall = current.simulation.stalledOn;
      if (!stall || seen) return;
      seen = true;
      const tick = current.simulation.state.tick;
      expect(stall.serial).toBe(false);
      expect(stall.commitTick).toBe(tick);
      expect(stall.cutIds).toHaveLength(1);
      // Asking for a lot of time while stalled advances nothing.
      current.simulation.step(5);
      expect(current.simulation.state.tick).toBe(tick);
      expect(current.simulation.stalledOn).toEqual(stall);
    });
    expect(seen).toBe(true);
  });

  it('honours a custom commit window and fences dynamic bodies inside the cut until the commit', () => {
    const setup = practiceSetup({ seed: 11, mode: 'bot', player: PLAYER });
    setup.rules.commitWindowTicks = 30;
    const run = harness({ latency: 1, setup }).until(600);
    const [first] = impacts(run);
    expect(first.commitTick).toBe(impactTick(first) + 30);
    const freeze = run.transactions.calls.find(call => call.op === 'freeze');
    expect(freeze).toMatchObject({ op: 'freeze', untilTick: first.commitTick });
    if (freeze?.op === 'freeze') for (let axis = 0; axis < 3; axis++) {
      expect(freeze.bounds.min[axis]).toBeCloseTo(first.cut!.center[axis] - first.cut!.radius, 12);
      expect(freeze.bounds.max[axis]).toBeCloseTo(first.cut!.center[axis] + first.cut!.radius, 12);
    }
  });

  it('never hands the turn over before the edit commits', () => {
    const run = harness({ latency: 1 }).until(900);
    const firstImpact = run.events.findIndex(event => event.type === 'impact');
    const firstCommit = run.events.findIndex(event => event.type === 'terrain-commit');
    const firstTurn = run.events.findIndex(event => event.type === 'turn');
    expect(firstImpact).toBeGreaterThanOrEqual(0);
    expect(firstCommit).toBeGreaterThan(firstImpact);
    expect(firstTurn).toBeGreaterThan(firstCommit);
  });
});

describe('speculative prepare', () => {
  it('promotes a matching speculative ticket and commits with zero stall', () => {
    // Latency 40 frames: longer than K (12), so a prepare made at impact would stall; the one made at fire time does not.
    const run = harness({ latency: 40 }).until(400);
    const [first] = impacts(run);
    expect(impactTick(first)).toBeGreaterThan(40);
    const prepares = run.transactions.calls.filter(call => call.op === 'prepare');
    expect(prepares[0]).toMatchObject({ speculative: true, cuts: [first.cut!.id], commitTick: first.commitTick });
    expect(run.transactions.calls.find(call => call.op === 'promote')).toMatchObject({ ticket: prepares[0].ticket, ok: true });
    expect(run.transactions.calls.filter(call => call.op === 'cancel')).toHaveLength(0);
    expect(run.commitTicks[0]).toBe(first.commitTick);
    expect(run.simulation.stalledFrames).toBe(0);
  });

  it('cancels a mispredicted speculative ticket and prepares the real cut', () => {
    const run = harness({ latency: 40 });
    let moved = false;
    run.until(400, current => {
      const shell = current.simulation.state.projectiles[0];
      if (moved || !shell || shell.age < .5) return;
      // The opponent drives into the shell's path: the pre-traced terrain impact never happens.
      moved = true;
      current.simulation.state.tanks[1].position = add(shell.position, mul(shell.velocity, 4 * FIXED_DT));
    });
    const [first] = impacts(run);
    const speculative = run.transactions.calls.find(call => call.op === 'prepare' && call.speculative);
    const real = run.transactions.calls.find(call => call.op === 'prepare' && !call.speculative);
    expect(speculative).toBeDefined();
    expect(real).toMatchObject({ cuts: [first.cut!.id], commitTick: first.commitTick });
    expect(run.transactions.calls).toContainEqual(expect.objectContaining({ op: 'cancel', ticket: speculative!.op === 'prepare' ? speculative!.ticket : -1 }));
    expect(run.transactions.status(speculative!.op === 'prepare' ? speculative!.ticket : -1)).toBe('cancelled');
    expect(run.simulation.stalledFrames).toBeGreaterThan(0);
    expect(run.commitTicks[0]).toBe(first.commitTick);
  });

  const speculativeTicket = (run: Run) => {
    const call = run.transactions.calls.find(entry => entry.op === 'prepare' && entry.speculative);
    return call?.op === 'prepare' ? call.ticket : undefined;
  };

  it('cancels the speculative ticket when the shell expires without an impact', () => {
    const setup = practiceSetup({ seed: 11, mode: 'bot', player: PLAYER });
    setup.rules.projectileAge = 1;
    let expiry = -1;
    const run = harness({ latency: 40, setup, open: s => {
      s.aim(0, .2, .6, 1);
      // Park the opponent half-way along the (terrain-only) path: the pre-trace, which sees tanks, hits it...
      const path = s.preview(0);
      s.state.tanks[1].position = [...path[Math.floor(path.length / 2)]];
      s.fire(0); s.endMove(0);
      // ...then it leaves before the shell arrives, and the shell ages out in the air.
      s.state.tanks[1].position = [0, -18.55, 0];
    } }).until(80, current => { if (expiry < 0 && !current.simulation.state.projectiles.length) expiry = current.simulation.state.tick; });
    const ticket = speculativeTicket(run);
    expect(ticket).toBeDefined();
    expect(impacts(run)).toEqual([]);
    expect(expiry).toBe(60);
    expect(run.transactions.calls.filter(call => call.op === 'cancel')).toEqual([expect.objectContaining({ op: 'cancel', ticket })]);
    expect(run.transactions.status(ticket!)).toBe('cancelled');
    expect(run.transactions.calls.some(call => call.op === 'promote')).toBe(false);
  });

  it('cancels the speculative ticket when the match ends with the shell in flight', () => {
    const run = harness({ latency: 40, open: s => {
      s.aim(0, 1, .5, .25); s.fire(0); s.endMove(0);
      // The last enemy falls through the core before the shell lands: the match is over.
      s.state.tanks[1].position = [0, 1, 0];
    } }).until(5);
    const ticket = speculativeTicket(run);
    expect(ticket).toBeDefined();
    expect(run.simulation.state.phase).toBe('finished');
    expect(run.events).toContainEqual({ type: 'kill', tank: 1, by: null, cause: 'fall' });
    expect(run.transactions.status(ticket!)).toBe('cancelled');
  });
});

describe('failed edits', () => {
  it('emits terrain-failed, keeps the old world and plays on', () => {
    const run = harness({ latency: 1, fail: () => ({ code: 'budget', message: 'edit exceeds the brick budget' }) }).until(1200);
    expect(run.events).toContainEqual({ type: 'terrain-failed', code: 'budget', message: 'edit exceeds the brick budget' });
    expect(run.events.some(event => event.type === 'terrain-commit')).toBe(false);
    expect(run.world.craters).toEqual([]);
    expect(run.world.version).toBe(0);
    expect(run.events.filter(event => event.type === 'turn').length).toBeGreaterThanOrEqual(2);
  });
});

describe('the serial compatibility path', () => {
  it('stalls at the impact tick until the host finishes the carve, without transactions', () => {
    const world = new SphereWorld(), simulation = new GameSimulation(world, practiceSetup({ seed: 11, mode: 'bot', player: PLAYER }));
    simulation.aim(0, 1, .5, .25); simulation.fire(0); simulation.endMove(0);
    let impact: ImpactEvent | undefined;
    for (let tick = 0; tick < 600 && !impact; tick++) impact = simulation.step(FIXED_DT).find((event): event is ImpactEvent => event.type === 'impact');
    expect(impact?.commitTick).toBe(simulation.state.tick);
    expect(simulation.stalledOn).toMatchObject({ serial: true, commitTick: simulation.state.tick, cutIds: [impact!.cut!.id] });
    expect(simulation.pendingSerialCuts()).toEqual([impact!.cut]);
    const tick = simulation.state.tick;
    simulation.step(1);
    expect(simulation.state.tick).toBe(tick);
    simulation.completeLegacyCarve({ status: 'committed' });
    expect(simulation.stalledOn).toBeNull();
    expect(simulation.step(0)).toContainEqual({ type: 'terrain-commit', cutIds: [impact!.cut!.id], version: 0 });
  });

  it('applies authored initial cuts before the first tick', () => {
    const setup = practiceSetup({ seed: 11, mode: 'bot', player: PLAYER });
    setup.initialCuts = [{ id: 'init:0', center: [0, 18, 6], radius: 2.5 }];
    const run = harness({ latency: 3, setup, open: () => {} }).until(5);
    expect(run.world.craters).toEqual([{ center: [0, 18, 6], radius: 2.5 }]);
    expect(run.commitTicks[0]).toBe(0);
    expect(run.events[0]).toEqual({ type: 'terrain-commit', cutIds: ['init:0'], version: 1 });
  });
});
