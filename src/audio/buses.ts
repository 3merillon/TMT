// Ported from Pinionfall src/audio/spatial-audio.ts (bus graph, applyMasterGain) and src/audio/audio-manager.ts (MIT, same owner)
/**
 * The bus graph (portmap audio-fx-materials §1.3), with the limiter Pinionfall's SFX master lacked:
 *
 *   weapons ─┐
 *   explosions, vehicles, impacts, projectiles, ambience, water ─┴→ sfx ─┐
 *   ui ──────────────────────────────────────────────────────────→ ui ──┤
 *   music → duck (−6 dB for 0.25 s on big booms, 1.2 s recovery) ─→ music ┼→ master → fade (0.6 s) → limiter
 *   voice ───────────────────────────────────────────────────────→ voice ┘      (−6 dB, ratio 20) → trim → meter → out
 *
 * Every bus has a tap meter (AnalyserNode) for `busPeaks`; the master meter after the trim measures what reaches the
 * destination (peak dBFS, clip count, NaN). User volumes (tmt:settings) ride the group gains, the fade-in rides its own
 * node, so a volume change never cancels the unlock fade.
 */
import { BUS_NAMES, type BusName } from './voice-select';

/** Fixed mix trims per bus (the user sliders ride the group gains). */
export const BUS_TRIM: Readonly<Record<BusName, number>> = {
  music: 0.55, ui: 0.9, alerts: 1.1, weapons: 1.0, explosions: 1.4, vehicles: 0.55, impacts: 0.85, projectiles: 0.7, ambience: 0.8, water: 0.7, voice: 1,
};
type Group = 'sfx' | 'ui' | 'music' | 'voice';
const GROUP_OF: Readonly<Record<BusName, Group>> = {
  music: 'music', ui: 'ui', alerts: 'ui', voice: 'voice', weapons: 'sfx', explosions: 'sfx', vehicles: 'sfx', impacts: 'sfx', projectiles: 'sfx', ambience: 'sfx', water: 'sfx',
};
/** Dialogue ducking: music drops to −8 dB and world effects to −4 dB while a line plays (the voice bus is untouched);
 * an incoming-fire alert dips world effects −3 dB for 0.35 s so the warning always reads. */
export const DIALOGUE_DUCK = { music: 0.4, sfx: 0.63, attack: 0.12, release: 0.35 } as const;
export const ALERT_DUCK = { depth: 0.7, hold: 0.35, release: 0.5 } as const;
export const LIMITER = { threshold: -6, knee: 0, ratio: 20, attack: 0.003, release: 0.12 } as const;
/** Post-limiter trim: the compressor's automatic makeup gain lifts its ceiling to about −2 dBFS; −1.5 dB keeps the
 * output under −1 dBFS. */
export const OUTPUT_TRIM = 0.84;
export const MASTER_FADE_IN_S = 0.6;
/** World SFX headroom on top of the sfx slider (Pinionfall ran its SFX master at 3.0): the layer peaks are authored
 * conservatively and the inverse-distance law is steep at diorama scale, so the world group runs hot and the limiter
 * catches the biggest booms. */
export const SFX_HEADROOM = 2.5;

export interface Volumes { master: number; music: number; sfx: number; ui: number; voice: number }
export const DEFAULT_VOLUMES: Readonly<Volumes> = { master: 0.8, music: 0.5, sfx: 0.85, ui: 0.7, voice: 0.8 };
/** Reads `detail.audio` of a tmt:settings event. Accepts 0..1 or 0..100 sliders; absent or invalid values keep the
 * defaults. */
export function volumesFrom(audio: unknown, base: Readonly<Volumes> = DEFAULT_VOLUMES): Volumes {
  const out: Volumes = { ...base };
  if (!audio || typeof audio !== 'object') return out;
  const src = audio as Record<string, unknown>;
  for (const key of ['master', 'music', 'sfx', 'ui', 'voice'] as const) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const unit = v > 1 ? v / 100 : v;
    out[key] = unit < 0 ? 0 : unit > 1 ? 1 : unit;
  }
  return out;
}

// ---- Ducking (pure) ---------------------------------------------------------------------------------------------------
export const DUCK = { depthDb: -6, attack: 0.03, hold: 0.25, release: 1.2 } as const;
/** Music-bus gain `t` seconds after a duck trigger (starting from `from`): down to −6 dB in 30 ms, held 0.25 s, then a
 * 1.2 s linear recovery to 1. */
