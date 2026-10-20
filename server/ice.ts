import { LobbyError } from './lobby';

export interface IceConfig { iceServers: RTCIceServer[]; iceExpiresAt?: number }
const TURN_TTL = 3 * 60 * 60;
const TURN_CACHE_MS = 5 * 60_000;
// One bounded cache per Worker isolate, including across newly created providers.
let turnProvider: { key: string; secret: string; request: typeof fetch; get: () => Promise<IceConfig> } | undefined;
export function relayConfigured(env: Record<string, string | undefined>): boolean {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) return true;
  try {
    const servers = JSON.parse(env.HUB_ICE_SERVERS ?? '[]') as RTCIceServer[];
    return Array.isArray(servers) && servers.some(s => s.username && s.credential && [s.urls].flat().some(url => /^turns?:/.test(url)));
  } catch { return false; }
}
/** Long-term relay keys stay inside the Worker. Only expiring client credentials leave it. */
export function iceProvider(env: Record<string, string | undefined>, request: typeof fetch = fetch): () => Promise<IceConfig> {
  const key = env.TURN_KEY_ID, secret = env.TURN_KEY_API_TOKEN;
  if (key && secret) {
    if (turnProvider?.key === key && turnProvider.secret === secret && turnProvider.request === request) return turnProvider.get;
    let cached: IceConfig | undefined, cachedUntil = 0, pending: Promise<IceConfig> | undefined;
    const issue = async (): Promise<IceConfig> => {
      const issuedAt = Date.now();
      const response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL }), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new LobbyError('The connection relay is temporarily unavailable. Please retry.', 503);
      const value = await response.json() as IceConfig;
      if (!Array.isArray(value.iceServers) || !value.iceServers.length) throw new LobbyError('Invalid connection relay configuration.', 503);
      cached = { iceServers: value.iceServers, iceExpiresAt: issuedAt + TURN_TTL * 1000 };
      cachedUntil = issuedAt + TURN_CACHE_MS;
      return cached;
    };
    const get = (): Promise<IceConfig> => {
      if (cached && Date.now() < cachedUntil) return Promise.resolve(cached);
      // Share in-flight issuance too; failures must allow a later retry.
      return pending ??= issue().finally(() => { pending = undefined; });
    };
    turnProvider = { key, secret, request, get };
    return get;
  }
  if (env.HUB_ICE_SERVERS) {
    const iceServers = JSON.parse(env.HUB_ICE_SERVERS) as RTCIceServer[];
    if (!Array.isArray(iceServers)) throw new Error('HUB_ICE_SERVERS must be a JSON array.');
    return async () => ({ iceServers });
  }
  return async () => ({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
}
