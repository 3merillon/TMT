import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cooperativeReward } from '../src/game/campaign/progress';
import { defaultProfile } from '../src/game/meta/profile';
import { MissionRunner, missionSetup, type MissionDef } from '../src/game/campaign/mission';
import { FIRST_LIGHT } from '../src/game/campaign/prologue';
import { hold, escort } from '../src/game/campaign/beats';
import { makeOnlineSetup } from '../src/game/online/setup';
import { networkCommand } from '../src/game/online/validation';
import { RealtimeMatch } from '../src/game/realtime/match';
import { GameSession, cooperativeSaveKey, ownedCooperativeCheckpoint } from '../src/game/app/session';
import type { Recovery, NetworkSnapshot } from '../src/game/online/state';
import type { GameView } from '../src/game/view';
import { SphereWorld } from './helpers/sphere-world';
import { realtimeRun, WARDEN } from './helpers/realtime';
import { PLANET_GENERATOR } from '../src/game/planet-field';

const storage = vi.hoisted(() => ({ write: vi.fn(async (_key: string, _value: unknown, _slot: string, _guard: () => boolean) => true), clear: vi.fn(async () => {}) }));
vi.mock('../src/game/meta/campaign-save', () => ({ writeCampaignSave: storage.write, clearCampaignSave: storage.clear, readCampaignSave: async () => null }));
const result = { medal: false, optional: false, secrets: 0 };
const peers = [{ seat: 0, name: 'Owner' }, { seat: 1, name: 'Helper' }];
function coop(def: MissionDef = FIRST_LIGHT) {
  const setup = makeOnlineSetup('coop', 3, WARDEN);
  setup.online!.campaignOwnerSeat = 0; setup.online!.runId = 'campaign-run-1';
  const runner = new MissionRunner(def), run = realtimeRun(setup, { script: runner });
  run.match.configureOnlineSeats(peers);
  return { ...run, run, setup, runner };
}
function recovery(run: ReturnType<typeof coop>): Recovery {
  return { setup: run.setup, realtime: run.match.checkpoint(true)!, terrain: {
    format: 'tmt-resident-terrain', schemaVersion: 1, generator: PLANET_GENERATOR, profile: 'resident-f32-game-v3',
    seed: run.setup.seed, revision: 2, tick: run.match.state.tick, bodies: [], chassis: [], structures: [],
    edits: [{ tick: 0, bodies: [], cut: { id: 'already-destroyed-wall', center: [0, 18, 0], radius: 2 } }],
  } };
}
function fakeSession(setup: ReturnType<typeof makeOnlineSetup>, seat: number) {
  const view = { onRealtimeEvent() {}, onGameEvent() {}, setTerrain() {}, reset() {} } as unknown as GameView;
  const session = new GameSession(view, 'bot');
  Object.assign(session, { current: setup, network: { seat, host: false }, generation: 1 });
  return session;
}
beforeEach(() => { storage.write.mockClear(); storage.clear.mockClear(); });

