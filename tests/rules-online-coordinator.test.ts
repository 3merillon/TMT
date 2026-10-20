import { afterEach, expect, it, vi } from 'vitest';
import { OnlineMatch } from '../src/game/online/match';
import { Lobby } from '../server/lobby';
import { ONLINE_PROTOCOL, type PeerMessage } from '../src/game/online/protocol';
import { makeOnlineSetup } from '../src/game/online/setup';
import type { GameSession } from '../src/game/app/session';
import type { OnlineClient } from '../src/game/online/client';
import type { PeerLink } from '../src/game/online/peer';

afterEach(() => vi.useRealTimers());
it('does not rebuild a lone 1v1 survivor and invalidates pending checkpoints when the match ends', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Survivor', build: 'test', protocol: ONLINE_PROTOCOL });
  const room = lobby.create(token, { name: 'Finished duel', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('duel', 2, kit) });
  let captured!: (value: unknown) => void;
  const game = { on() {}, network: undefined, ready: true, captureRecovery: () => new Promise(resolve => { captured = resolve; }) };
  const checkpoint = vi.fn(async () => {}), launch = vi.fn(async () => {}), errors = vi.fn();
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true, checkpoint }) as unknown as OnlineClient, launch, errors);
  try {
    const waiting = { ...room, phase: 'playing' as const, host: false, paused: true, reconnectUntil: Date.now() + 180000 };
    match.updateRoom(waiting, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(launch).not.toHaveBeenCalled(); expect(match.active).toBe(false);
    const pending = (match as any).captureRecovery();
    match.updateRoom({ ...waiting, phase: 'finished', ended: { reason: 'reconnect-timeout', winner: 0 }, epoch: 2 }, waiting);
    match.reset(); match.updateRoom({ ...room, code: 'NEWROOM', epoch: 1 }, null);
    captured({ setup: room.setup, turn: { tick: 1 } }); await pending;
    expect(checkpoint).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
    expect(game.network).toBeUndefined(); expect((match as any).recoveries.size).toBe(0);
  } finally { match.dispose(); }
});
it('retains the service-acknowledged and uncertain checkpoints while newer recoveries arrive', async () => {
  vi.useFakeTimers();
  const kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const lobby = new Lobby(), token = lobby.admit({ name: 'Host', build: 'test', protocol: ONLINE_PROTOCOL });
  const room = lobby.create(token, { name: 'Retention', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('realtime', 2, kit) });
  const restoreRecovery = vi.fn(async () => {}), errors = vi.fn(), pins = ['committed', 'uncertain'];
  const game = { on() {}, ready: true, setup: room.setup, restoreRecovery, localCommand() {}, captureRecovery: async () => null };
  const client = { leaseValid: () => true, retainedCheckpoints: () => pins, checkpoint: async () => {}, refresh: async () => {} };
  const match = new OnlineMatch(game as unknown as GameSession, () => client as unknown as OnlineClient, async (_setup, operation) => operation(), errors);
  try {
    match.updateRoom(room, null);
    const committed = { setup: room.setup, turn: { tick: 100 } }, uncertain = { setup: room.setup, turn: { tick: 200 } };
    (match as any).keepRecovery('committed', committed);
    (match as any).keepRecovery('uncertain', uncertain);
    for (let i = 0; i < 8; i++) (match as any).keepRecovery(`new-${i}`, { setup: room.setup, turn: { tick: 300 + i } });
    const elected = { ...room, epoch: 2, phase: 'playing' as const, checkpoint: 'uncertain', paused: true };
    match.updateRoom(elected, room); await vi.advanceTimersByTimeAsync(1);
    expect(restoreRecovery).toHaveBeenCalledWith(uncertain); expect(errors).not.toHaveBeenCalled();
    // A new host's capture remains present even if every older slot is pinned for recovery.
    pins.push('new-7'); (match as any).keepRecovery('new-capture', { setup: room.setup, turn: { tick: 400 } }, false);
    expect((match as any).recoveries.has('new-capture')).toBe(true);
  } finally { match.dispose(); }
});
it('publishes only registered recovery and retains an older elected checkpoint while a new capture is pending', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const tokens = ['Host', 'Guest'].map(name => lobby.admit({ name, build: 'test', protocol: ONLINE_PROTOCOL }));
  const waiting = lobby.create(tokens[0], { name: 'Registration race', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('realtime', 2, kit) });
  lobby.join(tokens[1], { code: waiting.code, password: '', kit }); lobby.playing(tokens[0]); const room = lobby.poll(tokens[0]).room!;
  let register!: () => void; const pending = new Promise<void>(resolve => { register = resolve; });
  const checkpoint = vi.fn((_id: string, _epoch: number, _resume?: boolean) => pending), sent: PeerMessage[] = [], errors = vi.fn();
  let tick = 0;
  const game = { on() {}, ready: true, setup: room.setup, startMatch: async () => {}, restoreRecovery: async () => {}, localCommand() {}, advanceOnline() {},
    captureNetwork: () => ({ world: { count: 0 } }), captureRecovery: async () => ({ setup: room.setup, turn: { tick: ++tick } }) };
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true, checkpoint, refresh: async () => {} }) as unknown as OnlineClient, async (_setup, operation) => operation(), errors);
  try {
    match.updateRoom(room, null); await vi.advanceTimersByTimeAsync(20);
    let receive!: (m: PeerMessage) => void;
    match.attach(room, 1, { busy: false, send(m: PeerMessage) { sent.push(m); }, listen(fn: (m: PeerMessage) => void) { receive = fn; } } as unknown as PeerLink);
    receive({ kind: 'ready', epoch: room.epoch, input: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(checkpoint).toHaveBeenCalledOnce(); expect(sent.some(m => m.kind === 'snapshot')).toBe(true);
    expect(sent.some(m => m.kind === 'recovery')).toBe(false);
    register(); await vi.advanceTimersByTimeAsync(20);
    expect(sent.some(m => m.kind === 'recovery')).toBe(true); expect(errors).not.toHaveBeenCalled();
    const first = sent.find(m => m.kind === 'recovery')!;
    await vi.advanceTimersByTimeAsync(4200); // retain several newer captures before resuming the oldest agreed world
    const elected = { ...room, epoch: 2, paused: true, checkpoint: first.id as string };
    match.updateRoom(elected, room); await vi.advanceTimersByTimeAsync(20);
    let finish!: () => void; const nextPending = new Promise<void>(resolve => { finish = resolve; });
    checkpoint.mockImplementation((_id, _epoch, resume) => resume ? Promise.resolve() : nextPending);
    const attach = () => {
      match.attach(elected, 1, { busy: false, send(m: PeerMessage) { sent.push(m); }, listen(fn: (m: PeerMessage) => void) { receive = fn; } } as unknown as PeerLink);
      receive({ kind: 'ready', epoch: elected.epoch, input: 0 });
    };
    attach(); await vi.advanceTimersByTimeAsync(2200);
    sent.length = 0; attach(); await vi.advanceTimersByTimeAsync(150);
    expect(sent.find(m => m.kind === 'recovery')).toMatchObject({ id: first.id, recovery: first.recovery });
    expect(errors).not.toHaveBeenCalled(); finish();
  } finally { match.dispose(); }
});
it('waits for every versus world, releases stale remote movement, and stops when its authority lease expires', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const tokens = ['Host', 'Second', 'Third'].map(name => lobby.admit({ name, build: 'test', protocol: ONLINE_PROTOCOL }));
  const waiting = lobby.create(tokens[0], { name: 'Three players', password: '', listed: false, capacity: 3, setup: makeOnlineSetup('realtime', 3, kit) });
  for (const token of tokens.slice(1)) lobby.join(token, { code: waiting.code, password: '', kit });
  lobby.playing(tokens[0]); const room = lobby.poll(tokens[0]).room!;
  const game = { on: vi.fn(), ready: true, setup: room.setup, startMatch: vi.fn(async () => {}), localCommand: vi.fn(), advanceOnline: vi.fn(),
    captureNetwork: () => null, captureRecovery: async () => null };
  const leaseValid = vi.fn(() => true), errors = vi.fn();
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid }) as unknown as OnlineClient, async (_setup, operation) => operation(), errors);
  try {
    match.updateRoom(waiting, null); match.updateRoom(room, waiting);
    await vi.advanceTimersByTimeAsync(20);
    const receive: Array<(m: PeerMessage) => void> = [];
    for (const seat of [1, 2]) match.attach(room, seat, { busy: false, send() {}, listen(fn: (m: PeerMessage) => void) { receive[seat] = fn; } } as unknown as PeerLink);
    receive[1]({ kind: 'ready', epoch: room.epoch, input: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(game.advanceOnline).not.toHaveBeenCalled();
    receive[2]({ kind: 'ready', epoch: room.epoch, input: 0 });
    await vi.advanceTimersByTimeAsync(20);
    expect(game.advanceOnline).toHaveBeenCalled();
    receive[1]({ kind: 'input', epoch: room.epoch, seq: 1, command: { k: 'drive', throttle: 1, steer: 0 } });
    expect(game.localCommand).toHaveBeenCalledWith(1, { k: 'drive', throttle: 1, steer: 0 });
    await vi.advanceTimersByTimeAsync(350);
    expect(game.localCommand).toHaveBeenCalledWith(1, { k: 'drive', throttle: 0, steer: 0 });
    game.advanceOnline.mockClear(); leaseValid.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(350);
    expect(game.advanceOnline).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  } finally { match.dispose(); }
});

