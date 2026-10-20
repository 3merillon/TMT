/** Listening previews of adaptive layering: a track's layers enter one by one (every N bars) from its lossless layer
 * masters, exactly as the runtime would stack them, then drop back. Writes previews/<id>-escalation.{wav,ogg}.
 *   node --import tsx scripts/audio-forge/preview-escalation.ts boss-crawler fleet-launch cradle-combat */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SR, type Stereo } from './dsp/core';
import { readWav, writeWav } from './dsp/wav';
import { encodeOpus } from './encode';
import manifest from '../../src/audio/score-manifest.json';

const OUT = process.env.TMT_AUDIO_OUT ?? 'G:/tmt-work/audio';
for (const id of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
  const track = (manifest as { tracks: Record<string, { bpm: number; beatsPerBar: number; introBars: number; loopBars: number; loopStartSec: number; loopEndSec: number; stems: { layer: number }[] }> }).tracks[id];
  if (!track) { console.error(`unknown track ${id}`); continue; }
  const layers = track.stems.map(s => s.layer).sort((a, b) => a - b);
  const files = layers.map(l => join(OUT, 'masters', id, `${id}-layer${l}.wav`));
  if (!files.every(existsSync)) { console.error(`${id}: layer masters missing`); continue; }
  const buffers = files.map(f => readWav(f).channels);
  const barSec = 60 / track.bpm * track.beatsPerBar, barN = Math.round(barSec * SR), every = 8;
  const loopStart = Math.round(track.loopStartSec * SR), loopEnd = Math.round(track.loopEndSec * SR), loopLen = loopEnd - loopStart;
  // Schedule: intro + layers stacking every 8 bars, then all layers for 8 bars, then down to layer 0 for 4 bars.
  const stages = [...layers.map((_, i) => i + 1), layers.length, 1];
  const total = loopStart + stages.length * every * barN;
  const out: Stereo = [new Float32Array(total), new Float32Array(total)];
  for (let i = 0; i < total; i++) {
    const srcIndex = i < loopEnd ? i : loopStart + ((i - loopStart) % loopLen);
    const stage = i < loopStart ? stages.length : Math.min(stages.length - 1, Math.floor((i - loopStart) / (every * barN)));
    const active = i < loopStart ? 1 : stages[stage];
    for (let l = 0; l < layers.length; l++) {
      if (l >= active) continue;
      // Smooth 0.5 s ramps at stage boundaries so the preview has the runtime's layer fades.
      const boundary = i < loopStart ? 1 : Math.min(1, ((i - loopStart) % (every * barN)) / (0.5 * SR));
      const prevActive = stage === 0 || i < loopStart ? active : stages[stage - 1];
      const g = l < prevActive ? 1 : boundary;
      out[0][i] += buffers[l][0][srcIndex] * g; out[1][i] += buffers[l][1][srcIndex] * g;
    }
  }
  for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] = Math.max(-1, Math.min(1, ch[i]));
  const wav = join(OUT, 'previews', `${id}-escalation.wav`);
  writeWav(wav, out, { bits: 16 });
  encodeOpus(wav, join(OUT, 'previews', `${id}-escalation.ogg`), 128);
  console.log(`${id}: ${(total / SR).toFixed(1)} s, layers ${layers.join('/')} stacking every ${every} bars → ${wav}`);
}
