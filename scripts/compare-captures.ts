/**
 * Offline comparison of two capture directories holding the same shots (no GPU workload).
 *   tsx scripts/compare-captures.ts BEFORE_DIR AFTER_DIR [--out report.json] [--diff DIR] [--match regex]
 *     [--ignore x,y,w,h[;x,y,w,h]]                                  pixel rectangles left out (e.g. a live readout)
 *     [--max-mean 0.5] [--min-ssim 0.99] [--max-changed 0.01]     any limit given makes a breach exit 1
 *
 * Per pair of equally named PNGs: whether the decoded pixels are identical, the largest and mean absolute channel
 * difference (8-bit sRGB levels), PSNR, luma SSIM, and the share of pixels whose channels differ by more than 2 and by
 * more than 8 levels. With --diff an amplified difference image is written for every pair that is not identical.
 * These are image differences after exposure, TAA and tone mapping: evidence for review, not a physical error measure.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, loadPng, lumaOf, ssim, type RgbaImage } from './image-metrics';

/** `ignore` rectangles ([x, y, w, h] in pixels) count as unchanged: the second image takes the first one's pixels there. */
export function compareImages(a: RgbaImage, b: RgbaImage, ignore: readonly (readonly number[])[] = []) {
  assert.ok(a.width === b.width && a.height === b.height, 'Images differ in size');
  if (ignore.length) {
    b = { ...b, data: new Uint8Array(b.data) };
    for (const [x0, y0, w, h] of ignore) for (let y = Math.max(0, y0); y < Math.min(a.height, y0 + h); y++) {
      const from = (y * a.width + Math.max(0, x0)) * 4, to = (y * a.width + Math.min(a.width, x0 + w)) * 4;
      if (to > from) b.data.set(a.data.subarray(from, to), from);
    }
  }
  const pixels = a.width * a.height, diff = new Uint8Array(pixels * 4);
  let max = 0, sum = 0, squared = 0, over2 = 0, over8 = 0;
  for (let p = 0; p < pixels; p++) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]);
      sum += d; squared += d * d; if (d > worst) worst = d;
      diff[p * 4 + c] = Math.min(255, d * 16);
    }
    diff[p * 4 + 3] = 255;
    if (worst > max) max = worst;
    if (worst > 2) over2++;
    if (worst > 8) over8++;
  }
  const mse = squared / (pixels * 3), rect: [number, number, number, number] = [0, 0, a.width, a.height];
  return { identical: max === 0, maxDifference: max, meanDifference: sum / (pixels * 3), psnr: mse ? 10 * Math.log10(255 * 255 / mse) : Infinity,
    ssim: max === 0 ? 1 : ssim(lumaOf(a, rect), lumaOf(b, rect), a.width, a.height), changedOver2: over2 / pixels, changedOver8: over8 / pixels,
    diff: { width: a.width, height: a.height, data: diff } as RgbaImage };
}

export function compareDirectories(before: string, after: string, options: { match?: RegExp; diff?: string; ignore?: readonly (readonly number[])[] } = {}) {
  const names = readdirSync(before).filter(name => name.endsWith('.png') && (!options.match || options.match.test(name))).sort();
  const present = new Set(readdirSync(after));
  if (options.diff) mkdirSync(options.diff, { recursive: true });
  const rows = names.filter(name => present.has(name)).map(name => {
    const { diff, ...metrics } = compareImages(loadPng(join(before, name)), loadPng(join(after, name)), options.ignore);
    if (options.diff && !metrics.identical) writeFileSync(join(options.diff, name), encodePng(diff));
    return { name, ...metrics, psnr: Number.isFinite(metrics.psnr) ? metrics.psnr : null };
  });
  return { before: resolve(before), after: resolve(after), missingInAfter: names.filter(name => !present.has(name)), rows,
    identical: rows.filter(row => row.identical).length, compared: rows.length,
    worst: { maxDifference: Math.max(0, ...rows.map(row => row.maxDifference)), meanDifference: Math.max(0, ...rows.map(row => row.meanDifference)),
      ssim: Math.min(1, ...rows.map(row => row.ssim)), changedOver8: Math.max(0, ...rows.map(row => row.changedOver8)) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), [before, after] = args;
  const value = (key: string) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : undefined;
  assert.ok(before && after && !before.startsWith('--') && !after.startsWith('--'), 'Pass BEFORE_DIR AFTER_DIR');
  const ignore = value('ignore')?.split(';').map(rect => rect.split(',').map(Number));
  assert.ok(!ignore || ignore.every(rect => rect.length === 4 && rect.every(Number.isFinite)), '--ignore takes x,y,w,h rectangles separated by ;');
  const report = compareDirectories(before, after, { match: value('match') ? new RegExp(value('match')!) : undefined, diff: value('diff'), ignore });
  assert.ok(report.compared, 'No shots with the same name in both directories');
  const limits = { maxMean: value('max-mean'), minSsim: value('min-ssim'), maxChanged: value('max-changed') };
  const breaches = report.rows.filter(row => (limits.maxMean !== undefined && row.meanDifference > Number(limits.maxMean))
    || (limits.minSsim !== undefined && row.ssim < Number(limits.minSsim)) || (limits.maxChanged !== undefined && row.changedOver8 > Number(limits.maxChanged))).map(row => row.name);
  const result = { ...report, limits, breaches, missing: report.missingInAfter.length };
  if (value('out')) writeFileSync(value('out')!, JSON.stringify(result, null, 1));
  for (const row of report.rows) console.log(`${row.identical ? 'same ' : 'DIFF '} max=${String(row.maxDifference).padStart(3)} mean=${row.meanDifference.toFixed(4)} psnr=${row.psnr === null ? 'inf' : row.psnr.toFixed(1)} ssim=${row.ssim.toFixed(5)} >2=${(row.changedOver2 * 100).toFixed(2)}% >8=${(row.changedOver8 * 100).toFixed(2)}%  ${row.name}`);
  console.log(JSON.stringify({ compared: report.compared, identical: report.identical, missing: report.missingInAfter.length, worst: report.worst, breaches }));
  if (breaches.length || report.missingInAfter.length) process.exitCode = 1;
}
