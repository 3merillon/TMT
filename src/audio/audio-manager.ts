// Ported from Pinionfall src/audio/audio-manager.ts (MIT, same owner)
/**
 * The AudioManager owns one AudioContext for music and SFX (one user-gesture gate) and everything built on it: the bus
 * graph, the shared noise pools, the listener, the voice budget and the per-bus burst caps. `play()` is the single
 * entry for one-shots: it spatialises, budgets and builds a recipe into a voice. Game semantics (which event plays
 * what) live in integrator.ts; the synth modules live in sfx/*.
 */
import { Buses, DEFAULT_VOLUMES, type Volumes } from './buses';
import { Listener, spatialParams, type SpatialParams } from './listener';
import { NoisePools } from './noise-pools';
import { Rng } from './rng';
import { playRecipe, Voice } from './sfx/layers';
import type { Recipe } from './sfx/tank-sfx-math';
import { validateRecipe } from './sfx/tank-sfx-math';
import { BUS_BURST, BUS_NAMES, LeakyBucket, MAX_SFX_VOICES, VoiceBudget, type BusName } from './voice-select';

type V3 = readonly [number, number, number];

export interface PlayOptions {
  bus: BusName;
  priority: number;
  /** World position: a spatial voice (gain, pan and air low-pass from the listener). Omitted = non-spatial. */
  position?: V3;
  /** Context time to start (default: now + 5 ms). */
  at?: number;
  /** Extra gain (non-spatial voices use it as their level). */
  gain?: number;
  /** Apply the bus burst cap (explosions, impacts, …). */
  burst?: boolean;
  /** Skip voices quieter than this at the listener (default 0.004 ≈ −48 dB). */
  minLoudness?: number;
}

export interface AudioManagerOptions { seed?: number; destination?: AudioNode; dev?: boolean }

const emptyCounts = (): Record<BusName, number> => Object.fromEntries(BUS_NAMES.map(b => [b, 0])) as Record<BusName, number>;

export class AudioManager {
  readonly buses: Buses;
  readonly pools: NoisePools;
  readonly listener = new Listener();
  readonly budget = new VoiceBudget(MAX_SFX_VOICES);
  rng: Rng;
  /** Cumulative voices started per bus, and the most voices ever live at once per bus. */
  readonly played = emptyCounts();
  readonly peakVoices = emptyCounts();
  private readonly live = emptyCounts();
  private readonly buckets = new Map<BusName, LeakyBucket>();
  private readonly scratch: SpatialParams = spatialParams();
  private readonly dev: boolean;
  private peakTotal = 0;
  nanRejected = 0;
  dropped = 0;
  lastError: string | null = null;

  constructor(readonly ctx: BaseAudioContext, o: AudioManagerOptions = {}) {
    this.rng = new Rng(o.seed ?? 0x51a7e);
    this.dev = o.dev ?? false;
    this.buses = new Buses(ctx, o.destination ?? ctx.destination);
    this.pools = new NoisePools(ctx, (o.seed ?? 0x51a7e) ^ 0x9e37);
    for (const [bus, spec] of Object.entries(BUS_BURST) as [BusName, readonly [number, number]][]) this.buckets.set(bus, new LeakyBucket(spec[0], spec[1]));
  }

  /** As if constructed with `seed`; only before anything has played (NoisePools.reseed). */
  reseed(seed: number): void {
    this.rng = new Rng(seed);
    this.pools.reseed(seed ^ 0x9e37);
  }

  now(): number { return this.ctx.currentTime; }

  /** Spatial parameters of a world point from the current listener (a shared scratch object: copy what you keep). */
  spatialize(p: V3): SpatialParams { return this.listener.spatialize(p, this.scratch); }

  /** Plays a recipe as one budgeted voice. Returns null when the voice was dropped (budget, burst cap, inaudible or
   * invalid input); a dropped voice allocates no nodes. */
  play(recipe: Recipe, o: PlayOptions): Voice | null {
    const now = this.ctx.currentTime;
    const at = Math.max(now, o.at ?? now + 0.005);
    let spatial: { gain: number; pan: number; lowpass: number } | undefined;
    let loudness = (o.gain ?? 1) * recipe.gain;
    if (o.position) {
      const s = this.spatialize(o.position);
      const gain = s.gain * (o.gain ?? 1);
      if (!Number.isFinite(gain) || !Number.isFinite(s.pan) || !Number.isFinite(s.lowpass)) { this.nanRejected++; return null; }
      spatial = { gain, pan: s.pan, lowpass: s.lowpass };
      loudness = gain * recipe.gain;
    }
    if (!Number.isFinite(loudness) || !Number.isFinite(at)) { this.nanRejected++; return null; }
    if (loudness < (o.minLoudness ?? 0.004)) { this.dropped++; return null; }
    if (this.dev) {
      const problems = validateRecipe(recipe);
      if (problems.length) { this.lastError = `invalid recipe on ${o.bus}: ${problems[0]}`; this.nanRejected++; return null; }
    }
    if (o.burst && this.buckets.get(o.bus)?.tryTake(now) === false) { this.dropped++; return null; }
    const voice = new Voice(this.ctx, this.buses.input[o.bus], { bus: o.bus, priority: o.priority, spatial, gain: o.gain });
    voice.loudness = loudness;
    voice.endAt = at + 30;                           // provisional (admit needs an end); playRecipe sets the real one
    if (!this.budget.admit(voice, now)) { voice.dispose(); this.dropped++; return null; }
    try { playRecipe(this.ctx, this.pools, voice, recipe, at); }
    catch (error) {
      // A thrown automation call (NaN, bad ramp) must never take the frame loop with it.
      this.budget.release(voice); voice.dispose();
      this.lastError = error instanceof Error ? error.message : String(error);
      this.nanRejected++;
      return null;
    }
    this.played[o.bus]++;
    this.noteLive();
    return voice;
  }

