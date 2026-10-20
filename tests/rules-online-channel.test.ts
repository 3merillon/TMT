import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomChannel, OnlineRequestError } from '../src/game/online/channel';

class Socket extends EventTarget {
  readyState = 0; bufferedAmount = 0; sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
const channels: RoomChannel[] = [];
afterEach(() => { channels.splice(0).forEach(c => c.close()); vi.useRealTimers(); });
function fixture() {
  const socket = new Socket(), push = vi.fn(), lost = vi.fn(); let url = '', protocols: string[] = [];
  const channel = new RoomChannel('https://game.test', 'AABBCCDDEE', 'private-bearer', push, lost, (u, p) => { url = u; protocols = p; return socket as unknown as WebSocket; });
  channels.push(channel); socket.open();
  return { channel, socket, push, lost, url, protocols };
}
describe('Cloudflare room channel', () => {
  it('keeps authentication out of URLs and correlates RPC replies independently of pushes', async () => {
    const f = fixture(); await f.channel.opened;
    expect(f.url).toBe('wss://game.test/api/online/socket?room=AABBCCDDEE');
    expect(f.protocols).toEqual(['tmt-v1', 'auth.private-bearer']);
    const first = f.channel.request('state'), second = f.channel.request('chat', { text: 'Hello' });
    f.socket.receive({ type: 'state', data: { revision: 5, room: null } });
    f.socket.receive({ type: 'reply', id: 2, data: { ok: true } });
    f.socket.receive({ type: 'reply', id: 1, data: { revision: 4 } });
    expect(await second).toEqual({ ok: true }); expect(await first).toEqual({ revision: 4 }); expect(f.push).toHaveBeenCalledTimes(1);
  });
  it('preserves auth failures and never replays a mutation after an uncertain timeout', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.channel.opened;
    const rejected = f.channel.request('state'); const denied = expect(rejected).rejects.toMatchObject(new OnlineRequestError('Expired', 401));
    f.socket.receive({ type: 'reply', id: 1, error: 'Expired', status: 401 }); await denied;
    const chat = f.channel.request('chat', { text: 'Only once' }), failed = expect(chat).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(8000); await failed;
    expect(f.socket.sent.filter(s => JSON.parse(s).path === 'chat')).toHaveLength(1); expect(f.lost).toHaveBeenCalledTimes(1);
  });
  it('rejects pending operations on disposal without triggering reconnection', async () => {
    const f = fixture(); await f.channel.opened;
    const result = f.channel.request('state'), failed = expect(result).rejects.toThrow('interrupted');
    f.channel.close(); await failed; expect(f.lost).not.toHaveBeenCalled(); expect(f.channel.connected).toBe(false);
  });
});
