import { LobbyError } from '../lobby';
import { iceProvider, relayConfigured } from '../ice';
import { directory, internal, roomStub, validCode, type Env } from './types';
export { GameRoom } from './room';
export { RoomDirectory } from './directory';

/** The same deployment serves static game assets and managed multiplayer. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/online/')) {
      if (url.pathname === '/play') { url.pathname = '/'; return Response.redirect(url.toString(), 302); }
      return env.ASSETS.fetch(request as any) as unknown as Promise<Response>;
    }
    const headers = new Headers({ 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin && !env.HUB_ORIGINS?.split(',').map(v => v.trim()).includes(origin)) throw new LobbyError('Origin is not allowed.', 403);
      if (origin) { headers.set('access-control-allow-origin', origin); headers.set('vary', 'Origin'); }
      if (request.method === 'OPTIONS') {
        headers.set('access-control-allow-headers', 'Authorization, Content-Type'); headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
        return new Response(null, { status: 204, headers });
      }
      if (!/^\/api\/online\/[a-z]+$/.test(url.pathname)) throw new LobbyError('Not found.', 404);
      const action = url.pathname.split('/').pop()!, relayEnv = { TURN_KEY_ID: env.TURN_KEY_ID, TURN_KEY_API_TOKEN: env.TURN_KEY_API_TOKEN, HUB_ICE_SERVERS: env.HUB_ICE_SERVERS };
      const relay = relayConfigured(relayEnv), ready = relay || env.ALLOW_DIRECT_ONLY === 'true';
      if (action === 'health' && request.method === 'GET') return Response.json({ ok: ready, deployment: 'cloudflare', relay,
        ...(!ready ? { error: 'Add TURN_KEY_ID and TURN_KEY_API_TOKEN as Worker secrets to enable cross-network multiplayer.' } : {}) }, { status: ready ? 200 : 503, headers });
      if (!ready) throw new LobbyError('Online Play needs TURN_KEY_ID and TURN_KEY_API_TOKEN in this Cloudflare Worker. See the multiplayer setup guide.', 503);
      if (action === 'socket' && request.method === 'GET') {
        const code = url.searchParams.get('room');
        if (!validCode(code) || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new LobbyError('Expected a room connection.', 400);
        const token = request.headers.get('sec-websocket-protocol')?.split(',').map(v => v.trim()).find(v => v.startsWith('auth.'))?.slice(5) ?? '';
        const admission = await internal<{ data?: { code: string }; error?: string; status?: number }>(directory(env), 'execute', {
          method: 'GET', path: 'socket', token, ip: request.headers.get('cf-connecting-ip') ?? 'local',
        });
        if (admission.error) throw new LobbyError(admission.error, admission.status ?? 401);
        if (admission.data?.code !== code) throw new LobbyError('You are not a member of this room.', 403);
        return roomStub(env, code).fetch(request as any) as unknown as Promise<Response>;
      }
      if (!['GET', 'POST'].includes(request.method)) throw new LobbyError('Method not allowed.', 405);
      const body = request.method === 'POST' ? await readBody(request) : undefined;
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const result = await internal<{ data?: any; error?: string; status?: number }>(directory(env), 'execute', {
        method: request.method, path: `${action}${url.search}`, token, body, ip: request.headers.get('cf-connecting-ip') ?? 'local',
      });
      if (result.error) throw new LobbyError(result.error, result.status ?? 503);
      if (action === 'session' || action === 'config') result.data = { ...result.data, ...await iceProvider(relayEnv)(), transport: 'websocket' };
      return Response.json(result.data, { headers });
    } catch (error) {
      return Response.json({ error: error instanceof LobbyError ? error.message : 'Matchmaking is temporarily unavailable. Please retry.' }, { status: error instanceof LobbyError ? error.status : 503, headers });
    }
  },
};
async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new LobbyError('Expected JSON.', 415);
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  if (reader) for (;;) {
    const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
    if (bytes > 64_000) { await reader.cancel(); throw new LobbyError('Request too large.', 413); }
    chunks.push(chunk.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LobbyError('Invalid JSON.', 400); }
}
