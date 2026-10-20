// Ported from Pinionfall src/audio/procedural-wind-synth.ts (MIT, same owner)
/**
 * Procedural wind ambience (Pinionfall's ProceduralWindSynth, TurboTwig lineage), on the ambience bus.
 *
 *   pink-L ─┐                     ┌ LP 200 Hz  ─ gLow  ┐
 *           ├ merger ─ windIn ────┼ BP 900 Hz  ─ gMid  ┼ bandMix ─ speedVCA ─ widener (Haas) ─ scenePan ─ dry ┐
 *   pink-R ─┘                     ├ HP 3.5 kHz ─ gHigh ┤                                        └ send ─ convolver ─ wet ┴ EQ ─ out
 *                                 └ HP 8 kHz   ─ gAir  ┘
 *
 * Changes from Pinionfall: the pink pair comes from the shared pools (no buffers of its own), the impulse response is
 * shorter (1.3 s, a diorama rather than a valley), parameter writes pass a deadband and run at ≤ 30 Hz, and the atmosphere
 * gate is gone (every TMT planet has air).
 */
import type { NoisePools } from '../noise-pools';
import { gateWorldGust } from './world-gust';

const TAU = 0.05, TAU_FAST = 0.02, TAU_SLOW = 0.10;
export const WIND_UPDATE_INTERVAL = 1 / 30;
const UPDATE_INTERVAL = WIND_UPDATE_INTERVAL;

export interface WindDrive {
  /** 0..1 effective wind speed the listener feels (weather wind or the apparent wind of a moving tank). */
  perceivedSpeed01: number;
  /** 0..1 base gust amplitude (the wind rule's gust). */
  gust01: number;
  /** 0..1 world gust field at the listener and at the left/right ears. */
  gustFieldCentre: number;
  gustFieldLeft: number;
  gustFieldRight: number;
  /** 0..1 terrain proximity: 1 hugging the ground, 0 open sky. */
  proximity01: number;
  /** 0..1 steady drone vs gust-modulated character. */
  bias01: number;
  /** -1..1 stereo bias from the wind direction projected onto the listener's right. */
  pan: number;
  enabled: boolean;
}

export class WindSynth {
  readonly output: GainNode;
  private readonly srcL: AudioBufferSourceNode;
  private readonly srcR: AudioBufferSourceNode;
  private readonly fLow: BiquadFilterNode;
  private readonly fMid: BiquadFilterNode;
  private readonly fHigh: BiquadFilterNode;
  private readonly fAir: BiquadFilterNode;
  private readonly gLow: GainNode;
  private readonly gMid: GainNode;
  private readonly gHigh: GainNode;
  private readonly gAir: GainNode;
  private readonly speedVCA: GainNode;
  private readonly widenerSideCtrl: ConstantSourceNode;
  private readonly scenePanner: StereoPannerNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly chaos: OscillatorNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly last = new Map<AudioParam, number>();
  private gustFollower = 0;
  private sinceUpdate = UPDATE_INTERVAL;
  private started = false;
  private disposed = false;

  /** `start` false builds the graph silent and unstarted (before the first user gesture); start() begins it. */
  constructor(private readonly ctx: BaseAudioContext, pools: NoisePools, start = true) {
    const now = ctx.currentTime;
    const gain = (v: number) => { const g = ctx.createGain(); g.gain.value = v; this.nodes.push(g); return g; };
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; this.nodes.push(b); return b;
    };
    this.output = ctx.createGain();
    this.output.gain.value = 0;

    // EQ tail (subtle character; the limiter handles dynamics).
    const eqLow = filter('lowshelf', 120, 0.7), eqMud = filter('peaking', 350, 1), eqPres = filter('peaking', 3000, 1.2), eqAir = filter('highshelf', 10000, 0.7);
    eqLow.gain.value = 0; eqMud.gain.value = -1.5; eqPres.gain.value = 2; eqAir.gain.value = 3;
    eqLow.connect(eqMud); eqMud.connect(eqPres); eqPres.connect(eqAir); eqAir.connect(this.output);
    const mixSum = gain(1);
    mixSum.connect(eqLow);

    // Reverb send.
    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = impulseResponse(ctx, 0.2, 0.55);
    this.nodes.push(convolver);
    this.wetGain = gain(Math.sin(0.2 * Math.PI * 0.5));
    convolver.connect(this.wetGain); this.wetGain.connect(mixSum);
    const send = gain(1);
    send.connect(convolver);
    this.dryGain = gain(Math.cos(0.2 * Math.PI * 0.5));
    this.dryGain.connect(mixSum);

    // Scene panner (dry path only; the reverb stays centred).
    this.scenePanner = ctx.createStereoPanner();
    this.nodes.push(this.scenePanner);
    this.scenePanner.connect(this.dryGain);

