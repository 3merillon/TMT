/**
 * The score player: one persistent transport that plays pre-rendered, sample-synchronized layer stems. A track is a
 * deck of looping AudioBufferSourceNodes (one per layer, identical loop points) started at the same context time, so
 * layers stay phase-locked and only their gains move. Track changes are cut on the OUTGOING deck's next bar or beat
 * (a short fade-out ending exactly where the new track starts, never a blend of two tempos); repeated requests for the
 * playing track never restart it. Buffers are fetched and decoded lazily through a
 * StemLoader and kept in a byte-bounded cache; stingers are one-shots on the same output.
 */
import type { ScoreManifest, ScoreTrack } from './manifest';

export interface StemLoader { load(file: string): Promise<AudioBuffer> }
export interface PlayerOptions { cacheBytes?: number; crossfadeSec?: number; layerRampSec?: number; offline?: boolean }
interface Deck { id: string; track: ScoreTrack; sources: AudioBufferSourceNode[]; gains: GainNode[]; master: GainNode; startedAt: number; barSec: number; loopStart: number; loopEnd: number; weights: number[]; stopAt: number }
export type Quantize = 'bar' | 'beat';
export interface RequestOptions { fade?: number; quantize?: Quantize }
interface Pending { id: string; layers: number[]; intro: boolean; fade?: number; quantize: Quantize }
/** Equal-power crossfade curves (64 points): the outgoing track follows cos, the incoming sin, so the sum keeps its level. */
const CURVE_N = 64;
const FADE_OUT = Float32Array.from({ length: CURVE_N }, (_, i) => Math.max(0.0001, Math.cos(i / (CURVE_N - 1) * Math.PI / 2)));
const FADE_IN = Float32Array.from({ length: CURVE_N }, (_, i) => Math.max(0.0001, Math.sin(i / (CURVE_N - 1) * Math.PI / 2)));
function fadeParam(p: AudioParam, at: number, seconds: number, curve: Float32Array, from: number): void {
  p.cancelScheduledValues(at);
  if (typeof (p as { setValueCurveAtTime?: unknown }).setValueCurveAtTime === 'function') {
    const scaled = from === 1 ? curve : Float32Array.from(curve, v => v * from);
    p.setValueAtTime(scaled[0], at); p.setValueCurveAtTime(scaled, at, Math.max(0.01, seconds));
  } else { p.setValueAtTime(curve[0] * from, at); p.linearRampToValueAtTime(curve[CURVE_N - 1] * from, at + Math.max(0.01, seconds)); }
}

export const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;

export class ScorePlayer {
  private deck: Deck | null = null;
  private retiring: Deck[] = [];
  private pending: Pending | null = null;
  private readonly buffers = new Map<string, { buffer: AudioBuffer; bytes: number; used: number }>();
  private readonly loading = new Map<string, Promise<AudioBuffer>>();
  private readonly pinned = new Set<string>();
  /** Loop position (seconds into the file) each track was last heard at, so a return resumes instead of restarting. */
  private readonly positions = new Map<string, number>();
  private cacheBytes = 0;
  private use = 0;
  readonly out: GainNode;
  private readonly stingerOut: GainNode;
  private muted = false;
  private level = 1;
  transitions = 0; loads = 0; decodeErrors = 0; stingers = 0; lastError: string | null = null;
  /** Context time the last stinger was scheduled (so UI thuds can yield to a musical hit). */
  lastStingerAt = -Infinity;
  constructor(readonly ctx: BaseAudioContext, destination: AudioNode, readonly manifest: ScoreManifest, private readonly loader: StemLoader, private readonly o: PlayerOptions = {}) {
    this.out = ctx.createGain(); this.out.gain.value = 1; this.out.connect(destination);
    this.stingerOut = ctx.createGain(); this.stingerOut.gain.value = 1; this.stingerOut.connect(destination);
  }
  get current(): string | null { return this.deck?.id ?? null; }
  get playing(): boolean { return this.deck !== null; }
  get sourceCount(): number { return (this.deck?.sources.length ?? 0) + this.retiring.reduce((a, d) => a + d.sources.length, 0); }
  has(id: string): boolean { return !!this.manifest.tracks[id]; }
  /** Position inside the playing track (seconds since its start, loop-wrapped) and the bar index. */
  position(): { seconds: number; bar: number } | null {
    const d = this.deck; if (!d) return null;
    const t = this.ctx.currentTime - d.startedAt;
    const loopLen = d.loopEnd - d.loopStart;
    const pos = t < d.loopEnd ? t : d.loopStart + ((t - d.loopStart) % loopLen);
    return { seconds: pos, bar: Math.floor(pos / d.barSec) };
  }

