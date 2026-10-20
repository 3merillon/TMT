/** Measures level continuity across a window of a recording: 100 ms RMS, the deepest dip relative to the surrounding
 * median, and the dip's duration below −6 dB of that median. Used to verify that track switches do not drop out.
 *   node --import tsx scripts/audio-forge/transition-dip.ts <wav> <fromSec> <toSec> */
import { readWav } from './dsp/wav';

const [file, fromS, toS] = process.argv.slice(2);
const { sampleRate, channels } = readWav(file);
const binArg = process.argv.find(a => a.startsWith('--bin=')), binMs = binArg ? Number(binArg.slice(6)) : 100;
const from = Math.round(Number(fromS) * sampleRate), to = Math.min(channels[0].length, Math.round(Number(toS) * sampleRate)), win = Math.round(binMs / 1000 * sampleRate);
const rms: number[] = [];
for (let s = from; s + win <= to; s += win) { let e = 0; for (let i = s; i < s + win; i++) for (const ch of channels) e += ch[i] * ch[i]; rms.push(Math.sqrt(e / (win * channels.length))); }
const db = (v: number) => v > 1e-9 ? 20 * Math.log10(v) : -120;
const sorted = [...rms].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
let minI = 0; rms.forEach((v, i) => { if (v < rms[minI]) minI = i; });
const below = rms.filter(v => db(v) < db(median) - 6).length * binMs / 1000;
if (process.argv.includes('--profile')) console.log(`profile dB/${binMs}ms: ` + rms.map(v => Math.round(db(v))).join(' '));
console.log(JSON.stringify({ file, window: [Number(fromS), Number(toS)], medianDb: Math.round(db(median) * 10) / 10, minDb: Math.round(db(rms[minI]) * 10) / 10, minAtSec: Math.round((Number(fromS) + minI * binMs / 1000) * 100) / 100, dipDb: Math.round((db(rms[minI]) - db(median)) * 10) / 10, secondsBelowMinus6dB: Math.round(below * 10) / 10 }));
