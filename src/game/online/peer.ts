import type { PeerMessage, Signal } from './protocol';
import { encodeWire, MAX_WIRE_TEXT, WireDecoder } from './wire';

/** One reliable, ordered channel per admitted opponent. ICE stays inside the authenticated room. */
export class PeerLink {
  private readonly pc: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private pending: PeerMessage[] = [];
  private pendingBytes = 0;
  private receiver?: (message: PeerMessage) => void;
  private candidates: RTCIceCandidateInit[] = [];
  private gathered: RTCIceCandidateInit[] = [];
  private gatherTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private output: { fragments: string[]; next: number; bytes: number; priority: number; recovery?: unknown }[] = [];
  private queuedBytes = 0;
  private messageId = 0;
  private readonly decoder = new WireDecoder();
  private timer: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  readonly opened: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  constructor(host: boolean, iceServers: RTCIceServer[], private signal: (signal: Signal) => Promise<void>, private failed: (message: string) => void, private notice: (epoch: number) => void = () => {}) {
    const relay = new URLSearchParams(globalThis.location?.search ?? '').get('relay') === '1';
    if (relay && !iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)))) throw new Error('Forced relay requires TURN credentials. Configure the Cloudflare TURN relay or remove relay=1.');
    this.pc = new RTCPeerConnection({ iceServers, ...(relay ? { iceTransportPolicy: 'relay' as const } : {}) });
    this.opened = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.opened.catch(() => {});
    this.timer = setTimeout(() => this.fail('Could not reach the other player. Check the connection or the server’s TURN relay configuration.'), 30_000);
    this.pc.onicecandidate = event => {
      if (event.candidate) this.gathered.push(event.candidate.toJSON());
      if (!event.candidate || this.gathered.length >= 32) this.flushCandidates();
      else this.gatherTimer ??= setTimeout(() => this.flushCandidates(), 75);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.fail('Peer connection failed. Return to Online Play to reconnect.');
      if (this.pc.connectionState === 'disconnected') this.disconnectTimer ??= setTimeout(() => this.fail('The other player disconnected.'), 15_000);
      if (this.pc.connectionState === 'connected') { clearTimeout(this.disconnectTimer); this.disconnectTimer = undefined; }
    };
    if (host) {
      this.bind(this.pc.createDataChannel('tmt-duel-v1', { ordered: true }));
      void this.offer().catch(error => this.fail(String(error)));
    } else this.pc.ondatachannel = event => {
      if (this.channel || event.channel.label !== 'tmt-duel-v1') { event.channel.close(); return; }
      this.bind(event.channel);
    };
  }
  private async offer(): Promise<void> {
    const offer = await this.pc.createOffer(); if (this.closed) return;
    await this.pc.setLocalDescription(offer); if (this.closed) return;
    await this.signal({ description: this.pc.localDescription!.toJSON() });
  }
  private flushCandidates(): void {
    clearTimeout(this.gatherTimer); this.gatherTimer = undefined;
    if (!this.closed && this.gathered.length) void this.signal({ candidates: this.gathered.splice(0, 32) }).catch(error => this.fail(String(error)));
  }
  accept(signal: Signal): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      if ('description' in signal) {
        await this.pc.setRemoteDescription(signal.description);
        if (this.closed) return;
        for (const candidate of this.candidates.splice(0)) { await this.pc.addIceCandidate(candidate); if (this.closed) return; }
        if (signal.description.type === 'offer') {
          const answer = await this.pc.createAnswer(); if (this.closed) return;
          await this.pc.setLocalDescription(answer); if (this.closed) return;
          await this.signal({ description: this.pc.localDescription!.toJSON() });
        }
      } else for (const candidate of 'candidates' in signal ? signal.candidates : [signal.candidate]) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
        else { if (this.candidates.length >= 256) throw new Error('Too many connection candidates.'); this.candidates.push(candidate); }
      }
    }).catch(error => this.fail(`Connection negotiation failed: ${String(error)}`));
    return this.chain;
  }
  private bind(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.bufferedAmountLowThreshold = 32_000;
    channel.onbufferedamountlow = () => { try { this.flush(); } catch { this.fail('The match connection closed during transfer.'); } };
    channel.onopen = () => { clearTimeout(this.timer); this.resolve(); };
    channel.onclose = () => this.fail('The other player left the match.');
    channel.onerror = () => this.fail('The match connection encountered an error.');
    channel.onmessage = event => {
      try {
        const message = this.decoder.decode(event.data) as PeerMessage | null;
        if (!message) return;
        if (typeof message.kind !== 'string') throw new Error('Invalid peer message');
        if (message.kind === 'lobby-notice') { this.notice(message.epoch); return; }
        if (this.receiver) { this.receiver(message); return; }
        // Messages arriving before listen() wait in a bounded queue.
        const bytes = JSON.stringify(message).length;
        if (this.pending.length >= 256 || this.pendingBytes + bytes > MAX_WIRE_TEXT) throw new Error('Peer message overflow');
        this.pending.push(message); this.pendingBytes += bytes;
      } catch { this.fail('The other player sent invalid match data.'); }
    };
  }
  listen(receiver: (message: PeerMessage) => void): void { this.receiver = receiver; this.pendingBytes = 0; for (const message of this.pending.splice(0)) receiver(message); }
  send(message: PeerMessage): void {
    if (this.closed || this.channel?.readyState !== 'open') throw new Error('The match connection is closed.');
    if (message.kind === 'recovery' && this.output.some(m => m.priority === 2 && m.recovery === message.id)) return;
    const fragments = encodeWire(message, ++this.messageId);
    const bytes = fragments.reduce((sum, s) => sum + s.length, 0);
    if (this.queuedBytes + bytes > 20 * 1024 * 1024) throw new Error('Network transfer buffer full.');
    const priority = message.kind === 'appearance-blob' ? 3 : message.kind === 'recovery' ? 2 : message.kind === 'snapshot' ? 1 : 0;
    if (priority === 0 && this.output.filter(m => m.priority === 0).reduce((sum, m) => sum + m.bytes, 0) + bytes > 128_000) throw new Error('Gameplay transfer buffer full.');
    // One bounded cosmetic asset at a time, behind gameplay and recovery. It never consumes their 128k backlog.
    if (priority === 3 && this.output.filter(m => m.priority === 3).reduce((sum, m) => sum + m.bytes, 0) + bytes > 2 * 1024 * 1024) throw new Error('Cosmetic transfer buffer full.');
    // At most one active and one queued checkpoint; a newer unsent checkpoint replaces the older one.
    if (priority === 2) {
      const unsent = this.output.findIndex(m => m.priority === 2 && m.next === 0);
      if (unsent >= 0) { this.queuedBytes -= this.output[unsent].bytes; this.output.splice(unsent, 1); }
    }
    this.output.push({ fragments, next: 0, bytes, priority, ...(priority === 2 ? { recovery: message.id } : {}) }); this.queuedBytes += bytes; this.flush();
  }
  /** Bulk recovery never prevents current snapshots or gameplay commands from being queued. */
  get busy(): boolean { return this.output.some(m => m.priority <= 1 && m.bytes > 128_000) || this.output.filter(m => m.priority <= 1).reduce((sum, m) => sum + m.bytes, 0) > 128_000; }
  get connected(): boolean { return !this.closed && this.channel?.readyState === 'open'; }
  /** Diagnostics deliberately omit addresses, credentials, SDP and candidate URLs. */
  async transportInfo(): Promise<{ local: string | null; remote: string | null; protocol: string | null }> {
    const stats = await this.pc.getStats(), reports = new Map<string, any>(); let pair: any;
    stats.forEach((report, key) => reports.set(key, report));
    reports.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) pair = reports.get(report.selectedCandidatePairId); });
    if (!pair) reports.forEach(report => { if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report; });
    const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
    return { local: local?.candidateType ?? null, remote: remote?.candidateType ?? null, protocol: local?.protocol ?? null };
  }
  updateIce(iceServers: RTCIceServer[]): void {
    if (!this.closed) this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
  }
  private flush(): void {
    while (!this.closed && this.output.length && this.channel?.readyState === 'open' && this.channel.bufferedAmount < 64_000) {
      const priority = Math.min(...this.output.map(m => m.priority)), index = this.output.findIndex(m => m.priority === priority), message = this.output[index];
      const next = message.fragments[message.next++]; this.queuedBytes -= next.length; message.bytes -= next.length; this.channel.send(next);
      if (message.next === message.fragments.length) this.output.splice(index, 1);
    }
  }
  private fail(message: string): void { if (this.closed) return; this.reject(new Error(message)); this.close(); this.failed(message); }
  close(): void {
    if (this.closed) return; this.closed = true;
    clearTimeout(this.timer); clearTimeout(this.disconnectTimer); clearTimeout(this.gatherTimer); this.gathered = [];
    this.reject(new Error('Connection closed.')); this.channel?.close(); this.pc.close(); this.pending = []; this.pendingBytes = 0; this.output = []; this.queuedBytes = 0; this.receiver = undefined;
  }
}