  /** Requests a track with layer weights. Same track: ramps the layers. Different track: loads it, then enters on the
   * outgoing deck's next bar with a crossfade. Latest request wins. */
  request(id: string | null, layers: readonly number[], intro: boolean, o: RequestOptions = {}): void {
    if (id === null) { this.pending = null; if (this.deck) this.retire(this.deck, this.ctx.currentTime, 0.3); this.deck = null; return; }
    const track = this.manifest.tracks[id];
    if (!track) { this.lastError = `unknown track ${id}`; return; }
    if (this.deck && this.deck.id === id) { this.pending = null; this.setLayers(this.deck, layers); return; }
    if (this.pending && this.pending.id === id) { this.pending.layers = [...layers]; return; }
    this.pending = { id, layers: [...layers], intro, fade: o.fade, quantize: o.quantize ?? 'bar' };
    void this.prefetch(id).then(() => this.tryStart()).catch(e => { this.lastError = String(e); });
  }
  /** Loads every layer of a track into the cache (pinned until another prefetch replaces it). */
  async prefetch(id: string): Promise<void> {
    const track = this.manifest.tracks[id]; if (!track) return;
    for (const stem of track.stems) this.pinned.add(stem.file);
    await Promise.all(track.stems.map(s => this.buffer(s.file)));
  }
  /** Drives pending starts and retirements. Called from the owner's timer. */
  tick(): void { this.tryStart(); this.sweep(); }
  setLevel(level: number): void { this.level = level; this.applyLevel(); }
  setMuted(muted: boolean): void { this.muted = muted; this.applyLevel(); }
  private applyLevel(): void { const g = this.muted ? 0 : this.level, now = this.ctx.currentTime; this.out.gain.cancelScheduledValues(now); this.out.gain.setTargetAtTime(g, now, 0.25); this.stingerOut.gain.setTargetAtTime(g, now, 0.25); }

  /** Fires a one-shot stinger, aligned to the next beat of the playing deck when `quantize` is set. */
  playStinger(id: string, quantize = true): void {
    const track = this.manifest.tracks[id]; if (!track) return;
    const file = track.stems[0]?.file; if (!file) return;
    void this.buffer(file).then(buffer => {
      const now = this.ctx.currentTime;
      let at = now + 0.01;
      if (quantize && this.deck) { const beat = this.deck.barSec / this.deck.track.beatsPerBar; at = this.deck.startedAt + Math.ceil((now - this.deck.startedAt + 0.02) / beat) * beat; }
      const src = this.ctx.createBufferSource(); src.buffer = buffer; src.connect(this.stingerOut); src.start(at); src.onended = () => { try { src.disconnect(); } catch { /* gone */ } };
      this.stingers++; this.lastStingerAt = at;
    }).catch(e => { this.lastError = String(e); });
  }

