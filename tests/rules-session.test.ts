/** GameSession on the serial compatibility path (a world without `transactions`, i.e. before the W1-TER merge): the
 * session itself carves what the simulation stalls on. Authored initial cuts stall tick 0 until the carve commits,
 * then the match runs; the terrain-commit reaches the view and the hooks. The resident backend is replaced by the
 * analytic SphereWorld with an asynchronous carve, like the real ResidentGameTerrain. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent, TerrainUpdate, V3 } from '../src/game/contracts';
import type { GameView } from '../src/game/view';
import { practiceSetup } from '../src/game/api/match';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { GameSession } from '../src/game/app/session';
import type { SphereWorld } from './helpers/sphere-world';

type FakeResident = SphereWorld & { carves: { center: V3; radius: number }[]; disposed: boolean; args: unknown[] };
const backend = vi.hoisted(() => ({ worlds: [] as unknown[], fail: false, delay: undefined as Promise<void> | undefined }));

vi.mock('../src/game/resident-terrain', async () => {
  const { SphereWorld } = await import('./helpers/sphere-world');
  const update = (version: number, rebuilt: number): TerrainUpdate => ({ version, chunks: [], removed: [], milliseconds: 0, triangles: 0, rebuilt });
  class ResidentGameTerrain extends SphereWorld {
    readonly resident = {};
    disposed = false;
    args: unknown[] = [];
    readonly carves: { center: V3; radius: number }[] = [];
    static async create(...args: unknown[]): Promise<ResidentGameTerrain> { const world = new ResidentGameTerrain(); world.args = args; backend.worlds.push(world); return world; }
    async initialize(): Promise<TerrainUpdate> { const fail = backend.fail; await backend.delay; if (fail) throw new Error('test topology failure'); return update(this.version, 0); }
    async carve(center: V3, radius: number): Promise<TerrainUpdate> {
      await new Promise(resolve => setTimeout(resolve, 5));
      this.carves.push({ center: [...center] as V3, radius });
      this.craters.push({ center: [...center] as V3, radius });
      return update(++this.version, 1);
    }
    diagnostics() { return {}; }
    dispose(): void { this.disposed = true; }
  }
  return { ResidentGameTerrain };
});

function fakeView() {
  const events: GameEvent[] = [];
  const view = {
    terrainHost: {}, setCampaignTime() {}, reset() {}, setWorld() {}, setTerrain() {}, focus() {}, preparePlanet: async () => {},
    onGameEvent(event: GameEvent) { events.push(event); },
    telemetry: () => ({}), cameraTelemetry: () => ({}),
    devControls: () => ({ vehicleAppearance: () => ({}) }),
  };
  return { view: view as unknown as GameView, events };
}
const frame = () => new Promise(resolve => setTimeout(resolve, 1));

describe('GameSession (serial compatibility path)', () => {
  beforeEach(() => { backend.fail = false; backend.delay = undefined; backend.worlds.length = 0; });
  it('releases a failed initialization and can retry the identical seed', async () => {
    const { view } = fakeView(), session = new GameSession(view, 'local');
    const setup = practiceSetup({ seed: 13, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.planet.kind = 'glacial'; backend.fail = true;
    await expect(session.startMatch(setup)).rejects.toThrow('test topology failure');
    expect((backend.worlds[0] as FakeResident).disposed).toBe(true);
    expect(session.world).toBeUndefined(); expect(session.starting).toBe(false); expect(session.ready).toBe(false);
    backend.fail = false;
    await session.restart();
    expect(session.ready).toBe(true); expect(session.setup?.seed).toBe(13);
    expect((backend.worlds[1] as FakeResident).args[4]).toBe('glacial');
    session.dispose();
  });
  it('never publishes playable terrain after selected shader rejection and retries the same setup', async () => {
    const { view } = fakeView(), session = new GameSession(view, 'local');
    const prepare = vi.fn().mockRejectedValueOnce(new Error('selected shader failed')).mockResolvedValue(undefined);
    view.preparePlanet = prepare;
    const setup = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.planet.kind = 'dune';
    await expect(session.startMatch(setup)).rejects.toThrow('selected shader failed');
    expect(session.ready).toBe(false); expect(session.world).toBeUndefined(); expect((backend.worlds[0] as FakeResident).disposed).toBe(true);
    await session.restart(); expect(session.ready).toBe(true); expect(session.setup?.planet.kind).toBe('dune');
    expect(prepare).toHaveBeenCalledTimes(2); session.dispose();
  });
  it('ignores an old shader rejection after the replacement match is ready', async () => {
    const { view } = fakeView(), session = new GameSession(view, 'local');
    let rejectOld!: (error: Error) => void;
    const oldCompile = new Promise<void>((_, reject) => { rejectOld = reject; });
    const prepare = vi.fn().mockReturnValueOnce(oldCompile).mockResolvedValue(undefined); view.preparePlanet = prepare;
    const setup = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    const old = session.startMatch(setup);
    while (!prepare.mock.calls.length) await frame();
    await session.startMatch({ ...setup, seed: 12, planet: { kind: 'glacial' } });
    rejectOld(new Error('old shader failed')); await old;
    expect(session.ready).toBe(true); expect(session.setup?.seed).toBe(12); expect(session.world).toBe(backend.worlds[1]);
    expect((backend.worlds[0] as FakeResident).disposed).toBe(true); expect((backend.worlds[1] as FakeResident).disposed).toBe(false);
    session.dispose();
  });
  it('cancels a pending initialization without publishing it over a new match', async () => {
    const { view } = fakeView(), session = new GameSession(view, 'local');
    let release!: () => void;
    backend.delay = new Promise<void>(resolve => { release = resolve; });
    const setup = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    const old = session.startMatch(setup);
    while (!backend.worlds.length) await frame();
    session.endMatch();
    expect((backend.worlds[0] as FakeResident).disposed).toBe(true);
    backend.delay = undefined;
    await session.startMatch({ ...setup, seed: 12 });
    release(); await old;
    expect(session.ready).toBe(true); expect(session.setup?.seed).toBe(12);
    expect(session.world).toBe(backend.worlds[1]);
    session.dispose();
  });
  it('unwinds an in-flight match on device loss', async () => {
    const { view } = fakeView(), session = new GameSession(view, 'local');
    let release!: () => void;
    backend.delay = new Promise<void>(resolve => { release = resolve; });
    const pending = session.startMatch(practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    while (!backend.worlds.length) await frame();
    session.invalidate(); release(); await pending;
    expect(session.reloadRequired).toBe(true); expect(session.ready).toBe(false); expect(session.world).toBeUndefined();
    expect((backend.worlds[0] as FakeResident).disposed).toBe(true);
  });
  it('restores old seed-derived worlds and new explicit kinds without changing their terrain profile', async () => {
    const { SphereWorld } = await import('./helpers/sphere-world');
    const setup = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.planet.kind = 'dune';
    const checkpoint = new GameSimulation(new SphereWorld(), setup).checkpoint();
    const legacyTerrain = { format: 'tmt-resident-terrain', schemaVersion: 1, generator: 'tmt-planet-v3',
      seed: 7, revision: 1, profile: 'resident-f32-game-v2', structures: [], edits: [], tick: 0, bodies: [], chassis: [] } as const;
    const { view } = fakeView(), session = new GameSession(view, 'local');
    await session.restoreCheckpoint({ ...checkpoint, terrain: legacyTerrain } as unknown as Parameters<GameSession['restoreCheckpoint']>[0]);
    expect((backend.worlds.at(-1) as FakeResident).args.slice(3)).toEqual(['resident-f32-game-v2', 'temperate', undefined, 'compatibility-v1']);
    expect(session.setup?.planet.kind).toBe('temperate');
    await session.restoreCheckpoint({ ...checkpoint, terrain: { ...legacyTerrain, profile: 'resident-f32-game-v3', kind: 'dune' } } as unknown as Parameters<GameSession['restoreCheckpoint']>[0]);
    expect((backend.worlds.at(-1) as FakeResident).args.slice(3)).toEqual(['resident-f32-game-v3', 'dune', undefined, 'compatibility-v1']);
    expect(session.setup?.planet.kind).toBe('dune');
    session.dispose();
  });
  it.each(['compatibility-v1', 'rust-resident-v1', ...Array.from({ length: 20 }, (_, i) => `rust-engine-v${i + 1}`)])('restores a saved %s through that exact engine', async engine => {
    const { SphereWorld } = await import('./helpers/sphere-world');
    const setup = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    const original = new GameSimulation(new SphereWorld(), setup), checkpoint = original.checkpoint(); original.dispose();
    const terrain = { format: 'tmt-resident-terrain', schemaVersion: 1, generator: 'tmt-planet-v3', engine,
      seed: 7, revision: 1, profile: 'resident-f32-game-v3', kind: 'temperate', structures: [], edits: [], tick: 0, bodies: [], chassis: [] };
    const { view } = fakeView(), session = new GameSession(view, 'local');
    try {
      await session.restoreCheckpoint({ ...checkpoint, terrain } as unknown as Parameters<GameSession['restoreCheckpoint']>[0]);
      expect((backend.worlds.at(-1) as FakeResident).args[6]).toBe(engine); expect(session.ready).toBe(true);
    } finally { session.dispose(); }
  });
  it('carves authored initial cuts at the start of a match, then the match runs past tick 0', async () => {
    const { view, events } = fakeView(), session = new GameSession(view, 'local');
    const setup = practiceSetup({ seed: 11, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.initialCuts = [{ id: 'init:0', center: [0, 18, 6], radius: 2.5 }];
    await session.startMatch(setup);
    const world = backend.worlds.at(-1) as FakeResident;
    expect(world.transactions).toBeUndefined();
    expect(session.snapshot?.tick).toBe(0);
    expect(session.telemetry().stall).toMatchObject({ serial: true, commitTick: 0, cutIds: ['init:0'] });
    for (let guard = 0; guard < 200 && (session.snapshot?.tick ?? 0) < 10; guard++) { session.step(FIXED_DT); await frame(); }
    expect(world.carves).toEqual([{ center: [0, 18, 6], radius: 2.5 }]);
    expect(session.snapshot?.tick).toBeGreaterThanOrEqual(10);
    expect(session.telemetry().stall).toBeNull();
    expect(events).toContainEqual({ type: 'terrain-commit', cutIds: ['init:0'], version: 1 });
    // The initial cut commits before any tick runs, and only once.
    expect(events.filter(event => event.type === 'terrain-commit')).toHaveLength(1);
    session.dispose();
  });

  it('starts without a stall when the setup has no initial cuts', async () => {
    const { view } = fakeView(), session = new GameSession(view, 'local');
    await session.startMatch(practiceSetup({ seed: 11, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    expect(session.telemetry().stall).toBeNull();
    session.step(FIXED_DT * 3);
    expect(session.snapshot?.tick).toBe(3);
    expect((backend.worlds.at(-1) as FakeResident).carves).toEqual([]);
    session.dispose();
  });

  it('takes commands for human-controlled tanks only', async () => {
    const { view } = fakeView(), session = new GameSession(view, 'bot');
    await session.startMatch(practiceSetup({ seed: 11, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    expect(session.observer).toBe(0);
    // The bot's tank is driven by its brain: outside aim, fire, scan or drive input for it is refused and never logged.
    for (const c of [{ k: 'aim', yaw: 1, pitch: .5, power: .4 }, { k: 'scan' }, { k: 'fire' }, { k: 'drive', throttle: 1, steer: 0 }] as const) {
      expect(session.command(1, c)).toBe(false);
    }
    expect(session.command(0, { k: 'aim', yaw: 1, pitch: .5, power: .4 })).toBe(true);
    session.dispose();
  });

  it('settles a finished match while paused without advancing combat or changing its result', async () => {
    const { view, events } = fakeView(), session = new GameSession(view, 'local');
    await session.startMatch(practiceSetup({ seed: 11, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    const state = session.snapshot!, world = backend.worlds.at(-1) as FakeResident;
    const step = vi.spyOn(world, 'stepTanks').mockImplementation(tanks => { tanks[0].position[1] -= .1; });
    session.settleWrecks(1 / 60); expect(step).not.toHaveBeenCalled();
    state.phase = 'finished'; state.winner = 1; state.tanks[0].health = 0;
    const tick = state.tick, time = state.time, position = [...state.tanks[0].position], eventCount = events.length;
    session.setPaused(true);
    for (let frame = 0; frame < 120; frame++) session.settleWrecks(1 / 120);
    expect(step).toHaveBeenCalledTimes(60);
    expect(state.tanks[0].position[1]).toBeCloseTo(position[1] - 6);
    expect(state.phase).toBe('finished'); expect(state.winner).toBe(1);
    expect(state.tick).toBe(tick); expect(state.time).toBe(time); expect(events).toHaveLength(eventCount);
    expect(session.interpolation()!.curr[0].position).toEqual(state.tanks[0].position);
    session.endMatch(); session.settleWrecks(1); expect(step).toHaveBeenCalledTimes(60);
    session.dispose();
  });
});