  /** Plays a sub-range of a decoded buffer (a bank sprite) as one budgeted voice: `offset`/`seconds` select the sprite,
   * `rate` pitches it, `loop` loops the sprite region. Null when dropped, exactly like play(). */
  playBuffer(buffer: AudioBuffer, offset: number, seconds: number, o: PlayOptions & { rate?: number; loop?: boolean }): Voice | null {
    const now = this.ctx.currentTime;
    const at = Math.max(now, o.at ?? now + 0.005);
    let spatial: { gain: number; pan: number; lowpass: number } | undefined;
    let loudness = o.gain ?? 1;
    if (o.position) {
      const s = this.spatialize(o.position);
      const gain = s.gain * (o.gain ?? 1);
      if (!Number.isFinite(gain) || !Number.isFinite(s.pan) || !Number.isFinite(s.lowpass)) { this.nanRejected++; return null; }
      spatial = { gain, pan: s.pan, lowpass: s.lowpass };
      loudness = gain;
    }
    if (!Number.isFinite(loudness) || !Number.isFinite(at) || !Number.isFinite(offset) || !(seconds > 0)) { this.nanRejected++; return null; }
    if (loudness < (o.minLoudness ?? 0.004)) { this.dropped++; return null; }
    if (o.burst && this.buckets.get(o.bus)?.tryTake(now) === false) { this.dropped++; return null; }
    const rate = o.rate && Number.isFinite(o.rate) && o.rate > 0 ? o.rate : 1;
    const voice = new Voice(this.ctx, this.buses.input[o.bus], { bus: o.bus, priority: o.priority, spatial, gain: o.gain, persistent: o.loop });
    voice.loudness = loudness;
    voice.endAt = o.loop ? Infinity : at + seconds / rate + 0.05;
    if (!this.budget.admit(voice, now)) { voice.dispose(); this.dropped++; return null; }
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      if (o.loop) { src.loop = true; src.loopStart = offset; src.loopEnd = offset + seconds; src.start(at, offset); }
      else src.start(at, offset, seconds);
      src.connect(voice.out);
      voice.sources.push(src); voice.nodes.push(src);
      voice.builtEnd = voice.endAt;
    } catch (error) {
      this.budget.release(voice); voice.dispose();
      this.lastError = error instanceof Error ? error.message : String(error);
      this.nanRejected++;
      return null;
    }
    this.played[o.bus]++;
    this.noteLive();
    return voice;
  }

  /** Admits a loop voice (engine slot, whistle, wind): persistent, never stolen by one-shots. */
  admitLoop(voice: Voice): boolean {
    const ok = this.budget.admit(voice, this.ctx.currentTime);
    if (ok) { this.played[voice.bus]++; this.noteLive(); }
    return ok;
  }
  releaseLoop(voice: Voice): void { this.budget.release(voice); this.noteLive(); }

  private noteLive(): void {
    this.budget.countByBus(this.live);
    let total = 0;
    for (const bus of BUS_NAMES) { total += this.live[bus]; if (this.live[bus] > this.peakVoices[bus]) this.peakVoices[bus] = this.live[bus]; }
    if (total > this.peakTotal) this.peakTotal = total;
  }

  /** Per frame: disposes finished voices and reads the meters. */
  update(): void {
    this.budget.prune(this.ctx.currentTime);
    this.noteLive();
    this.buses.readMeters(this.ctx.currentTime);
  }

  setVolumes(v: Volumes): void { this.buses.setVolumes(v, this.ctx.currentTime); }
  /** Ducks the music bus at context time `at` (a big boom's arrival). */
  duck(at: number): void { this.buses.duckMusic(at); }
  /** Dialogue ducking: music and world effects step down while a line plays. */
  setDialogue(active: boolean): void { this.buses.setDialogue(active, this.ctx.currentTime); }
  /** Alert ducking: world effects step aside briefly for an incoming-fire warning. */
  alertDuck(at: number): void { this.buses.alertDuck(at); }

  voiceTelemetry(extraMusic = 0) {
    this.noteLive();
    const buses = { ...this.live, music: this.live.music + extraMusic };
    let total = 0;
    for (const bus of BUS_NAMES) if (bus !== 'music') total += this.live[bus];
    return { total, max: this.budget.max, buses, peak: { total: this.peakTotal, buses: { ...this.peakVoices } }, stolen: this.budget.stolen, rejected: this.budget.rejected };
  }

  dispose(): void {
    this.budget.clear(this.ctx.currentTime);
    this.buses.dispose();
  }
}

export { DEFAULT_VOLUMES };