it('runs a solo co-op world before friends arrive and after the last helper leaves', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Owner', build: 'test', protocol: ONLINE_PROTOCOL });
  lobby.create(token, { name: 'Drop-in campaign', password: '', listed: false, capacity: 3, setup: makeOnlineSetup('coop', 3, kit) });
  lobby.playing(token); const room = lobby.poll(token).room!;
  const game = { on() {}, ready: true, setup: room.setup, startMatch: async () => {}, advanceOnline: vi.fn(), captureNetwork: () => null, captureRecovery: async () => null };
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient, async (_setup, operation) => operation(), vi.fn());
  try {
    match.updateRoom(room, null); await vi.advanceTimersByTimeAsync(100);
    expect(game.advanceOnline).toHaveBeenCalled(); expect(match.status).toBeNull();
    game.advanceOnline.mockClear(); (match as any).hadPeer = true; await vi.advanceTimersByTimeAsync(100);
    expect(game.advanceOnline).toHaveBeenCalled();
  } finally { match.dispose(); }
});
it('isolates a closed helper channel before the membership update and continues sending to healthy peers', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Owner', build: 'test', protocol: ONLINE_PROTOCOL });
  lobby.create(token, { name: 'Helper departure', password: '', listed: false, capacity: 3, setup: makeOnlineSetup('coop', 3, kit) });
  lobby.playing(token); const room = lobby.poll(token).room!;
  const game = { on() {}, ready: true, setup: room.setup, startMatch: async () => {}, localCommand: vi.fn(), advanceOnline: vi.fn(), captureNetwork: () => ({ world: { count: 0 } }), captureRecovery: async () => null };
  const errors = vi.fn(), sent: PeerMessage[] = [], receive: Array<(message: PeerMessage) => void> = [];
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient, async (_setup, operation) => operation(), errors);
  try {
    match.updateRoom(room, null); await vi.advanceTimersByTimeAsync(1);
    for (const seat of [1, 2]) {
      match.attach(room, seat, { busy: false, connected: seat === 1, send(message: PeerMessage) { if (seat === 2) throw new Error('The match connection is closed.'); sent.push(message); }, listen(fn: (message: PeerMessage) => void) { receive[seat] = fn; } } as unknown as PeerLink);
      receive[seat]({ kind: 'ready', epoch: 1, input: 0 });
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(game.advanceOnline).toHaveBeenCalled(); expect(sent.some(m => m.kind === 'snapshot')).toBe(true); expect(match.active).toBe(true);
    expect((match as any).peers.has(2)).toBe(false); expect(game.localCommand).toHaveBeenCalledWith(2, { k: 'drive', throttle: 0, steer: 0 }); expect(errors).not.toHaveBeenCalled();
  } finally { match.dispose(); }
});