    // Haas widener.
    const merge = ctx.createChannelMerger(2), split = ctx.createChannelSplitter(2);
    this.nodes.push(merge, split);
    merge.connect(this.scenePanner); merge.connect(send);
    const directL = gain(1), directR = gain(1);
    split.connect(directL, 0); split.connect(directR, 1);
    directL.connect(merge, 0, 0); directR.connect(merge, 0, 1);
    const delayL = ctx.createDelay(0.05), delayR = ctx.createDelay(0.05);
    delayL.delayTime.value = 0.012; delayR.delayTime.value = 0.012;
    this.nodes.push(delayL, delayR);
    split.connect(delayL, 0); split.connect(delayR, 1);
    const crossLR = gain(0), crossRL = gain(0);
    delayL.connect(crossLR); delayR.connect(crossRL);
    crossLR.connect(merge, 0, 1); crossRL.connect(merge, 0, 0);
    this.widenerSideCtrl = ctx.createConstantSource();
    this.widenerSideCtrl.offset.value = 0;
    this.widenerSideCtrl.connect(crossLR.gain); this.widenerSideCtrl.connect(crossRL.gain);
    this.nodes.push(this.widenerSideCtrl);

    // Speed VCA and the four bands.
    this.speedVCA = gain(0);
    this.speedVCA.connect(split);
    const bandMix = gain(1);
    bandMix.connect(this.speedVCA);
    this.gLow = gain(0); this.gMid = gain(0); this.gHigh = gain(0); this.gAir = gain(0);
    for (const g of [this.gLow, this.gMid, this.gHigh, this.gAir]) g.connect(bandMix);
    this.fLow = filter('lowpass', 200, 0.7); this.fMid = filter('bandpass', 900, 1.2); this.fHigh = filter('highpass', 3500, 0.7); this.fAir = filter('highpass', 8000, 0.7);
    this.fLow.connect(this.gLow); this.fMid.connect(this.gMid); this.fHigh.connect(this.gHigh); this.fAir.connect(this.gAir);
    const windIn = gain(1);
    for (const f of [this.fLow, this.fMid, this.fHigh, this.fAir]) windIn.connect(f);
    const windMerger = ctx.createChannelMerger(2);
    this.nodes.push(windMerger);
    windMerger.connect(windIn);

    // Slow incommensurate chaos on the filter detunes.
    const addChaos = (target: AudioParam, freq: number, depth: number) => {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.value = freq; g.gain.value = depth;
      osc.connect(g); g.connect(target);
      this.chaos.push(osc); this.nodes.push(osc, g);
    };
    addChaos(this.fMid.detune, 0.053, 300); addChaos(this.fMid.detune, 0.113, 180);
    addChaos(this.fHigh.detune, 0.071, 250); addChaos(this.fAir.detune, 0.089, 200);

