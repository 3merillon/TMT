import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { computeMetrics, crc32, decodePng, metricValue, resolveRect, type RgbaImage } from '../scripts/image-metrics';

// A tiny PNG encoder so every fixture is synthetic and exact.
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
interface EncodeOptions { colorType?: 2 | 6; filter?: 0 | 1 | 2 | 3 | 4 | 'cycle'; bitDepth?: number; colorTypeOverride?: number; interlace?: number }
function encodePng(image: RgbaImage, options: EncodeOptions = {}): Uint8Array {
  const colorType = options.colorType ?? 6, channels = colorType === 6 ? 4 : 3, stride = image.width * channels;
  const pixels = new Uint8Array(image.height * stride);
  for (let p = 0, q = 0; p < image.width * image.height; p++) for (let c = 0; c < channels; c++) pixels[q++] = image.data[p * 4 + c];
  const raw = new Uint8Array(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    const filter = options.filter === 'cycle' ? y % 5 : options.filter ?? 0;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      raw[y * (stride + 1) + 1 + i] = (x - predictor) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width); view.setUint32(4, image.height);
  header[8] = options.bitDepth ?? 8; header[9] = options.colorTypeOverride ?? colorType; header[12] = options.interlace ?? 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  return Buffer.concat(parts);
}

function makeImage(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number?]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a = 255] = pixel(x, y);
    data.set([r, g, b, a], (y * width + x) * 4);
  }
  return { width, height, data };
}
// Deterministic hash noise in [0, 255].
const noise = (x: number, y: number, seed = 1) => { let h = (x * 374761393 + y * 668265263 + seed * 2147483647) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h ^ (h >>> 16)) & 0xff; };

describe('PNG decoder', () => {
  const source = makeImage(13, 9, (x, y) => [noise(x, y), noise(x, y, 2), noise(x, y, 3), noise(x, y, 4)]);

  it.each([0, 1, 2, 3, 4, 'cycle'] as const)('round-trips RGBA with filter %s', filter => {
    const decoded = decodePng(encodePng(source, { colorType: 6, filter }));
    expect([decoded.width, decoded.height]).toEqual([13, 9]);
    expect(Buffer.from(decoded.data).equals(Buffer.from(source.data))).toBe(true);
  });

  it('decodes RGB (colour type 2) with opaque alpha', () => {
    const decoded = decodePng(encodePng(source, { colorType: 2, filter: 'cycle' }));
    for (let p = 0; p < 13 * 9; p++) {
      expect([...decoded.data.subarray(p * 4, p * 4 + 3)]).toEqual([...source.data.subarray(p * 4, p * 4 + 3)]);
      expect(decoded.data[p * 4 + 3]).toBe(255);
    }
  });

  it('rejects unsupported and corrupt files explicitly', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/signature/);
    expect(() => decodePng(encodePng(source, { colorTypeOverride: 3 }))).toThrow(/colour type 3/);
    expect(() => decodePng(encodePng(source, { colorTypeOverride: 0 }))).toThrow(/colour type 0/);
    expect(() => decodePng(encodePng(source, { bitDepth: 16 }))).toThrow(/bit depth 16/);
    expect(() => decodePng(encodePng(source, { interlace: 1 }))).toThrow(/interlaced/);
    const corrupt = encodePng(source); corrupt[20] ^= 0xff;
    expect(() => decodePng(corrupt)).toThrow(/CRC mismatch/);
    expect(() => decodePng(encodePng(source).subarray(0, 40))).toThrow(/truncated|missing/);
  });
});

