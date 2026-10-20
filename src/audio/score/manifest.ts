/** Types of the generated score manifest (src/audio/score-manifest.json, written by scripts/audio-forge/render-music.ts). */
export interface ScoreStem { id: string; file: string; layer: number; bytes: number }
export interface ScoreTrack {
  id: string; title: string; bpm: number; beatsPerBar: number; introBars: number; loopBars: number;
  seconds: number; samples: number; loopStartSec: number; loopEndSec: number; kind: 'loop' | 'stinger';
  stems: ScoreStem[]; lufs: number; truePeakDb: number; seed: number;
}
export interface ScoreManifest { version: number; sampleRate: number; encoder: string; kbps: number; generated: string; tracks: Record<string, ScoreTrack> }
