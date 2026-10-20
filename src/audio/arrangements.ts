/** Original, authored score data. No recordings, sample packs or external compositions. */
import type { PlanetKind } from '../world/sun';

export type MusicScene = 'title' | 'menu' | 'workshop' | 'setup' | 'loading' | 'skirmish' | 'pause' | 'results';
export type Arrangement = 'copper' | PlanetKind;
export type Drum = 'kick' | 'snare' | 'hat';
export interface ScoreStep { notes: readonly number[]; bass?: number; lead?: number; gate: number; accent: number; brightness: number; drums: Drum[] }
type Note = readonly [beat: number, pitch: number, gate: number];
interface Composition {
  title: string; lead: OscillatorType; color: number;
  chords: readonly (readonly number[])[]; roots: readonly number[];
  hooks: readonly (readonly Note[])[]; bassBeats: readonly number[]; bassIntervals: readonly number[]; kick: readonly number[];
}

/** Each world has a composed eight-bar question/answer, a development and a four-bar breakdown.
 * All five scores share 96 BPM so transitions can keep one transport and meet on the bar. */
export const WORLD_COMPOSITIONS: Readonly<Record<PlanetKind, Composition>> = {
  temperate: {
    title: 'Verdant Relay', lead: 'triangle', color: 1.15,
    chords: [[55, 59, 62], [55, 59, 64], [57, 60, 64], [54, 57, 62], [55, 59, 62], [55, 60, 64], [57, 60, 64], [54, 57, 62]],
    roots: [31, 40, 33, 38, 31, 36, 33, 38], bassBeats: [0, 3, 6, 8, 10, 14], bassIntervals: [0, 12, 7, 0, 12, 7], kick: [0, 6, 8, 11],
    hooks: [
      [[0, 67, 2], [3, 71, 1], [6, 74, 2], [10, 76, 2], [14, 74, 2]],
      [[1, 71, 2], [4, 67, 2], [8, 64, 3], [13, 67, 2]],
      [[0, 69, 2], [3, 72, 1], [6, 76, 2], [10, 79, 3], [14, 76, 2]],
      [[0, 74, 3], [4, 69, 2], [7, 66, 2], [11, 64, 1], [14, 62, 2]],
      [[0, 67, 2], [3, 74, 1], [6, 79, 2], [10, 78, 2], [14, 74, 2]],
      [[1, 76, 3], [5, 72, 2], [9, 67, 2], [13, 64, 2]],
      [[0, 69, 2], [3, 72, 1], [6, 76, 2], [9, 74, 2], [12, 72, 2]],
      [[0, 69, 3], [4, 66, 2], [8, 62, 2], [12, 66, 1], [14, 69, 2]],
    ],
  },
  glacial: {
    title: 'Glass Meridian', lead: 'sine', color: .8,
    chords: [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59], [57, 60, 64], [53, 57, 64], [55, 59, 62], [52, 56, 59]],
    roots: [33, 29, 31, 28, 33, 29, 31, 28], bassBeats: [0, 6, 10, 14], bassIntervals: [0, 12, 7, 12], kick: [0, 8],
    hooks: [
      [[0, 81, 3], [6, 76, 2], [10, 72, 3], [15, 76, 1]],
      [[2, 77, 3], [8, 72, 2], [12, 69, 3]],
      [[0, 79, 3], [6, 74, 2], [10, 71, 3], [15, 74, 1]],
      [[2, 76, 3], [8, 71, 2], [12, 67, 3]],
      [[0, 81, 3], [6, 84, 2], [10, 83, 3], [15, 81, 1]],
      [[2, 77, 3], [8, 76, 2], [12, 72, 3]],
      [[0, 79, 3], [6, 83, 2], [10, 86, 3], [15, 83, 1]],
      [[2, 80, 3], [8, 76, 2], [12, 71, 3]],
    ],
  },
  dune: {
    title: 'Amber Caravan', lead: 'triangle', color: .9,
    chords: [[52, 55, 59], [53, 57, 60], [52, 55, 59], [50, 53, 57], [52, 55, 59], [53, 57, 60], [55, 59, 62], [52, 56, 59]],
    roots: [28, 29, 28, 26, 28, 29, 31, 28], bassBeats: [0, 3, 7, 8, 11, 15], bassIntervals: [0, 7, 12, 0, 1, 7], kick: [0, 7, 10],
    hooks: [
      [[0, 64, 2], [3, 65, 1], [5, 67, 2], [9, 71, 2], [12, 67, 1], [15, 65, 1]],
      [[1, 69, 2], [4, 72, 3], [9, 71, 2], [12, 65, 3]],
      [[0, 64, 2], [3, 67, 1], [5, 71, 2], [9, 76, 2], [12, 71, 1], [15, 67, 1]],
      [[1, 69, 2], [4, 65, 3], [9, 62, 2], [12, 65, 3]],
      [[0, 76, 2], [3, 77, 1], [5, 79, 2], [9, 83, 2], [12, 79, 1], [15, 77, 1]],
      [[1, 81, 2], [4, 77, 3], [9, 76, 2], [12, 72, 3]],
      [[0, 74, 2], [3, 71, 1], [5, 67, 2], [9, 71, 2], [12, 74, 1], [15, 76, 1]],
      [[1, 80, 2], [4, 76, 3], [9, 71, 2], [12, 68, 3]],
    ],
  },
  volcanic: {
    title: 'Basalt Engine', lead: 'sawtooth', color: 1.25,
    chords: [[48, 51, 55], [44, 48, 51], [46, 50, 53], [43, 47, 50], [48, 51, 55], [44, 48, 55], [46, 50, 53], [43, 47, 50]],
    roots: [24, 32, 34, 31, 24, 32, 34, 31], bassBeats: [0, 2, 5, 8, 10, 13, 15], bassIntervals: [0, 0, 12, 0, 7, 12, 7], kick: [0, 4, 8, 12],
    hooks: [
      [[0, 60, 1], [2, 60, 1], [5, 67, 2], [8, 63, 1], [11, 62, 2], [14, 60, 2]],
      [[0, 63, 1], [2, 63, 1], [5, 68, 2], [8, 67, 1], [11, 63, 2], [14, 60, 2]],
      [[0, 62, 1], [2, 62, 1], [5, 65, 2], [8, 70, 1], [11, 69, 2], [14, 65, 2]],
      [[0, 62, 2], [4, 59, 2], [7, 55, 1], [10, 59, 2], [14, 62, 2]],
      [[0, 72, 1], [2, 72, 1], [5, 79, 2], [8, 75, 1], [11, 74, 2], [14, 72, 2]],
      [[0, 75, 1], [2, 75, 1], [5, 80, 2], [8, 79, 1], [11, 75, 2], [14, 72, 2]],
      [[0, 74, 1], [2, 74, 1], [5, 77, 2], [8, 82, 1], [11, 81, 2], [14, 77, 2]],
      [[0, 74, 2], [4, 71, 2], [7, 67, 1], [10, 71, 2], [14, 74, 2]],
    ],
  },
};

