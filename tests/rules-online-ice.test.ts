import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iceProvider } from '../server/ice';

const env = { TURN_KEY_ID: 'test/key', TURN_KEY_API_TOKEN: 'test-secret' };
const iceServers = [{ urls: 'turn:relay.test:3478', username: 'player', credential: 'temporary' }];
const start = 1_800_000_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => vi.useRealTimers());

describe('TURN credential issuance', () => {
  it('coalesces concurrent requests across providers and expires credentials three hours after issuance starts', async () => {
    let release!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
    const first = iceProvider(env, request)(), second = iceProvider({ ...env }, request)();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/test%2Fkey/credentials/generate-ice-servers');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: '{"ttl":10800}' });
    vi.setSystemTime(start + 2000); release(Response.json({ iceServers }));
    const config = await first;
    expect(await second).toEqual(config);
    expect(config).toEqual({ iceServers, iceExpiresAt: start + 10_800_000 });
  });

  it('reuses credentials for five minutes without extending their lifetime or the cache window', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ iceServers }));
    const first = await iceProvider(env, request)();
    vi.setSystemTime(start + 299_999);
    expect(await iceProvider({ ...env }, request)()).toEqual(first);
    expect(request).toHaveBeenCalledOnce();
    vi.setSystemTime(start + 300_000);
    expect(await iceProvider(env, request)()).toEqual({ iceServers, iceExpiresAt: start + 300_000 + 10_800_000 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['http', 'shape', 'json', 'network'])('retries after an issuance %s failure instead of caching a rejection or serving stale credentials', async failure => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ iceServers }));
    const get = iceProvider(env, request);
    await get(); vi.setSystemTime(start + 300_000);
    if (failure === 'network') request.mockRejectedValueOnce(new Error('Network unavailable'));
    else request.mockResolvedValueOnce(failure === 'http' ? new Response('', { status: 503 }) : failure === 'shape' ? Response.json({ iceServers: [] }) : new Response('{bad'));
    await expect(get()).rejects.toThrow();
    expect(await get()).toMatchObject({ iceExpiresAt: start + 300_000 + 10_800_000 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('invalidates cached credentials when the TURN key or API token changes', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ iceServers }));
    await iceProvider(env, request)();
    await iceProvider({ ...env, TURN_KEY_ID: 'another-key' }, request)();
    await iceProvider({ TURN_KEY_ID: 'another-key', TURN_KEY_API_TOKEN: 'rotated-secret' }, request)();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][1]?.headers).toMatchObject({ authorization: 'Bearer rotated-secret' });
  });

  it('preserves static ICE and local STUN configuration without issuing credentials', async () => {
    const request = vi.fn<typeof fetch>();
    expect(await iceProvider({ HUB_ICE_SERVERS: JSON.stringify(iceServers) }, request)()).toEqual({ iceServers });
    expect(await iceProvider({}, request)()).toEqual({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    expect(request).not.toHaveBeenCalled();
  });
});
