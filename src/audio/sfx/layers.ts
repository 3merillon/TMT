// Ported from Pinionfall src/audio/spatial-audio.ts (combatNoiseVoice, combatSweepVoice, combatToneVoice, the
// playThunder layers and synthUi's tone/sweepNoise helpers) (MIT, same owner)
/**
 * Translates a {@link Recipe} into WebAudio nodes. The numbers come from the pure tank-sfx-math; this file only builds
 * graphs. Every noise layer reads a shared pool at a seeded offset: no one-shot allocates an AudioBuffer.
 *
 * A voice is one head (out gain → air low-pass → stereo pan → bus) plus its layers. The VoiceBudget owns the voice:
 * it disposes it once `endAt` has passed, or fades it out in 30 ms when a louder/more important voice steals it.
 */
import type { NoisePools } from '../noise-pools';
import type { BudgetVoice, BusName } from '../voice-select';
import type { Layer, NoiseLayer, Recipe, TickLayer } from './tank-sfx-math';
import { partialDecay, recipeDuration } from './tank-sfx-math';

const FLOOR = 0.0001;
const MAX_FILTER_HZ = 18000;

export interface VoiceOptions {
  bus: BusName;
  priority: number;
  /** Stereo pan and air low-pass for a spatial voice; omitted = a non-spatial (UI/music) voice. */
  spatial?: { gain: number; pan: number; lowpass: number };
  /** Overall gain for a non-spatial voice (spatial voices use spatial.gain). */
  gain?: number;
  persistent?: boolean;
}

export class Voice implements BudgetVoice {
  readonly bus: BusName;
  readonly priority: number;
  readonly persistent: boolean;
  loudness: number;
  endAt = Infinity;
  /** End of everything built into this voice so far (context time). */
  builtEnd = 0;
  /** Layers connect here. */
  readonly out: GainNode;
  readonly lowpass: BiquadFilterNode | null;
  readonly panner: StereoPannerNode | null;
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  private disposed = false;

  constructor(readonly ctx: BaseAudioContext, dest: AudioNode, o: VoiceOptions) {
    this.bus = o.bus;
    this.priority = o.priority;
    this.persistent = o.persistent ?? false;
    this.out = ctx.createGain();
    const level = o.spatial ? o.spatial.gain : o.gain ?? 1;
    this.out.gain.value = level;
    this.loudness = level;
    if (o.spatial) {
      this.lowpass = ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.Q.value = 0.5;
      this.lowpass.frequency.value = Math.min(MAX_FILTER_HZ, Math.max(200, o.spatial.lowpass));
      this.panner = ctx.createStereoPanner();
      this.panner.pan.value = Math.max(-1, Math.min(1, o.spatial.pan));
      this.out.connect(this.lowpass); this.lowpass.connect(this.panner); this.panner.connect(dest);
    } else {
      this.lowpass = null; this.panner = null;
      this.out.connect(dest);
    }
  }

  /** Fast fade (a steal or a release). The budget disposes the voice after it. */
  stop(now: number): void {
    if (this.disposed) return;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.03);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* already disconnected */ } }
    try { this.out.disconnect(); } catch { /* already disconnected */ }
    try { this.lowpass?.disconnect(); } catch { /* already disconnected */ }
    try { this.panner?.disconnect(); } catch { /* already disconnected */ }
  }
}

function envelope(g: AudioParam, t: number, attack: number, hold: number, dur: number, peak: number, swell: boolean): void {
  g.setValueAtTime(FLOOR, t);
  if (swell) g.exponentialRampToValueAtTime(peak, t + attack);
  else g.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) g.setValueAtTime(peak, t + attack + hold);
  g.exponentialRampToValueAtTime(FLOOR, t + dur);
}
const hz = (f: number) => Math.min(MAX_FILTER_HZ, Math.max(20, f));
function sweep(p: AudioParam, t: number, f0: number, f1: number, dur: number, fMid?: number, midAt?: number): void {
  p.setValueAtTime(hz(f0), t);
  if (fMid !== undefined && midAt !== undefined) p.exponentialRampToValueAtTime(hz(fMid), t + dur * midAt);
  if (f1 !== f0 || fMid !== undefined) p.exponentialRampToValueAtTime(hz(f1), t + dur);
}

function noiseSource(ctx: BaseAudioContext, pools: NoisePools, v: Voice, color: NoiseLayer['noise'], t: number, len: number): AudioBufferSourceNode {
  const buffer = pools.get(color);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const offset = pools.offset(buffer, len);
  if (offset + len > buffer.duration) src.loop = true;
  src.start(t, offset, len);
  v.sources.push(src); v.nodes.push(src);
  return src;
}

function noiseLayer(ctx: BaseAudioContext, pools: NoisePools, v: Voice, dest: AudioNode, l: NoiseLayer, t: number): void {
  const src = noiseSource(ctx, pools, v, l.noise, t, l.dur + 0.05);
  const flt = ctx.createBiquadFilter();
  flt.type = l.filter;
  flt.Q.value = l.q;
  sweep(flt.frequency, t, l.f0, l.f1, l.dur, l.fMid, l.midAt);
  const g = ctx.createGain();
  g.gain.value = 0;
  envelope(g.gain, t, l.attack, l.hold, l.dur, l.peak, !!l.swell);
  src.connect(flt); flt.connect(g);
  v.nodes.push(flt, g);
  let tail: AudioNode = g;
  if (l.lfo) {
    // Two incommensurate LFOs roll the gain (rolls and peals, not a drone).
    const roll = ctx.createGain();
    roll.gain.value = 0.65;
    for (const [rate, depth] of [[l.lfo[0], l.lfo[1]], [l.lfo[2], l.lfo[3]]] as const) {
      const osc = ctx.createOscillator(), depthGain = ctx.createGain();
      osc.frequency.value = rate;
      depthGain.gain.value = depth;
      osc.connect(depthGain); depthGain.connect(roll.gain);
      osc.start(t); osc.stop(t + l.dur + 0.1);
      v.sources.push(osc); v.nodes.push(osc, depthGain);
    }
    tail.connect(roll); v.nodes.push(roll); tail = roll;
  }
  if (l.pan) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = l.pan;
    tail.connect(pan); v.nodes.push(pan); tail = pan;
  }
  tail.connect(dest);
}

