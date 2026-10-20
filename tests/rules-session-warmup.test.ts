/** GameSession's match warm-up: with a frame loop listening for 'warming', a new match exists (its tick-0 snapshot can
 * be rendered) but is ready only when the loop ends the warm-up; the simulation never steps meanwhile. The resident
 * backend is replaced by the analytic SphereWorld, as in rules-session.test.ts. */
import { describe, expect, it, vi } from 'vitest';
import type { TerrainUpdate, V3 } from '../src/game/contracts';
import type { GameView } from '../src/game/view';
import { practiceSetup } from '../src/game/api/match';
import { FIXED_DT } from '../src/game/simulation';
import { GameSession } from '../src/game/app/session';

const backend = vi.hoisted(() => ({ worlds: [] as unknown[] }));
vi.mock('../src/game/resident-terrain', async () => {
  const { SphereWorld } = await import('./helpers/sphere-world');
  const update = (version: number): TerrainUpdate => ({ version, chunks: [], removed: [], milliseconds: 0, triangles: 0, rebuilt: 0 });
  class ResidentGameTerrain extends SphereWorld {
    readonly resident = {};
    disposed = false;
    static async create(): Promise<ResidentGameTerrain> { const world = new ResidentGameTerrain(); backend.worlds.push(world); return world; }
    async initialize(): Promise<TerrainUpdate> { return update(this.version); }
    async carve(center: V3, radius: number): Promise<TerrainUpdate> { this.craters.push({ center: [...center] as V3, radius }); return update(++this.version); }
    diagnostics() { return {}; }
    dispose(): void { this.disposed = true; }
  }
  return { ResidentGameTerrain };
});

function fakeView() {
  return { terrainHost: {}, setCampaignTime() {}, reset() {}, setWorld() {}, setTerrain() {}, focus() {}, preparePlanet: async () => {}, onGameEvent() {},
    telemetry: () => ({}), cameraTelemetry: () => ({}), devControls: () => ({ vehicleAppearance: () => ({}) }) } as unknown as GameView;
}
const setup = (seed: number) => practiceSetup({ seed, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('GameSession warm-up', () => {
  it('holds a new match at tick 0 until the loop ends the warm-up, then reports it ready once', async () => {
    const session = new GameSession(fakeView(), 'local'), warming = vi.fn(), ready = vi.fn();
    session.on('warming', warming); session.on('ready', ready);
    let started = false;
    const start = session.startMatch(setup(11)).then(() => { started = true; });
    await vi.waitFor(() => expect(warming).toHaveBeenCalledOnce());
    expect(session.warming).toBe(true); expect(session.ready).toBe(false); expect(session.starting).toBe(true);
    expect(session.snapshot?.tick).toBe(0); expect(session.startupProgress.stage).toBe('Rendering the first frames');
    expect(session.step(FIXED_DT * 3)).toEqual([]);
    await settle();
    expect(session.snapshot?.tick).toBe(0); expect(started).toBe(false); expect(ready).not.toHaveBeenCalled();
    session.endWarmup();
    await start;
    expect(session.warming).toBe(false); expect(session.ready).toBe(true); expect(ready).toHaveBeenCalledOnce();
    session.step(FIXED_DT * 2);
    expect(session.snapshot!.tick).toBeGreaterThan(0);
    session.dispose();
  });

  it('releases a warming start that a new match or the menu replaces, without publishing it', async () => {
    const session = new GameSession(fakeView(), 'local'), warming = vi.fn(), ready = vi.fn();
    session.on('warming', warming); session.on('ready', ready);
    const first = session.startMatch(setup(11));
    await vi.waitFor(() => expect(warming).toHaveBeenCalledTimes(1));
    const second = session.startMatch(setup(12));
    await first;
    expect(ready).not.toHaveBeenCalled(); expect(session.ready).toBe(false);
    await vi.waitFor(() => expect(warming).toHaveBeenCalledTimes(2));
    expect(session.setup?.seed).toBe(12); expect(session.warming).toBe(true);
    session.endMatch();
    await second;
    expect(ready).not.toHaveBeenCalled(); expect(session.ready).toBe(false); expect(session.warming).toBe(false); expect(session.starting).toBe(false);
    session.dispose();
  });

  it('is ready at once without a loop that renders the warm-up', async () => {
    const session = new GameSession(fakeView(), 'local');
    await session.startMatch(setup(11));
    expect(session.ready).toBe(true); expect(session.warming).toBe(false);
    session.dispose();
  });
});
