import { createHash, randomBytes } from 'node:crypto';
import type { DurableObjectState, Request, Response as WorkerResponse } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { Lobby, LobbyError, RECONNECT_TTL, onlineSetup } from '../lobby';
import { internal, roomStub, validCode, validToken, type Env, type Listing, type Member, type Operation, type RoomResult } from './types';
declare const Response: typeof import('@cloudflare/workers-types').Response;

interface Session {
  member: Member; room: string | null;
  pending?: { code: string; fingerprint: string };
  entered?: string;
  reconnecting?: string;
  rotated?: { id: string; replacement: string };
}
type Row = { data: string; expires: number };
/** Serializes discovery/admission only. Active matches talk directly to their own GameRoom. */
export class RoomDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires)');
    sql.exec('CREATE TABLE IF NOT EXISTS listings (code TEXT PRIMARY KEY, data TEXT, revision INTEGER NOT NULL, expires INTEGER NOT NULL, build TEXT, queueable INTEGER NOT NULL, latency REAL)');
    sql.exec('CREATE INDEX IF NOT EXISTS discovery ON listings(build, expires)');
    sql.exec('CREATE INDEX IF NOT EXISTS matchmaking ON listings(build, queueable, expires)');
    sql.exec('CREATE TABLE IF NOT EXISTS rates (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS rate_expiry ON rates(expires)');
  }
  async fetch(request: Request): Promise<WorkerResponse> {
    const body = await request.json() as any;
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (new URL(request.url).pathname === '/publish') { this.publish(body.code, body.result); await this.cleanupLater(); return Response.json({ ok: true }); }
        const result = await this.execute(body);
        await this.cleanupLater();
        return Response.json({ data: result });
      } catch (error) {
        await this.cleanupLater();
        return Response.json({ error: error instanceof LobbyError ? error.message : 'Matchmaking is temporarily unavailable. Please retry.', status: error instanceof LobbyError ? error.status : 503 });
      }
    });
  }
  private get(token: string): Session {
    if (!validToken(token)) throw new LobbyError('Your online session expired. Connect again.', 401);
    const row = this.ctx.storage.sql.exec<Row>('SELECT data, expires FROM sessions WHERE token = ?', token).toArray()[0];
    if (!row || row.expires < Date.now()) throw new LobbyError('Your online session expired. Connect again.', 401);
    return JSON.parse(row.data);
  }
  private put(token: string, session: Session, expires = Date.now() + RECONNECT_TTL): void {
    this.ctx.storage.sql.exec('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET data = excluded.data, expires = excluded.expires', token, JSON.stringify(session), expires);
  }
  private rate(key: string, maximum: number): void {
    const now = Date.now();
    this.ctx.storage.sql.exec('INSERT INTO rates VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rates.expires < ? THEN 1 ELSE rates.count + 1 END, expires = CASE WHEN rates.expires < ? THEN excluded.expires ELSE rates.expires END', key, now + 60_000, now, now);
    const row = this.ctx.storage.sql.exec<{ count: number }>('SELECT count FROM rates WHERE key = ?', key).one();
    if (row.count > maximum) throw new LobbyError('Too many requests. Wait a minute.', 429);
  }
  private listings(build: string, queue = false): Listing[] {
    return this.ctx.storage.sql.exec<{ data: string }>(`SELECT data FROM listings WHERE build = ? AND expires > ? AND data IS NOT NULL ${queue ? 'AND queueable = 1' : ''} ORDER BY latency ASC LIMIT 200`, build, Date.now()).toArray().map(r => JSON.parse(r.data));
  }
  private publish(code: string, result: RoomResult): void {
    if (!validCode(code)) throw new LobbyError('Invalid room.', 400);
    const previous = this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM listings WHERE code = ?', code).toArray()[0];
    if (previous && previous.revision >= result.revision) return;
    const listing = result.listing, visible = listing?.listed && listing.expires > Date.now();
    this.ctx.storage.sql.exec('INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, revision = excluded.revision, expires = excluded.expires, build = excluded.build, queueable = excluded.queueable, latency = excluded.latency',
      code, visible ? JSON.stringify(listing) : null, result.revision, listing?.expires ?? Date.now(), listing?.build ?? '',
      Number(!!visible && listing.mode !== 'coop' && !listing.locked && listing.capacity === 2 && listing.reserved < 2 && listing.phase === 'waiting'), listing?.latency ?? 99999);
    for (const member of result.members) {
      let session: Session; try { session = this.get(member.token); } catch { continue; }
      if (session.room !== code && session.pending?.code !== code) continue;
      session.member = member; session.room = member.room;
      if (member.room && session.pending) { session.entered = session.pending.fingerprint; delete session.pending; }
      this.put(member.token, session, member.seen + RECONNECT_TTL);
    }
  }
  private async room(code: string, op: Operation): Promise<RoomResult> {
    const result = await internal<RoomResult>(roomStub(this.env, code), 'execute', op);
    this.publish(code, result); return result;
  }
  private unwrap(result: RoomResult): any {
    if (result.error) throw new LobbyError(result.error, result.status ?? 503);
    return result.data;
  }
  private async execute(op: Operation): Promise<any> {
    const url = new URL(`/api/online/${op.path}`, 'https://directory'), action = url.pathname.split('/').pop();
    const ip = createHash('sha256').update(op.ip ?? 'local').digest('hex').slice(0, 24);
    this.rate(`http:${ip}`, 300);
    if (action === 'session' && op.method === 'POST') {
      this.rate(`admit:${ip}`, 12);
      const lobby = new Lobby(), token = lobby.admit(op.body);
      this.put(token, { member: lobby.snapshot().members[0], room: null });
      return { token };
    }
    let session = this.get(op.token);
    if (session.rotated) {
      if (action === 'config' && op.method === 'GET') return { inRoom: true };
      if (action === 'reconnect' && op.method === 'POST' && op.body?.reconnectId === session.rotated.id) return { token: session.rotated.replacement };
      throw new LobbyError('This seat has reconnected in another browser. Connect again.', 401);
    }
    if (action === 'config' && session.reconnecting) return { inRoom: true };
    // Complete an admission whose room commit survived a lost directory response/restart.
    if (session.pending) {
      const result = await this.room(session.pending.code, { method: 'GET', path: 'inspect', token: op.token });
      if (result.data?.room) { session.room = session.pending.code; session.entered = session.pending.fingerprint; }
      delete session.pending; this.put(op.token, session);
    }
    if (['create', 'join', 'queue'].includes(action ?? '') && op.method === 'POST') {
      const fingerprint = createHash('sha256').update(JSON.stringify([action, op.body])).digest('hex');
      if (session.room) {
        if (session.entered === fingerprint) return this.unwrap(await this.room(session.room, { method: 'GET', path: 'inspect', token: op.token })).room;
        throw new LobbyError('Leave your current server first.', 409);
      }
      if (action === 'queue') {
        const setup = onlineSetup(op.body?.setup);
        if (setup.online?.kind === 'coop' || setup.tanks.length !== 2) throw new LobbyError('Quick Match needs two players in the selected versus mode.');
      }
      const candidates = action === 'queue' ? this.listings(session.member.build, true).filter(r => r.mode === op.body.setup.online.kind).map(r => r.code) : [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = candidates.shift();
        const code = action === 'join' ? String(op.body?.code ?? '').trim().toUpperCase() : candidate ?? randomBytes(5).toString('hex').toUpperCase();
        if (!validCode(code)) throw new LobbyError('Enter the ten-character invite code.', 400);
        session.pending = { code, fingerprint }; this.put(op.token, session);
        const path = action === 'queue' && !candidate ? 'queue-create' : action;
        const result = await internal<RoomResult>(roomStub(this.env, code), 'enter', { ...op, path, code, member: session.member });
        this.publish(code, result);
        const updated = result.members.find(m => m.token === op.token);
        if (updated) session.member = updated;
        if (result.error) {
          delete session.pending; this.put(op.token, session);
          if (action === 'queue' && candidate && [404, 409].includes(result.status ?? 0)) continue;
          return this.unwrap(result);
        }
        session.room = code; session.entered = fingerprint; delete session.pending; this.put(op.token, session);
        return result.data;
      }
      throw new LobbyError('Servers changed during matchmaking. Try again.', 409);
    }
    if (action === 'rooms' && op.method === 'GET') { this.put(op.token, session); return this.listings(session.member.build).map(publicListing); }
    if (action === 'socket' && op.method === 'GET') return { code: session.room };
    if (!session.room) {
      session.member.seen = Date.now(); this.put(op.token, session);
      if (action === 'config' && op.method === 'GET') return { inRoom: false };
      if (action === 'leave' && op.method === 'POST') return { ok: true };
      if (action === 'state' && op.method === 'GET') return { room: null, queued: false, signals: [], chat: [], rooms: url.searchParams.get('list') === '1' ? this.listings(session.member.build).map(publicListing) : [] };
      throw new LobbyError('You are no longer in this server.', 409);
    }
    if (action === 'reconnect' && op.body?.lostWorld === true) {
      if (!/^[\w-]{16,64}$/.test(op.body?.reconnectId ?? '')) throw new LobbyError('Invalid reconnect request.', 400);
      session.reconnecting = op.body.reconnectId; this.put(op.token, session);
    }
    const code = session.room, result = await this.room(code, op), data = this.unwrap(result);
    if (action === 'reconnect' && data.token) {
      const member = result.members.find(m => m.token === data.token)!;
      this.ctx.storage.transactionSync(() => {
        this.put(data.token, { member, room: code });
        this.put(op.token, { ...session, rotated: { id: op.body.reconnectId, replacement: data.token } });
      });
    } else if (action === 'leave') {
      session.room = null; delete session.entered;
      session.member = result.members.find(m => m.token === op.token) ?? { ...session.member, room: null, seat: -1, queued: false, checkpoint: null, signals: [] };
      this.put(op.token, session);
    }
    if (action === 'state') data.rooms = url.searchParams.get('list') === '1' ? this.listings(session.member.build).map(publicListing) : [];
    return data;
  }
  private async cleanupLater(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + RECONNECT_TTL);
  }
  async alarm(): Promise<void> {
    const now = Date.now(), sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM sessions WHERE expires < ?', now);
    sql.exec('DELETE FROM rates WHERE expires < ?', now);
    // Keep revision tombstones briefly so delayed publication cannot resurrect a departed room.
    sql.exec('DELETE FROM listings WHERE expires < ?', now - RECONNECT_TTL);
    const next = sql.exec<{ next: number | null }>('SELECT MIN(expiry) AS next FROM (SELECT MIN(expires) AS expiry FROM sessions UNION ALL SELECT MIN(expires) FROM rates UNION ALL SELECT MIN(expires) + ? FROM listings)', RECONNECT_TTL).one().next;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(now + 1000, next + 1));
  }
}
function publicListing({ code, name, locked, players, reserved, capacity, phase, mode, created, latency }: Listing) {
  return { code, name, locked, players, reserved, capacity, phase, mode, created, latency };
}
