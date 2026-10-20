/** A small score manifest and a loader of silent buffers, so the music tests never fetch or decode. */
import type { FakeAudioContext } from '../../src/audio/testing/fake-audio-context';
import type { ScoreManifest, ScoreTrack } from '../../src/audio/score/manifest';
import type { StemLoader } from '../../src/audio/score/player';

export function track(id: string, bpm: number, loopBars: number, introBars = 0, layers = [0, 1, 2], kind: 'loop' | 'stinger' = 'loop'): ScoreTrack {
  const barSec = 60 / bpm * 4, seconds = (introBars + loopBars) * barSec;
  return { id, title: id, bpm, beatsPerBar: 4, introBars, loopBars, seconds, samples: Math.round(seconds * 48000), loopStartSec: introBars * barSec, loopEndSec: seconds, kind,
    stems: layers.map(layer => ({ id: `l${layer}`, file: `${id}-l${layer}.ogg`, layer, bytes: 1000 })), lufs: -14, truePeakDb: -1, seed: 1 };
}
export function testManifest(): ScoreManifest {
  const tracks = [track('title', 108, 4, 1), track('workshop', 96, 4), track('cradle-explore', 118, 4, 0, [0, 1, 2]), track('cradle-combat', 158, 4, 0, [0, 1, 2, 3]), track('cradle-combat-b', 172, 4, 0, [0, 1, 2, 3, 4]), track('cradle-hunt', 132, 4, 0, [0, 1, 2]), track('dune-combat', 146, 4, 0, [0, 1, 2, 3]),
    track('boss-crawler', 132, 4, 0, [0, 1, 2, 3]), track('stinger-victory', 120, 1, 0, [0], 'stinger'), track('stinger-defeat', 120, 1, 0, [0], 'stinger'), track('stinger-boss-phase', 120, 1, 0, [0], 'stinger')];
  return { version: 1, sampleRate: 48000, encoder: 'test', kbps: 64, generated: '', tracks: Object.fromEntries(tracks.map(t => [t.id, t])) };
}
/** Resolves buffers synchronously-ish (next microtask) and counts loads; `fail` makes a file reject. */
export class FakeLoader implements StemLoader {
  loads: string[] = [];
  fail = new Set<string>();
  constructor(private readonly ctx: FakeAudioContext, private readonly manifest: ScoreManifest, private readonly sampleRate = 8000) {}
  async load(file: string): Promise<AudioBuffer> {
    this.loads.push(file);
    if (this.fail.has(file)) throw new Error(`missing ${file}`);
    const t = Object.values(this.manifest.tracks).find(tr => tr.stems.some(s => s.file === file))!;
    return this.ctx.createBuffer(2, Math.max(1, Math.round(t.seconds * this.sampleRate)), this.sampleRate) as unknown as AudioBuffer;
  }
}
/** Flushes pending promises (loads resolve through microtasks; no timers, so it works under fake timers too). */
export const settle = async (n = 24) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