    // The stereo pink pair (incommensurate lengths hide the loop).
    this.srcL = ctx.createBufferSource(); this.srcL.buffer = pools.pinkL; this.srcL.loop = true;
    this.srcR = ctx.createBufferSource(); this.srcR.buffer = pools.pinkR; this.srcR.loop = true;
    this.srcL.connect(windMerger, 0, 0); this.srcR.connect(windMerger, 0, 1);
    this.nodes.push(this.srcL, this.srcR);
    if (start) this.start(now);
  }

  /** Starts the noise pair, the widener control and the chaos oscillators (once). */
  start(at = this.ctx.currentTime): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.widenerSideCtrl.start(at);
    for (const osc of this.chaos) osc.start(at);
    this.srcL.start(at); this.srcR.start(at);
  }

  private set(p: AudioParam, v: number, now: number, tau: number, rel = 0.01): void {
    const prev = this.last.get(p);
    if (prev !== undefined && Math.abs(v - prev) <= Math.max(1e-4, Math.abs(prev) * rel)) return;
    p.setTargetAtTime(v, now, tau);
    this.last.set(p, v);
  }

  /** Drives every parameter from this frame's state (throttled to 30 Hz). */
  update(p: WindDrive, dt: number): void {
    if (this.disposed) return;
    this.sinceUpdate += Math.max(0, dt);
    if (this.sinceUpdate < UPDATE_INTERVAL) return;
    const step = Math.min(0.25, this.sinceUpdate);
    this.sinceUpdate = 0;
    const now = this.ctx.currentTime;
    this.set(this.output.gain, p.enabled ? 1 : 0, now, TAU_FAST);
    if (!p.enabled) return;
    const c01 = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    const sNorm = c01(p.perceivedSpeed01), gUser = c01(p.gust01), prox = c01(p.proximity01), bias = c01(p.bias01);
    const gLeft = c01(p.gustFieldLeft), gRight = c01(p.gustFieldRight);

    // Visual-synced gust: the gated world field, amplitude-coupled to the speed and gust knobs.
    const rawGust = gateWorldGust(c01(p.gustFieldCentre)) * (0.25 + 0.55 * sNorm) * (0.2 + 0.8 * gUser);
    const atkTc = 0.6 - Math.min(0.35, rawGust * 0.5), relTc = 2.4 - Math.min(1.2, this.gustFollower * 1.5);
    const alpha = 1 - Math.exp(-Math.max(0.001, step) / (rawGust > this.gustFollower ? atkTc : relTc));
    this.gustFollower += (rawGust - this.gustFollower) * alpha;
    const gust = this.gustFollower;

    this.set(this.speedVCA.gain, Math.min(2.2, Math.pow(sNorm, 1.4) * (0.04 + bias * 0.32) + gust * 2.4), now, TAU * 0.6);
    const proxLow = 0.5 * (0.6 + 0.8 * prox), proxMid = 0.75 * (0.85 + 0.3 * prox), proxHigh = 0.55 * (1.1 - 0.25 * prox), proxAir = 0.3 * (1.15 - 0.3 * prox);
    const emphasis = 1 + (1 - sNorm) * 1.2;
    this.set(this.gLow.gain, proxLow * Math.pow(sNorm, 2.4) * (1 + gust * 0.6 * emphasis), now, TAU);
    this.set(this.gMid.gain, proxMid * (0.08 + Math.pow(sNorm, 0.85) * 0.92) * (1 + gust * 1.4 * emphasis), now, TAU);
    this.set(this.gHigh.gain, proxHigh * (0.18 + sNorm * 0.82) * (1 + gust * 3 * emphasis), now, TAU * 0.4);
    this.set(this.gAir.gain, proxAir * (0.38 + sNorm * 0.62) * (1 + gust * 4 * emphasis), now, TAU * 0.4);
    const bright = 1 + Math.pow(sNorm, 0.8) * 0.18 + (1 + (1 - sNorm) * 1.8) * gust;
    this.set(this.fLow.frequency, 200 * (1 + sNorm * 0.08), now, TAU_SLOW);
    this.set(this.fMid.frequency, 900 * bright, now, TAU * 0.4);
    this.set(this.fHigh.frequency, 3500 * bright, now, TAU * 0.4);
    this.set(this.fAir.frequency, Math.min(18000, 8000 * bright), now, TAU * 0.4);
    // The ear-to-ear gust difference says which side the wavefront is on: the swell sweeps across the stereo field.
    const pan = Math.max(-1, Math.min(1, Math.max(-1, Math.min(1, p.pan)) * 0.4 + (gRight - gLeft) * 2));
    this.set(this.scenePanner.pan, pan, now, TAU, 0.02);
    this.set(this.widenerSideCtrl.offset, 1 - (0.85 + 0.45 * (1 - prox)), now, TAU);
    const mix = 0.12 + 0.22 * (1 - prox);
    this.set(this.dryGain.gain, Math.cos(mix * Math.PI * 0.5), now, TAU);
    this.set(this.wetGain.gain, Math.sin(mix * Math.PI * 0.5), now, TAU);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of [this.srcL, this.srcR, this.widenerSideCtrl, ...this.chaos]) { try { s.stop(); } catch { /* already stopped */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* already disconnected */ } }
    try { this.output.disconnect(); } catch { /* already disconnected */ }
  }
}

/** A generated stereo impulse response (Pinionfall's generateReverbIR), built once per synth. */
function impulseResponse(ctx: BaseAudioContext, roomSize: number, damping: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = 0.4 + roomSize * 4.6;
  const length = Math.max(1, Math.floor(seconds * sr));
  const decayPower = 2 + (1 - damping) * 4;
  const earlyCutoff = Math.floor((0.08 / seconds) * length);
  const buffer = ctx.createBuffer(2, length, sr);
  const seeds = [0xdeadbeef, 0xbeeff00d];
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    let s = seeds[ch] >>> 0, last = 0, m = 0;
    for (let i = 0; i < length; i++) {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      const u = i / length;
      const sample = (r * 2 - 1) * Math.pow(1 - u, decayPower) * (i < earlyCutoff ? 1.6 : 1);
      last = last + Math.max(0.05, 1 - u * damping * 0.9) * (sample - last);
      d[i] = last;
      if (Math.abs(last) > m) m = Math.abs(last);
    }
    if (m > 0) { const k = 0.9 / m; for (let i = 0; i < length; i++) d[i] *= k; }
  }
  // A 7-sample right-channel offset for decorrelation.
  const right = buffer.getChannelData(1);
  right.copyWithin(7, 0, length - 7);
  right.fill(0, 0, Math.min(7, length));
  return buffer;
}
