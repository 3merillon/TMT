/**
 * Sequencer and mastering for the forge. A Track is a tempo grid (intro + loop + tail bars) with named stems. Parts add
 * rendered audio into stems; render() applies stem effects, folds the tail into the loop start (seamless loop), then
 * masters: a glue compressor and a true-peak limiter are computed on the FULL mix and their gain curves applied to every
 * stem identically, so the shipped stems still sum to the mastered mix and can be layered at runtime.
 *
 * Notation (steps are sixteenths):
 *   riff   "B1m:2 B1m:2 D2P:4 -:2 B1x:1 >E2o/D2:3"  pitch + articulation + :length; '-' rest; '>' accent; '^' ghost;
 *          '~' vibrato; '/X' slide from X; articulations m pm-single, o open-single (default), M pm-power, P open-power,
 *          W open-power8, w pm-power8, x dead, h harmonic
 *   drums  { kick: "x...x...", snare: "....X...", hat: "x.x.x.x." }   x hit, X accent, o ghost, f flam, . rest
 */
import { SR, type Mono, type Stereo, mono, stereo, Rng, db, noteHz, addInto, addStereo, hashString, assertFinite, clamp } from './dsp/core';
import { Biquad, type BiquadType } from './dsp/filters';
import { fdnReverb, type ReverbSpec, width as setWidth, shape, shapers } from './dsp/fx';
import { compressorGain, limiterGain, applyGain, type CompSpec, multiplyGains, transientShape } from './dsp/dynamics';
import { measure } from './dsp/loudness';
import { renderRhythmGuitar, renderLeadGuitar, type GuitarEvent, type AmpPreset, AMPS } from './instruments/guitar';
import { renderPickedBass, renderSnarlBass, type BassEvent, type SnarlEvent } from './instruments/bass';
import { DrumKit, PIECE_PAN, DRUM_LEVEL, type Piece, type KitStyle } from './instruments/drums';
import type { Articulation } from './instruments/string';

export interface TrackSpec { id: string; title: string; bpm: number; beatsPerBar?: number; introBars?: number; loopBars: number; tailBars?: number; seed?: number; targetLufs?: number; kind?: 'loop' | 'stinger'; masterEq?: readonly [BiquadType, number, number?, number?][] | null }
/** Default master tilt: a little less weight under 110 Hz, a little more bite around 2.8 kHz and air above 8 kHz. */
export const MASTER_EQ: readonly [BiquadType, number, number?, number?][] = [['lowshelf', 120, 0.7, -3.5], ['peaking', 2800, 0.8, 1.5], ['highshelf', 8000, 0.7, 1]];
export interface StemSpec { layer: number; gainDb?: number; hp?: number; lp?: number; eq?: readonly [BiquadType, number, number?, number?][]; comp?: CompSpec; reverb?: { spec: ReverbSpec; mixDb: number }; width?: number; sat?: number; transient?: [number, number] }
export interface DrumHit { at: number; piece: Piece; vel: number; variant: number }

