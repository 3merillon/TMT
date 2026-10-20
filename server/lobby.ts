/** Discovery, authenticated membership, chat and authority leases. Never simulates the game. */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { validateMatchSetup } from '../src/game/rules/setup';
import { validateKitLoadout, assembleKit } from '../src/game/kit';
import { ONLINE_PROTOCOL, type ChatMessage, type CreateRequest, type JoinRequest, type LobbyState, type PlayerIdentity, type Room, type RoomSummary, type Signal } from '../src/game/online/protocol';

export class LobbyError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
interface Member {
  token: string; name: string; build: string; seen: number; room: string | null; seat: number; generation: number; queued: boolean; latency: number | null;
  signals: LobbyState['signals']; serial: number; attempts: number[]; chats: number[]; checkpoint: string | null;
}
interface HostedRoom {
  code: string; name: string; listed: boolean; salt: Buffer; password: Buffer | null; capacity: 2 | 3;
  members: Member[]; host: Member; phase: RoomSummary['phase']; created: number; setup: Room['setup'];
  epoch: number; checkpoint: string | null; paused: boolean; recovering: boolean; issued: Set<string>; chat: ChatMessage[]; chatId: number;
  reconnectUntil?: number; ended?: Room['ended'];
}
/** Private storage format. Tokens and password hashes must never be returned to browsers. */
export interface StoredLobby {
  version: 1;
  members: Member[];
  rooms: Array<Omit<HostedRoom, 'members' | 'host' | 'salt' | 'password' | 'issued'> & {
    members: string[]; host: string; salt: string; password: string | null; issued: string[];
  }>;
}
export const MEMBER_TTL = 15_000, RECONNECT_TTL = 180_000;
export class Lobby {
  private members = new Map<string, Member>();
  private rooms = new Map<string, HostedRoom>();
  constructor(private readonly now = Date.now, private readonly maximum = 1000) {}
  snapshot(): StoredLobby {
    return structuredClone({ version: 1, members: [...this.members.values()], rooms: [...this.rooms.values()].map(room => ({
      ...room, members: room.members.map(m => m.token), host: room.host.token, salt: room.salt.toString('base64'),
      password: room.password?.toString('base64') ?? null, issued: [...room.issued],
    })) });
  }
  static restore(saved: StoredLobby, now = Date.now): Lobby {
    if (saved?.version !== 1 || !Array.isArray(saved.members) || !Array.isArray(saved.rooms)) throw new Error('Unsupported lobby storage format.');
    const lobby = new Lobby(now);
    for (const member of structuredClone(saved.members)) {
      if (lobby.members.has(member.token)) throw new Error('Duplicate stored member.');
      lobby.members.set(member.token, member);
    }
    for (const room of structuredClone(saved.rooms)) {
      const members = room.members.map(token => lobby.members.get(token)), host = lobby.members.get(room.host);
      if (!host || members.some(m => !m || m.room !== room.code) || !members.includes(host) || lobby.rooms.has(room.code)) throw new Error('Invalid stored membership.');
      lobby.rooms.set(room.code, { ...room, members: members as Member[], host, salt: Buffer.from(room.salt, 'base64'),
        password: room.password ? Buffer.from(room.password, 'base64') : null, issued: new Set(room.issued) });
    }
    return lobby;
  }
  admit(input: PlayerIdentity): string {
    this.sweep();
    if (input?.protocol !== ONLINE_PROTOCOL) throw new LobbyError('This game version is incompatible. Reload both players.', 409);
    if (typeof input.build !== 'string' || !/^[\w.-]{1,80}$/.test(input.build)) throw new LobbyError('Invalid game build.');
    if (this.members.size >= this.maximum) throw new LobbyError('Matchmaking is full. Try again shortly.', 503);
    const token = randomBytes(32).toString('base64url');
    this.members.set(token, { token, name: label(input.name, 'Player'), build: input.build, seen: this.now(), room: null, seat: -1, generation: 0,
      queued: false, latency: null, signals: [], serial: 0, attempts: [], chats: [], checkpoint: null }); return token;
  }
  private member(token: string): Member {
    this.sweep(); const member = this.members.get(token);
    if (!member) throw new LobbyError('Your online session expired. Connect again.', 401);
    if (this.now() - member.seen > MEMBER_TTL) { member.generation++; member.signals = []; }
    member.seen = this.now();
    const room = member.room && this.rooms.get(member.room);
    // No successor was elected: the original authority can renew its lease and continue.
    if (room && room.host === member && !room.recovering) room.paused = false;
    if (room) this.updateDuelWait(room);
    return member;
  }
  private online(member: Member): boolean { return this.now() - member.seen <= MEMBER_TTL; }
  private idle(member: Member): void { if (member.room) throw new LobbyError('Leave your current server first.', 409); }
  private summary(room: HostedRoom): RoomSummary {
    const ownerReserved = room.setup.online?.kind === 'coop' && !room.members.some(m => m.seat === (room.setup.online?.campaignOwnerSeat ?? 0));
    return { code: room.code, name: room.name, locked: !!room.password, players: room.members.filter(m => this.online(m)).length,
      reserved: room.members.length + Number(ownerReserved), capacity: room.capacity, phase: room.phase, mode: room.setup.online?.kind ?? 'duel', created: room.created, latency: room.host.latency };
  }
  private view(room: HostedRoom, member: Member): Room {
    return { ...this.summary(room), host: room.host === member, seat: member.seat, hostSeat: room.host.seat, epoch: room.epoch,
      setup: structuredClone(room.setup), peers: room.members.map(m => ({ seat: m.seat, name: m.name, connected: this.online(m), generation: m.generation })),
      checkpoint: room.checkpoint, ownCheckpoint: member.checkpoint, paused: room.paused, reconnectUntil: room.reconnectUntil, ended: room.ended,
      canTransfer: !room.reconnectUntil && room.members.some(m => m !== room.host && this.online(m) && !!m.checkpoint) };
  }
  poll(token: string, after = 0, latency = 0): LobbyState {
    const member = this.member(token);
    if (Number.isFinite(latency) && latency > 0 && latency < 10_000) member.latency = latency;
    if (!Number.isSafeInteger(after) || after < 0 || after > member.serial) throw new LobbyError('Invalid signal acknowledgement.');
    member.signals = member.signals.filter(s => s.id > after);
    return this.read(token);
  }
  /** Push notifications must never renew another player's authority lease. */
  read(token: string): LobbyState {
    const member = this.members.get(token);
    if (!member) throw new LobbyError('Your online session expired. Connect again.', 401);
    const room = member.room ? this.rooms.get(member.room) : undefined;
    return { room: room ? this.view(room, member) : null, queued: member.queued,
      rooms: [...this.rooms.values()].filter(r => r.listed && this.online(r.host) && r.host.build === member.build).map(r => this.summary(r)).slice(0, 200),
      signals: structuredClone(member.signals), chat: room ? structuredClone(room.chat) : [] };
  }
  create(token: string, input: CreateRequest, reservedCode?: string): Room {
    const member = this.member(token); this.idle(member);
    const setup = onlineSetup(input?.setup), password = passwordText(input.password);
    if (typeof input.listed !== 'boolean' || ![2, 3].includes(input.capacity) || setup.tanks.length !== input.capacity) throw new LobbyError('Choose two or three player slots.');
    const salt = randomBytes(16);
    let code: string; do { code = randomBytes(5).toString('hex').toUpperCase(); } while (this.rooms.has(code));
    if (reservedCode) {
      if (!/^[A-F0-9]{10}$/.test(reservedCode) || this.rooms.has(reservedCode)) throw new LobbyError('Invalid room reservation.', 409);
      code = reservedCode;
    }
    setup.tanks[0].name = member.name;
    if (setup.online?.kind === 'coop') { setup.online.campaignOwnerSeat = 0; setup.online.runId = randomBytes(16).toString('hex'); }
    const room: HostedRoom = { code, name: label(input.name, `${member.name}'s game`), listed: input.listed, capacity: input.capacity, salt,
      password: password ? scryptSync(password, salt, 32) : null, members: [member], host: member, phase: 'waiting', created: this.now(), setup,
      epoch: 1, checkpoint: null, paused: false, recovering: false, issued: new Set(), chat: [], chatId: 0 };
    member.room = code; member.seat = 0; member.checkpoint = null; member.queued = false; this.rooms.set(code, room);
    return this.view(room, member);
  }
  join(token: string, input: JoinRequest): Room {
    const member = this.member(token); this.idle(member);
    member.attempts = member.attempts.filter(t => this.now() - t < 60_000);
    if (member.attempts.length >= 8) throw new LobbyError('Too many join attempts. Wait a minute.', 429);
    member.attempts.push(this.now());
    const room = this.rooms.get(typeof input?.code === 'string' ? input.code.trim().toUpperCase() : '');
    if (!room) throw new LobbyError('Server not found. Check the code or refresh the list.', 404);
    if (!this.online(room.host)) throw new LobbyError('That server is no longer available. Refresh the list.', 409);
    if (room.host.build !== member.build) throw new LobbyError('The host uses a different game build. Reload both games.', 409);
    if (room.members.length >= room.capacity || (room.phase !== 'waiting' && !(room.phase === 'playing' && room.setup.online?.kind === 'coop'))) throw new LobbyError('That server is full or already playing.', 409);
    const password = passwordText(input.password);
    if (room.password && !timingSafeEqual(room.password, scryptSync(password, room.salt, 32))) throw new LobbyError('Incorrect password.', 403);
    const kit = validateKitLoadout(input.kit); assembleKit(kit);
    const seat = Array.from({ length: room.capacity }, (_, i) => i).find(i => !room.members.some(m => m.seat === i)
      && !(room.setup.online?.kind === 'coop' && i === room.setup.online.campaignOwnerSeat));
    if (seat === undefined) throw new LobbyError('No helper slot is available. The campaign owner’s seat stays reserved.', 409);
    // A late join takes its already-simulated reserve tank; loadout changes are only admitted in the lobby.
    if (room.phase === 'waiting') room.setup.tanks[seat].loadout = { ...kit };
    room.setup.tanks[seat].name = member.name;
    member.room = room.code; member.seat = seat; member.checkpoint = null; member.queued = false; room.members.push(member);
    if (room.host.queued) { room.host.queued = false; room.phase = 'playing'; }
    return this.view(room, member);
  }
  queue(token: string, setup: Room['setup'], reservedCode?: string, joinOnly = false): Room {
    const member = this.member(token); this.idle(member); setup = onlineSetup(setup);
    if (setup.online?.kind === 'coop' || setup.tanks.length !== 2) throw new LobbyError('Quick Match needs two players in the selected versus mode.');
    const available = [...this.rooms.values()].sort((a, b) => (a.host.latency ?? Infinity) - (b.host.latency ?? Infinity) || a.created - b.created).find(r => r.listed && !r.password && r.capacity === 2 && r.members.length < r.capacity && r.phase === 'waiting'
      && r.setup.online?.kind === setup.online?.kind && r.host.build === member.build && this.online(r.host));
    if (available) { const result = this.join(token, { code: available.code, password: '', kit: setup.tanks[0].loadout });
      const room = this.rooms.get(result.code)!; if (room.members.length === room.capacity) room.phase = 'playing'; return this.view(room, member); }
    if (joinOnly) throw new LobbyError('That queue room is no longer available.', 409);
    this.create(token, { name: 'Quick Match', password: '', listed: true, capacity: 2, setup }, reservedCode); member.queued = true;
    return this.view(this.rooms.get(member.room!)!, member);
  }
  private inRoom(token: string): [Member, HostedRoom] {
    const member = this.member(token), room = member.room && this.rooms.get(member.room);
    if (!room) throw new LobbyError('You are no longer in this server.', 409); return [member, room];
  }
  signal(token: string, input: { to: number; generation: number; toGeneration: number; epoch: number; value: Signal }): void {
    const [member, room] = this.inRoom(token);
    if (input?.epoch !== room.epoch) throw new LobbyError('Host changed. Reconnect to the current host.', 409);
    const peer = room.members.find(m => m.seat === input.to && m !== member);
    if (!peer || (member !== room.host && peer !== room.host)) throw new LobbyError('Invalid peer.', 403);
    if (input.generation !== member.generation || input.toGeneration !== peer.generation) return; // cancelled negotiation
    if (!validSignal(input.value)) throw new LobbyError('Invalid connection signal.');
    if (peer.signals.length >= 256) throw new LobbyError('Connection signaling overflow.', 429);
    if (JSON.stringify(peer.signals).length + JSON.stringify(input.value).length > 128_000) throw new LobbyError('Connection signaling overflow.', 429);
    peer.signals.push({ id: ++peer.serial, from: member.seat, generation: member.generation, toGeneration: peer.generation, epoch: room.epoch, value: structuredClone(input.value) });
  }
  playing(token: string): void {
    const [member, room] = this.inRoom(token);
    if (member !== room.host) throw new LobbyError('Only the host can start.', 403);
    if (room.phase !== 'waiting') throw new LobbyError('This match already started.', 409);
    if (room.setup.online?.kind !== 'coop' && room.members.filter(m => this.online(m)).length < 2) throw new LobbyError('Wait for another player.');
    if (room.setup.online?.kind !== 'coop' && room.members.filter(m => this.online(m)).length !== room.capacity) throw new LobbyError('Wait for every versus slot to fill.');
    room.phase = 'playing';
  }
  complete(token: string, epoch: number): void {
    const [member, room] = this.inRoom(token);
    if (member !== room.host || epoch !== room.epoch) throw new LobbyError('Only the current host can finish the match.', 403);
    room.phase = 'finished'; room.paused = false; room.recovering = false; room.reconnectUntil = undefined;
  }
  restart(token: string, input: Room['setup']): void {
    const [member, room] = this.inRoom(token);
    if (member !== room.host || room.phase !== 'finished') throw new LobbyError('The host can start another round after this match finishes.', 403);
    const setup = onlineSetup(input);
    if (setup.tanks.length !== room.capacity || setup.online?.kind !== room.setup.online?.kind) throw new LobbyError('Keep the same mode and player slots for this party.');
    if (setup.online?.kind === 'coop') { setup.online.campaignOwnerSeat = room.setup.online!.campaignOwnerSeat ?? 0; setup.online.runId = randomBytes(16).toString('hex'); }
    for (const peer of room.members) { setup.tanks[peer.seat].name = peer.name; setup.tanks[peer.seat].loadout = structuredClone(room.setup.tanks[peer.seat].loadout); }
    room.setup = setup; room.phase = 'waiting'; room.epoch++; room.checkpoint = null; room.paused = false; room.recovering = false; room.issued.clear();
    room.ended = undefined; room.reconnectUntil = undefined;
    for (const peer of room.members) { peer.checkpoint = null; peer.signals = []; peer.generation++; }
  }
  chat(token: string, text: unknown): void {
    const [member, room] = this.inRoom(token);
    if (typeof text !== 'string' || !text.trim() || text.length > 500 || /[\x00-\x08\x0b-\x1f]/.test(text)) throw new LobbyError('Messages must contain 1–500 readable characters.');
    member.chats = member.chats.filter(t => this.now() - t < 10_000);
    if (member.chats.length >= 5) throw new LobbyError('Please wait before sending more messages.', 429);
    member.chats.push(this.now()); room.chat.push({ id: ++room.chatId, seat: member.seat, name: member.name, text: text.trim(), at: this.now() });
    if (room.chat.length > 100) room.chat.shift();
  }
  checkpoint(token: string, input: { id: string; epoch: number; resume?: boolean }): void {
    const [member, room] = this.inRoom(token);
    if (input?.epoch !== room.epoch || !/^[0-9]+:[a-f0-9]{16}$/.test(input.id)) throw new LobbyError('Invalid recovery checkpoint.');
    if (input.resume && (member !== room.host || input.id !== room.checkpoint)) throw new LobbyError('Only the elected host can resume the agreed checkpoint.', 403);
    if (member !== room.host && !room.issued.has(input.id)) throw new LobbyError('The host has not published that checkpoint.', 409);
    if (member === room.host) {
      room.issued.add(input.id);
      while (room.issued.size > 32) room.issued.delete(room.issued.values().next().value!);
    }
    member.checkpoint = input.id;
    if (input.resume) { room.paused = false; room.recovering = false; }
    // A refreshed host has lost its in-memory world. A later recovery acknowledgment can rescue the paused room.
    else if (member !== room.host && room.recovering && !room.host.checkpoint) this.elect(room, room.host);
  }
  reconnect(token: string, lostWorld = false): string | null {
    const [member, room] = this.inRoom(token); member.generation++; member.signals = [];
    if (!lostWorld) return null; // transport renegotiation retains the existing world
    // A duplicated tab can inherit sessionStorage. Rotate the bearer so only this browser instance owns the seat.
    this.members.delete(token); member.token = randomBytes(32).toString('base64url'); this.members.set(member.token, member);
    member.checkpoint = null;
    if (member === room.host && room.phase === 'playing' && !this.elect(room, member)) {
      room.checkpoint = null; room.paused = true; room.recovering = true;
    }
    return member.token;
  }
  handoff(token: string): void {
    const [member, room] = this.inRoom(token);
    if (member !== room.host) throw new LobbyError('Only the host can transfer the game.', 403);
    if (!this.elect(room, member)) throw new LobbyError('No connected player has a verified recovery checkpoint yet.');
  }
  leave(token: string): void { this.removeFromRoom(this.member(token)); }
  private elect(room: HostedRoom, excluding: Member): boolean {
    // A lone 1v1 survivor waits for reconnection; rebuilding an uncontested world serves no purpose.
    if (room.reconnectUntil) return false;
    const candidate = room.members.filter(m => m !== excluding && this.online(m) && (room.phase !== 'playing' || m.checkpoint))
      .sort((a, b) => Number(b.checkpoint?.split(':')[0] ?? 0) - Number(a.checkpoint?.split(':')[0] ?? 0) || a.seat - b.seat)[0];
    if (!candidate) { room.paused = room.phase === 'playing'; return false; }
    room.host = candidate; room.epoch++; room.checkpoint = room.phase === 'playing' ? candidate.checkpoint : null; room.paused = room.phase === 'playing';
    room.recovering = room.paused;
    for (const member of room.members) { member.signals = []; member.generation++; member.queued = false; }
    return true;
  }
  private updateDuelWait(room: HostedRoom): void {
    if (room.phase !== 'playing' || room.setup.online?.kind === 'coop') return;
    const missing = room.members.filter(m => !this.online(m));
    room.reconnectUntil = missing.length && room.members.length - missing.length <= 1 ? Math.min(...missing.map(m => m.seen + RECONNECT_TTL)) : undefined;
    if (room.reconnectUntil) room.paused = true;
    else if (!room.recovering) room.paused = false;
  }
  private removeFromRoom(member: Member, reason: NonNullable<Room['ended']>['reason'] = 'opponent-left'): void {
    const room = member.room && this.rooms.get(member.room);
    if (room) {
      room.members = room.members.filter(m => m !== member);
      if (room.phase === 'playing' && room.setup.online?.kind !== 'coop' && room.members.length === 1) {
        room.phase = 'finished'; room.host = room.members[0]; room.epoch++;
        room.ended = { reason, winner: room.host.seat }; room.reconnectUntil = undefined;
        room.paused = room.recovering = false; room.checkpoint = null; room.issued.clear();
        for (const peer of room.members) { peer.signals = []; peer.checkpoint = null; peer.queued = false; peer.generation++; }
      }
      if (!room.members.length || (room.host === member && !this.elect(room, member))) {
        for (const peer of room.members) { peer.room = null; peer.queued = false; peer.signals = []; }
        this.rooms.delete(room.code);
      }
    }
    member.room = null; member.seat = -1; member.queued = false; member.signals = []; member.checkpoint = null;
  }
  sweep(): void {
    for (const room of this.rooms.values()) { this.updateDuelWait(room); if (!this.online(room.host)) this.elect(room, room.host); }
    for (const [token, member] of this.members) if (this.now() - member.seen > RECONNECT_TTL) { this.removeFromRoom(member, 'reconnect-timeout'); this.members.delete(token); }
  }
}
function label(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > 48 || /[\x00-\x1f]/.test(value)) throw new LobbyError('Names must be at most 48 readable characters.');
  return value.trim() || fallback;
}
function passwordText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) throw new LobbyError('Passwords must be at most 128 characters.'); return value;
}
export function onlineSetup(value: unknown): Room['setup'] {
  const setup = validateMatchSetup(value as Room['setup']), mode = setup.online?.kind;
  if (!mode || setup.tanks.length < 2 || setup.tanks.length > 3 || setup.online!.seats.length !== setup.tanks.length
    || setup.online!.seats.some((s, i) => s !== i) || setup.tanks.some(t => t.brain)) throw new LobbyError('Online matches need two or three human slots.');
  if (mode === 'coop' ? setup.mode !== 'campaign' || setup.rules.turnModel !== 'realtime'
    : setup.mode !== 'online' || setup.rules.turnModel !== (mode === 'duel' ? 'tempo' : 'realtime') || setup.teams.some(t => t.ai)) throw new LobbyError('Invalid online rules.');
  return setup;
}
function validSignal(value: Signal): boolean {
  if (!value || typeof value !== 'object') return false;
  if ('description' in value) return ['offer', 'answer'].includes(value.description?.type) && typeof value.description.sdp === 'string' && value.description.sdp.length < 32_000;
  const candidate = (v: RTCIceCandidateInit) => typeof v?.candidate === 'string' && v.candidate.length < 4096;
  if ('candidates' in value) return Array.isArray(value.candidates) && value.candidates.length > 0 && value.candidates.length <= 32 && value.candidates.every(candidate);
  return 'candidate' in value && candidate(value.candidate);
}
