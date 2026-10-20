/**
 * Offline image metrics for capture verdicts: every screenshot judgement in a rubric
 * is paired with one of these numbers. No dependencies: a minimal PNG decoder on node:zlib.
 *
 *   npx tsx scripts/image-metrics.ts <png> [--rect x,y,w,h] [--hue green|blue|cyan|orange] [--golden <png>]
 *
 *   --rect x,y,w,h   region to measure. When every value is <= 1 they are fractions of the image, otherwise pixels
 *                    (e.g. --rect 0,0,1,0.15 is the top 15% band, the "sky not black" check).
 *   --hue <name>     also print hueCoverage for one hue (all four are always in "hue").
 *   --golden <png>   SSIM of the same rect against a golden image of the same size.
 *
 * Output (JSON on stdout), all over the rect:
 *   lumaMean, lumaVariance, lumaStd   sRGB-encoded Rec.709 luma in [0, 1] (no linearisation, so 0.12 means a dark band)
 *   laplacianVariance                 variance of the 3x3 Laplacian of luma over interior pixels (sharpness)
 *   colorfulness                      Hasler–Süsstrunk M = σ_rgyb + 0.3·μ_rgyb on a 0–255 scale (≈ 0 grey, > 33 colourful)
 *   hue.{green,blue,cyan,orange}      fraction of pixels in the hue range with HSV saturation > 0.2 (and value > 0.05, so
 *                                     sensor-dark noise does not count); ranges in degrees: orange 15–45, green 75–165,
 *                                     cyan 165–200, blue 200–260
 *   nanBlocks.{black,magenta,total}   aligned 8x8 blocks that are entirely pure black (every channel < 2/255) or pure
 *                                     magenta (R, B > 245 and G < 10): the "no NaN blotches" check
 *   bandRatio                         Laplacian variance of the top + bottom 20% rows ÷ the centre band (40–60%): the
 *                                     tilt-shift check (< 0.45 means the bands are blurred); null when the centre is flat
 *   ssim                              mean SSIM of luma over 8x8 windows (stride 4) against --golden
 *
 * Only 8-bit, non-interlaced truecolour PNGs (colour types 2 and 6) are decoded; anything else is rejected explicitly.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

export interface RgbaImage { width: number; height: number; /** RGBA8, row-major */ data: Uint8Array }
/** Pixel rectangle: x, y, width, height. */
export type PixelRect = [number, number, number, number];
export type HueName = 'green' | 'blue' | 'cyan' | 'orange';
export const HUE_RANGES: Record<HueName, [number, number]> = { orange: [15, 45], green: [75, 165], cyan: [165, 200], blue: [200, 260] };

export interface ImageMetrics {
  width: number; height: number; rect: PixelRect;
  lumaMean: number; lumaVariance: number; lumaStd: number;
  laplacianVariance: number;
  colorfulness: number;
  hue: Record<HueName, number>;
  nanBlocks: { black: number; magenta: number; total: number; blocks: number };
  bandRatio: number | null;
  ssim?: number;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class PngError extends Error { override name = 'PngError'; }

/** Decode an 8-bit truecolour (RGB or RGBA), non-interlaced PNG into RGBA8. */
export function decodePng(input: Uint8Array): RgbaImage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) throw new PngError('not a PNG file (bad signature)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, colorType = -1, sawEnd = false;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8, dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new PngError(`truncated ${type} chunk`);
    if (crc32(bytes, offset + 4, dataEnd) !== view.getUint32(dataEnd)) throw new PngError(`CRC mismatch in ${type} chunk`);
    if (type === 'IHDR') {
      width = view.getUint32(dataStart); height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]; colorType = bytes[dataStart + 9];
      const interlace = bytes[dataStart + 12];
      if (bitDepth !== 8) throw new PngError(`unsupported bit depth ${bitDepth} (only 8-bit PNGs are decoded)`);
      if (colorType !== 2 && colorType !== 6) throw new PngError(`unsupported colour type ${colorType} (only truecolour 2 and truecolour+alpha 6 are decoded)`);
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0) throw new PngError('unsupported compression or filter method');
      if (interlace !== 0) throw new PngError('interlaced PNGs are not supported');
      if (!width || !height) throw new PngError('PNG has zero width or height');
    } else if (type === 'IDAT') idat.push(bytes.subarray(dataStart, dataEnd));
    else if (type === 'IEND') { sawEnd = true; break; }
    offset = dataEnd + 4;
  }
  if (colorType < 0) throw new PngError('missing IHDR chunk');
  if (!idat.length) throw new PngError('missing IDAT chunk');
  if (!sawEnd) throw new PngError('missing IEND chunk (truncated file?)');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new PngError(`image data too short: ${raw.length} < ${height * (stride + 1)} bytes`);
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1, row = y * stride, previous = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[source + i];
      const a = i >= channels ? pixels[row + i - channels] : 0;
      const b = y > 0 ? pixels[previous + i] : 0;
      const c = y > 0 && i >= channels ? pixels[previous + i - channels] : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new PngError(`invalid filter type ${filter} on row ${y}`);
      }
      pixels[row + i] = value & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: pixels };
  const data = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) { data[q] = pixels[p]; data[q + 1] = pixels[p + 1]; data[q + 2] = pixels[p + 2]; data[q + 3] = 255; }
  return { width, height, data };
}