  /** The outgoing deck's next bar (combat/exploration changes) or next beat (menu changes, which must feel responsive),
   * at least `lead` seconds away so the outgoing fade can finish ON that boundary. */
  private quantize(mode: Quantize = 'bar', lead = 0): number {
    const now = this.ctx.currentTime, d = this.deck;
    if (!d) return now + 0.02;
    const elapsed = now - d.startedAt + lead;
    const bar = d.barSec, beat = bar / d.track.beatsPerBar;
    if (mode === 'beat') return d.startedAt + Math.ceil(elapsed / beat) * beat;
    const next = d.startedAt + Math.ceil(elapsed / bar) * bar;
    // Never wait more than one bar; a very long bar (slow tempos) still enters within ~2.5 s on a beat.
    if (next - now > 2.6) return d.startedAt + Math.ceil(elapsed / beat) * beat;
    return next;
  }
  private tryStart(): void {
    const p = this.pending; if (!p) return;
    const track = this.manifest.tracks[p.id];
    if (!track.stems.every(s => this.buffers.has(s.file))) return;
    if (!this.o.offline && this.ctx.state !== 'running') return;
    this.pending = null;
    // A cut on the beat, not a blend: tracks have different tempos, so overlapping them sounds jumbled. The outgoing
    // deck fades over its last `lead` seconds and ends exactly on the boundary where the incoming deck starts.
    const lead = p.fade ?? this.o.crossfadeSec ?? 0.3;
    const at = this.quantize(p.quantize, lead + 0.03);
    if (this.deck) this.retire(this.deck, at - lead, lead);
    this.deck = this.start(track, p.layers, p.intro, at, 0.05);
    this.transitions++;
  }
  private start(track: ScoreTrack, layers: readonly number[], intro: boolean, at: number, fadeIn: number): Deck {
    const ctx = this.ctx, master = ctx.createGain();
    master.gain.value = 0.0001;
    if (fadeIn <= 0.1) { master.gain.setValueAtTime(0.0001, at); master.gain.linearRampToValueAtTime(1, at + Math.max(0.02, fadeIn)); }
    else fadeParam(master.gain, at, fadeIn, FADE_IN, 1);
    master.connect(this.out);
    const barSec = 60 / track.bpm * track.beatsPerBar;
    const sources: AudioBufferSourceNode[] = [], gains: GainNode[] = [];
    const offset = intro ? 0 : this.resumeOffset(track, barSec);
    // All layers must share one length for lock-step looping: use the shortest decoded duration for the loop end.
    let loopEnd = track.loopEndSec;
    for (const s of track.stems) { const b = this.buffers.get(s.file)!; this.touch(s.file); loopEnd = Math.min(loopEnd, b.buffer.duration); }
    const weights = track.stems.map(s => layers[s.layer] ?? 0);
    track.stems.forEach((s, i) => {
      const src = ctx.createBufferSource(); src.buffer = this.buffers.get(s.file)!.buffer;
      if (track.kind !== 'stinger') { src.loop = true; src.loopStart = track.loopStartSec; src.loopEnd = loopEnd; }
      const g = ctx.createGain(); g.gain.value = weights[i];
      src.connect(g); g.connect(master);
      src.start(at, offset);
      sources.push(src); gains.push(g);
    });
    return { id: track.id, track, sources, gains, master, startedAt: at - offset, barSec, loopStart: track.loopStartSec, loopEnd, weights, stopAt: Infinity };
  }
  private setLayers(d: Deck, layers: readonly number[]): void {
    const now = this.ctx.currentTime, ramp = this.o.layerRampSec ?? 0.7;
    d.track.stems.forEach((s, i) => {
      const w = Math.max(0, Math.min(1, layers[s.layer] ?? 0));
      if (Math.abs(w - d.weights[i]) < 0.005) return;
      d.weights[i] = w;
      const g = d.gains[i].gain; g.cancelScheduledValues(now); g.setTargetAtTime(w, now, ramp / 3);
    });
  }
  /** Where a track resumes when it is not entering by its intro: its remembered loop position snapped to a bar, else the loop start. */
  private resumeOffset(track: ScoreTrack, barSec: number): number {
    const remembered = this.positions.get(track.id);
    if (remembered === undefined || track.kind === 'stinger') return track.loopStartSec;
    const loopLen = Math.max(barSec, track.loopEndSec - track.loopStartSec);
    const bars = Math.floor(Math.max(0, remembered - track.loopStartSec) / barSec);
    const offset = track.loopStartSec + (bars * barSec) % loopLen;
    return offset > track.loopEndSec - barSec * 0.5 ? track.loopStartSec : offset;
  }
  private retire(d: Deck, at: number, fade = 0.3): void {
    // Remember where this track was at the switch, so a return resumes there instead of restarting its intro.
    const t = at + fade - d.startedAt, loopLen = Math.max(0.001, d.loopEnd - d.loopStart);
    this.positions.set(d.id, t < d.loopEnd ? Math.max(0, t) : d.loopStart + ((t - d.loopStart) % loopLen));
    fadeParam(d.master.gain, at, fade, FADE_OUT, Math.min(1, Math.max(0.0001, d.master.gain.value)));
    d.stopAt = at + fade + 0.05;
    for (const s of d.sources) { try { s.stop(d.stopAt); } catch { /* already stopped */ } }
    this.retiring.push(d);
  }
  private sweep(): void {
    const now = this.ctx.currentTime;
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      const d = this.retiring[i];
      if (now < d.stopAt + 0.1) continue;
      for (const n of [...d.sources, ...d.gains, d.master]) { try { n.disconnect(); } catch { /* gone */ } }
      this.retiring.splice(i, 1);
    }
  }
  // ---- cache ------------------------------------------------------------------------------------------------------------
  private async buffer(file: string): Promise<AudioBuffer> {
    const hit = this.buffers.get(file);
    if (hit) { this.touch(file); return hit.buffer; }
    let p = this.loading.get(file);
    if (!p) {
      p = this.loader.load(file).then(buffer => {
        const bytes = buffer.length * buffer.numberOfChannels * 4;
        this.buffers.set(file, { buffer, bytes, used: ++this.use }); this.cacheBytes += bytes; this.loads++;
        this.evict();
        return buffer;
      }).catch(e => { this.decodeErrors++; this.lastError = `load ${file}: ${e instanceof Error ? e.message : String(e)}`; throw e; }).finally(() => this.loading.delete(file));
      this.loading.set(file, p);
    }
    return p;
  }
  private touch(file: string): void { const e = this.buffers.get(file); if (e) e.used = ++this.use; }
  /** Evicts least-recently-used buffers that no deck or pin holds, down to the byte bound. */
  private evict(): void {
    const bound = this.o.cacheBytes ?? DEFAULT_CACHE_BYTES;
    const held = new Set<string>();
    for (const d of [this.deck, ...this.retiring]) if (d) for (const s of d.track.stems) held.add(s.file);
    if (this.pending) for (const s of this.manifest.tracks[this.pending.id].stems) held.add(s.file);
    while (this.cacheBytes > bound) {
      let victim: string | null = null, oldest = Infinity;
      for (const [file, e] of this.buffers) if (!held.has(file) && !this.pinned.has(file) && e.used < oldest) { oldest = e.used; victim = file; }
      if (!victim) { for (const [file, e] of this.buffers) if (!held.has(file) && e.used < oldest) { oldest = e.used; victim = file; } }
      if (!victim) return;
      this.cacheBytes -= this.buffers.get(victim)!.bytes; this.buffers.delete(victim); this.pinned.delete(victim);
    }
  }
  /** Drops pins from tracks other than `keep` so their buffers become evictable. */
  pinOnly(keep: readonly string[]): void {
    const files = new Set<string>();
    for (const id of keep) for (const s of this.manifest.tracks[id]?.stems ?? []) files.add(s.file);
    for (const f of [...this.pinned]) if (!files.has(f)) this.pinned.delete(f);
    this.evict();
  }
  snapshot() {
    const pos = this.position();
    return { track: this.deck?.id ?? null, pending: this.pending?.id ?? null, layers: this.deck?.weights ?? [], bar: pos?.bar ?? -1, seconds: pos ? Math.round(pos.seconds * 100) / 100 : -1, retiring: this.retiring.length, sources: this.sourceCount,
      cacheBytes: this.cacheBytes, cached: this.buffers.size, loading: this.loading.size, loads: this.loads, decodeErrors: this.decodeErrors, transitions: this.transitions, stingers: this.stingers, lastError: this.lastError };
  }
  dispose(): void {
    const now = this.ctx.currentTime;
    for (const d of [this.deck, ...this.retiring]) if (d) { for (const s of d.sources) { try { s.stop(now); } catch { /* ok */ } } for (const n of [...d.sources, ...d.gains, d.master]) { try { n.disconnect(); } catch { /* ok */ } } }
    this.deck = null; this.retiring = []; this.pending = null;
    this.buffers.clear(); this.cacheBytes = 0;
    try { this.out.disconnect(); this.stingerOut.disconnect(); } catch { /* ok */ }
  }
}

/** Fetches `audio/music/<file>` and decodes it. Decoding through a dedicated OfflineAudioContext at `decodeRate`
 * (32 kHz by default) halves resident memory versus the 48 kHz context rate; the source nodes resample on playback. */
export class FetchStemLoader implements StemLoader {
  private decoder: BaseAudioContext | null = null;
  constructor(private readonly ctx: BaseAudioContext, private readonly baseUrl: string, private readonly decodeRate = 32000) {}
  async load(file: string): Promise<AudioBuffer> {
    const response = await fetch(`${this.baseUrl}audio/music/${file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    return this.decode(bytes);
  }
  private decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.decoder) {
      try { const Ctor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext; this.decoder = Ctor && this.decodeRate !== this.ctx.sampleRate ? new Ctor(2, 1, this.decodeRate) : this.ctx; }
      catch { this.decoder = this.ctx; }
    }
    return this.decoder.decodeAudioData(bytes).catch(async error => {
      // A browser that rejects the reduced-rate decoder falls back to the context's own rate.
      if (this.decoder !== this.ctx) { this.decoder = this.ctx; return this.ctx.decodeAudioData(bytes); }
      throw error;
    });
  }
}