export class Track {
  readonly bpm: number; readonly beatsPerBar: number; readonly barSamples: number; readonly stepSamples: number;
  readonly introBars: number; readonly loopBars: number; readonly tailBars: number; readonly length: number;
  readonly rng: Rng;
  private readonly stems = new Map<string, { spec: StemSpec; buf: Stereo }>();
  constructor(readonly spec: TrackSpec) {
    this.bpm = spec.bpm; this.beatsPerBar = spec.beatsPerBar ?? 4;
    this.barSamples = Math.round(60 / this.bpm * this.beatsPerBar * SR);
    this.stepSamples = this.barSamples / (this.beatsPerBar * 4);
    this.introBars = spec.introBars ?? 0; this.loopBars = spec.loopBars; this.tailBars = spec.tailBars ?? (spec.kind === 'stinger' ? 0 : 2);
    this.length = (this.introBars + this.loopBars + this.tailBars) * this.barSamples;
    this.rng = new Rng(spec.seed ?? hashString(spec.id));
  }
  get loopStart(): number { return this.introBars * this.barSamples; }
  get loopEnd(): number { return (this.introBars + this.loopBars) * this.barSamples; }
  /** Sample position of a bar (0-based, intro included) and a step within it. */
  at(bar: number, step = 0): number { return Math.round(bar * this.barSamples + step * this.stepSamples); }
  /** A humanised event nominally on the loop's first downbeat must not land before the seam (it would only be heard on
   * the first pass); events are clamped into the loop. */
  private clampSeam(at: number): number { const ls = this.loopStart; return at < ls && at > ls - 0.03 * SR ? ls : Math.max(0, at); }
  stem(name: string, spec: StemSpec): this { if (!this.stems.has(name)) this.stems.set(name, { spec, buf: stereo(this.length) }); return this; }
  private buf(name: string): Stereo { const s = this.stems.get(name); if (!s) throw new Error(`stem '${name}' is not declared`); return s.buf; }
  /** Adds a rendered buffer into a stem. */
  add(stemName: string, src: Mono | Stereo, gainDb = 0, pan = 0, at = 0): this {
    const g = db(gainDb);
    if (src instanceof Float32Array) { const a = (pan + 1) * Math.PI / 4; addStereo(this.buf(stemName), src, at, Math.cos(a) * g, Math.sin(a) * g); }
    else addStereo(this.buf(stemName), src, at, g, g);
    return this;
  }
  // ---- notation ---------------------------------------------------------------------------------------------------------
  /** Parses riff notation into guitar events starting at `bar` (steps are sixteenths). */
  riff(notation: string, o: { bar: number; vel?: number; transpose?: number; gateScale?: number; humanize?: number; bass?: boolean }): GuitarEvent[] {
    const out: GuitarEvent[] = [];
    let step = 0, lastFreq: number | null = null;
    const vel0 = o.vel ?? 0.9, rng = this.rng.fork(hashString(notation) ^ o.bar);
    for (const raw of notation.split(/\s+/)) {
      const tok = raw.replace(/\|/g, '').trim();
      if (!tok) continue;
      const m = /^([>^~]*)([A-Ga-g][#b]?-?\d|-|\.)([mMoPWwxh]?)(?:\/([A-Ga-g][#b]?-?\d))?(?::(\d+(?:\.\d+)?))?$/.exec(tok);
      if (!m) throw new Error(`bad riff token '${tok}' in "${notation}"`);
      const [, mods, pitch, artCh, slide, lenS] = m;
      const len = lenS ? Number(lenS) : 1;
      if (pitch === '-' || pitch === '.') { step += len; continue; }
      const freq = noteHz(pitch) * Math.pow(2, (o.transpose ?? 0) / 12);
      const artMap: Record<string, [Articulation, GuitarEvent['chord']]> = { m: ['pm', 'single'], o: ['open', 'single'], M: ['pm', 'power'], P: ['open', 'power'], W: ['open', 'power8'], w: ['pm', 'power8'], x: ['dead', 'single'], h: ['harm', 'single'], '': ['open', 'single'] };
      const [art, chord] = artMap[artCh];
      let vel = vel0 * (mods.includes('>') ? 1.12 : 1) * (mods.includes('^') ? 0.7 : 1);
      vel = clamp(vel * (1 + rng.signed() * (o.humanize ?? 0.04)), 0.05, 1);
      const lenSamples = len * this.stepSamples;
      const gap = art === 'pm' || art === 'dead' ? Math.max(0.008 * SR, lenSamples * 0.14) : 0.004 * SR;
      const gate = Math.max(0.02 * SR, Math.round((lenSamples - gap) * (o.gateScale ?? 1)));
      const at = this.clampSeam(this.at(o.bar, step) + Math.round(rng.signed() * (o.humanize ?? 0.04) * 0.025 * SR));
      const slideFrom = slide ? noteHz(slide) * Math.pow(2, (o.transpose ?? 0) / 12) : mods.includes('/') && lastFreq ? lastFreq : undefined;
      out.push({ at: Math.max(0, at), gate, freq, vel, art, chord, slideFrom, slideSamples: slideFrom ? Math.round(Math.min(0.12 * SR, lenSamples * 0.4)) : undefined,
        vibrato: mods.includes('~') ? { rate: 5.5, cents: 35, delay: 0.15 } : undefined });
      lastFreq = freq; step += len;
    }
    return out;
  }
  /** Parses drum patterns (one string per piece) starting at `bar`; `res` steps per bar (16 or 32). */
  drums(patterns: Partial<Record<Piece, string>>, o: { bar: number; res?: 16 | 32; vel?: number; humanize?: number; swing?: number }): DrumHit[] {
    const out: DrumHit[] = [], res = o.res ?? 16, stepLen = this.barSamples / res, rng = this.rng.fork(o.bar * 31 + res);
    let variant = 0;
    for (const [piece, pattern] of Object.entries(patterns) as [Piece, string][]) {
      const chars = pattern.replace(/[|\s]/g, '');
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '.') continue;
        const vel = ch === 'X' ? 1 : ch === 'o' ? 0.45 : ch === 'f' ? 0.9 : 0.82;
        const swing = o.swing && (i % 2 === 1) ? o.swing * stepLen * 0.5 : 0;
        const at = this.clampSeam(this.at(o.bar) + Math.round(i * stepLen + swing + rng.signed() * (o.humanize ?? 0.03) * 0.012 * SR));
        if (ch === 'f') out.push({ at: this.clampSeam(at - Math.round(0.022 * SR)), piece, vel: 0.5, variant: variant++ });
        out.push({ at, piece, vel: clamp(vel * (o.vel ?? 1) * (1 + rng.signed() * 0.06), 0.1, 1), variant: variant++ });
      }
    }
    return out;
  }
  // ---- parts --------------------------------------------------------------------------------------------------------------
  guitar(stemName: string, events: readonly GuitarEvent[], o: { amp?: AmpPreset; gainDb?: number; lead?: boolean; spread?: number; seed?: number } = {}): this {
    if (!events.length) return this;
    const seed = o.seed ?? this.rng.fork(stemName.length).next() * 1e9 | 0;
    const buf = o.lead ? renderLeadGuitar(events, this.length, { seed, amp: o.amp ?? AMPS.lead }) : renderRhythmGuitar(events, this.length, { seed, amp: o.amp ?? AMPS.rhythm, spread: o.spread });
    return this.add(stemName, buf, o.gainDb ?? 0);
  }
  bass(stemName: string, events: readonly GuitarEvent[], o: { gainDb?: number; drive?: number; sub?: number } = {}): this {
    if (!events.length) return this;
    const be: BassEvent[] = events.map(e => ({ at: e.at, gate: e.gate, freq: e.freq, vel: e.vel, art: e.art === 'dead' ? 'dead' : e.art === 'pm' ? 'pm' : 'open', slideFrom: e.slideFrom, slideSamples: e.slideSamples }));
    return this.add(stemName, renderPickedBass(be, this.length, { seed: this.rng.fork(77).next() * 1e9 | 0, drive: o.drive, sub: o.sub }), o.gainDb ?? 0);
  }
  snarl(stemName: string, events: readonly SnarlEvent[], o: { gainDb?: number; bits?: number; downsample?: number; resonance?: number; drive?: number } = {}): this {
    if (!events.length) return this;
    return this.add(stemName, renderSnarlBass(events, this.length, { seed: this.rng.fork(91).next() * 1e9 | 0, ...o }), o.gainDb ?? 0);
  }
  kit(stemName: string, hits: readonly DrumHit[], o: { style?: KitStyle; gainDb?: number; seed?: number } = {}): this {
    if (!hits.length) return this;
    const kit = new DrumKit(o.style ?? {}, o.seed ?? 11), buf = stereo(this.length);
    for (const h of hits) {
      const sample = kit.hit(h.piece, h.vel, h.variant), pan = PIECE_PAN[h.piece], a = (pan + 1) * Math.PI / 4, g = DRUM_LEVEL[h.piece];
      addStereo(buf, sample, h.at, Math.cos(a) * g, Math.sin(a) * g);
    }
    return this.add(stemName, buf, o.gainDb ?? 0);
  }
  // ---- render -------------------------------------------------------------------------------------------------------------
  render(): { stems: Record<string, Stereo>; full: Stereo; loopStart: number; loopEnd: number; stemLayers: Record<string, number>; stats: ReturnType<typeof measure> & { gainDb: number } } {
    const loopStart = this.loopStart, loopEnd = this.loopEnd, tail = this.tailBars * this.barSamples, out: Record<string, Stereo> = {}, layers: Record<string, number> = {};
    const stinger = this.spec.kind === 'stinger';
    const finalLen = stinger ? this.length : loopEnd;
    const masterEq = this.spec.masterEq === null ? [] : this.spec.masterEq ?? MASTER_EQ;
    for (const [name, { spec, buf }] of this.stems) {
      const s = this.processStem(buf, spec);
      for (const [type, f, q, g] of masterEq) for (const ch of s) new Biquad(type, f, q ?? 0.7071, g ?? 0).process(ch);
      // Fold the tail (reverb/decay past the loop end) into the loop start so the seam carries the ring-out.
      if (!stinger) for (let i = 0; i < tail; i++) { s[0][loopStart + i] += s[0][loopEnd + i]; s[1][loopStart + i] += s[1][loopEnd + i]; }
      out[name] = [s[0].slice(0, finalLen), s[1].slice(0, finalLen)];
      layers[name] = spec.layer;
    }
    const full = stereo(finalLen);
    for (const s of Object.values(out)) addStereo(full, s, 0);
    // Loudness pre-gain on the full mix, then glue + limiter from the full mix applied to every stem.
    const target = this.spec.targetLufs ?? -14;
    const pre = measure(full), gain0 = db(clamp(target - pre.integratedLufs, -30, 30));
    for (const s of [full, ...Object.values(out)]) { for (const ch of s) for (let i = 0; i < ch.length; i++) ch[i] *= gain0; }
    const glue = compressorGain(full, { thresholdDb: -12, ratio: 2.2, attack: 0.025, release: 0.22, kneeDb: 8, detector: 'rms', sidechainHp: 90 });
    const glued = stereo(finalLen); addStereo(glued, full, 0); applyGain(glued, glue);
    const lim = limiterGain(glued, -1.0, 1.5, 70);
    const total = multiplyGains(glue, lim);
    for (const s of [full, ...Object.values(out)]) applyGain(s, total);
    assertFinite(full, this.spec.id);
    const post = measure(full);
    return { stems: out, full, loopStart, loopEnd, stemLayers: layers, stats: { ...post, gainDb: Math.round(20 * Math.log10(gain0) * 10) / 10 } };
  }
  private processStem(buf: Stereo, spec: StemSpec): Stereo {
    const s: Stereo = [new Float32Array(buf[0]), new Float32Array(buf[1])];
    const each = (fn: (ch: Mono) => void) => { fn(s[0]); fn(s[1]); };
    if (spec.hp) each(ch => { new Biquad('highpass', spec.hp!, 0.7).process(ch); });
    if (spec.lp) each(ch => { new Biquad('lowpass', spec.lp!, 0.7).process(ch); });
    if (spec.eq) for (const [type, f, q, g] of spec.eq) each(ch => { new Biquad(type, f, q ?? 0.7071, g ?? 0).process(ch); });
    if (spec.transient) each(ch => { transientShape(ch, spec.transient![0], spec.transient![1]); });
    if (spec.sat) each(ch => { shape(ch, shapers.tanh(spec.sat!)); });
    if (spec.comp) applyGain(s, compressorGain(s, spec.comp));
    if (spec.reverb) { const wet = fdnReverb(s, spec.reverb.spec, 3), g = db(spec.reverb.mixDb); for (let c = 0; c < 2; c++) for (let i = 0; i < s[c].length; i++) s[c][i] += wet[c][i] * g; }
    if (spec.width !== undefined) setWidth(s, spec.width);
    if (spec.gainDb) { const g = db(spec.gainDb); each(ch => { for (let i = 0; i < ch.length; i++) ch[i] *= g; }); }
    return s;
  }
}
/** Repeats a one-bar (or n-bar) pattern string for `bars` bars. */
export const rep = (pattern: string, bars: number) => Array.from({ length: bars }, () => pattern).join(' ');
/** Concatenates riff notation fragments. */
export const seq = (...parts: string[]) => parts.join(' ');
export { addInto, mono, stereo };