it('rejects out-of-order snapshots while applying terrain, applies events once, and fences obsolete async work', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Host', build: 'test', protocol: ONLINE_PROTOCOL });
  const created = lobby.create(token, { name: 'Snapshots', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('realtime', 2, kit) });
  const room = { ...created, host: false, seat: 1, phase: 'playing' as const };
  const state = { tick: 1, tanks: [0, 1].map(id => ({ id, position: [id, 0, 0], rotation: [0, 0, 0, 1], health: 10, turretYaw: 0, barrelPitch: 0 })), projectiles: [] };
  const snapshot = { state, world: { from: 0, count: 0, edits: [], bodies: [], chassis: [], tick: 1 } };
  let release!: () => void, isCurrent!: () => boolean;
  const applyNetwork = vi.fn(async (_snapshot, _events, current) => { isCurrent = current; if (applyNetwork.mock.calls.length === 1) await new Promise<void>(r => { release = r; }); });
  const game = { on() {}, ready: true, setup: room.setup, snapshot: state, startMatch: async () => {}, applyNetwork, predictNetwork() {} };
  const errors = vi.fn(), match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient, async (_setup, operation) => operation(), errors);
  let receive!: (message: PeerMessage) => void;
  try {
    match.updateRoom(room, null); await vi.advanceTimersByTimeAsync(1);
    match.attach(room, 0, { busy: false, send() {}, listen(fn: (message: PeerMessage) => void) { receive = fn; } } as unknown as PeerLink);
    const message = (seq: number, ids: number[]) => ({ kind: 'snapshot', epoch: room.epoch, seq, ack: 0, snapshot, events: ids.map(id => ({ id })) });
    receive(message(2, [1])); receive(message(4, [1, 2])); receive(message(3, [1])); receive(message(4, [1, 2]));
    release(); await vi.advanceTimersByTimeAsync(1);
    expect(applyNetwork.mock.calls.map(args => args[1].map((event: { id: number }) => event.id))).toEqual([[1], [2]]);
    expect((match as any).applied).toBe(4); expect(errors).not.toHaveBeenCalled();
    expect(isCurrent()).toBe(true); match.reset(); expect(isCurrent()).toBe(false);
  } finally { match.dispose(); }
});