/** Minimal RGBA8 PNG encoder (filter 0, colour type 6), for goldens, diff images and test fixtures. */
export function encodePng(image: RgbaImage): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  };
  const stride = image.width * 4;
  const raw = new Uint8Array(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width); view.setUint32(4, image.height);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([new Uint8Array(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

/** Resolve a rect given as fractions (every value <= 1) or pixels, clamped to the image and at least 1x1. */
export function resolveRect(spec: string | readonly number[] | undefined, width: number, height: number): PixelRect {
  if (spec === undefined) return [0, 0, width, height];
  const values = (typeof spec === 'string' ? spec.split(',') : spec).map(Number);
  if (values.length !== 4 || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`bad rect ${JSON.stringify(spec)}: use x,y,w,h (fractions <= 1 or pixels)`);
  const fractions = values.every(value => value <= 1);
  let [x, y, w, h] = fractions ? [values[0] * width, values[1] * height, values[2] * width, values[3] * height] : values;
  x = Math.min(width - 1, Math.max(0, Math.round(x))); y = Math.min(height - 1, Math.max(0, Math.round(y)));
  w = Math.max(1, Math.min(width - x, Math.round(w))); h = Math.max(1, Math.min(height - y, Math.round(h)));
  return [x, y, w, h];
}

/** sRGB-encoded Rec.709 luma of the rect, row-major, in [0, 1]. */
export function lumaOf(image: RgbaImage, rect: PixelRect): Float32Array {
  const [x0, y0, w, h] = rect;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = ((y0 + y) * image.width + x0 + x) * 4;
    out[y * w + x] = (0.2126 * image.data[p] + 0.7152 * image.data[p + 1] + 0.0722 * image.data[p + 2]) / 255;
  }
  return out;
}

function meanVariance(values: ArrayLike<number>, start = 0, end = values.length): { mean: number; variance: number; count: number } {
  let sum = 0, sumSq = 0;
  for (let i = start; i < end; i++) { sum += values[i]; sumSq += values[i] * values[i]; }
  const count = end - start;
  if (!count) return { mean: 0, variance: 0, count };
  const mean = sum / count;
  return { mean, variance: Math.max(0, sumSq / count - mean * mean), count };
}

/** 3x3 Laplacian response per interior pixel; NaN on the border so row bands can skip it. */
function laplacian(luma: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h).fill(Number.NaN);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    out[i] = luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w] - 4 * luma[i];
  }
  return out;
}
function varianceOfRows(values: Float32Array, w: number, rows: [number, number][]): number | null {
  let sum = 0, sumSq = 0, count = 0;
  for (const [from, to] of rows) for (let y = from; y < to; y++) for (let x = 0; x < w; x++) {
    const value = values[y * w + x];
    if (Number.isNaN(value)) continue;
    sum += value; sumSq += value * value; count++;
  }
  if (!count) return null;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

/** Mean SSIM of two equally sized luma arrays over 8x8 windows with stride 4 (constants for a dynamic range of 1). */
export function ssim(a: Float32Array, b: Float32Array, w: number, h: number): number {
  if (a.length !== b.length || a.length !== w * h) throw new Error('ssim: images differ in size');
  const C1 = 0.01 ** 2, C2 = 0.03 ** 2, size = Math.min(8, w, h), step = Math.max(1, size >> 1);
  let total = 0, windows = 0;
  for (let y = 0; y + size <= h; y += step) for (let x = 0; x + size <= w; x += step) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const k = (y + j) * w + x + i, va = a[k], vb = b[k];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
    const n = size * size, ma = sa / n, mb = sb / n;
    const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
    total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    windows++;
  }
  return windows ? total / windows : 1;
}

export interface MetricOptions { rect?: string | readonly number[]; golden?: RgbaImage }

