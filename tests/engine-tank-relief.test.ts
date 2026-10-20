import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTankReliefTextureData, TANK_RELIEF_DEPTH_WORLD, TANK_RELIEF_SIZE, TANK_RELIEF_TILE_WORLD } from '../src/engine/materials/tank-relief-textures';

const levels = buildTankReliefTextureData();
describe('shared tank paint relief textures', () => {
  it('authors deterministic sparse chips while preserving a mostly planar paint surface', () => {
    const h = levels[0].height;
    let intact = 0, chipped = 0, deep = 0, grit = 0;
    for (let i = 0; i < h.length; i += 4) { intact += Number(h[i] === 255); chipped += Number(h[i + 1] > 16); deep += Number(h[i] < 128); grit += Number(h[i + 2] > 0); }
    const count = TANK_RELIEF_SIZE ** 2;
    expect(intact / count).toBeGreaterThan(.9);
    expect(chipped / count).toBeGreaterThan(.005); expect(chipped / count).toBeLessThan(.07);
    expect(deep).toBeGreaterThan(100); expect(grit).toBeGreaterThan(chipped);
    const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
    expect(hash(buildTankReliefTextureData()[0].height)).toBe(hash(h));
  });

  it('encodes normals agreeing with physical height gradients, including the repeating seam, at every mip', () => {
    for (const { size, height, normal } of levels) {
      const at = (x: number, y: number) => height[((y + size) % size * size + (x + size) % size) * 4] / 255;
      const spacing = TANK_RELIEF_TILE_WORLD / size;
      const check = (x: number, y: number) => {
        const dx = (at(x + 1, y) - at(x - 1, y)) * TANK_RELIEF_DEPTH_WORLD / (2 * spacing);
        const dy = (at(x, y + 1) - at(x, y - 1)) * TANK_RELIEF_DEPTH_WORLD / (2 * spacing);
        const len = Math.hypot(dx, dy, 1), expected = [-dx / len, -dy / len, 1 / len], p = (y * size + x) * 4;
        for (let c = 0; c < 3; c++) expect(Math.abs(normal[p + c] / 255 * 2 - 1 - expected[c])).toBeLessThanOrEqual(1 / 255 + 1e-9);
        expect(normal[p + 3]).toBe(255);
      };
      for (let p = 0; p < size * size; p += 1031) check(p % size, Math.floor(p / size));
      for (let i = 0; i < size; i += Math.max(1, Math.floor(size / 32))) { check(0, i); check(size - 1, i); check(i, 0); check(i, size - 1); }
    }
  });

  it('contains broad visible notches, small flakes, and shallow dents with their paint intact', () => {
    const { size, height } = levels[0], seen = new Uint8Array(size * size), stack = new Int32Array(size * size);
    let large = 0, small = 0, paintedDentPixels = 0;
    for (let i = 0; i < size * size; i++) {
      if (height[i * 4] < 245 && height[i * 4 + 1] < 8) paintedDentPixels++;
      if (seen[i] || height[i * 4 + 1] < 128) continue;
      let count = 0, top = 1, x0 = size, x1 = 0, y0 = size, y1 = 0;
      stack[0] = i; seen[i] = 1;
      while (top) {
        const p = stack[--top], x = p % size, y = Math.floor(p / size);
        count++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const q = ny * size + nx;
          if (!seen[q] && height[q * 4 + 1] >= 128) { seen[q] = 1; stack[top++] = q; }
        }
      }
      if (x0 === 0 || y0 === 0 || x1 === size - 1 || y1 === size - 1) continue;
      const diagonal = Math.hypot(x1 - x0 + 1, y1 - y0 + 1), millimeters = diagonal * TANK_RELIEF_TILE_WORLD * 1000 / size;
      // Area per major-axis length rejects long one-pixel scratches masquerading as large chips.
      if (millimeters >= 17 && count / diagonal >= 2) large++;
      if (millimeters <= 8 && count >= 3) small++;
    }
    expect(large).toBeGreaterThanOrEqual(15);
    expect(small).toBeGreaterThan(250);
    expect(paintedDentPixels).toBeGreaterThan(1000);
  });

  it('keeps complete mip chains in 10.67 MiB and downsamples masks within each four-pixel range', () => {
    expect(levels.map(l => l.size)).toEqual([1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
    expect(levels.reduce((bytes, l) => bytes + l.height.byteLength + l.normal.byteLength, 0)).toBe(11184808);
    for (let level = 1; level < levels.length; level++) {
      const current = levels[level], previous = levels[level - 1];
      expect(current.height.length).toBe(current.size ** 2 * 4); expect(current.normal.length).toBe(current.height.length);
      for (let pixel = 0; pixel < current.size ** 2; pixel += 733) for (let c = 0; c < 4; c++) {
        const x = pixel % current.size, y = Math.floor(pixel / current.size), samples: number[] = [];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) samples.push(previous.height[((y * 2 + dy) * previous.size + x * 2 + dx) * 4 + c]);
        const value = current.height[pixel * 4 + c];
        expect(value).toBeGreaterThanOrEqual(Math.min(...samples)); expect(value).toBeLessThanOrEqual(Math.max(...samples));
        expect(value).toBe(Math.round(samples.reduce((a, b) => a + b) / 4));
      }
    }
  });
});