it('does not consume input sequence numbers while the transport rejects a send', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Host', build: 'test', protocol: ONLINE_PROTOCOL });
  const created = lobby.create(token, { name: 'Backpressure', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('realtime', 2, kit) });
  const room = { ...created, host: false, seat: 1, phase: 'playing' as const };
  const game = { on() {}, ready: true, setup: room.setup, startMatch: async () => {} };
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient, async (_setup, operation) => operation(), vi.fn());
  let blocked = true; const sent: PeerMessage[] = [];
  try {
    match.updateRoom(room, null); await vi.advanceTimersByTimeAsync(1);
    match.attach(room, 0, { busy: true, send(message: PeerMessage) { if (blocked) throw new Error('Buffer full'); sent.push(message); }, listen() {} } as unknown as PeerLink);
    for (let i = 0; i < 600; i++) expect(match.command(1, { k: 'fire' })).toBe(false);
    expect((match as any).inputSeq).toBe(0);
    blocked = false; expect(match.command(1, { k: 'fire' })).toBe(true);
    expect(sent).toEqual([{ kind: 'input', epoch: 1, seq: 1, command: { k: 'fire' } }]);
  } finally { match.dispose(); }
});
it('coalesces high-refresh aiming while ordering the final aim immediately before fire', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Host', build: 'test', protocol: ONLINE_PROTOCOL });
  const created = lobby.create(token, { name: 'High refresh controls', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('realtime', 2, kit) });
  const room = { ...created, host: false, seat: 1, phase: 'playing' as const };
  const game = { on() {}, ready: true, setup: room.setup, startMatch: async () => {}, aimNetwork: vi.fn(), predictNetwork() {} };
  const sent: PeerMessage[] = [], match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient, async (_setup, operation) => operation(), vi.fn());
  try {
    match.updateRoom(room, null); await vi.advanceTimersByTimeAsync(1);
    match.attach(room, 0, { busy: false, send(message: PeerMessage) { sent.push(message); }, listen() {} } as unknown as PeerLink);
    for (let i = 0; i < 240; i++) { match.command(1, { k: 'aim', yaw: i / 240, pitch: .3, power: .8 }); await vi.advanceTimersByTimeAsync(1000 / 240); }
    expect(game.aimNetwork).toHaveBeenCalledTimes(240);
    expect(sent.filter(m => m.kind === 'input').length).toBeLessThan(150);
    match.command(1, { k: 'aim', yaw: 2, pitch: .4, power: .9 }); match.command(1, { k: 'fire' });
    expect(sent.slice(-2).map(m => m.command)).toEqual([{ k: 'aim', yaw: 2, pitch: .4, power: .9 }, { k: 'fire' }]);
    const inputs = sent.filter(m => m.kind === 'input'); expect(inputs.map(m => m.seq)).toEqual(inputs.map((_, i) => i + 1));
  } finally { match.dispose(); }
});

