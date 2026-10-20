import type { DurableObjectState, Request, Response as WorkerResponse, WebSocket as CloudSocket } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { Lobby, LobbyError, MEMBER_TTL, RECONNECT_TTL, type StoredLobby } from '../lobby';
import { lobbyAction } from '../actions';
import { directory, internal, validToken, type Env, type Member, type Operation, type RoomRecord, type RoomResult } from './types';

declare const WebSocketPair: { new(): { 0: CloudSocket; 1: CloudSocket } };
declare const Response: typeof import('@cloudflare/workers-types').Response;

interface Attachment { token: string; window: number; requests: number }
/** One durable serialization boundary per match. No world simulation or recurring timers live here. */
export class GameRoom extends DurableObject<Env> {
  private cleared = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)');
  }
  private load(): RoomRecord {
    if (this.cleared) { this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)'); this.cleared = false; }
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM room WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.data) : { lobby: { version: 1, members: [], rooms: [] }, revision: 0, published: 0 };
  }
  private save(record: RoomRecord): void {
    this.ctx.storage.sql.exec('INSERT INTO room VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', JSON.stringify(record));
  }
  async fetch(request: Request): Promise<WorkerResponse> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.connectSocket(request);
    const url = new URL(request.url), body = await request.json() as any;
    return this.ctx.blockConcurrencyWhile(async () => {
      const result = this.execute(url.pathname === '/enter' ? { ...body, enter: true } : body);
      await this.schedule(result.members);
      this.broadcast();
      return Response.json(result);
    });
  }
  private execute(op: Operation & { enter?: boolean; member?: Member; code?: string }): RoomResult {
    const record = this.load();
    let lobby = Lobby.restore(record.lobby), data: any, failure: unknown;
    lobby.sweep();
    try {
      if (!validToken(op.token)) throw new LobbyError('Invalid session.', 401);
      const reconnecting = op.path === 'reconnect' && op.body?.lostWorld === true;
      if (reconnecting && !/^[\w-]{16,64}$/.test(op.body?.reconnectId ?? '')) throw new LobbyError('Invalid reconnect request. Reload the game.', 400);
      record.reconnects = record.reconnects?.filter(r => r.expires > Date.now());
      const receipt = reconnecting && record.reconnects?.find(r => r.token === op.token && r.id === op.body.reconnectId);
      if (receipt) data = { token: receipt.replacement };
      else if (op.enter) {
        if (!op.member || op.member.token !== op.token) throw new LobbyError('Invalid admission.', 401);
        const existing = lobby.snapshot().members.find(m => m.token === op.token);
        if (existing?.room) data = lobby.poll(op.token).room; // retry after an uncertain response
        else {
          const saved = lobby.snapshot();
          saved.members = saved.members.filter(m => m.token !== op.token); saved.members.push(op.member);
          lobby = Lobby.restore(saved);
          const creating = op.path === 'create' || op.path === 'queue-create';
          if (creating && saved.rooms.length) throw new LobbyError('Room reservation is already occupied.', 409);
          if (op.path === 'create') data = lobby.create(op.token, op.body, op.code);
          else if (op.path === 'queue-create') data = lobby.queue(op.token, op.body.setup, op.code);
          else if (op.path === 'queue') {
            const room = saved.rooms[0];
            if (!room || !room.listed || room.password || room.capacity !== 2 || room.members.length >= 2 || room.phase !== 'waiting' || room.setup.online?.kind === 'coop' || room.setup.online?.kind !== op.body?.setup?.online?.kind) throw new LobbyError('Queue room is no longer available for that mode.', 409);
            data = lobby.queue(op.token, op.body.setup, undefined, true);
          } else data = lobby.join(op.token, op.body);
        }
      } else if (op.path === 'inspect') data = lobby.read(op.token);
      else {
        data = lobbyAction(lobby, op.method, new URL(`/api/online/${op.path}`, 'https://room'), op.token, op.body);
        if (reconnecting && data?.token) (record.reconnects ??= []).push({ token: op.token, id: op.body.reconnectId, replacement: data.token, expires: Date.now() + RECONNECT_TTL });
      }
    } catch (error) { failure = error; }
    const saved = lobby.snapshot();
    if (saved.rooms.length > 1) throw new Error('A Durable Object cannot own multiple rooms.');
    // Failed join attempts belong to the session, not to every room the caller tried.
    const members = saved.members;
    if (op.enter && failure) saved.members = members.filter(m => m.room);
    record.lobby = saved; record.revision++;
    this.save(record);
    const hosted = saved.rooms[0], host = hosted && members.find(m => m.token === hosted.host);
    const listing = hosted && host ? { ...lobby.read(host.token).room!, listed: hosted.listed, build: host.build,
      revision: record.revision, expires: host.seen + MEMBER_TTL } : null;
    // Public discovery receives summaries only. Never copy setup, chat, passwords or tokens into it.
    const safeListing = listing ? { code: listing.code, name: listing.name, locked: listing.locked, players: listing.players,
      reserved: listing.reserved, capacity: listing.capacity, phase: listing.phase, mode: listing.mode, created: listing.created,
      latency: listing.latency, listed: listing.listed, build: listing.build, revision: listing.revision, expires: listing.expires } : null;
    if (data && typeof data === 'object' && 'signals' in data) data.revision = record.revision;
    return { data, ...(failure ? { error: failure instanceof LobbyError ? failure.message : 'Room temporarily unavailable.', status: failure instanceof LobbyError ? failure.status : 503 } : {}),
      listing: safeListing, revision: record.revision, members };
  }
  private async connectSocket(request: Request): Promise<WorkerResponse> {
    const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(p => p.trim()) ?? [];
    const token = protocols.find(p => p.startsWith('auth.'))?.slice(5) ?? '';
    return this.ctx.blockConcurrencyWhile(async () => {
      const lobby = Lobby.restore(this.load().lobby); lobby.sweep();
      if (!protocols.includes('tmt-v1') || !validToken(token)) return new Response('Unauthorized', { status: 401 });
      try { if (!lobby.read(token).room) return new Response('Room closed', { status: 409 }); }
      catch { return new Response('Session expired', { status: 401 }); }
      // A duplicate tab cannot maintain a second control connection for the same bearer.
      for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket)?.token === token) socket.close(4001, 'Connection replaced');
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ token, window: Date.now(), requests: 0 } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'tmt-v1' } });
    });
  }
  private attachment(socket: CloudSocket): Attachment | undefined { return socket.deserializeAttachment() as Attachment | undefined; }
  async webSocketMessage(socket: CloudSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(socket);
    if (!attachment || typeof message !== 'string' || new TextEncoder().encode(message).byteLength > 64_000) { socket.close(1009, 'Invalid message'); return; }
    if (Date.now() - attachment.window > 10_000) { attachment.window = Date.now(); attachment.requests = 0; }
    if (++attachment.requests > 100) { socket.close(1008, 'Too many requests'); return; }
    socket.serializeAttachment(attachment);
    let input: { id: number; path: string; body?: unknown };
    try { input = JSON.parse(message); } catch { socket.close(1008, 'Expected JSON'); return; }
    if (!Number.isSafeInteger(input?.id) || typeof input.path !== 'string' || input.path.length > 512 || !/^(state(?:\?.*)?|signal|playing|complete|restart|chat|checkpoint|handoff)$/.test(input.path)) {
      socket.close(1008, 'Invalid operation'); return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const before = this.load(), prior = before.lobby.rooms[0];
      const result = this.execute({ method: input.body === undefined ? 'GET' : 'POST', path: input.path, token: attachment.token, body: input.body });
      await this.schedule(result.members);
      socket.send(JSON.stringify({ type: 'reply', id: input.id, data: result.data, error: result.error, status: result.status }));
      // Heartbeats renew only the caller. Everything changing the visible room is pushed to all members.
      if (!input.path.startsWith('state') || prior?.epoch !== result.data?.room?.epoch || !!prior?.paused !== !!result.data?.room?.paused) this.broadcast();
      const after = this.load(), code = after.lobby.rooms[0]?.code ?? prior?.code;
      if (code && (Date.now() - before.published >= 10_000 || !input.path.startsWith('state'))) {
        after.published = Date.now(); this.save(after);
        this.ctx.waitUntil(internal(directory(this.env), 'publish', { code, result }).catch(() => { /* next heartbeat retries */ }));
      }
    });
  }
  private broadcast(): void {
    const record = this.load(), lobby = Lobby.restore(record.lobby);
    for (const socket of this.ctx.getWebSockets()) {
      const token = this.attachment(socket)?.token;
      try { socket.send(JSON.stringify({ type: 'state', data: { ...lobby.read(token ?? ''), rooms: [], revision: record.revision } })); }
      catch { socket.close(4001, 'Session ended'); }
    }
  }
  private async schedule(members: Member[]): Promise<void> {
    const now = Date.now(), next = members.length ? Math.min(...members.map(m => m.seen + (now - m.seen <= MEMBER_TTL ? MEMBER_TTL : RECONNECT_TTL) + 1)) : now + RECONNECT_TTL;
    const alarm = await this.ctx.storage.getAlarm();
    if (Number.isFinite(next) && (alarm === null || next < alarm)) await this.ctx.storage.setAlarm(Math.max(now + 1, next));
  }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const record = this.load(), code = record.lobby.rooms[0]?.code, lobby = Lobby.restore(record.lobby);
      lobby.sweep(); record.lobby = lobby.snapshot(); record.revision++; this.save(record);
      this.broadcast();
      if (code) {
        const token = record.lobby.members[0]?.token;
        const result = token ? this.execute({ method: 'GET', path: 'inspect', token }) : { members: [], listing: null, revision: record.revision };
        this.ctx.waitUntil(internal(directory(this.env), 'publish', { code, result }).catch(() => {}));
      }
      if (!record.lobby.members.length) { for (const socket of this.ctx.getWebSockets()) socket.close(4001, 'Room expired'); await this.ctx.storage.deleteAll(); this.cleared = true; }
      else await this.schedule(record.lobby.members);
    });
  }
  // The configured runtime automatically replies to close frames, including a close without a status.
  webSocketClose(): void {}
  webSocketError(socket: CloudSocket): void { socket.close(1011, 'Connection interrupted'); }
}
