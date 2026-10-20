/** Offline regression for the reproduced contact-shadow self-plane defect. No GPU workload.
 * tsx scripts/check-terrain-shadow-comparison.ts BEFORE_DIR AFTER_DIR [OUTPUT.json]
 * Inputs are the unchanged planetary-shadow-diagnosis capture plan's PNGs and seed7-failing.json.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPng, type PixelRect, type RgbaImage } from './image-metrics';

export function contactDarkening(on: RgbaImage, off: RgbaImage, rect: PixelRect) {
  assert.equal(on.width, off.width); assert.equal(on.height, off.height);
  const [x, y, width, height] = rect;
  assert.ok(x >= 0 && y >= 0 && x + width <= on.width && y + height <= on.height);
  let darkness = 0, darkPixels = 0, offLuma = 0, onLuma = 0;
  const luma = (image: RgbaImage, index: number) => (image.data[index] * .2126 + image.data[index + 1] * .7152 + image.data[index + 2] * .0722) / 255;
  for (let j = y; j < y + height; j++) for (let i = x; i < x + width; i++) {
    const index = (j * on.width + i) * 4, a = luma(on, index), b = luma(off, index), difference = Math.max(0, b - a);
    onLuma += a; offLuma += b; darkness += difference; if (difference > .1) darkPixels++;
  }
  const pixels = width * height;
  return { pixels, meanPositiveDarkening: darkness / pixels, stronglyDarkenedFraction: darkPixels / pixels, onLuma: onLuma / pixels, offLuma: offLuma / pixels };
}

export function compareTerrainShadows(beforeDirectory: string, afterDirectory: string) {
  const captures = [beforeDirectory, afterDirectory].map(dir => JSON.parse(readFileSync(join(dir, 'seed7-failing.json'), 'utf8')));
  const regions: { azimuth: string; rect: PixelRect; note: string }[] = [
    { azimuth: '3-14', rect: [825, 270, 250, 90], note: 'Bare ridge above and right of tank; excludes sky, tank and labels.' },
    { azimuth: '4-71', rect: [20, 360, 530, 240], note: 'Bare left slope; excludes tank, buildings, sky and labels.' },
  ];
  const rows = regions.map(region => {
    const shot = (arm: number, label: string) => captures[arm].shots.find((s: any) => s.label === `${region.azimuth}-${label}`);
    const before = shot(0, 'Sun-shadow'), after = shot(1, 'Sun-shadow'); assert.ok(before && after, 'Required shadow shots missing');
    const maxDelta = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const cameraDelta = Math.max(maxDelta(before.probe.camera.eye, after.probe.camera.eye), maxDelta(before.probe.camera.target, after.probe.camera.target));
    const sunDelta = maxDelta(before.probe.sun.dirToward, after.probe.sun.dirToward);
    assert.ok(cameraDelta <= .001, `Unmatched ${region.azimuth} camera (${cameraDelta})`); assert.ok(sunDelta <= 1e-6, 'Unmatched sun');
    assert.equal(captures[0].size, '1600x1000'); assert.equal(captures[1].size, '1600x1000');
    const arms = [beforeDirectory, afterDirectory].map(dir => contactDarkening(loadPng(join(dir, `seed7-failing-${region.azimuth}-Sun-shadow.png`)),
      loadPng(join(dir, `seed7-failing-${region.azimuth}-without-Contact-shadow.png`)), region.rect));
    return { ...region, cameraDelta, sunDelta, before: arms[0], after: arms[1],
      removal: 1 - arms[1].meanPositiveDarkening / Math.max(1e-9, arms[0].meanPositiveDarkening),
      reproduced: arms[0].stronglyDarkenedFraction > .05,
      passed: arms[1].meanPositiveDarkening < .01 && arms[1].stronglyDarkenedFraction < .01 };
  });
  return { beforeDirectory: resolve(beforeDirectory), afterDirectory: resolve(afterDirectory), rows,
    passed: rows.every(r => r.reproduced && r.passed),
    interpretation: 'sRGB image difference attributable to contact shadows on two fixed bare-terrain regions; excludes tank contact and is not a universal artifact-freedom claim.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [before, after, output] = process.argv.slice(2); assert.ok(before && after, 'Pass BEFORE_DIR AFTER_DIR [OUTPUT.json]');
  const report = compareTerrainShadows(before, after); if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
}