it('sends current state to a late joiner without replaying obsolete mission and impact events', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Owner', build: 'test', protocol: ONLINE_PROTOCOL });
  const room = lobby.create(token, { name: 'Current mission', password: '', listed: false, capacity: 3, setup: makeOnlineSetup('coop', 3, kit) });
  const game = { on() {}, ready: true, setup: room.setup, captureNetwork: vi.fn(() => ({ world: { count: 5 } })) };
  const sent: PeerMessage[] = [], match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient, async () => {}, vi.fn());
  let receive!: (message: PeerMessage) => void;
  try {
    match.updateRoom(room, null); (match as any).record({ realtime: { type: 'objective', id: 'old', done: false } });
    match.attach(room, 1, { busy: false, send(message: PeerMessage) { sent.push(message); }, listen(fn: (message: PeerMessage) => void) { receive = fn; } } as unknown as PeerLink);
    receive({ kind: 'ready', epoch: 1, input: 0 }); (match as any).publish();
    expect(sent[0].events).toEqual([]); expect(game.captureNetwork).toHaveBeenCalledWith(0, true);
    (match as any).record({ realtime: { type: 'objective', id: 'new', done: true } }); (match as any).publish();
    expect(sent[1].events).toEqual([{ id: 2, realtime: { type: 'objective', id: 'new', done: true } }]);
  } finally { match.dispose(); }
});

it('rejects oversized captures before retaining them and preserves the last recoverable world', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Host', build: 'test', protocol: ONLINE_PROTOCOL });
  const room = lobby.create(token, { name: 'Bounded recovery', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('realtime', 2, kit) });
  const game = { on() {}, captureRecovery: async () => ({ setup: room.setup, turn: { tick: 2 }, terrain: { edits: Array(20_001).fill(null) } }) };
  const checkpoint = vi.fn(), errors = vi.fn();
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ checkpoint }) as unknown as OnlineClient, async () => {}, errors);
  try {
    match.updateRoom(room, null); (match as any).keepRecovery('previous', { setup: room.setup, turn: { tick: 1 } });
    await (match as any).captureRecovery(); await (match as any).captureRecovery();
    expect([...(match as any).recoveries.keys()]).toEqual(['previous']); expect((match as any).latestRecovery).toBe('previous');
    expect(checkpoint).not.toHaveBeenCalled(); expect(errors).toHaveBeenCalledTimes(1); expect(errors.mock.calls[0][0]).toContain('previous verified checkpoint');
  } finally { match.dispose(); }
});

it('reliably sends the final outcome then stops finished-match snapshots and checkpoints after acknowledgment', async () => {
  vi.useFakeTimers();
  const lobby = new Lobby(), kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
  const token = lobby.admit({ name: 'Host', build: 'test', protocol: ONLINE_PROTOCOL });
  const created = lobby.create(token, { name: 'Final delivery', password: '', listed: false, capacity: 2, setup: makeOnlineSetup('realtime', 2, kit) });
  const room = { ...created, phase: 'playing' as const, peers: [...created.peers, { seat: 1, name: 'Guest', connected: true, generation: 0 }] };
  const game = { on() {}, ready: true, setup: room.setup, snapshot: { phase: 'finished' }, startMatch: async () => {}, advanceOnline: vi.fn(),
    captureNetwork: () => ({ world: { count: 0 } }), captureRecovery: vi.fn(async () => null) };
  const match = new OnlineMatch(game as unknown as GameSession, () => ({ leaseValid: () => true }) as unknown as OnlineClient, async (_setup, operation) => operation(), vi.fn());
  let receive!: (message: PeerMessage) => void; const sent: PeerMessage[] = [];
  try {
    match.updateRoom(room, null); await vi.advanceTimersByTimeAsync(1);
    match.attach(room, 1, { busy: false, send(message: PeerMessage) { sent.push(message); }, listen(fn: (message: PeerMessage) => void) { receive = fn; } } as unknown as PeerLink);
    receive({ kind: 'ready', epoch: 1, input: 0 }); (match as any).record({ game: { type: 'finish', winner: 0 } });
    match.updateRoom({ ...room, phase: 'finished' }, room); await vi.advanceTimersByTimeAsync(500);
    const final = sent.filter(m => m.kind === 'snapshot').at(-1)!; expect(final.events).toEqual([{ id: 1, game: { type: 'finish', winner: 0 } }]);
    receive({ kind: 'ack', epoch: 1, seq: final.seq, world: 0, event: 1 });
    const before = sent.filter(m => m.kind === 'snapshot').length; await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.filter(m => m.kind === 'snapshot')).toHaveLength(before); expect(game.advanceOnline).not.toHaveBeenCalled(); expect(game.captureRecovery).not.toHaveBeenCalled();
  } finally { match.dispose(); }
});