export function duckGainAt(t: number, from = 1, d = DUCK): number {
  const low = 10 ** (d.depthDb / 20);
  if (!(t >= 0)) return from;
  if (t < d.attack) return from + (Math.min(from, low) - from) * (t / d.attack);
  const bottom = Math.min(from, low);
  if (t < d.attack + d.hold) return bottom;
  const r = (t - d.attack - d.hold) / d.release;
  return r >= 1 ? 1 : bottom + (1 - bottom) * r;
}
/** Schedules the duck envelope on an AudioParam at context time `at`, starting from the param's current value. */
export function scheduleDuck(param: AudioParam, at: number, from: number, d = DUCK): void {
  const low = Math.min(from, 10 ** (d.depthDb / 20));
  param.cancelScheduledValues(at);
  param.setValueAtTime(from, at);
  param.linearRampToValueAtTime(low, at + d.attack);
  param.setValueAtTime(low, at + d.attack + d.hold);
  param.linearRampToValueAtTime(1, at + d.attack + d.hold + d.release);
}

// ---- Meters -----------------------------------------------------------------------------------------------------------
export const METER_FLOOR_DB = -120;
export function toDb(peak: number): number { return peak > 1e-6 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(peak)) : METER_FLOOR_DB; }
/** A sample at or above this magnitude at the destination counts as clipping. */
export const CLIP_LEVEL = 0.999;
/** Minimum audio time between meter reads (s): shorter than the 2048-sample master window at 44.1-48 kHz. */
export const METER_INTERVAL_S = 0.025;

class Meter {
  private readonly data: Float32Array<ArrayBuffer>;
  /** Peak-hold (linear), decaying ~20 dB/s. */
  hold = 0;
  constructor(readonly node: AnalyserNode) { this.data = new Float32Array(node.fftSize); }
  /** Reads the latest window; returns its peak (NaN when a non-finite sample was seen). */
  read(): number {
    this.node.getFloatTimeDomainData(this.data);
    let peak = 0;
    const d = this.data;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      else if (a !== a) return NaN;
    }
    return peak;
  }
  decay(dt: number): void { this.hold *= 10 ** (-20 * Math.max(0, dt) / 20); }
}

export class Buses {
  readonly input: Record<BusName, GainNode>;
  readonly groups: Record<Group, GainNode>;
  readonly duck: GainNode;
  /** Dialogue ducks (music path and world-effects path) and the alert duck on world effects. */
  readonly musicDialogue: GainNode;
  readonly sfxDialogue: GainNode;
  readonly sfxAlert: GainNode;
  readonly master: GainNode;
  readonly fade: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly trim: GainNode;
  private readonly meters: Record<BusName, Meter>;
  private readonly masterMeter: Meter;
  private meterCursor = 0;
  private lastMeterAt = -1;
  /** Highest destination peak since the graph was built (linear). */
  peakMax = 0;
  clipCount = 0;
  nanCount = 0;
  volumes: Volumes = { ...DEFAULT_VOLUMES };

  constructor(private readonly ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    const gain = (v: number) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.trim = gain(OUTPUT_TRIM);
    const meterNode = ctx.createAnalyser();
    meterNode.fftSize = 2048;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMITER.threshold;
    this.limiter.knee.value = LIMITER.knee;
    this.limiter.ratio.value = LIMITER.ratio;
    this.limiter.attack.value = LIMITER.attack;
    this.limiter.release.value = LIMITER.release;
    this.fade = gain(0);
    this.master = gain(this.volumes.master);
    this.master.connect(this.fade); this.fade.connect(this.limiter); this.limiter.connect(this.trim);
    this.trim.connect(meterNode); this.trim.connect(destination);
    this.masterMeter = new Meter(meterNode);
    this.duck = gain(1);
    this.musicDialogue = gain(1); this.sfxDialogue = gain(1); this.sfxAlert = gain(1);
    this.groups = { sfx: gain(this.volumes.sfx * SFX_HEADROOM), ui: gain(this.volumes.ui), music: gain(this.volumes.music), voice: gain(this.volumes.voice) };
    this.groups.ui.connect(this.master); this.groups.music.connect(this.master); this.groups.voice.connect(this.master);
    // World effects: group → dialogue duck → alert duck → master.
    this.groups.sfx.connect(this.sfxDialogue); this.sfxDialogue.connect(this.sfxAlert); this.sfxAlert.connect(this.master);
    // Music: bus → boom duck → dialogue duck → group.
    this.duck.connect(this.musicDialogue); this.musicDialogue.connect(this.groups.music);
    const input = {} as Record<BusName, GainNode>, meters = {} as Record<BusName, Meter>;
    for (const bus of BUS_NAMES) {
      const node = gain(BUS_TRIM[bus]);
      node.connect(bus === 'music' ? this.duck : this.groups[GROUP_OF[bus]]);
      const tap = ctx.createAnalyser();
      tap.fftSize = 1024;
      node.connect(tap);
      input[bus] = node;
      meters[bus] = new Meter(tap);
    }
    this.input = input;
    this.meters = meters;
  }