describe('image metrics', () => {
  it('resolves fractional and pixel rects', () => {
    expect(resolveRect('0,0,1,0.15', 200, 100)).toEqual([0, 0, 200, 15]);
    expect(resolveRect([10, 20, 30, 40], 200, 100)).toEqual([10, 20, 30, 40]);
    expect(resolveRect([150, 90, 100, 100], 200, 100)).toEqual([150, 90, 50, 10]);
    expect(() => resolveRect('1,2,3', 10, 10)).toThrow(/bad rect/);
  });

  it('measures sRGB luma mean and variance over a rect', () => {
    // Top half black, bottom half white.
    const image = makeImage(16, 16, (_x, y) => y < 8 ? [0, 0, 0] : [255, 255, 255]);
    const whole = computeMetrics(image);
    expect(whole.lumaMean).toBeCloseTo(0.5, 6);
    expect(whole.lumaVariance).toBeCloseTo(0.25, 6);
    const top = computeMetrics(image, { rect: '0,0,1,0.5' });
    expect(top.lumaMean).toBe(0);
    expect(top.lumaVariance).toBe(0);
    const grey = computeMetrics(makeImage(4, 4, () => [0, 255, 0]));
    expect(grey.lumaMean).toBeCloseTo(0.7152, 4);
  });

  it('separates flat from detailed regions by Laplacian variance', () => {
    const flat = computeMetrics(makeImage(32, 32, () => [90, 90, 90]));
    const checker = computeMetrics(makeImage(32, 32, (x, y) => (x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
    expect(flat.laplacianVariance).toBe(0);
    expect(checker.laplacianVariance).toBeGreaterThan(1);
  });

  it('scores colourfulness and hue coverage', () => {
    const grey = computeMetrics(makeImage(20, 20, (x) => [x * 10, x * 10, x * 10]));
    expect(grey.colorfulness).toBeCloseTo(0, 6);
    expect(Object.values(grey.hue).every(value => value === 0)).toBe(true);
    const halfGreen = computeMetrics(makeImage(20, 20, (x) => x < 10 ? [40, 180, 60] : [128, 128, 128]));
    expect(halfGreen.hue.green).toBeCloseTo(0.5, 6);
    expect(halfGreen.hue.blue).toBe(0);
    expect(halfGreen.colorfulness).toBeGreaterThan(30);
    const quadrants = computeMetrics(makeImage(20, 20, (x, y) => x < 10 ? (y < 10 ? [230, 120, 20] : [20, 200, 220]) : (y < 10 ? [30, 60, 220] : [5, 5, 5])));
    expect(quadrants.hue.orange).toBeCloseTo(0.25, 6);
    expect(quadrants.hue.cyan).toBeCloseTo(0.25, 6);
    expect(quadrants.hue.blue).toBeCloseTo(0.25, 6);
    expect(metricValue(quadrants, 'hue.green')).toBe(0);
  });

  it('counts pure black and magenta 8x8 blocks as NaN blotches', () => {
    const image = makeImage(64, 32, (x, y) => {
      if (x >= 8 && x < 24 && y >= 8 && y < 24) return [0, 1, 0];       // 2x2 aligned black blocks
      if (x >= 40 && x < 48 && y >= 16 && y < 24) return [255, 0, 255]; // one magenta block
      if (x >= 50 && x < 60 && y < 8) return [10, 10, 12];               // near-black is not NaN
      return [120, 110, 100];
    });
    const metrics = computeMetrics(image);
    expect(metrics.nanBlocks).toEqual({ black: 4, magenta: 1, total: 5, blocks: 32 });
    expect(computeMetrics(makeImage(16, 16, () => [3, 3, 3])).nanBlocks.total).toBe(0);
  });

  it('reports the tilt-shift band ratio', () => {
    // Sharp noise in the centre band only: blurred bands give a ratio near 0.
    const tilt = computeMetrics(makeImage(64, 100, (x, y) => { const v = y >= 30 && y < 70 ? noise(x, y) : 128; return [v, v, v]; }));
    expect(tilt.bandRatio).not.toBeNull();
    expect(tilt.bandRatio!).toBeLessThan(0.05);
    // Uniform noise: all bands equally sharp.
    const uniform = computeMetrics(makeImage(64, 100, (x, y) => { const v = noise(x, y); return [v, v, v]; }));
    expect(uniform.bandRatio!).toBeGreaterThan(0.7);
    expect(uniform.bandRatio!).toBeLessThan(1.3);
    expect(computeMetrics(makeImage(16, 16, () => [7, 7, 7])).bandRatio).toBeNull();
  });

  it('computes SSIM against a golden', () => {
    const golden = makeImage(48, 32, (x, y) => { const v = (x * 5 + y * 3) % 256; return [v, v, v]; });
    expect(computeMetrics(golden, { golden }).ssim).toBeCloseTo(1, 9);
    const noisy = makeImage(48, 32, (x, y) => { const v = Math.min(255, Math.max(0, (x * 5 + y * 3) % 256 + (noise(x, y) - 128) / 2)); return [v, v, v]; });
    const score = computeMetrics(noisy, { golden }).ssim!;
    expect(score).toBeLessThan(0.9);
    expect(score).toBeGreaterThan(0);
    expect(() => computeMetrics(noisy, { golden: makeImage(10, 10, () => [0, 0, 0]) })).toThrow(/golden is 10x10/);
  });
});

describe('image-metrics CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-image-metrics-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prints JSON metrics for a rect, including the requested hue', () => {
    const file = join(dir, 'sky.png');
    writeFileSync(file, encodePng(makeImage(40, 20, (_x, y) => y < 3 ? [8, 10, 24] : [60, 170, 70]), { colorType: 2 }));
    const out = execFileSync(process.execPath, ['--import', 'tsx', resolve('scripts/image-metrics.ts'), file, '--rect', '0,0,1,0.15', '--hue', 'green'], { encoding: 'utf8' });
    const metrics = JSON.parse(out);
    expect(metrics.rect).toEqual([0, 0, 40, 3]);
    expect(metrics.lumaMean).toBeLessThan(0.12);
    expect(metrics.hueName).toBe('green');
    expect(metrics.hueCoverage).toBe(0);
  }, 30000);
});
