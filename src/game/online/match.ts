import type { GameSession } from '../app/session';
import type { PlayerCommand } from '../api/session';
import type { DriveInput, GameEvent } from '../contracts';
import type { MatchSetup } from '../api/match';
import type { PeerLink } from './peer';
import type { PeerMessage, Room } from './protocol';
import type { OnlineClient } from './client';
import type { NetworkEvent, NetworkSnapshot, Recovery, SessionNetwork } from './state';
import { networkCommand, validateNetworkSnapshot, validateRecovery } from './validation';
import { snapshotHash } from '../rules/hash';
import type { SimInterpolation, TankPose } from '../api/extensions';
import { MAX_WIRE_TEXT } from './wire';
import { OnlineAppearanceSync } from './appearance';

interface Remote {
  link: PeerLink; ready: boolean; acknowledged: number; sent: number; world: number; event: number;
  input: number; lastInput: number; lastSeen: number; sentWorld: number; window: number; commands: number;
}
interface PredictedInput { seq: number; drive: DriveInput }
const ZERO: DriveInput = { throttle: 0, steer: 0 };
/** Host authority with client prediction. Simulation, NPCs, damage and edits run only at the elected host. */
export class OnlineMatch implements SessionNetwork {
  room: Room | null = null;
  private peers = new Map<number, Remote>();
  private started = false;
  private loading = false;
  private launchDeferred = false;
  private transferring = false;
  private failed = false;
  private failure = '';
  private hadPeer = false;
  private began = false;
  private lifecycle = 0;
  private accumulator = 0;
  private lastFrame = performance.now();
  private lastPublish = 0;
  private lastRecovery = -Infinity;
  private recovering = false;
  private recoveryError = '';
  private seq = 0;
  private inputSeq = 0;
  private drive: DriveInput = ZERO;
  private aim?: PlayerCommand;
  private munition?: PlayerCommand;
  private pendingAim?: PlayerCommand;
  private lastAimSent = -Infinity;
  private prediction: PredictedInput[] = [];
  private applying = false;
  private pending: { seq: number; ack: number; snapshot: NetworkSnapshot; events: NetworkEvent[] } | null = null;
  private applied = 0;
  private received = 0;
  private eventId = 0;
  private events: NetworkEvent[] = [];
  private recoveries = new Map<string, Recovery>();
  private latestRecovery: string | null = null;
  private heartbeat = 0;
  private lastHost = performance.now();
  private smooth?: { previous: TankPose[]; current: TankPose[]; projectiles: NonNullable<SimInterpolation['projectiles']>; at: number };
  latency: number | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly appearances: OnlineAppearanceSync;
  constructor(private readonly game: GameSession, private readonly client: () => OnlineClient,
    private readonly launch: (setup: MatchSetup, operation: () => Promise<void>) => Promise<void>, private readonly error: (message: string) => void) {
    this.appearances = new OnlineAppearanceSync(error);
    game.on('event', game => { if (this.host && this.started) {
      this.record({ game: game as GameEvent });
      if ((game as GameEvent).type === 'finish' && this.room) void this.client().complete(this.room.epoch);
    } });
    game.on('realtime', realtime => { if (this.host && this.started) this.record({ realtime: realtime as NetworkEvent['realtime'] }); });
    this.timer = setInterval(() => this.pump(), 1000 / 60);
  }
  get seat(): number { return this.room?.seat ?? 0; }
  get host(): boolean { return this.room?.host ?? false; }
  get active(): boolean { return this.started && !this.room?.reconnectUntil && !this.room?.ended && !this.loading && !this.transferring && !this.failed && this.client().leaseValid(); }
  get status(): string | null {
    if (!this.started) return null;
    if (this.room?.reconnectUntil) return `Opponent disconnected · ${Math.max(0, Math.ceil((this.room.reconnectUntil - Date.now()) / 1000))}s to reconnect`;
    if (this.failed) return this.failure;
    if (this.loading) return this.launchDeferred ? 'Match ready · save or discard paint, then choose Return to match' : 'Loading shared world…';
    if (this.transferring) return 'Restoring the new host’s world…';
    if (!this.client().leaseValid()) return 'Connection interrupted · simulation paused';
    if (!this.peers.size && !(this.host && this.room?.mode === 'coop') || !this.host && performance.now() - this.lastHost > 1500) return 'Waiting for the peer connection…';
    return null;
  }
  updateRoom(room: Room, previous: Room | null): void {
    const old = this.room; this.room = room;
    if (old && old.code !== room.code) this.reset(false);
    this.appearances.updateRoom(room);
    if (room.ended) { this.reset(false); return; }
    if (room.reconnectUntil) return;
    if (!old && room.host && room.phase === 'playing' && room.paused) {
      this.started = true; this.game.network = this;
      this.fail('The host refreshed before another player had a recovery checkpoint. Waiting for recovery; leave the server to start a new match.'); return;
    }
    if (old && old.epoch !== room.epoch) {
      this.peers.clear(); this.pending = null; this.prediction = []; this.applied = this.received = 0; this.seq = 0;
      this.inputSeq = this.eventId = 0; this.events = [];
      this.drive = ZERO; this.aim = this.munition = this.pendingAim = undefined; this.lastAimSent = -Infinity;
      if (room.phase === 'waiting') { this.reset(false); this.appearances.updateRoom(room); return; }
      if (room.phase === 'finished') { this.transferring = false; return; }
      this.transferring = true; this.failed = false; this.game.network = this;
      if (room.host) void this.takeOver(room);
      else void this.begin(room); // discard the old authority's world, including edits newer than the recovery
      return;
    }
    if (room.phase === 'playing' && !this.started && !this.loading) void this.begin(room);
    if (!room.paused && this.transferring && !room.host && this.applied > 0) this.transferring = false;
    if (this.host && !this.loading) this.game.realtime?.configureOnlineSeats(room.peers);
    for (const [seat] of this.peers) if (!room.peers.some(p => p.seat === seat && p.connected)) { this.peers.delete(seat); this.game.localCommand(seat, { k: 'drive', ...ZERO }); }
    void previous;
  }
  private async begin(room: Room): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.pending = null; this.applying = this.recovering = false;
    this.loading = true; this.launchDeferred = false; this.started = true; this.failed = false; this.game.network = this;
    try {
      await this.launch(room.setup, () => { if (lifecycle !== this.lifecycle) throw new Error('Online load cancelled.'); return this.game.startMatch(room.setup, undefined, true); });
      if (lifecycle !== this.lifecycle || this.room?.code !== room.code) return;
      this.loading = false; this.lastFrame = performance.now();
      if (this.host) this.game.realtime?.configureOnlineSeats(this.room.peers);
      if (!this.host) this.sendHost({ kind: 'ready', epoch: room.epoch, input: this.inputSeq });
      else this.lastRecovery = -Infinity;
    } catch (error) { if (lifecycle === this.lifecycle) this.fail(`Could not load the online world: ${String(error)}`); }
  }
  attach(room: Room, seat: number, link: PeerLink): void {
    if (room.code !== this.room?.code || room.epoch !== this.room.epoch) return;
    const peer: Remote = { link, ready: false, acknowledged: 0, sent: 0, world: 0, event: 0, input: 0, lastInput: performance.now(), lastSeen: performance.now(), sentWorld: 0, window: performance.now(), commands: 0 };
    this.peers.set(seat, peer);
    if (!this.host && this.failed) { this.failed = false; this.applied = this.received = 0; this.eventId = 0; this.transferring = true; void this.begin(room); }
    this.appearances.attach(seat, message => this.sendPeer(peer, message));
    link.listen(message => {
      if (this.peers.get(seat) !== peer || !this.room || message.epoch !== this.room.epoch) return;
      try { this.receive(seat, peer, message); } catch (error) {
        if (this.host) { link.close(); this.peers.delete(seat); this.game.localCommand(seat, { k: 'drive', ...ZERO }); this.error('Disconnected a player who sent invalid commands.'); }
        else this.fail(`Invalid multiplayer state: ${String(error)}`);
      }
    });
    if (!this.host && this.started && !this.loading) this.sendHost({ kind: 'ready', epoch: room.epoch, input: this.inputSeq });
  }
  private receive(seat: number, peer: Remote, m: PeerMessage): void {
    peer.lastSeen = performance.now();
    if (this.appearances.receive(seat, m)) return;
    if (m.kind === 'ping') { this.sendPeer(peer, { kind: 'pong', epoch: m.epoch, at: m.at }); return; }
    if (m.kind === 'pong' && typeof m.at === 'number') { this.latency = Math.max(0, Math.round(performance.now() - m.at)); return; }
    if (this.host) {
      // The first snapshot contains the current mission. Replaying its historical radio/objective/
      // impact ledger would show old effects and could replace current objective text for a late joiner.
      if (m.kind === 'ready') { if (peer.ready) return; peer.ready = true; peer.event = this.eventId; this.hadPeer = true; if (Number.isSafeInteger(m.input) && (m.input as number) >= 0) peer.input = m.input as number; this.lastPublish = 0; return; }
      if (m.kind === 'input') {
        if (!this.active || !peer.ready || !Number.isSafeInteger(m.seq) || (m.seq as number) <= peer.input) return;
        if ((m.seq as number) - peer.input > 512) throw new Error('Input sequence jumped.');
        if (performance.now() - peer.window >= 1000) { peer.window = performance.now(); peer.commands = 0; }
        if (++peer.commands > 240) { peer.link.close(); this.peers.delete(seat); this.game.localCommand(seat, { k: 'drive', ...ZERO }); return; }
        peer.input = m.seq as number; peer.lastInput = performance.now();
        const c = networkCommand(m.command);
        if (this.game.setup?.rules.turnModel !== 'realtime' && this.game.snapshot?.active !== seat) return;
        this.game.localCommand(seat, c); return;
      }
      if (m.kind === 'ack') {
        if (!Number.isSafeInteger(m.seq) || (m.seq as number) > peer.sent || (m.seq as number) < peer.acknowledged) return;
        peer.acknowledged = m.seq as number;
        if (Number.isSafeInteger(m.world) && (m.world as number) >= peer.world && (m.world as number) <= peer.sentWorld) peer.world = m.world as number;
        if (Number.isSafeInteger(m.event) && (m.event as number) >= peer.event && (m.event as number) <= this.eventId) peer.event = m.event as number;
        return;
      }
      return;
    }
    if (seat !== this.room?.hostSeat) return;
    this.lastHost = performance.now();
    if (m.kind === 'snapshot') {
      if (!this.started || this.loading || !Number.isSafeInteger(m.seq) || (m.seq as number) <= this.received || !Number.isSafeInteger(m.ack)
        || (m.ack as number) < 0 || (m.ack as number) > this.inputSeq || !Array.isArray(m.events) || m.events.length > 2048) return;
      const snapshot = validateNetworkSnapshot(m.snapshot);
      if (m.events.some((e, i, all) => !e || !Number.isSafeInteger(e.id) || e.id <= 0 || i > 0 && all[i - 1].id >= e.id)) throw new Error('Invalid gameplay event sequence.');
      this.received = m.seq as number;
      this.pending = { seq: m.seq as number, ack: m.ack as number, snapshot, events: m.events as NetworkEvent[] };
      void this.apply(); return;
    }
    if (m.kind === 'recovery') {
      const recovery = validateRecovery(m.recovery), hash = snapshotHash(recovery), id = `${recovery.realtime?.state.tick ?? recovery.turn!.tick}:${hash}`;
      if (id !== m.id) throw new Error('Recovery checksum mismatch.');
      this.keepRecovery(id, recovery);
      void this.game.persistOnlineRecovery?.(recovery);
      void this.client().checkpoint(id, m.epoch).catch(() => {});
    }
  }
  command(tank: number, value: PlayerCommand): boolean {
    if (!this.active || tank !== this.seat || !this.game.ready) return false;
    let c: PlayerCommand; try { c = networkCommand(value); } catch { return false; }
    if (c.k === 'drive') { this.drive = c; if (this.host) this.game.localCommand(tank, c); return true; }
    if (this.game.setup?.rules.turnModel !== 'realtime' && this.game.snapshot?.active !== tank) return false;
    if (this.host) return this.game.localCommand(tank, c);
    if (c.k === 'aim') {
      this.aim = this.pendingAim = c; this.game.aimNetwork(c);
      if (performance.now() - this.lastAimSent >= 1000 / 60) this.flushAim();
      return true; // render-rate aim is coalesced to the next network step
    }
    if (c.k === 'munition') { this.munition = c; this.game.aimNetwork(c); }
    if (c.k === 'fire' && !this.flushAim()) return false; // fire always follows the final local aim
    return this.sendInput(c);
  }
  step(_dt: number): readonly GameEvent[] { return []; } // the independent network clock also runs while menus are open
  interpolation(): SimInterpolation | undefined {
    if (this.host || !this.smooth || !this.game.snapshot) return undefined;
    const alpha = Math.min(1, Math.max(0, (performance.now() - this.smooth.at) / 100));
    const own = this.game.snapshot.tanks[this.seat];
    const previous = [...this.smooth.previous], current = [...this.smooth.current];
    // The local chassis is already predicted; only remote units spend a snapshot interval in the interpolation buffer.
    if (own) previous[this.seat] = current[this.seat] = pose(own);
    return { alpha, prev: previous, curr: current, projectiles: this.smooth.projectiles };
  }
  private pump(): void {
    this.appearances.pump();
    const now = performance.now(), dt = Math.min(.1, (now - this.lastFrame) / 1000); this.lastFrame = now;
    if (!this.room || !this.started || this.loading || this.failed) return;
    try {
      if (now - this.heartbeat > 2000) { this.heartbeat = now; for (const p of this.peers.values()) if (!p.link.busy) this.sendPeer(p, { kind: 'ping', epoch: this.room.epoch, at: now }); }
      if (!this.active || !this.game.ready) { this.accumulator = 0; return; }
      if (this.room.phase === 'finished' || this.game.snapshot?.phase === 'finished') {
        // Deliver the final state/event until acknowledged, then leave only the low-rate room heartbeat.
        if (this.host && now - this.lastPublish >= 100 && [...this.peers.values()].some(p => p.ready && (p.acknowledged === 0 || p.event < this.eventId))) { this.lastPublish = now; this.publish(); }
        return;
      }
      if (this.host) {
        // All versus players must finish loading before the first tick. Co-op also supports joining mid-mission.
        if (!this.began && this.room.mode !== 'coop' && this.room.peers.some(p => p.seat !== this.seat && (!p.connected || !this.peers.get(p.seat)?.ready))) return;
        // Wait for at least one opponent's world. A disconnected player's last throttle never remains held.
        if (![...this.peers.values()].some(p => p.ready && now - p.lastSeen < 10_000) && this.room.mode !== 'coop') return;
        this.began = true;
        for (const [seat, peer] of this.peers) if (now - peer.lastInput > 300) this.game.localCommand(seat, { k: 'drive', ...ZERO });
        this.game.advanceOnline(dt);
        if (now - this.lastPublish >= 100) { this.lastPublish = now; this.publish(); }
        if (now - this.lastRecovery >= 2000 && !this.recovering) { this.lastRecovery = now; void this.captureRecovery(); }
      } else {
        if (now - this.lastHost > 1500 || this.applying) return;
        if (now - this.lastAimSent >= 1000 / 60) this.flushAim();
        this.accumulator = Math.min(.05, this.accumulator + dt);
        while (this.accumulator >= 1 / 60) {
          this.accumulator -= 1 / 60;
          if (!this.sendInput({ k: 'drive', ...this.drive })) break;
          const seq = this.inputSeq;
          this.prediction.push({ seq, drive: { ...this.drive } });
          if (this.prediction.length > 30) { this.prediction.shift(); break; }
          this.game.predictNetwork(this.drive);
        }
      }
    } catch (error) { this.fail(`Multiplayer paused: ${String(error)}`); }
  }
  private publish(): void {
    if (!this.room) return;
    const seq = ++this.seq;
    for (const peer of this.peers.values()) {
      if (!peer.ready || peer.link.busy || peer.sent - peer.acknowledged > 30) continue;
      const snapshot = this.game.captureNetwork(peer.world, peer.acknowledged === 0); if (!snapshot) continue;
      if (!this.sendPeer(peer, { kind: 'snapshot', epoch: this.room.epoch, seq, ack: peer.input, snapshot, events: this.events.filter(e => e.id > peer.event) })) continue;
      peer.sent = seq; peer.sentWorld = snapshot.world.count;
      const recovery = this.latestRecovery && this.recoveries.get(this.latestRecovery);
      if (recovery && peer.acknowledged === 0) this.sendPeer(peer, { kind: 'recovery', epoch: this.room.epoch, id: this.latestRecovery, recovery });
    }
  }
  private async apply(): Promise<void> {
    if (this.applying) return; this.applying = true;
    const epoch = this.room?.epoch, lifecycle = this.lifecycle;
    try {
      while (this.pending && epoch === this.room?.epoch && lifecycle === this.lifecycle) {
        const next = this.pending; this.pending = null;
        const previous = this.game.snapshot?.tanks.map(pose), priorGenerations = this.game.snapshot?.tanks.map(t => t.generation);
        const priorProjectiles = new Map(this.game.snapshot?.projectiles.map(p => [p.id, [...p.position] as import('../contracts').V3]));
        await this.game.applyNetwork(next.snapshot, next.events.filter(e => e.id > this.eventId), () => epoch === this.room?.epoch && lifecycle === this.lifecycle && !this.room?.ended);
        if (epoch !== this.room?.epoch || lifecycle !== this.lifecycle) return;
        this.applied = next.seq; this.eventId = Math.max(this.eventId, ...next.events.map(e => e.id));
        const current = next.snapshot.state.tanks.map(pose);
        this.smooth = { previous: current.map((p, i) => priorGenerations?.[i] === next.snapshot.state.tanks[i].generation ? previous?.[i] ?? p : p), current,
          projectiles: next.snapshot.state.projectiles.map(p => ({ id: p.id, previous: priorProjectiles.get(p.id) ?? p.position, current: p.position })), at: performance.now() };
        this.prediction = this.prediction.filter(p => p.seq > next.ack).slice(-15);
        for (const p of this.prediction) this.game.predictNetwork(p.drive);
        if (this.aim) this.game.aimNetwork(this.aim);
        if (this.munition) this.game.aimNetwork(this.munition);
        this.transferring = this.room?.paused ?? false;
        this.sendHost({ kind: 'ack', epoch: epoch!, seq: next.seq, world: next.snapshot.world.count, event: this.eventId });
      }
    } catch (error) { if (lifecycle === this.lifecycle) this.fail(`World synchronization failed: ${String(error)}`); }
    finally { if (lifecycle === this.lifecycle) this.applying = false; }
  }
  private record(event: Omit<NetworkEvent, 'id'>): void { this.events.push({ ...event, id: ++this.eventId }); if (this.events.length > 2048) this.events.shift(); }
  private async captureRecovery(): Promise<void> {
    this.recovering = true; const epoch = this.room?.epoch, lifecycle = this.lifecycle;
    try {
      const recovery = await this.game.captureRecovery(); if (!recovery || epoch !== this.room?.epoch || lifecycle !== this.lifecycle) return;
      if (recovery.terrain?.edits.length > 20_000 || JSON.stringify(recovery).length > MAX_WIRE_TEXT - 256) throw new Error('The recovery world exceeds its 16 MiB / 20,000 terrain-edit limit. The previous verified checkpoint is retained; finish this match before starting another.');
      void this.game.persistOnlineRecovery?.(recovery);
      const id = `${recovery.realtime?.state.tick ?? recovery.turn!.tick}:${snapshotHash(recovery)}`;
      this.keepRecovery(id, recovery, false);
      await this.client().checkpoint(id, epoch!);
      if (epoch !== this.room?.epoch || lifecycle !== this.lifecycle) return;
      this.latestRecovery = id;
      this.recoveryError = '';
      for (const peer of this.peers.values()) if (peer.ready && !peer.link.busy) this.sendPeer(peer, { kind: 'recovery', epoch: epoch!, id, recovery });
    } catch (error) {
      const message = `Recovery checkpoint unavailable: ${String(error)}`;
      if (lifecycle === this.lifecycle && message !== this.recoveryError) { this.recoveryError = message; this.error(message); }
    }
    finally { if (lifecycle === this.lifecycle) this.recovering = false; }
  }
  private keepRecovery(id: string, recovery: Recovery, published = true): void {
    this.recoveries.set(id, recovery); if (published) this.latestRecovery = id;
    // The service may still elect an older acknowledged world, or commit an acknowledgment whose
    // reply was lost. Keep both until a later authoritative reply proves which one is committed.
    const pinned = new Set(this.client().retainedCheckpoints?.() ?? []);
    pinned.add(id); // the newly captured world is about to be registered and must survive this eviction pass
    while (this.recoveries.size > 3) {
      const oldest = [...this.recoveries.keys()].find(key => key !== this.latestRecovery && key !== this.room?.checkpoint && !pinned.has(key));
      if (!oldest) break; this.recoveries.delete(oldest);
    }
  }
  private async takeOver(room: Room): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.pending = null; this.applying = this.recovering = false;
    const recovery = room.checkpoint ? this.recoveries.get(room.checkpoint) : undefined;
    if (!recovery) { this.fail('Host transfer paused: the elected recovery checkpoint is unavailable. Return to the server browser.'); return; }
    this.loading = true;
    try {
      await this.launch(recovery.setup, () => { if (lifecycle !== this.lifecycle) throw new Error('Host transfer cancelled.'); return this.game.restoreRecovery(recovery); });
      if (lifecycle !== this.lifecycle || this.room?.epoch !== room.epoch) return;
      this.keepRecovery(room.checkpoint!, recovery);
      this.events = []; this.eventId = 0; this.started = true; this.loading = false; this.hadPeer = this.began = true;
      this.game.realtime?.configureOnlineSeats(this.room.peers);
      await this.client().checkpoint(room.checkpoint!, room.epoch, true);
      await this.client().refresh();
      if (lifecycle === this.lifecycle && this.room?.epoch === room.epoch) { this.transferring = false; this.lastPublish = 0; }
    } catch (error) { if (lifecycle === this.lifecycle) this.fail(`Host transfer could not restore the match: ${String(error)}`); }
  }
  private sendHost(message: PeerMessage): boolean {
    const peer = this.peers.get(this.room?.hostSeat ?? -1); if (!peer) return false;
    try { peer.link.send(message); return true; } catch { return false; }
  }
  private sendPeer(peer: Remote, message: PeerMessage): boolean {
    try { peer.link.send(message); return true; }
    catch {
      // A data channel can close before the service's membership push arrives. One departing helper
      // must never freeze the authoritative world or the remaining healthy links.
      if (peer.link.connected === false) for (const [seat, current] of this.peers) if (current === peer) {
        this.peers.delete(seat); this.game.localCommand(seat, { k: 'drive', ...ZERO });
      }
      return false;
    }
  }
  private sendInput(command: PlayerCommand): boolean {
    if (!this.room || !this.sendHost({ kind: 'input', epoch: this.room.epoch, seq: this.inputSeq + 1, command })) return false;
    this.inputSeq++; return true;
  }
  private flushAim(): boolean {
    if (!this.pendingAim) return true;
    if (!this.sendInput(this.pendingAim)) return false;
    this.pendingAim = undefined; this.lastAimSent = performance.now(); return true;
  }
  private fail(message: string): void { this.failed = true; this.failure = message; this.error(message); }
  reset(clearRoom = true): void {
    this.launchDeferred = false;
    this.appearances.reset();
    this.lifecycle++;
    this.game.network = undefined; this.started = this.loading = this.transferring = this.failed = false;
    this.peers.clear(); this.pending = null; this.prediction = []; this.events = []; this.recoveries.clear(); this.latestRecovery = null;
    this.seq = this.inputSeq = this.applied = this.received = this.eventId = 0; this.drive = ZERO; this.aim = this.munition = this.pendingAim = undefined; this.lastAimSent = -Infinity;
    this.smooth = undefined;
    this.applying = this.recovering = false; this.lastRecovery = -Infinity; this.lastPublish = this.accumulator = 0;
    this.hadPeer = this.began = false; this.failure = this.recoveryError = '';
    if (clearRoom) this.room = null;
  }
  dispose(): void { clearInterval(this.timer); this.reset(); }
  /** Read-only cosmetic transfer diagnostics: content hashes and byte counts, never peer credentials. */
  appearanceDiagnostics() { return this.appearances.diagnostics(); }
  appearanceChanged(): void { this.appearances.appearanceChanged(); }
  /** A pending local paint decision keeps the same load/epoch; Return to match explicitly resumes it. */
  deferLaunch(deferred: boolean): void { this.launchDeferred = deferred; }
}
function pose(tank: import('../contracts').TankState): TankPose { return { position: [...tank.position], rotation: [...tank.rotation], turretYaw: tank.turretYaw, barrelPitch: tank.barrelPitch }; }