  /** The unlock fade: 0 → 1 over 0.6 s, which swallows the activation pop. */
  fadeIn(at: number): void {
    const p = this.fade.gain;
    p.cancelScheduledValues(at);
    p.setValueAtTime(0, at);
    p.linearRampToValueAtTime(1, at + MASTER_FADE_IN_S);
  }

  setVolumes(v: Volumes, at: number): void {
    this.volumes = { ...v };
    const set = (node: GainNode, value: number) => { node.gain.cancelScheduledValues(at); node.gain.setTargetAtTime(value, at, 0.05); };
    set(this.master, v.master);
    set(this.groups.sfx, v.sfx * SFX_HEADROOM);
    set(this.groups.ui, v.ui);
    set(this.groups.music, v.music);
    set(this.groups.voice, v.voice);
  }

  /** Ducks the music bus −6 dB for 0.25 s at context time `at` (the boom's arrival). */
  duckMusic(at: number): void { scheduleDuck(this.duck.gain, Math.max(at, this.ctx.currentTime), Math.min(1, Math.max(0.01, this.duck.gain.value))); }
  /** Dialogue on/off: smooth ducks that never cancel the boom duck or the user's volume ramps. */
  setDialogue(active: boolean, at: number): void {
    const tc = active ? DIALOGUE_DUCK.attack : DIALOGUE_DUCK.release;
    for (const [node, low] of [[this.musicDialogue, DIALOGUE_DUCK.music], [this.sfxDialogue, DIALOGUE_DUCK.sfx]] as const) { node.gain.cancelScheduledValues(at); node.gain.setTargetAtTime(active ? low : 1, at, tc); }
  }
  /** A short dip of the world effects under an alert cue. */
  alertDuck(at: number): void {
    const g = this.sfxAlert.gain, t0 = Math.max(at, this.ctx.currentTime);
    g.cancelScheduledValues(t0); g.setValueAtTime(Math.min(1, Math.max(0.01, g.value)), t0); g.linearRampToValueAtTime(ALERT_DUCK.depth, t0 + 0.02);
    g.setValueAtTime(ALERT_DUCK.depth, t0 + 0.02 + ALERT_DUCK.hold); g.linearRampToValueAtTime(1, t0 + 0.02 + ALERT_DUCK.hold + ALERT_DUCK.release);
  }

  /** Reads the meters, spaced in audio time rather than per frame: the master window (2048 samples, ~43 ms at 48 kHz)
   * is read every ≥ 25 ms so no destination sample escapes it; two bus meters per read, round-robin. */
  readMeters(now: number): void {
    if (this.lastMeterAt >= 0 && now - this.lastMeterAt < METER_INTERVAL_S) return;
    const dt = this.lastMeterAt < 0 ? 0 : now - this.lastMeterAt;
    this.lastMeterAt = now;
    const peak = this.masterMeter.read();
    if (peak !== peak) this.nanCount++;
    else {
      if (peak > this.peakMax) this.peakMax = peak;
      if (peak >= CLIP_LEVEL) this.clipCount++;
      this.masterMeter.decay(dt);
      if (peak > this.masterMeter.hold) this.masterMeter.hold = peak;
    }
    for (const bus of BUS_NAMES) this.meters[bus].decay(dt);
    for (let k = 0; k < 2; k++) {
      const bus = BUS_NAMES[this.meterCursor];
      this.meterCursor = (this.meterCursor + 1) % BUS_NAMES.length;
      const m = this.meters[bus], v = m.read();
      if (v !== v) this.nanCount++;
      else if (v > m.hold) m.hold = v;
    }
  }

  /** Peak-hold per bus and at the master, in dBFS (floor −120). */
  peaksDb(): Record<BusName | 'master', number> {
    const out = { master: round1(toDb(this.masterMeter.hold)) } as Record<BusName | 'master', number>;
    for (const bus of BUS_NAMES) out[bus] = round1(toDb(this.meters[bus].hold));
    return out;
  }

  dispose(): void {
    try { this.trim.disconnect(); } catch { /* already disconnected */ }
    try { this.master.disconnect(); } catch { /* already disconnected */ }
  }
}
const round1 = (v: number) => Math.round(v * 10) / 10;
