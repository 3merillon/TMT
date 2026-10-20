import type { MatchSetup } from '../api/match';
import { ONLINE_BUILD, ONLINE_PROTOCOL, type Admission, type CreateRequest, type JoinRequest, type LobbyState, type Room } from './protocol';
import { PeerLink } from './peer';
import { RoomChannel, OnlineRequestError, type SocketState } from './channel';

export interface OnlineState extends LobbyState { connected: boolean; busy: boolean; status: string; error: string | null; latency: number | null }
const empty = (): OnlineState => ({ connected: false, busy: false, latency: null, status: 'Connect to find a game.', error: null, room: null, rooms: [], queued: false, signals: [], chat: [] });
export interface OnlineCallbacks {
  room(room: Room, previous: Room | null): void;
  peer(room: Room, seat: number, link: PeerLink): void;
  lost(message: string): void;
}
/** One serialized request stream owns membership. Screens only subscribe; navigating never cancels a queue. */
export class OnlineClient {
  state = empty();
  private token = '';
  private ice: RTCIceServer[] = [];
  private iceExpiresAt = Infinity;
  private browsing = false;
  private recovery?: { id: string; epoch: number; resolve(): void; reject(error: Error): void };
  private unconfirmedRecovery = new Set<string>();
  private after = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private peers = new Map<number, { key: string; link: PeerLink }>();
  private epoch = 0;
  private leaving = false;
  private stopped = false;
  private failures = 0;
  private lastSuccess = 0;
  private lastLease = 0;
  private lastNotice = 0;
  private retries = 0;
  private useSocket = false;
  private channel?: RoomChannel;
  private channelConnecting = false;
  private revision = -1;
  private revisionRoom = '';
  private lastList = 0;
  private readonly storageKey: string;
  constructor(private readonly callbacks: OnlineCallbacks, private readonly base = (import.meta.env?.VITE_ONLINE_URL ?? '').replace(/\/$/, ''), private readonly request: typeof fetch = fetch.bind(globalThis)) {
    this.storageKey = `tmt:online:${base}:${ONLINE_BUILD}`;
    try { this.token = sessionStorage.getItem(this.storageKey) ?? ''; } catch { /* optional */ }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get hasSession(): boolean { return !!this.token; }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.chain.then(action); this.chain = next.catch(() => {}); return next; }
  private async api<T>(path: string, body?: unknown): Promise<T> {
    const started = Date.now();
    if (this.channel?.connected && /^(state(?:\?.*)?|signal|playing|complete|restart|chat|checkpoint|handoff)$/.test(path)) {
      try {
        const data = await this.channel.request<T>(path, body); this.success(started); return data;
      } catch (error) {
        if (error instanceof OnlineRequestError && error.status === 401) { this.storeToken(''); this.state.connected = false; }
        throw error;
      }
    }
    const response = await this.request(`${this.base}/api/online/${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(8000), cache: 'no-store',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({ error: 'Online service is unavailable. Check the deployment’s multiplayer configuration.' }));
    if (!response.ok) { if (response.status === 401) { this.storeToken(''); this.state.connected = false; } throw new Error(data.error ?? 'Online request failed.'); }
    this.success(started);
    return data as T;
  }
  private success(started: number): void {
    this.lastSuccess = Date.now(); this.state.latency = Math.round(this.state.latency === null ? this.lastSuccess - started : this.state.latency * .7 + (this.lastSuccess - started) * .3);
  }
  private storeToken(token: string): void { this.token = token; try { if (token) sessionStorage.setItem(this.storageKey, token); else sessionStorage.removeItem(this.storageKey); } catch { /* optional */ } }
  private reconnectId(): string {
    const key = `${this.storageKey}:reconnect`;
    try { const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null'); if (saved?.token === this.token) return saved.id; } catch { /* optional */ }
    const id = crypto.randomUUID();
    try { sessionStorage.setItem(key, JSON.stringify({ token: this.token, id })); } catch { /* optional */ }
    return id;
  }
  connect(name = 'Player'): Promise<void> {
    return this.action(async () => {
      if (this.token) {
        try { const config = await this.api<{ iceServers: RTCIceServer[]; iceExpiresAt?: number; inRoom: boolean; transport?: string }>('config'); this.ice = config.iceServers; this.iceExpiresAt = config.iceExpiresAt ?? Infinity; this.useSocket = config.transport === 'websocket';
          if (config.inRoom) {
            this.closeChannel();
            const resumed = await this.api<{ token: string | null }>('reconnect', { lostWorld: !this.state.room, reconnectId: this.reconnectId() });
            if (resumed.token) this.storeToken(resumed.token);
          }
          this.retries = 0; await this.poll(); this.schedule(); return; }
        catch { if (this.token) throw new Error('Cannot reach the online service. Try again.'); }
      }
      const admission = await this.api<Admission>('session', { name, protocol: ONLINE_PROTOCOL, build: ONLINE_BUILD });
      this.storeToken(admission.token); this.ice = admission.iceServers; this.iceExpiresAt = admission.iceExpiresAt ?? Infinity; this.after = 0;
      this.useSocket = admission.transport === 'websocket';
      this.state.connected = true; await this.poll(); this.schedule();
    });
  }
  private action(action: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      this.state.busy = true; this.state.error = null; this.changed();
      try { await action(); } catch (error) { this.state.error = error instanceof Error ? error.message : String(error); }
      finally { this.state.busy = false; this.changed(); }
    });
  }
  create(input: CreateRequest): Promise<void> { return this.action(async () => { this.requireConnection(); await this.api('create', input); await this.poll(); }); }
  join(input: JoinRequest): Promise<void> { return this.action(async () => { this.requireConnection(); await this.api('join', input); await this.poll(); }); }
  queue(setup: MatchSetup): Promise<void> { return this.action(async () => { this.requireConnection(); await this.api('queue', { setup }); await this.poll(); }); }
  start(): Promise<void> { return this.action(async () => { await this.api('playing', {}); await this.poll(); }); }
  complete(epoch: number): Promise<void> { return this.action(async () => { await this.api('complete', { epoch }); await this.poll(); }); }
  restart(setup: MatchSetup): Promise<void> { return this.action(async () => { await this.api('restart', { setup }); await this.poll(); }); }
  transfer(): Promise<void> { return this.action(async () => { this.lastLease = 0; await this.api('handoff', {}); await this.poll(); }); }
  chat(text: string): Promise<void> { return this.action(async () => { await this.api('chat', { text }); if (!this.channel?.connected) this.notifyPeers(); await this.poll(); }); }
  private notifyPeers(except = -1): void {
    for (const [seat, peer] of this.peers) if (seat !== except && peer.link.connected) {
      try { peer.link.send({ kind: 'lobby-notice', epoch: this.epoch }); } catch { /* polling remains the fallback */ }
    }
  }
  private notice(seat: number, epoch: number): void {
    // Hints contain no chat content or authority. Read the committed room; cap peer-triggered requests.
    if (epoch !== this.epoch || this.leaving || Date.now() - this.lastNotice < 1000) return;
    this.lastNotice = Date.now();
    if (this.state.room?.host) this.notifyPeers(seat);
    void this.refresh();
  }
  checkpoint(id: string, epoch: number, resume = false): Promise<void> {
    if (resume) return this.serial(async () => { await this.api('checkpoint', { id, epoch, resume }); });
    this.recovery?.reject(new Error('Superseded by a newer recovery checkpoint.'));
    return new Promise((resolve, reject) => { this.recovery = { id, epoch, resolve, reject }; });
  }
  /** A lost reply does not prove that the service failed to commit this recovery. */
  retainedCheckpoints(): string[] {
    return [...this.unconfirmedRecovery, ...(this.recovery ? [this.recovery.id] : []), ...(this.state.room?.ownCheckpoint ? [this.state.room.ownCheckpoint] : [])];
  }
  setBrowsing(value: boolean): void {
    if (this.browsing === value) return; this.browsing = value;
    if (value && this.token && this.state.connected) void this.refresh();
    this.schedule();
  }
  refresh(): Promise<void> { return this.action(() => this.poll()); }
  leaseValid(): boolean { return !!this.state.room && !this.stopped && !this.leaving && this.state.connected && Date.now() - this.lastLease < 10_000 && !this.state.room.paused; }
  private requireConnection(): void { if (!this.token) throw new Error('Connect to Online Play first.'); }
  leave(): Promise<void> {
    this.recovery?.reject(new Error('Left the online room.')); this.recovery = undefined;
    this.leaving = true; this.closePeers();
    this.closeChannel();
    this.state.room = null; this.state.queued = false; this.state.chat = []; this.changed();
    return this.action(async () => {
      if (this.token) await this.api('leave', {});
      this.finishLeave();
    });
  }
  private finishLeave(): void {
    this.unconfirmedRecovery.clear();
    this.state.room = null; this.state.queued = false; this.state.chat = []; this.leaving = false; this.epoch = 0; this.retries = 0;
    this.state.status = 'Left server. Ready for another game.'; this.changed();
  }
  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.stopped || !this.token || !this.state.connected || !this.state.room && !this.browsing) return;
    const room = this.state.room;
    const interval = !room ? 15_000 : room.paused || [...this.peers.values()].some(p => !p.link.connected) ? 1000 : room.phase === 'playing' ? 4000 : 2000;
    this.timer = setTimeout(() => { void this.serial(async () => {
      try { await this.poll(); this.failures = 0; }
      catch (error) {
        this.failures++; this.state.error = `Connection interrupted. Reconnecting… ${error instanceof Error ? error.message : String(error)}`;
        if (!this.token) { this.state.connected = false; this.closePeers(); this.callbacks.lost('Your online session expired. Connect again.'); }
        this.changed();
      } finally { this.schedule(); }
    }); }, this.failures ? 3000 : interval);
  }
  private async poll(): Promise<void> {
    this.requireConnection();
    if (this.leaving) { await this.api('leave', {}); this.finishLeave(); return; }
    if (Date.now() + 300_000 >= this.iceExpiresAt) {
      const config = await this.api<{ iceServers: RTCIceServer[]; iceExpiresAt?: number }>('config');
      this.ice = config.iceServers; this.iceExpiresAt = config.iceExpiresAt ?? Infinity;
      for (const peer of this.peers.values()) peer.link.updateIce(this.ice);
    }
    const recovery = this.recovery;
    const leaseStarted = Date.now();
    if (recovery) {
      this.unconfirmedRecovery.add(recovery.id);
      // Every later attempted registration supersedes an earlier committed value at the service.
      // Eight uncertain receipts comfortably span the 15-second election lease without unbounded pins.
      while (this.unconfirmedRecovery.size > 8) this.unconfirmedRecovery.delete(this.unconfirmedRecovery.values().next().value!);
    }
    const state = await this.api<LobbyState & { revision?: number }>(`state?after=${this.after}&latency=${this.state.latency ?? 0}&list=${Number(this.browsing)}${recovery ? `&checkpoint=${encodeURIComponent(recovery.id)}&epoch=${recovery.epoch}` : ''}`);
    if (recovery && this.recovery === recovery) {
      this.recovery = undefined;
      if (state.room?.epoch === recovery.epoch) recovery.resolve(); else recovery.reject(new Error('The host changed.'));
    }
    if (this.leaving) return;
    this.lastLease = leaseStarted; // delayed replies cannot extend our lease beyond the server's deadline
    if (this.useSocket && this.browsing && Date.now() - this.lastList >= 15_000) {
      state.rooms = await this.api<LobbyState['rooms']>('rooms'); this.lastList = Date.now();
    } else if (this.channel?.connected) state.rooms = this.state.rooms;
    this.applyState(state);
    this.unconfirmedRecovery.clear(); // this authoritative reply identifies the currently committed checkpoint
    this.ensureChannel();
    this.schedule();
  }
  private applyState(state: LobbyState & { revision?: number }): void {
    if (this.leaving || this.stopped) return;
    if (state.room?.code !== this.revisionRoom) { this.revisionRoom = state.room?.code ?? ''; this.revision = -1; }
    if (state.revision !== undefined && state.revision < this.revision) return;
    this.revision = state.revision ?? this.revision;
    const previous = this.state.room;
    Object.assign(this.state, state, { connected: true });
    if (previous && !state.room) { this.closePeers(); this.callbacks.lost('The server closed or your reserved seat expired.'); }
    this.state.status = state.room?.ended ? 'Match over · opponent disconnected'
      : state.room?.reconnectUntil ? `Opponent disconnected · ${Math.max(0, Math.ceil((state.room.reconnectUntil - Date.now()) / 1000))}s to reconnect`
      : state.queued ? `Finding ${state.room?.mode === 'realtime' ? 'realtime PvP' : state.room?.mode === 'artillery' ? 'realtime artillery' : 'turn-based artillery'}… You can use Workshop and Settings.`
      : state.room?.paused ? 'Transferring host · restoring the verified world…'
      : state.room?.phase === 'waiting' ? `Server ${state.room.code} · ${state.room.players}/${state.room.capacity} players`
      : state.room?.phase === 'finished' ? 'Match finished · the host can start another round.'
      : state.room ? 'Online match · connected' : 'Quick Match, browse servers, or create your own.';
    if (state.room) {
      if (state.room.epoch !== this.epoch) { this.closePeers(); this.epoch = state.room.epoch; this.retries = 0; }
      this.callbacks.room(state.room, previous);
      this.pair(state.room);
    }
    for (const signal of state.signals) {
      if (signal.id <= this.after) continue;
      const from = state.room?.peers.find(p => p.seat === signal.from), me = state.room?.peers.find(p => p.seat === state.room?.seat);
      if (signal.epoch === this.epoch && signal.generation === from?.generation && signal.toGeneration === me?.generation) void this.peers.get(signal.from)?.link.accept(signal.value);
      this.after = signal.id;
    }
    this.changed();
  }
  private ensureChannel(): void {
    const room = this.state.room;
    if (!room) { this.closeChannel(); return; }
    if (!this.useSocket || this.stopped || this.leaving || this.channelConnecting || this.channel?.connected && this.channel.code === room.code) return;
    this.closeChannel(); this.channelConnecting = true;
    try {
      const channel = new RoomChannel(this.base, room.code, this.token,
        (state: SocketState) => { if (this.channel === channel) this.applyState({ ...state, rooms: this.state.rooms }); },
        () => { if (this.channel === channel) { this.channelConnecting = false; this.lastLease = 0; this.schedule(); } });
      this.channel = channel;
      void channel.opened.then(() => { if (this.channel === channel) { this.channelConnecting = false; void this.refresh(); } }).catch(() => { if (this.channel === channel) { this.channelConnecting = false; this.closeChannel(); } });
    } catch { this.channelConnecting = false; }
  }
  private closeChannel(): void { this.channel?.close(); this.channel = undefined; this.channelConnecting = false; }
  private pair(room: Room): void {
    const me = room.peers.find(p => p.seat === room.seat)!;
    const targets = room.peers.filter(p => p.connected && p.seat !== room.seat && (room.host || p.seat === room.hostSeat));
    for (const [seat, peer] of this.peers) if (!targets.some(p => p.seat === seat)) { peer.link.close(); this.peers.delete(seat); }
    for (const target of targets) {
      const key = `${room.epoch}:${me.generation}:${target.generation}`, old = this.peers.get(target.seat);
      if (old?.key === key) continue;
      old?.link.close();
      const epoch = this.epoch;
      try {
        const link = new PeerLink(room.host, this.ice,
          value => this.serial(async () => {
            if (!this.leaving && epoch === this.epoch && this.peers.get(target.seat)?.key === key) {
              const response = await this.api<{ retry?: boolean }>('signal', { to: target.seat, generation: me.generation, toGeneration: target.generation, epoch, value });
              if (response.retry) void this.refresh();
            }
          }),
          message => {
            if (this.leaving || epoch !== this.epoch || this.peers.get(target.seat)?.link !== link) return;
            this.state.error = `${message} Reconnecting…`; this.changed();
            if (++this.retries <= 3) void this.action(async () => { await this.api('reconnect', {}); await this.poll(); });
            else this.callbacks.lost('Peer connection could not be restored. Your seat stays reserved for three minutes.');
          }, noticeEpoch => this.notice(target.seat, noticeEpoch));
        this.peers.set(target.seat, { key, link });
        void link.opened.then(() => { if (!this.leaving && epoch === this.epoch && this.peers.get(target.seat)?.link === link && this.state.room) { this.retries = 0; this.callbacks.peer(this.state.room, target.seat, link); } }).catch(() => {});
      } catch (error) { this.state.error = `WebRTC unavailable: ${String(error)}`; }
    }
  }
  private closePeers(): void { for (const peer of this.peers.values()) peer.link.close(); this.peers.clear(); }
  dispose(): void { this.stopped = true; clearTimeout(this.timer); this.closeChannel(); this.recovery?.reject(new Error('Online session closed.')); this.recovery = undefined; this.closePeers(); this.listeners.clear(); }
}