export function worldScoreStep(step: number, world: PlanetKind): ScoreStep {
  const c = WORLD_COMPOSITIONS[world], bar = Math.floor(step / 16) % 32, beat = step % 16, phrase = bar % 8;
  const breakdown = bar >= 24 && bar < 28, development = bar >= 16 && bar < 24, reprise = bar >= 28;
  const melody = c.hooks[phrase].find(n => n[0] === beat), bassIndex = c.bassBeats.indexOf(beat);
  const drums: Drum[] = [];
  if ((breakdown ? [0] : c.kick).includes(beat)) drums.push('kick');
  if (!breakdown && (beat === 4 || beat === 12) && (world !== 'glacial' || bar % 2 === 1)) drums.push('snare');
  if ((breakdown ? [10] : [2, 6, 10, 14]).includes(beat) || (development && [7, 15].includes(beat))) drums.push('hat');
  if ((bar === 15 || bar === 31) && beat === 15) drums.push('snare');
  return {
    notes: beat === 0 ? c.chords[phrase] : [],
    bass: bassIndex >= 0 && (!breakdown || beat === 0) ? c.roots[phrase] + c.bassIntervals[bassIndex] : undefined,
    lead: melody && (!breakdown || beat < 8) ? melody[1] + (development && phrase < 4 ? 12 : 0) : undefined,
    gate: melody?.[2] ?? 1, accent: beat % 4 === 0 ? 1 : .76,
    brightness: c.color * (breakdown ? .58 : development || reprise ? 1.12 : 1), drums,
  };
}

export const SCENE_MIX: Readonly<Record<MusicScene, { level: number; intensity: number }>> = {
  title: { level: .8, intensity: .08 }, menu: { level: .8, intensity: .1 }, workshop: { level: 1, intensity: .2 },
  setup: { level: .82, intensity: .15 }, loading: { level: .8, intensity: .18 }, skirmish: { level: .88, intensity: .2 },
  pause: { level: .48, intensity: 0 }, results: { level: .75, intensity: .06 },
};