describe('co-op campaign ownership and rewards', () => {
  it('pays helpers once without changing their campaign, endings, build or unlocks', () => {
    const before = defaultProfile(); before.stars['campaign:p3'] = 2; before.unlocks.push('ending:rewind');
    const first = cooperativeReward(before, '3-3', { ...result, ending: 'release' }, false);
    expect(first.xp).toBe(35); expect(first.scrap).toBe(35);
    expect(first.stars).toEqual(before.stars); expect(first.unlocks).toEqual(before.unlocks); expect(first.loadouts).toEqual(before.loadouts);
    expect(cooperativeReward(first, '3-3', { ...result, ending: 'release' }, false)).toEqual(first);
    const medal = cooperativeReward(first, '3-3', { ...result, medal: true }, false);
    expect(medal.xp).toBe(45); expect(cooperativeReward(medal, '3-3', result, false)).toEqual(medal);
    expect(medal.stats).toEqual({ matches: 1, wins: 1 });
  });
  it('advances only the campaign owner, idempotently even when a finish is replayed after transfer', () => {
    const first = cooperativeReward(defaultProfile(), 'p1', result, true);
    expect(first.stars['campaign:p1']).toBe(1); expect(first.xp).toBe(75);
    expect(cooperativeReward(first, 'p1', result, true)).toEqual(first);
    const improved = cooperativeReward(first, 'p1', { ...result, medal: true }, true);
    expect(improved.xp).toBe(90); expect(improved.stats).toEqual(first.stats);
  });
  it('persists the owner independently of simulation hosting and never writes a helper save', async () => {
    const run = coop(), saved = recovery(run), owner = fakeSession(run.setup, 0), guest = fakeSession(run.setup, 1);
    await guest.persistOnlineRecovery(saved); expect(storage.write).not.toHaveBeenCalled();
    await owner.persistOnlineRecovery(saved);
    expect(storage.write).toHaveBeenCalledOnce(); expect(storage.write.mock.calls[0][2]).toBe('owned-coop');
    expect(owner.hasCampaignCheckpoint).toBe(true);
    run.match.dispose();
  });
  it('fences asynchronous persistence after a match change and keeps a distinct solo checkpoint key', async () => {
    const run = coop(), saved = recovery(run), owner = fakeSession(run.setup, 0);
    await owner.persistOnlineRecovery(saved);
    const guard = storage.write.mock.calls[0][3] as unknown as () => boolean;
    expect(guard()).toBe(true); Object.assign(owner, { generation: 2 }); expect(guard()).toBe(false);
    const solo = missionSetup(FIRST_LIGHT, WARDEN, 'normal', { gunner: 0, driver: 0, commander: 0, gadgets: [], ultimate: null });
    expect(cooperativeSaveKey(run.setup)).toBe(cooperativeSaveKey(solo));
    expect(cooperativeSaveKey(solo)).not.toBe(JSON.stringify(solo)); run.match.dispose();
  });
  it('continues the owner checkpoint with its modified world and NPCs, retiring guest tanks', () => {
    const run = coop(); run.run.run(4); const saved = recovery(run), fallback = ownedCooperativeCheckpoint(saved)!;
    expect(fallback.terrain.edits).toEqual(saved.terrain.edits);
    expect(saved.realtime!.state.tanks[1].health).toBeGreaterThan(0);
    const runner = new MissionRunner(FIRST_LIGHT), solo = missionSetup(FIRST_LIGHT, WARDEN);
    const resumed = new RealtimeMatch(new SphereWorld(), solo, { script: runner, checkpoint: fallback.match });
    expect(resumed.state.tick).toBe(run.match.state.tick); expect(resumed.state.tanks[1]).toMatchObject({ retired: true, health: 0 });
    expect(runner.objectiveList()).toEqual(run.runner.objectiveList());
    expect(resumed.checkpoint(true)?.online?.seats).toEqual([0]);
    resumed.dispose(); run.match.dispose();
  });
});

