import { ElectroMusic } from '../../audio/electro-music';
export { electroScoreStep as workshopScoreStep } from '../../audio/electro-music';
/** Original spatial machinery. Runtime music is owned by the application; standalone auditions can include it. */
export type WorkshopSound = 'servo' | 'release' | 'clamp' | 'seat' | 'ratchet' | 'steam';
export type WorkshopMotion = 'lift' | 'arm' | 'trolley';
type Point = readonly [number, number, number];
export interface WorkshopAudioSettings { master: number; music: number; sfx: number }
interface Voice { sources: AudioScheduledSourceNode[]; nodes: AudioNode[]; end: number; bus: 'sfx' | 'music' }
interface Loop { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode; air: BiquadFilterNode; amount: number; position: Point; level: number; ambient: boolean }
interface AudioOptions { context?: BaseAudioContext; offline?: boolean; music?: boolean; destination?: AudioNode }
const unit = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
const TAU = Math.PI * 2;
const SOURCES: Record<WorkshopMotion | 'fan' | 'boiler' | 'compressor', Point> = {
  lift: [0, .3, 0], arm: [-2.65, 1.7, -1], trolley: [-3.8, .7, .6],
  fan: [0, 4.2, -8.6], boiler: [5.05, 2, -5.7], compressor: [-5.3, .7, -6.3],
};
export function workshopSpatial(position: Point, eye: Point, target: Point) {
  const dx = position[0] - eye[0], dy = position[1] - eye[1], dz = position[2] - eye[2];
  const fx = target[0] - eye[0], fz = target[2] - eye[2], horizontal = Math.hypot(fx, fz) || 1, distance = Math.hypot(dx, dy, dz);
  return { pan: Math.max(-.85, Math.min(.85, (dx * -fz + dz * fx) / horizontal / Math.max(2, distance))),
    gain: 1 / (1 + Math.max(0, distance - 2) * .085), cutoff: Math.max(1800, 10500 / (1 + distance * .055)) };
}
export function workshopCueSpatial(kind: WorkshopSound, position: Point, eye: Point, target: Point) {
  const spatial = workshopSpatial(position, eye, target), distance = Math.hypot(...position.map((n, i) => n - eye[i]));
  return { ...spatial, gain: kind === 'steam' ? .17 * spatial.gain / (1 + Math.max(0, distance - 2) * .09) : .66 * spatial.gain,
    cutoff: kind === 'steam' ? Math.max(750, 2100 / (1 + distance * .075)) : spatial.cutoff };
}
/** Deterministic metal modes, ratchet teeth, motor harmonics and filtered pressure noise. */
export function workshopSoundSamples(kind: WorkshopSound, sampleRate: number): Float32Array {
  const duration = ({ servo: .32, release: .22, clamp: .28, seat: .48, ratchet: .34, steam: .95 })[kind];
  const samples = new Float32Array(Math.ceil(sampleRate * duration)); let seed = 0x581d, low = 0, previous = 0;
  for (let i = 0; i < samples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const white = seed / 2147483648 - 1, t = i / sampleRate;
    low += (white - low) * .16; const high = white - previous; previous = white; let value = 0;
    if (kind === 'steam') value = (low * .8 + high * .035) * Math.min(1, t / .075) * (1 - t / duration) ** 1.9;
    else if (kind === 'ratchet') value = (white * .18 + Math.sin(TAU * 1320 * t) * .22) * Math.exp(-((t * 38) % 1) * 13) * (1 - t / duration);
    else if (kind === 'servo') { const phase = TAU * (105 * t + 85 * t * t); value = (Math.sin(phase) * .10 + Math.sin(phase * 3) * .03 + low * .12) * Math.sin(Math.PI * t / duration) ** 2; }
    else {
      const root = kind === 'seat' ? 94 : kind === 'clamp' ? 176 : 325;
      value = (Math.sin(TAU * root * t) * .28 * Math.exp(-t * 18) + Math.sin(TAU * root * 2.71 * t) * .13 * Math.exp(-t * 24)
        + Math.sin(TAU * root * 4.13 * t) * .06 * Math.exp(-t * 42) + white * .32 * Math.exp(-t * 85)) * Math.min(1, t / .0015);
      if (kind === 'release') value += low * .45 * Math.exp(-t * 17) * Math.min(1, t / .009);
    }
    samples[i] = value * Math.min(1, (duration - t) / .015);
  }
  return samples;
}
let ownerId = 0;
export class WorkshopAudio {
  private context: BaseAudioContext | null;
  private master: GainNode | null = null; private sfx: GainNode | null = null; private music: GainNode | null = null;
  private output: DynamicsCompressorNode | null = null; private capture: MediaStreamAudioDestinationNode | null = null;
  private readonly nodes = new Set<AudioNode>(); private readonly voices = new Set<Voice>();
  private readonly loops = new Map<string, Loop>(); private readonly buffers = new Map<WorkshopSound, AudioBuffer>();
  private score: ElectroMusic | null = null;
  private levels: WorkshopAudioSettings; private readonly cleanups: (() => void)[] = [];
  private readonly token = `workshop-${++ownerId}`; private announced = false; private unlocked = false; private active = true; private disposed = false;
  private eye: Point = [-3, 3, 7]; private target: Point = [0, 1.4, 0];
  private cues = 0; private lastError: string | null = null;
  constructor(settings: number | WorkshopAudioSettings = .35, private readonly options: AudioOptions = {}) {
    this.context = options.context ?? null;
    this.levels = typeof settings === 'number' ? { master: 1, sfx: unit(settings), music: .35 } : { master: unit(settings.master), sfx: unit(settings.sfx), music: unit(settings.music) };
    if (!options.offline && typeof document !== 'undefined') {
      const visibility = () => this.setActive(!document.hidden);
      const changed = (event: Event) => { const audio = (event as CustomEvent).detail?.audio; if (audio) this.applySettings(audio); };
      document.addEventListener('visibilitychange', visibility); window.addEventListener('tmt:settings', changed);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', visibility), () => window.removeEventListener('tmt:settings', changed)); this.active = !document.hidden;
    }
  }
  private own<T extends AudioNode>(node: T): T { this.nodes.add(node); return node; }
  private forget(nodes: AudioNode[]): void { for (const node of nodes) { try { node.disconnect(); } catch { /* already released */ } this.nodes.delete(node); } }
  private announce(active: boolean): void {
    if (this.options.offline || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('tmt:workshop-audio', { detail: { active, token: this.token } })); this.announced = active;
  }
  unlock(): void {
    if (this.disposed || !this.active) return;
    try {
      if (!this.context) { if (typeof AudioContext === 'undefined') return; this.context = new AudioContext({ latencyHint: 'interactive' }); }
      if (!this.master) this.build(); this.unlocked = true;
      if (!this.announced) this.announce(true);
      if (!this.options.offline) void (this.context as AudioContext).resume().catch(error => { this.lastError = String(error); }); this.update();
    } catch (error) { this.lastError = String(error); }
  }
  private build(): void {
    const c = this.context!; this.master = this.own(c.createGain()); this.master.gain.value = .65;
    this.sfx = this.own(c.createGain()); this.music = this.own(c.createGain());
    const limiter = this.output = this.own(c.createDynamicsCompressor()); limiter.threshold.value = -14; limiter.knee.value = 9; limiter.ratio.value = 3; limiter.attack.value = .004; limiter.release.value = .22;
    this.sfx.connect(this.master); this.music.connect(this.master); this.master.connect(limiter); limiter.connect(this.options.destination ?? c.destination);
    const echo = this.own(c.createDelay(.5)), feedback = this.own(c.createGain()), damp = this.own(c.createBiquadFilter()), wet = this.own(c.createGain());
    echo.delayTime.value = .173; feedback.gain.value = .22; wet.gain.value = .13; damp.type = 'lowpass'; damp.frequency.value = 1700;
    this.sfx.connect(echo); echo.connect(damp); damp.connect(feedback); feedback.connect(echo); damp.connect(wet); wet.connect(this.master);
    this.applyLevels(); for (const name of Object.keys(SOURCES) as (keyof typeof SOURCES)[]) this.makeLoop(name);
    if (this.options.music ?? !!this.options.context) { this.score = new ElectroMusic(c, this.music, { mode: 'workshop', offline: this.options.offline }); this.score.setEnabled(this.levels.master * this.levels.music > 0); }
  }
  private makeLoop(kind: keyof typeof SOURCES): void {
    const c = this.context!, length = Math.round(c.sampleRate * 2), buffer = c.createBuffer(1, length, c.sampleRate), data = buffer.getChannelData(0);
    let seed = 7183 + this.loops.size * 911, brown = 0;
    const frequency = ({ lift: 60, arm: 96, trolley: 38, fan: 47, boiler: 50, compressor: 42 })[kind];
    const ambient = kind === 'fan' || kind === 'boiler' || kind === 'compressor';
    // Two seconds plus a 50 ms tail that is crossfaded into the head: the loop is seamless (no gap or click at the seam).
    const fade = Math.round(c.sampleRate * .05), raw = new Float32Array(length + fade);
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const t = i / c.sampleRate, noise = seed / 2147483648 - 1; brown += (noise - brown) * .055;
      // Machinery in motion ratchets (a fast pulse); the room's ambience only breathes (one slow swell per loop), never flutters.
      const mechanical = Math.sin(TAU * frequency * t) * .28 + Math.sin(TAU * frequency * 3 * t) * .055, pulse = ambient ? .92 + .08 * Math.cos(TAU * .5 * t) : .7 + .3 * Math.cos(TAU * 14 * t);
      raw[i] = (kind === 'boiler' ? brown * 1.3 : kind === 'trolley' ? brown * 1.6 + mechanical * .25 : kind === 'fan' ? brown * 1.2 + mechanical * .2 : mechanical + brown * .5) * pulse;
    }
    // The tones and pulses repeat exactly every 2 s, so a linear crossfade keeps them intact; the noise dips < 3 dB for 50 ms.
    for (let i = 0; i < length; i++) data[i] = i < fade ? raw[i] * (i / fade) + raw[length + i] * (1 - i / fade) : raw[i];
    const source = this.own(c.createBufferSource()), gain = this.own(c.createGain()), pan = this.own(c.createStereoPanner()), air = this.own(c.createBiquadFilter());
    source.buffer = buffer; source.loop = true; gain.gain.value = 0; air.type = 'lowpass'; air.frequency.value = 2400;
    source.connect(air); air.connect(gain); gain.connect(pan); pan.connect(this.sfx!); source.start();
    // The room tone sits well under the cues and the music; machinery is only heard while it moves.
    this.loops.set(kind, { source, gain, pan, air, amount: ambient ? 1 : 0, position: SOURCES[kind], level: ambient ? .05 : .32, ambient });
  }
  applySettings(settings: WorkshopAudioSettings): void { this.levels = { master: unit(settings.master), music: unit(settings.music), sfx: unit(settings.sfx) }; this.applyLevels(); }
  setVolume(volume: number): void { this.levels = { ...this.levels, master: 1, sfx: unit(volume) }; this.applyLevels(); }
  setMusicVolume(volume: number): void { this.levels = { ...this.levels, master: 1, music: unit(volume) }; this.applyLevels(); }
  private applyLevels(): void {
    this.score?.setEnabled(this.levels.master * this.levels.music > 0);
    const now = this.context?.currentTime ?? 0; this.sfx?.gain.setTargetAtTime(this.levels.master * this.levels.sfx, now, .04); this.music?.gain.setTargetAtTime(this.levels.master * this.levels.music, now, .08);
  }
  setListener(position: Point, target: Point): void { if ([...position, ...target].every(Number.isFinite)) { this.eye = position; this.target = target; } }
  setMotion(motion: Partial<Record<WorkshopMotion, number>>, positions: Partial<Record<WorkshopMotion, Point>> = {}): void {
    for (const kind of ['lift', 'arm', 'trolley'] as const) { const loop = this.loops.get(kind); if (!loop) continue; loop.amount = unit(motion[kind] ?? 0); if (positions[kind]) loop.position = positions[kind]!; }
  }
  setActive(active: boolean): void {
    this.active = active; const c = this.context as AudioContext | null; if (!c || this.options.offline || this.disposed || !this.unlocked) return;
    if (!active) { this.cancel(); void c.suspend().catch(error => { this.lastError = String(error); }); } else void c.resume().catch(error => { this.lastError = String(error); });
  }
  update(_time?: number): void {
    const c = this.context; if (!c || !this.unlocked || !this.active || this.disposed) return;
    for (const voice of [...this.voices]) if (voice.end <= c.currentTime) this.release(voice);
    for (const [name, loop] of this.loops) {
      const spatial = workshopSpatial(loop.position, this.eye, this.target);
      loop.gain.gain.setTargetAtTime(loop.level * loop.amount * spatial.gain, c.currentTime, .075); loop.pan.pan.setTargetAtTime(spatial.pan, c.currentTime, .08); loop.air.frequency.setTargetAtTime(loop.ambient ? Math.min(900, spatial.cutoff) : spatial.cutoff, c.currentTime, .15);
      if (name === 'lift' || name === 'arm' || name === 'trolley') loop.source.playbackRate.setTargetAtTime(.65 + loop.amount * .65, c.currentTime, .09);
    }
    this.score?.update();
  }
  private release(voice: Voice): void {
    if (!this.voices.delete(voice)) return;
    for (const source of voice.sources) { source.onended = null; try { source.stop(); } catch { /* ended */ } } this.forget(voice.nodes);
  }
  private admit(voice: Voice): void {
    if (this.voices.size >= 32 - (this.score?.liveVoices ?? 0) && !this.options.offline) { const oldest = this.voices.values().next().value; if (oldest) this.release(oldest); }
    this.voices.add(voice); voice.sources.at(-1)!.onended = () => this.release(voice);
  }
  play(kind: WorkshopSound, position: Point = SOURCES.arm, at?: number): void {
    const c = this.context; if (!c || !this.sfx || !this.unlocked || this.disposed || !this.active || this.levels.master * this.levels.sfx <= 0) return;
    let buffer = this.buffers.get(kind); if (!buffer) { const samples = workshopSoundSamples(kind, c.sampleRate); buffer = c.createBuffer(1, samples.length, c.sampleRate); buffer.getChannelData(0).set(samples); this.buffers.set(kind, buffer); }
    const now = Math.max(c.currentTime, at ?? c.currentTime), source = this.own(c.createBufferSource()), gain = this.own(c.createGain()), pan = this.own(c.createStereoPanner()), air = this.own(c.createBiquadFilter()), spatial = workshopCueSpatial(kind, position, this.eye, this.target);
    source.buffer = buffer; source.playbackRate.value = .98 + (this.cues % 5) * .01; gain.gain.value = spatial.gain; pan.pan.value = spatial.pan; air.type = 'lowpass'; air.frequency.value = spatial.cutoff; air.Q.value = .55;
    source.connect(air); air.connect(gain); gain.connect(pan); pan.connect(this.sfx); source.start(now); source.stop(now + buffer.duration / source.playbackRate.value + .01);
    this.admit({ sources: [source], nodes: [source, air, gain, pan], end: now + buffer.duration / source.playbackRate.value + .02, bus: 'sfx' }); this.cues++;
  }
  scheduleMusic(until: number): void { this.score?.scheduleUntil(until); }
  cancel(): void { for (const voice of [...this.voices]) if (voice.bus === 'sfx') this.release(voice); this.setMotion({}); if (this.context) for (const name of ['lift', 'arm', 'trolley']) this.loops.get(name)?.gain.gain.setTargetAtTime(0, this.context.currentTime, .025); }
  snapshot() { return { state: this.disposed ? 'disposed' : !this.unlocked ? 'locked' : this.context?.state, active: this.active, voices: this.voices.size + (this.score?.liveVoices ?? 0), nodes: this.nodes.size + (this.score?.nodeCount ?? 0), musicNotes: this.score?.notes ?? 0, cues: this.cues,
    musicOwner: this.score ? 'standalone' : 'application', levels: { ...this.levels }, motion: Object.fromEntries([...this.loops].filter(([name]) => ['lift', 'arm', 'trolley'].includes(name)).map(([name, loop]) => [name, loop.amount])), lastError: this.lastError }; }
  /** Optional recording tap. Consumers may clone tracks; this owner stops the originals on exit. */
  captureStream(): MediaStream | undefined {
    if (this.disposed || this.options.offline || !this.output) return;
    const context = this.context as AudioContext;
    if (!this.capture) { this.capture = this.own(context.createMediaStreamDestination()); this.output.connect(this.capture); }
    return this.capture.stream;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.cleanups.splice(0).forEach(cleanup => cleanup());
    for (const voice of [...this.voices]) this.release(voice);
    for (const loop of this.loops.values()) { try { loop.source.stop(); } catch { /* ended */ } }
    this.capture?.stream.getTracks().forEach(track => track.stop()); this.capture = null; this.output = null;
    this.loops.clear(); this.forget([...this.nodes]); this.buffers.clear(); this.score?.dispose(); if (this.announced) this.announce(false);
    if (!this.options.context) void (this.context as AudioContext | null)?.close().catch(() => {}); this.context = null; this.master = this.sfx = this.music = null;
  }
}
export function scheduleWorkshopAudioPreview(context: BaseAudioContext, seconds: number): WorkshopAudio {
  const audio = new WorkshopAudio({ master: .8, music: .65, sfx: .8 }, { context, offline: true });
  audio.unlock(); audio.setMotion({ lift: .55, arm: .3, trolley: .15 }); audio.update();
  for (const [at, cue] of [[1.3, 'release'], [2.1, 'clamp'], [3, 'ratchet'], [4.8, 'seat'], [6.1, 'steam'], [8, 'servo']] as [number, WorkshopSound][]) if (at < seconds) audio.play(cue, cue === 'steam' ? SOURCES.boiler : SOURCES.arm, at);
  audio.scheduleMusic(seconds); return audio;
}
