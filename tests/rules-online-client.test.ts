import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnlineClient } from '../src/game/online/client';
import { Lobby } from '../server/lobby';
import { makeOnlineSetup } from '../src/game/online/setup';
import { lobbyAction } from '../server/actions';
import { ONLINE_BUILD, ONLINE_PROTOCOL } from '../src/game/online/protocol';

const clients: OnlineClient[] = [];
afterEach(() => { clients.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(delayQueue?: Promise<void>) {
  const lobby = new Lobby(), callbacks = { room: vi.fn(), peer: vi.fn(), lost: vi.fn() }, calls: string[] = [];
  let token = '', expires = Infinity, replyDelay = 0;
  const request: typeof fetch = async (url, init) => {
    const path = String(url).split('/api/online/')[1], headers = init?.headers as Record<string, string>, bearer = headers.Authorization?.slice(7) ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push(path);
    let result: unknown;
    if (path === 'session') result = { token: token = lobby.admit(body), iceServers: [], iceExpiresAt: expires };
    else {
      if (path === 'queue') await delayQueue;
      result = lobbyAction(lobby, init?.method ?? 'GET', new URL(String(url)), bearer, body);
      if (path === 'config') result = { ...result as object, iceServers: [], iceExpiresAt: Date.now() + 86400000 };
    }
    if (path.startsWith('state') && replyDelay) vi.setSystemTime(Date.now() + replyDelay);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const newClient = () => { const c = new OnlineClient(callbacks, 'http://local', request); clients.push(c); return c; };
  const client = newClient();
  return { client, newClient, calls, callbacks, expireAt: (value: number) => { expires = value; }, delayReply: (ms: number) => { replyDelay = ms; }, start: () => {
    const guest = lobby.admit({ name: 'Guest', build: ONLINE_BUILD, protocol: ONLINE_PROTOCOL });
    lobby.join(guest, { code: lobby.poll(token).room!.code, password: '', kit });
  } };
}
const kit = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
describe('persistent online client', () => {
  it('does not extend authority with delayed replies or unsolicited room pushes', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.connect(); await f.client.queue(makeOnlineSetup('duel', 2, kit));
    f.delayReply(7000); await f.client.refresh();
    expect(f.client.leaseValid()).toBe(true); vi.setSystemTime(Date.now() + 3001);
    expect(f.client.leaseValid()).toBe(false);
    (f.client as any).applyState({ ...f.client.state, revision: 100 });
    expect(f.client.leaseValid()).toBe(false);
  });
  it('pins an uncertain checkpoint after a lost reply until the room confirms its committed world', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.connect(); await f.client.queue(makeOnlineSetup('duel', 2, kit));
    const id = '120:0123456789abcdef', pending = f.client.checkpoint(id, 1); void pending.catch(() => {});
    // Simulate a response loss after the request could have committed at the service.
    const original = (f.client as any).api.bind(f.client); let lose = true;
    (f.client as any).api = async (path: string, body?: unknown) => { const result = await original(path, body); if (lose && path.startsWith('state')) { lose = false; throw new Error('Response lost'); } return result; };
    await f.client.refresh(); expect(f.client.retainedCheckpoints()).toContain(id);
    const newer = f.client.checkpoint('240:fedcba9876543210', 1); void newer.catch(() => {});
    expect(f.client.retainedCheckpoints()).toContain(id);
    await f.client.refresh(); await newer;
    expect(f.client.retainedCheckpoints()).toEqual(['240:fedcba9876543210']);
  });
  it('bounds uncertain checkpoint receipts during repeated lost responses', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.connect(); await f.client.queue(makeOnlineSetup('duel', 2, kit));
    const original = (f.client as any).api.bind(f.client);
    (f.client as any).api = async (path: string, body?: unknown) => { const result = await original(path, body); if (path.startsWith('state')) throw new Error('Response lost'); return result; };
    for (let i = 1; i <= 20; i++) { void f.client.checkpoint(`${i}:0123456789abcdef`, 1).catch(() => {}); await f.client.refresh(); }
    expect((f.client as any).unconfirmedRecovery.size).toBe(8);
    expect(f.client.retainedCheckpoints()).toContain('20:0123456789abcdef');
  });
  it('never polls a saved seat before reconnect validates whether the world survived a page reload', async () => {
    vi.useFakeTimers(); const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
    const f = fixture(); await f.client.connect(); await f.client.queue(makeOnlineSetup('duel', 2, kit)); f.start(); await f.client.refresh();
    f.client.dispose(); f.callbacks.room.mockClear(); const restored = f.newClient(), before = f.calls.length;
    restored.setBrowsing(true); await vi.advanceTimersByTimeAsync(20000);
    expect(f.calls).toHaveLength(before); expect(f.callbacks.room).not.toHaveBeenCalled();
    await restored.connect(); expect(f.calls.slice(before, before + 2)).toEqual(['config', 'reconnect']);
    expect(restored.state.room?.paused).toBe(true);
  });
  it('stops idle menu traffic and resumes browsing with a 15-second refresh', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.connect();
    const idle = f.calls.length; await vi.advanceTimersByTimeAsync(60000); expect(f.calls).toHaveLength(idle);
    f.client.setBrowsing(true); await f.client.refresh(); const browsing = f.calls.length;
    await vi.advanceTimersByTimeAsync(14999); expect(f.calls).toHaveLength(browsing);
    await vi.advanceTimersByTimeAsync(1); expect(f.calls).toHaveLength(browsing + 1); expect(f.calls.at(-1)).toContain('list=1');
    f.client.setBrowsing(false); const stopped = f.calls.length;
    await vi.advanceTimersByTimeAsync(60000); expect(f.calls).toHaveLength(stopped);
  });
  it('batches checkpoint registration into the stable match heartbeat', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.client.connect(); await f.client.queue(makeOnlineSetup('duel', 2, kit));
    f.start(); await f.client.refresh(); const before = f.calls.length;
    const checkpoint = f.client.checkpoint('120:0123456789abcdef', 1), resolved = vi.fn(); void checkpoint.then(resolved);
    await vi.advanceTimersByTimeAsync(3999); expect(f.calls).toHaveLength(before); expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await checkpoint;
    expect(f.calls).toHaveLength(before + 1); expect(f.calls.at(-1)).toContain('checkpoint=120%3A0123456789abcdef');
    expect(f.calls).not.toContain('checkpoint'); expect(f.client.leaseValid()).toBe(true);
  });
  it('renews expiring relay credentials without rotating the seat or reconnecting its transport', async () => {
    vi.useFakeTimers(); const f = fixture(); f.expireAt(Date.now() + 300001); await f.client.connect();
    await vi.advanceTimersByTimeAsync(2); await f.client.refresh();
    expect(f.calls.filter(c => c === 'config')).toHaveLength(1); expect(f.calls).not.toContain('reconnect');
  });
  it('serializes cancellation behind admission and never reopens a cancelled room', async () => {
    let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; }), f = fixture(delayed);
    await f.client.connect('Player');
    const queue = f.client.queue(makeOnlineSetup('duel', 2, kit));
    await Promise.resolve();
    const leave = f.client.leave(); release(); await Promise.all([queue, leave]);
    expect(f.client.state.room).toBeNull(); expect(f.client.state.queued).toBe(false);
    expect(f.callbacks.room).not.toHaveBeenCalled();
    expect(f.calls.indexOf('leave')).toBeGreaterThan(f.calls.indexOf('queue'));
    await f.client.refresh(); expect(f.client.state.room).toBeNull();
  });
  it('keeps the queue independently of subscribers and expires the simulation lease before host election', async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.client.connect(); await f.client.queue(makeOnlineSetup('duel', 2, kit));
    const unsubscribe = f.client.subscribe(() => {}); unsubscribe();
    expect(f.client.state.queued).toBe(true); expect(f.client.leaseValid()).toBe(true);
    vi.setSystemTime(Date.now() + 10001); expect(f.client.leaseValid()).toBe(false);
    await f.client.refresh(); expect(f.client.leaseValid()).toBe(true);
    await f.client.leave(); expect(f.client.leaseValid()).toBe(false);
  });
  it('fences the simulation immediately when its room client is disposed', async () => {
    const f = fixture(); await f.client.connect(); await f.client.queue(makeOnlineSetup('duel', 2, kit));
    expect(f.client.leaseValid()).toBe(true); f.client.dispose(); expect(f.client.leaseValid()).toBe(false);
  });
});