describe('shared campaign triggers and complete mission checkpoints', () => {
  it('allows a helper to reach objectives and continue after the owner leaves', () => {
    const run = coop();
    run.match.state.tanks[1].position = [...run.runner.marker!]; run.run.run(1);
    expect(run.runner.beatId).toBe('targets'); expect(run.runner.objectiveList()[0].state).toBe('done');
    run.match.configureOnlineSeats([peers[1]]); run.run.run(1);
    expect(run.runner.outcome).toBeNull(); expect(run.match.state.tanks[0].retired).toBe(true); run.match.dispose();
  });
  it('accepts a helper shell in the First Light dig-in lesson', () => {
    const def = { ...FIRST_LIGHT, beats: [FIRST_LIGHT.beats.find(b => b.id === 'dig-in')!] };
    const run = coop(def), helper = run.match.state.tanks[1];
    (run.match as any).units[1].impacts.push([...helper.position]); run.run.run(1);
    expect(run.runner.outcome).toBe('won'); run.match.dispose();
  });
  it('repairs a helper on the relay pad while the owner is away', () => {
    const run = coop({ ...FIRST_LIGHT, beats: [hold('relay-test', 'range', 60, ['battery'], 0)] });
    const helper = run.match.state.tanks[1], pad = run.runner.marker!;
    helper.position = [...pad]; helper.health -= 30;
    const before = helper.health; run.run.run(1); expect(helper.health).toBeGreaterThan(before); run.match.dispose();
  });
  it('keeps the caravan moving when only a helper escorts it', () => {
    const run = coop({ ...FIRST_LIGHT, beats: [escort('escort-test', ['range', 'hidden'])] });
    const wagon = run.match.state.tanks.find(t => t.name === 'Archive caravan') ?? run.match.state.tanks[3];
    run.match.state.tanks[1].position = [...wagon.position]; run.run.run(1);
    expect((run.match as any).units[wagon.id].commanded).toBeTruthy(); run.match.dispose();
  });
  it('fences ending choices to the living commander and preserves ending, medal and outcome on recovery', () => {
    const def: MissionDef = { ...FIRST_LIGHT, beats: [{ id: 'ending-choice', done: ctx => !!ctx.flags.ending }] };
    const run = coop(def);
    expect(run.match.command(1, networkCommand({ k: 'utility', id: 'ending-release' }))).toBe(false);
    run.match.configureOnlineSeats([peers[1]]);
    expect(run.match.command(1, networkCommand({ k: 'utility', id: 'ending-release' }))).toBe(true);
    run.run.run(1); expect(run.runner.outcome).toBe('won');
    const runner = new MissionRunner(def), resumed = new RealtimeMatch(new SphereWorld(), run.setup, { script: runner, checkpoint: run.match.checkpoint(true)! });
    expect(runner.outcome).toBe('won'); expect(runner.ending).toBe('release'); expect(runner.medalEarned).toBe(run.runner.medalEarned);
    expect(resumed.matchHash()).toBe(run.match.matchHash()); resumed.dispose(); run.match.dispose();
  });
  it('removes a departed versus seat but retains temporarily disconnected reservations', () => {
    const run = realtimeRun(makeOnlineSetup('realtime', 3, WARDEN));
    run.match.configureOnlineSeats([...peers, { seat: 2, name: 'Third' }]);
    run.match.configureOnlineSeats(peers); expect(run.match.state.tanks[2]).toMatchObject({ retired: true, health: 0 });
    expect(run.match.state.tanks[1].health).toBeGreaterThan(0); run.match.dispose();
  });
  it('opens results once from a final snapshot even if its finish event has left the bounded event log', async () => {
    const run = coop(), session = fakeSession(run.setup, 1), replica = new RealtimeMatch(new SphereWorld(), run.setup, { replica: true });
    Object.assign(session, { simulation: replica, terrain: { applyNetworkWorld: async () => ({}) } });
    const finish = vi.fn(); session.on('finish', finish);
    const state = structuredClone(run.match.state); state.phase = 'finished'; state.winner = 0; state.winnerTeam = 0;
    const snapshot: NetworkSnapshot = { state, realtime: { ...run.match.replica(), state }, world: { from: 0, count: 0, edits: [], bodies: [], chassis: [], tick: 0 },
      mission: { id: 'p1', won: true, medal: false, optional: false, secrets: 0, ending: null, objectives: [], marker: null } };
    await session.applyNetwork(snapshot, []); await session.applyNetwork(snapshot, []);
    expect(finish).toHaveBeenCalledOnce(); run.match.dispose(); replica.dispose();
  });
  it('discards a snapshot that finishes loading after its authority epoch is fenced', async () => {
    const run = coop(), session = fakeSession(run.setup, 1), replica = new RealtimeMatch(new SphereWorld(), run.setup, { replica: true });
    let complete!: (value: unknown) => void, current = true;
    Object.assign(session, { simulation: replica, terrain: { applyNetworkWorld: () => new Promise(resolve => { complete = resolve; }) } });
    const state = structuredClone(run.match.state); state.tick = 300;
    const snapshot: NetworkSnapshot = { state, realtime: { ...run.match.replica(), state }, world: { from: 0, count: 0, edits: [], bodies: [], chassis: [], tick: 300 } };
    const applied = session.applyNetwork(snapshot, [], () => current); current = false; complete({}); await applied;
    expect(replica.state.tick).toBe(0); run.match.dispose(); replica.dispose();
  });
});
