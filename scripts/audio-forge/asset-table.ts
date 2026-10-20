/** Prints the shipped-asset cost table (markdown) from the manifests: Opus bytes, decoded bytes at the runtime's decode
 * rates (music 32 kHz stereo float, effects 48 kHz mono float), loop lengths. Used to fill docs/audio-continuity.md. */
import score from '../../src/audio/score-manifest.json';
import sfx from '../../src/audio/sfx-manifest.json';

const MUSIC_RATE = 32000, SFX_RATE = 48000;
const mb = (b: number) => (b / 1048576).toFixed(1);
const rows: string[] = ['| Track | Loop | Layers | Opus | Decoded (32 kHz) | LUFS / TP |', '|---|---|---|---|---|---|'];
let opusTotal = 0, decodedTotal = 0, biggest = 0;
for (const t of Object.values(score.tracks).sort((a, b) => a.id.localeCompare(b.id))) {
  const opus = t.stems.reduce((a, s) => a + s.bytes, 0), decoded = t.seconds * MUSIC_RATE * 2 * 4 * t.stems.length;
  opusTotal += opus; decodedTotal += decoded; biggest = Math.max(biggest, decoded);
  rows.push(`| \`${t.id}\` | ${t.kind === 'stinger' ? `${t.seconds.toFixed(1)} s one-shot` : `${t.introBars}+${t.loopBars} bars, ${t.seconds.toFixed(1)} s`} | ${t.stems.length} | ${(opus / 1024).toFixed(0)} KB | ${mb(decoded)} MB | ${t.lufs} / ${t.truePeakDb} |`);
}
const banks = (sfx as { banks?: { file: string; seconds: number; bytes: number }[] }).banks ?? [{ file: sfx.file, seconds: sfx.seconds, bytes: sfx.bytes }];
const bankDecoded = banks.reduce((a, b) => a + b.seconds * SFX_RATE * 4, 0), bankBytes = banks.reduce((a, b) => a + b.bytes, 0);
for (const b of banks) rows.push(`| effects bank \`${b.file}\` (${Object.values(sfx.sprites).filter(s => (s as { bank?: number }).bank === banks.indexOf(b)).length} sprites) | ${b.seconds.toFixed(1)} s | 1 | ${(b.bytes / 1024).toFixed(0)} KB | ${mb(b.seconds * SFX_RATE * 4)} MB (48 kHz mono) | — |`);
console.log(rows.join('\n'));
console.log(`\nTotals: music download ${mb(opusTotal)} MB (${Object.keys(score.tracks).length} tracks), effects ${mb(bankBytes)} MB; decoded if everything were resident ${mb(decodedTotal)} MB, largest track ${mb(biggest)} MB; runtime cache bound 128 MB + banks ${mb(bankDecoded)} MB.`);
