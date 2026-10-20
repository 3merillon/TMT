/** Instrument smoke checks: tuning of the string model (autocorrelation pitch), level sanity of drums, amp output. */
import { SR, mono, noteHz, type Mono } from './dsp/core';
import { renderString } from './instruments/string';
import { ampChain, AMPS, renderDryGuitar } from './instruments/guitar';
import { DrumKit } from './instruments/drums';
import { measure } from './dsp/loudness';
import { writeWav } from './dsp/wav';

function pitchOf(a: Mono, from: number, to: number, fMin = 40, fMax = 1200): number {
  const seg = a.subarray(from, to), n = seg.length, minLag = Math.floor(SR / fMax), maxLag = Math.ceil(SR / fMin);
  let best = 0, bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i + lag < n; i++) { s += seg[i] * seg[i + lag]; e1 += seg[i] * seg[i]; e2 += seg[i + lag] * seg[i + lag]; } const c = s / Math.sqrt(e1 * e2 + 1e-12); if (c > best) { best = c; bestLag = lag; } }
  // Parabolic refinement around the best lag.
  return SR / bestLag;
}
const cents = (f: number, ref: number) => Math.round(1200 * Math.log2(f / ref) * 10) / 10;
for (const [note, art] of [['B1', 'open'], ['B1', 'pm'], ['E2', 'open'], ['E2', 'pm'], ['B3', 'open'], ['A1', 'pm']] as const) {
  const f = noteHz(note), s = renderString({ freq: f, gate: Math.round(0.6 * SR), vel: 0.9, art, seed: 5 });
  const p = pitchOf(s, Math.round(0.03 * SR), Math.round(0.25 * SR), f * 0.6, f * 1.6);
  console.log(`${note} ${art}: ${p.toFixed(2)} Hz vs ${f.toFixed(2)} (${cents(p, f)} cents), peak ${Math.max(...Array.from(s.subarray(0, 48000)).map(Math.abs)).toFixed(3)}`);
}
const ev = [0, 0.25, 0.5, 0.75, 1.0, 1.5].map((t, i) => ({ at: Math.round(t * SR), gate: Math.round(0.18 * SR), freq: noteHz(i === 5 ? 'D2' : 'B1'), vel: 0.9, art: i === 5 ? 'open' as const : 'pm' as const, chord: i === 5 ? 'power' as const : 'single' as const }));
const dry = renderDryGuitar(ev, 2 * SR, { seed: 3 });
const amp = ampChain(dry, AMPS.rhythm);
console.log('dry peak', Math.max(...Array.from(dry).map(Math.abs)).toFixed(3), 'amp', measure([amp, amp]));
const kit = new DrumKit();
for (const piece of ['kick', 'snare', 'hat', 'crash', 'anvil', 'slam'] as const) { const h = kit.hit(piece, 0.9); console.log(piece, 'len', (h.length / SR).toFixed(2), measure([h, h])); }
const demo = mono(3 * SR);
for (const [t, piece] of [[0, 'kick'], [0.5, 'snare'], [1, 'kick'], [1.25, 'kick'], [1.5, 'snare'], [2, 'crash'], [2, 'kick']] as const) { const h = kit.hit(piece, 0.95); for (let i = 0; i < h.length && t * SR + i < demo.length; i++) demo[Math.round(t * SR) + i] += h[i]; }
writeWav('G:/tmt-work/audio/previews/smoke-guitar.wav', [amp, amp]);
writeWav('G:/tmt-work/audio/previews/smoke-drums.wav', [demo, demo]);
console.log('wrote smoke wavs');