function tickLayer(ctx: BaseAudioContext, pools: NoisePools, v: Voice, dest: AudioNode, l: TickLayer, t0: number): void {
  const n = l.times.length;
  if (!n) return;
  const first = t0 + l.times[0], last = t0 + l.times[n - 1] + l.durs[n - 1];
  const src = noiseSource(ctx, pools, v, l.noise, Math.max(t0, first - 0.005), last - first + 0.02);
  const flt = ctx.createBiquadFilter();
  flt.type = l.filter;
  flt.Q.value = l.q;
  flt.frequency.value = hz(l.freqs[0]);
  const g = ctx.createGain();
  g.gain.value = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + l.times[i], dur = l.durs[i], attack = Math.min(0.001, dur * 0.3);
    flt.frequency.setValueAtTime(hz(l.freqs[i]), t);
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.linearRampToValueAtTime(l.peaks[i], t + attack);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
  }
  src.connect(flt); flt.connect(g); g.connect(dest);
  v.nodes.push(flt, g);
}

function layer(ctx: BaseAudioContext, pools: NoisePools, v: Voice, dest: AudioNode, l: Layer, t0: number): void {
  const t = t0 + l.delay;
  switch (l.kind) {
    case 'noise': noiseLayer(ctx, pools, v, dest, l, t); return;
    case 'ticks': tickLayer(ctx, pools, v, dest, l, t); return;
    case 'tone': {
      const osc = ctx.createOscillator();
      osc.type = l.wave;
      sweep(osc.frequency, t, l.f0, l.f1, l.dur);
      const g = ctx.createGain();
      g.gain.value = 0;
      envelope(g.gain, t, l.attack, l.hold, l.dur, l.peak, !!l.swell);
      osc.connect(g); g.connect(dest);
      osc.start(t); osc.stop(t + l.dur + 0.03);
      v.sources.push(osc); v.nodes.push(osc, g);
      if (l.vibrato) {
        const lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = l.vibrato[0];
        depth.gain.value = l.vibrato[1];
        lfo.connect(depth); depth.connect(osc.detune);
        lfo.start(t); lfo.stop(t + l.dur + 0.03);
        v.sources.push(lfo); v.nodes.push(lfo, depth);
      }
      return;
    }
    case 'partials': {
      for (let i = 0; i < l.ratios.length; i++) {
        const f = l.f * l.ratios[i];
        if (!(f < 16000)) continue;
        const decay = partialDecay(l.decay, i);
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.frequency.value = f;
        g.gain.value = 0;
        g.gain.setValueAtTime(FLOOR, t);
        g.gain.linearRampToValueAtTime(l.peaks[i], t + 0.002);
        g.gain.exponentialRampToValueAtTime(FLOOR, t + decay);
        osc.connect(g); g.connect(dest);
        osc.start(t); osc.stop(t + decay + 0.03);
        v.sources.push(osc); v.nodes.push(osc, g);
      }
      return;
    }
    case 'whine': {
      const osc = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
      osc.type = 'sawtooth';
      sweep(osc.frequency, t, l.f0, l.f1, l.dur);
      lp.type = 'lowpass';
      lp.Q.value = l.q;
      sweep(lp.frequency, t, l.f0 * 2.5, l.f1 * 2.5, l.dur);
      g.gain.value = 0;
      envelope(g.gain, t, l.attack, 0, l.dur, l.peak, false);
      osc.connect(lp); lp.connect(g); g.connect(dest);
      osc.start(t); osc.stop(t + l.dur + 0.03);
      v.sources.push(osc); v.nodes.push(osc, lp, g);
      return;
    }
    case 'ring': {
      const src = noiseSource(ctx, pools, v, 'white', t, l.dur + 0.05);
      const bp = ctx.createBiquadFilter(), ring = ctx.createGain(), carrier = ctx.createOscillator(), g = ctx.createGain();
      bp.type = 'bandpass';
      bp.frequency.value = hz(l.f);
      bp.Q.value = l.q;
      ring.gain.value = 0;                      // gain = carrier(t): ring modulation
      carrier.frequency.value = l.carrier;
      carrier.connect(ring.gain);
      g.gain.value = 0;
      envelope(g.gain, t, l.attack, 0, l.dur, l.peak, false);
      src.connect(bp); bp.connect(ring); ring.connect(g); g.connect(dest);
      carrier.start(t); carrier.stop(t + l.dur + 0.05);
      v.sources.push(carrier); v.nodes.push(bp, ring, carrier, g);
      return;
    }
  }
}

/** Builds every layer of `recipe` into `voice`, starting at context time `t0`; returns the voice's end time. */
export function playRecipe(ctx: BaseAudioContext, pools: NoisePools, voice: Voice, recipe: Recipe, t0: number): number {
  const trim = ctx.createGain();
  trim.gain.value = recipe.gain;
  trim.connect(voice.out);
  voice.nodes.push(trim);
  voice.loudness *= recipe.gain;
  for (const l of recipe.layers) layer(ctx, pools, voice, trim, l, t0);
  const end = t0 + recipeDuration(recipe) + 0.05;
  voice.builtEnd = Math.max(voice.builtEnd, end);
  voice.endAt = voice.builtEnd;
  return end;
}
