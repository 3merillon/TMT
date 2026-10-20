import { describe, expect, it } from 'vitest';
import { Lobby, MEMBER_TTL, RECONNECT_TTL } from '../server/lobby';
import { makeOnlineSetup } from '../src/game/online/setup';
import { ONLINE_PROTOCOL } from '../src/game/online/protocol';
import type { OnlineMode } from '../src/game/online/protocol';

const kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
function fixture(mode: OnlineMode = 'duel', capacity: 2 | 3 = 2, password = '', listed = true) {
  let time = 1000;
  const lobby = new Lobby(() => time);
  const admit = (name: string, build = 'test') => lobby.admit({ name, build, protocol: ONLINE_PROTOCOL });
  const host = admit('Host'), guest = admit('Friend'), third = admit('Third');
  const room = lobby.create(host, { name: 'The room', password, listed, capacity, setup: makeOnlineSetup(mode, capacity, kit) });
  const join = (token = guest, pass = password) => lobby.join(token, { code: room.code.toLowerCase(), password: pass, kit });
  return { lobby, host, guest, third, room, join, admit, advance: (ms: number) => { time += ms; } };
}
const recovery = '120:0123456789abcdef';
describe('online membership and authority', () => {
  it.each(['duel', 'realtime', 'artillery'] as const)('ends a %s 1v1 when either player leaves, without electing a world to restore', mode => {
    for (const leavesHost of [false, true]) {
      const f = fixture(mode); f.join(); f.lobby.playing(f.host);
      for (const token of [f.host, f.guest]) f.lobby.checkpoint(token, { id: recovery, epoch: 1 });
      f.lobby.leave(leavesHost ? f.host : f.guest);
      const survivor = leavesHost ? f.guest : f.host, ended = f.lobby.poll(survivor).room!;
      expect(ended).toMatchObject({ phase: 'finished', host: true, paused: false, checkpoint: null, ended: { reason: 'opponent-left', winner: leavesHost ? 1 : 0 } });
      f.lobby.restart(survivor, ended.setup);
      expect(f.lobby.poll(survivor).room).toMatchObject({ phase: 'waiting', ended: undefined, checkpoint: null });
      expect(() => f.lobby.playing(survivor)).toThrow(/another player/);
    }
  });
  it('waits without 1v1 host migration, resumes a returning authority, then finishes at the reconnect deadline', () => {
    const f = fixture(); f.join(); f.lobby.playing(f.host);
    for (const token of [f.host, f.guest]) f.lobby.checkpoint(token, { id: recovery, epoch: 1 });
    f.advance(10_000); f.lobby.poll(f.guest); f.advance(6_000);
    expect(f.lobby.poll(f.guest).room).toMatchObject({ host: false, epoch: 1, paused: true, reconnectUntil: 1000 + RECONNECT_TTL });
    expect(f.lobby.poll(f.host).room).toMatchObject({ host: true, epoch: 1, paused: false, reconnectUntil: undefined });
    for (let i = 0; i < 19; i++) { f.advance(10_000); f.lobby.poll(f.guest); }
    const ended = f.lobby.poll(f.guest).room!;
    expect(ended).toMatchObject({ host: true, phase: 'finished', paused: false, checkpoint: null, ended: { reason: 'reconnect-timeout' } });
    expect(() => f.lobby.poll(f.host)).toThrow(/expired/);
    f.lobby.leave(f.guest);
    expect(f.lobby.create(f.guest, { name: 'Fresh match', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('duel', 2, kit) })).toMatchObject({ phase: 'waiting', epoch: 1, checkpoint: null, ended: undefined });
  });
  it('transfers a refreshed host to a recovery holder and excludes a refreshed guest from election', () => {
    const f = fixture('realtime', 3); f.join(); f.join(f.third); f.lobby.playing(f.host);
    for (const token of [f.host, f.guest, f.third]) f.lobby.checkpoint(token, { id: recovery, epoch: 1 });
    const stale = f.host;
    f.guest = f.lobby.reconnect(f.guest, true)!;
    f.host = f.lobby.reconnect(f.host, true)!;
    expect(() => f.lobby.poll(stale)).toThrow(/expired/);
    const room = f.lobby.poll(f.third).room!;
    expect(room.host).toBe(true); expect(room.paused).toBe(true); expect(room.epoch).toBe(2);
    f.lobby.checkpoint(f.third, { id: recovery, epoch: 2, resume: true });
    expect(f.lobby.poll(f.host).room?.host).toBe(false);
    expect(f.lobby.poll(f.guest).room?.paused).toBe(false);
  });
  it('never resumes a refreshed authority without a world, but accepts a late recovery holder', () => {
    const f = fixture('realtime'); f.join(); f.lobby.playing(f.host);
    f.lobby.checkpoint(f.host, { id: recovery, epoch: 1 });
    f.host = f.lobby.reconnect(f.host, true)!;
    expect(f.lobby.poll(f.host).room?.paused).toBe(true);
    expect(f.lobby.poll(f.host).room?.checkpoint).toBeNull();
    f.lobby.checkpoint(f.guest, { id: recovery, epoch: 1 });
    expect(f.lobby.poll(f.guest).room?.host).toBe(true);
    expect(f.lobby.poll(f.guest).room?.epoch).toBe(2);
  });
  it('keeps private rooms hidden, gates the code with a password, and never exposes the password', () => {
    const f = fixture('duel', 2, 'a secret', false);
    expect(f.lobby.poll(f.guest).rooms).toEqual([]);
    expect(() => f.join(f.guest, 'wrong')).toThrow(/password/);
    expect(f.join().seat).toBe(1);
    expect(JSON.stringify(f.lobby.poll(f.guest))).not.toContain('a secret');
    expect(() => f.join(f.third)).toThrow(/full/);
    expect(() => f.lobby.playing(f.guest)).toThrow(/host/);
  });
  it('rejects mismatched builds and malformed human slots', () => {
    const f = fixture(), alien = f.admit('Old game', 'old');
    expect(f.lobby.poll(alien).rooms).toEqual([]);
    expect(() => f.join(alien)).toThrow(/build/);
    const setup = makeOnlineSetup('realtime', 3, kit); setup.online!.seats = [0, 1, 1];
    expect(() => f.lobby.create(f.third, { name: 'bad', password: '', listed: true, capacity: 3, setup })).toThrow();
  });
  it('fills the lowest latency compatible duel and permits cancellation without orphaning the other player', () => {
    const f = fixture(); f.lobby.poll(f.host, 0, 200);
    const fast = f.admit('Fast');
    const low = f.lobby.create(fast, { name: 'Fast room', password: '', listed: true, capacity: 2, setup: makeOnlineSetup('duel', 2, kit) });
    f.lobby.poll(fast, 0, 20);
    expect(f.lobby.queue(f.guest, makeOnlineSetup('duel', 2, kit)).code).toBe(low.code);
    expect(f.lobby.poll(fast).room?.phase).toBe('playing');
    f.lobby.leave(f.guest);
    expect(f.lobby.poll(f.guest).room).toBeNull();
    expect(f.lobby.poll(fast).room?.peers).toHaveLength(1);
  });
  it.each(['duel', 'realtime', 'artillery'] as const)('keeps %s quick matchmaking in the requested ruleset', mode => {
    const f = fixture(mode);
    const wrong = f.admit('Different mode'), wrongKind = mode === 'duel' ? 'realtime' : 'duel';
    const other = f.lobby.queue(wrong, makeOnlineSetup(wrongKind, 2, kit));
    expect(other.code).not.toBe(f.room.code);
    const matched = f.lobby.queue(f.guest, makeOnlineSetup(mode, 2, kit));
    expect(matched.code).toBe(f.room.code); expect(matched.mode).toBe(mode); expect(matched.phase).toBe('playing');
    expect(f.lobby.poll(wrong).queued).toBe(true);
  });
  it('continues a three-player match with two, then applies reconnect grace and an immediate final departure result', () => {
    const f = fixture('realtime', 3); f.join(); f.join(f.third); f.lobby.playing(f.host);
    f.lobby.leave(f.third);
    expect(f.lobby.poll(f.host).room).toMatchObject({ phase: 'playing', epoch: 1, paused: false, players: 2 });
    f.advance(10_000); f.lobby.poll(f.guest); f.advance(6_000);
    expect(f.lobby.poll(f.guest).room).toMatchObject({ epoch: 1, paused: true, reconnectUntil: 1000 + RECONNECT_TTL });
    f.lobby.poll(f.host); f.lobby.leave(f.host);
    expect(f.lobby.poll(f.guest).room).toMatchObject({ host: true, phase: 'finished', paused: false, checkpoint: null, ended: { reason: 'opponent-left', winner: 1 } });
  });
  it('pauses a lone three-player survivor without transfer and resumes as soon as a second player returns', () => {
    const f = fixture('realtime', 3); f.join(); f.join(f.third); f.lobby.playing(f.host);
    for (const token of [f.host, f.guest, f.third]) f.lobby.checkpoint(token, { id: recovery, epoch: 1 });
    f.advance(10_000); f.lobby.poll(f.guest); f.advance(6_000);
    expect(f.lobby.poll(f.guest).room).toMatchObject({ host: false, epoch: 1, players: 1, paused: true, reconnectUntil: 1000 + RECONNECT_TTL });
    const resumed = f.lobby.poll(f.third).room!;
    expect(resumed.players).toBe(2);
    // The following authoritative read can now elect a verified connected successor for real opposition.
    expect(f.lobby.poll(f.guest).room).toMatchObject({ host: true, epoch: 2, paused: true, checkpoint: recovery, reconnectUntil: undefined });
  });
  it('starts a solo campaign, keeps its ownership during handoff, and never assigns the owner seat to a helper', () => {
    const f = fixture('coop', 3); f.lobby.playing(f.host);
    expect(f.lobby.poll(f.host).room?.phase).toBe('playing');
    const original = f.lobby.poll(f.host).room!.setup.online!;
    expect(original.campaignOwnerSeat).toBe(0); expect(original.runId).toMatch(/^[a-f0-9]{32}$/);
    f.join(); for (const token of [f.host, f.guest]) f.lobby.checkpoint(token, { id: recovery, epoch: 1 });
    f.lobby.leave(f.host);
    const transferred = f.lobby.poll(f.guest).room!;
    expect(transferred).toMatchObject({ host: true, phase: 'playing', epoch: 2, paused: true, checkpoint: recovery });
    expect(transferred.setup.online).toEqual(original);
    f.lobby.checkpoint(f.guest, { id: recovery, epoch: 2, resume: true });
    expect(f.join(f.third).seat).toBe(2);
    expect(f.lobby.poll(f.guest).room?.reserved).toBe(3);
    f.lobby.complete(f.guest, 2); f.lobby.restart(f.guest, makeOnlineSetup('coop', 3, kit));
    const next = f.lobby.poll(f.guest).room!.setup.online!;
    expect(next.campaignOwnerSeat).toBe(0); expect(next.runId).not.toBe(original.runId);
  });
  it('requires every versus seat but admits friends into empty campaign seats mid-mission', () => {
    const pvp = fixture('realtime', 3); pvp.join();
    expect(() => pvp.lobby.playing(pvp.host)).toThrow(/every versus slot/);
    pvp.join(pvp.third); pvp.lobby.playing(pvp.host);
    const coop = fixture('coop', 3); coop.join(); coop.lobby.playing(coop.host);
    expect(coop.join(coop.third).seat).toBe(2);
    expect(coop.lobby.poll(coop.third).room?.phase).toBe('playing');
  });
  it('reserves disconnected seats, elects exactly one checkpoint holder, and rejects stale authority', () => {
    const f = fixture('realtime', 3); f.join(); f.join(f.third); f.lobby.playing(f.host);
    expect(() => f.lobby.checkpoint(f.guest, { id: recovery, epoch: 1 })).toThrow(/not published/);
    f.lobby.checkpoint(f.host, { id: recovery, epoch: 1 });
    f.lobby.checkpoint(f.guest, { id: recovery, epoch: 1 });
    f.advance(10_000); f.lobby.poll(f.guest); f.lobby.poll(f.third);
    f.advance(MEMBER_TTL - 9_999); // original host lease expires
    const elected = f.lobby.poll(f.guest).room!;
    expect(elected).toMatchObject({ host: true, epoch: 2, paused: true, checkpoint: recovery, players: 2, reserved: 3 });
    expect(f.lobby.poll(f.third).room?.host).toBe(false);
    expect(() => f.lobby.checkpoint(f.host, { id: recovery, epoch: 1, resume: true })).toThrow(/checkpoint/);
    expect(() => f.lobby.checkpoint(f.third, { id: recovery, epoch: 2, resume: true })).toThrow(/elected host/);
    f.lobby.checkpoint(f.guest, { id: recovery, epoch: 2, resume: true });
    expect(f.lobby.poll(f.host).room).toMatchObject({ host: false, seat: 0, epoch: 2, paused: false });
  });
  it('lets the original host recover its lease when no successor can safely take over', () => {
    const f = fixture(); f.join(); f.lobby.playing(f.host);
    f.advance(10_000); f.lobby.poll(f.guest); f.advance(6_000);
    expect(f.lobby.poll(f.guest).room?.paused).toBe(true);
    expect(f.lobby.poll(f.host).room).toMatchObject({ epoch: 1, host: true, paused: false });
  });
  it('fences old negotiations after reconnect and after graceful transfer', () => {
    const f = fixture(); f.join();
    const offer = { to: 1, generation: 0, toGeneration: 0, epoch: 1, value: { description: { type: 'offer' as const, sdp: 'test' } } };
    f.lobby.reconnect(f.guest); f.lobby.signal(f.host, offer);
    expect(f.lobby.poll(f.guest).signals).toEqual([]);
    f.lobby.signal(f.host, { ...offer, toGeneration: 1 });
    expect(f.lobby.poll(f.guest).signals).toHaveLength(1);
    f.lobby.handoff(f.host);
    expect(() => f.lobby.signal(f.host, offer)).toThrow(/Host changed/);
    expect(f.lobby.poll(f.guest).signals).toEqual([]);
  });
  it('expires abandoned seats and bounds chat and password attempts', () => {
    const f = fixture('coop', 3, 'secret'); f.join(); f.lobby.playing(f.host);
    for (let i = 0; i < 5; i++) f.lobby.chat(f.host, `message ${i}`);
    expect(() => f.lobby.chat(f.host, 'spam')).toThrow(/wait/);
    expect(f.lobby.poll(f.guest).chat[0]).toMatchObject({ name: 'Host', seat: 0 });
    for (let i = 0; i < 8; i++) expect(() => f.join(f.third, 'wrong')).toThrow(/password/);
    expect(() => f.join(f.third)).toThrow(/attempts/);
    for (let i = 0; i < 20; i++) { f.advance(10_000); f.lobby.poll(f.host); }
    expect(f.lobby.poll(f.host).room?.reserved).toBe(1);
    expect(() => f.lobby.poll(f.guest)).toThrow(/expired/);
    expect(RECONNECT_TTL).toBe(180_000);
  });
  it('keeps the party and password for another mission and fences the old round', () => {
    const f = fixture('coop', 3, 'secret'); f.join(); f.lobby.playing(f.host);
    expect(() => f.lobby.complete(f.guest, 1)).toThrow(/current host/);
    f.lobby.complete(f.host, 1);
    expect(() => f.join(f.third)).toThrow(/already playing/);
    expect(() => f.lobby.restart(f.guest, f.room.setup)).toThrow(/host/);
    f.lobby.restart(f.host, makeOnlineSetup('coop', 3, kit, undefined, 'p2'));
    const room = f.lobby.poll(f.guest).room!;
    expect(room).toMatchObject({ code: f.room.code, epoch: 2, locked: true, phase: 'waiting', checkpoint: null });
    expect(room.setup.id).toContain('p2');
    expect(() => f.lobby.complete(f.host, 1)).toThrow(/current host/);
    expect(() => f.join(f.third, 'bad')).toThrow(/password/);
    f.lobby.playing(f.host); expect(f.lobby.poll(f.guest).room?.phase).toBe('playing');
  });
});
