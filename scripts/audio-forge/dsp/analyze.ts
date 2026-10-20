/** Analysis views for a renderer that cannot listen: spectrogram PNGs (via sharp), waveform PNGs, and a stats bundle. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SR, type Stereo, toDb } from './core';
import { measure, bands, barProfile, onsetsPerSecond, seamCheck } from './loudness';

/** In-place iterative radix-2 FFT (real input in re, zeros in im). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
/** Log-frequency spectrogram PNG: time across, 30 Hz–16 kHz up, dB colour map (−90..0). */
export async function spectrogramPng(path: string, s: Stereo, o: { width?: number; height?: number; fftSize?: number; floorDb?: number; title?: string } = {}): Promise<void> {
  const sharp = (await import('sharp')).default;
  const width = o.width ?? 1400, height = o.height ?? 420, N = o.fftSize ?? 2048, floor = o.floorDb ?? -84;
  const n = s[0].length, hop = Math.max(1, Math.floor((n - N) / width));
  const re = new Float64Array(N), im = new Float64Array(N), win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const fLo = 30, fHi = 16000, bins = N / 2;
  const img = Buffer.alloc(width * height * 3);
  const mag = new Float64Array(bins);
  for (let x = 0; x < width; x++) {
    const start = x * hop;
    for (let i = 0; i < N; i++) { const k = start + i; re[i] = k < n ? (s[0][k] + s[1][k]) * 0.5 * win[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < bins; b++) mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]) / (N / 4);
    for (let y = 0; y < height; y++) {
      const f = fLo * Math.pow(fHi / fLo, 1 - y / (height - 1));
      const bf = f / SR * N, b0 = Math.floor(bf), b1 = Math.min(bins - 1, b0 + 1), t = bf - b0;
      const m = mag[Math.min(bins - 1, b0)] * (1 - t) + mag[b1] * t;
      const v = Math.max(0, Math.min(1, (toDb(m) - floor) / -floor));
      const [r, g, bl] = colorMap(v);
      const at = (y * width + x) * 3; img[at] = r; img[at + 1] = g; img[at + 2] = bl;
    }
  }
  // Grid lines at 100 Hz, 1 kHz, 10 kHz and every 10 s.
  for (const f of [100, 1000, 10000]) { const y = Math.round((1 - Math.log(f / fLo) / Math.log(fHi / fLo)) * (height - 1)); for (let x = 0; x < width; x++) { const at = (y * width + x) * 3; img[at] = 255; img[at + 1] = 255; img[at + 2] = 255; } }
  for (let tSec = 10; tSec * SR < n; tSec += 10) { const x = Math.round(tSec * SR / hop); if (x >= width) break; for (let y = 0; y < height; y += 2) { const at = (y * width + x) * 3; img[at] = 200; img[at + 1] = 200; img[at + 2] = 200; } }
  mkdirSync(dirname(path), { recursive: true });
  await sharp(img, { raw: { width, height, channels: 3 } }).png().toFile(path);
}
function colorMap(v: number): [number, number, number] {
  // black → deep blue → purple → orange → yellow → white
  const stops: [number, number, number, number][] = [[0, 0, 0, 0], [0.25, 20, 10, 90], [0.5, 140, 30, 110], [0.72, 240, 110, 30], [0.9, 255, 220, 60], [1, 255, 255, 255]];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) { const a = stops[i - 1], b = stops[i], t = (v - a[0]) / (b[0] - a[0]); return [Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t), Math.round(a[3] + (b[3] - a[3]) * t)]; }
  return [255, 255, 255];
}
/** Waveform overview PNG (peak + RMS per column). */
export async function waveformPng(path: string, s: Stereo, o: { width?: number; height?: number } = {}): Promise<void> {
  const sharp = (await import('sharp')).default;
  const width = o.width ?? 1400, height = o.height ?? 160, n = s[0].length, per = n / width, img = Buffer.alloc(width * height * 3, 16);
  for (let x = 0; x < width; x++) {
    const a = Math.floor(x * per), b = Math.min(n, Math.floor((x + 1) * per)); let p = 0, e = 0;
    for (let i = a; i < b; i++) { const v = Math.max(Math.abs(s[0][i]), Math.abs(s[1][i])); if (v > p) p = v; e += v * v; }
    const r = Math.sqrt(e / Math.max(1, b - a));
    const draw = (amp: number, col: [number, number, number]) => { const h = Math.round(amp * (height / 2)); for (let y = height / 2 - h; y < height / 2 + h; y++) { if (y < 0 || y >= height) continue; const at = (y * width + x) * 3; img[at] = col[0]; img[at + 1] = col[1]; img[at + 2] = col[2]; } };
    draw(p, [70, 110, 200]); draw(r, [250, 200, 60]);
  }
  mkdirSync(dirname(path), { recursive: true });
  await sharp(img, { raw: { width, height, channels: 3 } }).png().toFile(path);
}
export function stats(s: Stereo, o: { barSamples?: number; loop?: [number, number] } = {}) {
  return {
    seconds: Math.round(s[0].length / SR * 100) / 100, ...measure(s), bands: bands(s), onsetsPerSecond: onsetsPerSecond(s),
    ...(o.barSamples ? { barRmsDb: barProfile(s, o.barSamples) } : {}), ...(o.loop ? { seam: seamCheck(s, o.loop[0], o.loop[1]) } : {}),
  };
}