export function computeMetrics(image: RgbaImage, options: MetricOptions = {}): ImageMetrics {
  const rect = resolveRect(options.rect, image.width, image.height);
  const [x0, y0, w, h] = rect;
  const luma = lumaOf(image, rect);
  const lumaStats = meanVariance(luma);
  const lap = laplacian(luma, w, h);
  const laplacianVariance = varianceOfRows(lap, w, [[0, h]]) ?? 0;
  const band = (from: number, to: number): [number, number] => [Math.floor(from * h), Math.max(Math.floor(from * h) + 1, Math.ceil(to * h))];
  const edges = varianceOfRows(lap, w, [band(0, 0.2), band(0.8, 1)]);
  const centre = varianceOfRows(lap, w, [band(0.4, 0.6)]);
  const bandRatio = edges === null || centre === null || centre === 0 ? null : edges / centre;

  let sumRg = 0, sumYb = 0, sumRg2 = 0, sumYb2 = 0;
  const hueCounts: Record<HueName, number> = { green: 0, blue: 0, cyan: 0, orange: 0 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = ((y0 + y) * image.width + x0 + x) * 4;
    const r = image.data[p], g = image.data[p + 1], b = image.data[p + 2];
    const rg = r - g, yb = 0.5 * (r + g) - b;
    sumRg += rg; sumYb += yb; sumRg2 += rg * rg; sumYb2 += yb * yb;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (!max || delta / max <= 0.2 || max / 255 <= 0.05) continue;
    let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue *= 60; if (hue < 0) hue += 360;
    for (const name of Object.keys(HUE_RANGES) as HueName[]) { const [from, to] = HUE_RANGES[name]; if (hue >= from && hue < to) hueCounts[name]++; }
  }
  const n = w * h;
  const muRg = sumRg / n, muYb = sumYb / n;
  const sdRg = Math.sqrt(Math.max(0, sumRg2 / n - muRg * muRg)), sdYb = Math.sqrt(Math.max(0, sumYb2 / n - muYb * muYb));
  const colorfulness = Math.sqrt(sdRg * sdRg + sdYb * sdYb) + 0.3 * Math.sqrt(muRg * muRg + muYb * muYb);

  const nanBlocks = { black: 0, magenta: 0, total: 0, blocks: 0 };
  for (let by = 0; by + 8 <= h; by += 8) for (let bx = 0; bx + 8 <= w; bx += 8) {
    nanBlocks.blocks++;
    let black = true, magenta = true;
    for (let j = 0; j < 8 && (black || magenta); j++) for (let i = 0; i < 8; i++) {
      const p = ((y0 + by + j) * image.width + x0 + bx + i) * 4;
      const r = image.data[p], g = image.data[p + 1], b = image.data[p + 2];
      if (r >= 2 || g >= 2 || b >= 2) black = false;
      if (r <= 245 || g >= 10 || b <= 245) magenta = false;
      if (!black && !magenta) break;
    }
    if (black) nanBlocks.black++; else if (magenta) nanBlocks.magenta++;
  }
  nanBlocks.total = nanBlocks.black + nanBlocks.magenta;

  const metrics: ImageMetrics = {
    width: image.width, height: image.height, rect,
    lumaMean: lumaStats.mean, lumaVariance: lumaStats.variance, lumaStd: Math.sqrt(lumaStats.variance),
    laplacianVariance, colorfulness,
    hue: { green: hueCounts.green / n, blue: hueCounts.blue / n, cyan: hueCounts.cyan / n, orange: hueCounts.orange / n },
    nanBlocks, bandRatio,
  };
  if (options.golden) {
    if (options.golden.width !== image.width || options.golden.height !== image.height)
      throw new Error(`golden is ${options.golden.width}x${options.golden.height}, image is ${image.width}x${image.height}`);
    metrics.ssim = ssim(luma, lumaOf(options.golden, rect), w, h);
  }
  return metrics;
}

const decodedCache = new Map<string, RgbaImage>();
/** Decode a PNG file (memoised per path for the lifetime of the process). */
export function loadPng(path: string): RgbaImage {
  const key = resolve(path);
  let image = decodedCache.get(key);
  if (!image) { image = decodePng(readFileSync(key)); decodedCache.set(key, image); }
  return image;
}

export function imageMetricsFromFile(path: string, options: { rect?: string | readonly number[]; golden?: string } = {}): ImageMetrics {
  return computeMetrics(loadPng(path), { rect: options.rect, golden: options.golden ? loadPng(options.golden) : undefined });
}

/** Read a dotted metric path such as "lumaMean", "hue.green" or "nanBlocks.total". */
export function metricValue(metrics: ImageMetrics, path: string): number | null | undefined {
  let value: unknown = metrics;
  for (const key of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' || value === null ? value : undefined;
}

function main(argv: string[]): void {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`missing value for --${key}`);
      flags[key] = value;
    } else positional.push(token);
  }
  if (positional.length !== 1) throw new Error('usage: image-metrics.ts <png> [--rect x,y,w,h] [--hue green|blue|cyan|orange] [--golden <png>]');
  const hue = flags.hue as HueName | undefined;
  if (hue && !(hue in HUE_RANGES)) throw new Error(`unknown --hue ${hue}; use ${Object.keys(HUE_RANGES).join('|')}`);
  const metrics = imageMetricsFromFile(positional[0], { rect: flags.rect, golden: flags.golden });
  console.log(JSON.stringify({ file: positional[0], ...metrics, ...(hue ? { hueName: hue, hueCoverage: metrics.hue[hue] } : {}) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`[image-metrics] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
