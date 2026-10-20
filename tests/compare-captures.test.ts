import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareDirectories, compareImages } from '../scripts/compare-captures';
import { encodePng, loadPng, type RgbaImage } from '../scripts/image-metrics';

/** A 16x16 gradient; `shift` brightens one 4x4 block by that many levels. */
function image(shift = 0): RgbaImage {
  const data = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const p = (y * 16 + x) * 4, block = x < 4 && y < 4 ? shift : 0;
    data[p] = x * 8 + block; data[p + 1] = y * 8 + block; data[p + 2] = 64 + block; data[p + 3] = 255;
  }
  return { width: 16, height: 16, data };
}

const directories: string[] = [];
afterAll(() => { for (const dir of directories) rmSync(dir, { recursive: true, force: true }); });

describe('capture comparison', () => {
  it('reports identical images as identical', () => {
    expect(compareImages(image(), image())).toMatchObject({ identical: true, maxDifference: 0, meanDifference: 0, psnr: Infinity, ssim: 1, changedOver2: 0 });
  });

  it('measures a local change by size and by area', () => {
    const result = compareImages(image(), image(10));
    expect(result.identical).toBe(false);
    expect(result.maxDifference).toBe(10);
    // 16 of 256 pixels moved by 10 levels on three channels.
    expect(result.meanDifference).toBeCloseTo(10 * 16 / 256, 9);
    expect(result.changedOver2).toBe(16 / 256);
    expect(result.changedOver8).toBe(16 / 256);
    expect(result.psnr).toBeCloseTo(10 * Math.log10(255 * 255 / (100 * 16 / 256)), 9);
    expect(result.ssim).toBeLessThan(1);
    expect(Array.from(result.diff.data.subarray(0, 4))).toEqual([160, 160, 160, 255]);
    expect(() => compareImages(image(), { width: 8, height: 8, data: new Uint8Array(256) })).toThrow('size');
  });

  it('leaves ignored rectangles out, and only those', () => {
    expect(compareImages(image(), image(10), [[0, 0, 4, 4]])).toMatchObject({ identical: true, maxDifference: 0 });
    // Half of the changed block stays in view.
    expect(compareImages(image(), image(10), [[0, 0, 2, 4]]).changedOver8).toBe(8 / 256);
    expect(compareImages(image(), image(10), [[-5, 2, 100, 100]]).changedOver8).toBe(8 / 256);
  });

  it('pairs shots by name, writes a difference image only where they differ and lists missing shots', () => {
    const [before, after, diff] = ['before', 'after', 'diff'].map(name => { const dir = mkdtempSync(join(tmpdir(), `tmt-compare-${name}-`)); directories.push(dir); return dir; });
    writeFileSync(join(before, 'same.png'), encodePng(image())); writeFileSync(join(after, 'same.png'), encodePng(image()));
    writeFileSync(join(before, 'moved.png'), encodePng(image())); writeFileSync(join(after, 'moved.png'), encodePng(image(3)));
    writeFileSync(join(before, 'only-before.png'), encodePng(image()));
    const report = compareDirectories(before, after, { diff });
    expect(report).toMatchObject({ compared: 2, identical: 1, missingInAfter: ['only-before.png'], worst: { maxDifference: 3 } });
    expect(readdirSync(diff)).toEqual(['moved.png']);
    expect(loadPng(join(diff, 'moved.png')).data[0]).toBe(48);
    expect(compareDirectories(before, after, { match: /^same/ }).compared).toBe(1);
  });
});
