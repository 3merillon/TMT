/** Shared material: the TMT motif in any key, stem presets, drum vocabularies, and helpers used by every score. */
import type { Track, StemSpec, DrumHit } from '../sequencer';
import { noteMidi } from '../dsp/core';
import type { Piece } from '../instruments/drums';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
/** Transposes every pitch in riff notation by `semis` (keeps articulations/lengths). */
export function transposeRiff(notation: string, semis: number): string {
  return notation.replace(/([A-G][#b]?-?\d)/g, n => midiName(noteMidi(n) + semis));
}
/** The TMT motif, lead register, relative to a tonic given as a note name of octave 3 (e.g. 'B3' → original). */
export function motif(tonic: string, variant: 'a' | 'answer' | 'high' | 'fast' | 'major' = 'a'): string {
  const base = {
    a: 'B3o:2 B3o:2 D4o:2 C4o:2 B3o:2 -:2 A3o:2 B3o:2 | ~F#3o:8 E3o:2 F#3o:2 G3o:2 F#3o:2',
    answer: 'D4o:2 D4o:2 F#4o:2 E4o:2 D4o:2 -:2 C#4o:2 D4o:2 | ~B3o:6 A3o:2 G3o:2 F#3o:2 E3o:2 F#3o:2',
    high: 'B4o:2 B4o:2 D5o:2 C5o:2 B4o:2 -:2 A4o:2 B4o:2 | ~F#4o:8 E4o:2 F#4o:2 G4o:2 F#4o:2',
    fast: 'B3o:1 B3o:1 D4o:1 C4o:1 B3o:2 A3o:1 B3o:1 F#3o:2 E3o:1 F#3o:1 G3o:2 F#3o:2 | B3o:1 B3o:1 D4o:1 C4o:1 B3o:2 A3o:1 B3o:1 ~F#3o:6',
    major: 'B3o:2 B3o:2 D#4o:2 C#4o:2 B3o:2 -:2 A3o:2 B3o:2 | ~F#3o:8 E3o:2 F#3o:2 G#3o:2 F#3o:2',
  }[variant];
  return transposeRiff(base, noteMidi(tonic) - noteMidi('B3'));
}
/** Guitar rhythm notation → bass notation: chords become single picked notes, mutes kept. */
export const bassLine = (notation: string) => notation.replace(/[PWMw]/g, 'm');
export const STEMS = {
  drums: (gainDb = -2.5): StemSpec => ({ layer: 0, hp: 30, comp: { thresholdDb: -14, ratio: 3, attack: 0.012, release: 0.11, kneeDb: 6, makeupDb: 2 }, sat: 1.25, transient: [1.35, 0.95], reverb: { spec: { seconds: 0.9, damp: 5000, preDelayMs: 8, size: 0.7 }, mixDb: -20 }, gainDb }),
  bass: (gainDb = -5): StemSpec => ({ layer: 0, hp: 32, lp: 7000, gainDb }),
  guitars: (gainDb = 2, layer = 1): StemSpec => ({ layer, hp: 80, eq: [['peaking', 250, 1.2, -1.5], ['peaking', 3000, 1, 1]], gainDb }),
  lead: (gainDb = -2, layer = 2): StemSpec => ({ layer, hp: 160, reverb: { spec: { seconds: 1.8, damp: 4200, preDelayMs: 25, size: 1.1 }, mixDb: -14 }, gainDb }),
  electro: (gainDb = 2, layer = 1): StemSpec => ({ layer, hp: 50, width: 1.25, reverb: { spec: { seconds: 1.2, damp: 3500, preDelayMs: 10 }, mixDb: -20 }, gainDb }),
  atmo: (gainDb = 0, layer = 0): StemSpec => ({ layer, hp: 40, width: 1.4, reverb: { spec: { seconds: 2.6, damp: 2800, preDelayMs: 20, size: 1.3 }, mixDb: -12 }, gainDb }),
  escalation: (gainDb = 0, layer = 3): StemSpec => ({ layer, hp: 40, gainDb }),
};
/** Repeats a bar pattern set for `bars` bars with a fill set on the last. */
export function bars(t: Track, main: Partial<Record<Piece, string>>, fill: Partial<Record<Piece, string>>, from: number, count: number, o: { res?: 16 | 32; vel?: number; swing?: number } = {}): DrumHit[] {
  const out: DrumHit[] = [];
  for (let i = 0; i < count; i++) out.push(...t.drums(i === count - 1 ? fill : main, { bar: from + i, ...o }));
  return out;
}
