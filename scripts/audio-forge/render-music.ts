/**
 * Renders scores to lossless masters (G:\tmt-work\audio), encodes shipping Opus stems into public/audio/music/, writes
 * per-track analysis (stats JSON, spectrogram and waveform PNG) and the runtime manifest.
 *
 *   node --import tsx scripts/audio-forge/render-music.ts [trackId ...] [--no-encode] [--preview]
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SR, type Stereo } from './dsp/core';
import { writeWav } from './dsp/wav';
import { spectrogramPng, waveformPng, stats } from './dsp/analyze';
import { encodeOpus, ffmpegVersion } from './encode';
import type { Track } from './sequencer';
import { SCORES } from './scores';

const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith('--'))), ids = args.filter(a => !a.startsWith('--'));
const OUT = process.env.TMT_AUDIO_OUT ?? 'G:/tmt-work/audio';
const SHIP = join(process.cwd(), 'public/audio/music');
const MANIFEST = join(process.cwd(), 'src/audio/score-manifest.json');
const KBPS = Number(process.env.TMT_OPUS_KBPS ?? 64);
mkdirSync(join(OUT, 'masters'), { recursive: true }); mkdirSync(join(OUT, 'analysis'), { recursive: true }); mkdirSync(SHIP, { recursive: true });

interface ManifestStem { id: string; file: string; layer: number; bytes: number }
interface ManifestTrack { id: string; title: string; bpm: number; beatsPerBar: number; introBars: number; loopBars: number; seconds: number; samples: number; loopStartSec: number; loopEndSec: number; kind: 'loop' | 'stinger'; stems: ManifestStem[]; lufs: number; truePeakDb: number; seed: number }
type Manifest = { version: number; sampleRate: number; encoder: string; kbps: number; generated: string; tracks: Record<string, ManifestTrack> };

const manifest: Manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { version: 1, sampleRate: SR, encoder: ffmpegVersion(), kbps: KBPS, generated: '', tracks: {} };
const wanted = ids.length ? ids : Object.keys(SCORES);
for (const id of wanted) {
  const make = SCORES[id];
  if (!make) { console.error(`unknown score '${id}'; known: ${Object.keys(SCORES).join(', ')}`); process.exit(1); }
  const t0 = Date.now();
  const track: Track = make();
  const r = track.render();
  const ms = Date.now() - t0;
  const dir = join(OUT, 'masters', id); mkdirSync(dir, { recursive: true });
  writeWav(join(dir, `${id}-full.wav`), r.full);
  // Lossless masters keep every stem; the shipping files are one Opus per LAYER (stems of a layer summed), which is what
  // the runtime mixes, so decoded memory stays at one buffer per layer.
  const stems: ManifestStem[] = [];
  const layers = new Map<number, Stereo>();
  for (const [name, buf] of Object.entries(r.stems)) {
    writeWav(join(dir, `${id}-${name}.wav`), buf);
    const layer = r.stemLayers[name];
    const acc = layers.get(layer) ?? [new Float32Array(buf[0].length), new Float32Array(buf[0].length)];
    for (let c = 0; c < 2; c++) for (let i = 0; i < acc[c].length; i++) acc[c][i] += buf[c][i];
    layers.set(layer, acc);
  }
  for (const [layer, buf] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const wav = join(dir, `${id}-layer${layer}.wav`);
    writeWav(wav, buf);
    const file = `${id}-l${layer}.ogg`;
    const bytes = flags.has('--no-encode') ? 0 : encodeOpus(wav, join(SHIP, file), KBPS);
    stems.push({ id: `l${layer}`, file, layer, bytes });
  }
  const barSamples = track.barSamples;
  const st = stats(r.full, { barSamples, loop: track.spec.kind === 'stinger' ? undefined : [r.loopStart, r.loopEnd] });
  const analysis = { id, title: track.spec.title, bpm: track.bpm, bars: { intro: track.introBars, loop: track.loopBars }, renderMs: ms, preGainDb: r.stats.gainDb, ...st,
    stems: Object.fromEntries(Object.entries(r.stems).map(([n, b]) => [n, stats(b as Stereo)])) };
  writeFileSync(join(OUT, 'analysis', `${id}.json`), JSON.stringify(analysis, null, 1));
  await spectrogramPng(join(OUT, 'analysis', `${id}-spectrogram.png`), r.full, { title: id });
  await waveformPng(join(OUT, 'analysis', `${id}-waveform.png`), r.full);
  if (flags.has('--preview') || !flags.has('--no-encode')) {
    const prev = join(OUT, 'previews', `${id}.wav`); writeWav(prev, r.full, { bits: 16 });
    encodeOpus(prev, join(OUT, 'previews', `${id}.ogg`), 128);
  }
  manifest.tracks[id] = { id, title: track.spec.title, bpm: track.bpm, beatsPerBar: track.beatsPerBar, introBars: track.introBars, loopBars: track.loopBars,
    seconds: r.full[0].length / SR, samples: r.full[0].length, loopStartSec: r.loopStart / SR, loopEndSec: r.loopEnd / SR, kind: track.spec.kind ?? 'loop',
    stems, lufs: st.integratedLufs, truePeakDb: st.truePeakDb, seed: track.spec.seed ?? 0 };
  manifest.generated = new Date().toISOString(); manifest.kbps = KBPS; manifest.encoder = ffmpegVersion();
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  const total = stems.reduce((a, s) => a + s.bytes, 0);
  console.log(`[${id}] ${(r.full[0].length / SR).toFixed(1)}s render ${(ms / 1000).toFixed(1)}s · ${st.integratedLufs} LUFS · TP ${st.truePeakDb} dB · crest ${st.crestDb} dB · corr ${st.correlation} · onsets/s ${st.onsetsPerSecond} · seam ${JSON.stringify(st.seam ?? {})} · opus ${(total / 1024).toFixed(0)} KB`);
  console.log(`  bands ${JSON.stringify(st.bands)}`);
}
void statSync;
