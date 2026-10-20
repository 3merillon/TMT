/** Shared, deterministic paint relief. Linear RGBA data: height / exposed chip / grit / roughness. */
export const TANK_RELIEF_SIZE = 1024;
export const TANK_RELIEF_TILE_WORLD = .42;
export const TANK_RELIEF_DEPTH_WORLD = .0025;
export interface TankReliefLevel { size: number; height: Uint8Array<ArrayBuffer>; normal: Uint8Array<ArrayBuffer> }

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
function hash(value: number): number {
  let x = value | 0; x = Math.imul(x ^ x >>> 16, 0x7feb352d); x = Math.imul(x ^ x >>> 15, 0x846ca68b);
  return (x ^ x >>> 16) >>> 0;
}

/** Central differences of the actual encoded height, with the same physical scale as the shader's POM.
 * Recomputed at each mip rather than averaging encoded vectors; flat paint is exactly (128,128,255). */
function normals(height: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(height.length), scale = TANK_RELIEF_DEPTH_WORLD * size / (TANK_RELIEF_TILE_WORLD * 2 * 255);
  const h = (x: number, y: number) => height[((y + size) % size * size + (x + size) % size) * 4];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * scale, dy = (h(x, y + 1) - h(x, y - 1)) * scale;
    const inverse = 1 / Math.hypot(dx, dy, 1), p = (y * size + x) * 4;
    out[p] = Math.round((-.5 * dx * inverse + .5) * 255);
    out[p + 1] = Math.round((-.5 * dy * inverse + .5) * 255);
    out[p + 2] = Math.round((.5 * inverse + .5) * 255); out[p + 3] = 255;
  }
  return out;
}

/** Authored wear at several physical scales: paint pores, narrow scratches, chipped notches and shallow
 * rolled-metal depressions. The broad features are sparse, with separate bare-metal masks. */
export function buildTankReliefTextureData(): TankReliefLevel[] {
  const size = TANK_RELIEF_SIZE, height = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const h = hash(i + 0x44e981), p = i * 4;
    // A few shallow enamel pores; the uncut majority stays planar. Grit changes roughness much more than height.
    height[p] = (h & 31) === 0 ? 252 + (h >>> 8 & 3) : 255;
    height[p + 1] = 0; height[p + 2] = (h & 63) === 1 ? 20 + (h >>> 9 & 31) : 0;
    height[p + 3] = 124 + (h >>> 19 & 7);
  }
  let seed = 0x42746d74;
  const rand = () => { seed = hash(seed + 0x9e3779b9); return seed / 0x100000000; };
  const pixels = (millimeters: number) => millimeters * .001 / TANK_RELIEF_TILE_WORLD * size;
  const cut = (cx: number, cy: number, length: number, width: number, angle: number, depth: number, salt: number) => {
    const c = Math.cos(angle), s = Math.sin(angle), reach = Math.ceil(length / 2 + width + 2);
    for (let iy = Math.floor(cy - reach); iy <= Math.ceil(cy + reach); iy++) for (let ix = Math.floor(cx - reach); ix <= Math.ceil(cx + reach); ix++) {
      const dx = ix + .5 - cx, dy = iy + .5 - cy, u = dx * c + dy * s, v = -dx * s + dy * c;
      const t = u / length + .5;
      if (t < 0 || t > 1) continue;
      // Unequal straight flanks, pointed ends and pixel-sized nicks make elongated paint flakes.
      const flank = width * (.25 + .75 * Math.min(t * 3, (1 - t) * 2, 1));
      // Broad flakes have broken shoulders at two scales; narrow scratches retain a crisp continuous cut.
      const broken = width > 2 ? .84 + (hash(salt + Math.floor(u / 4)) & 7) * .04 : 1;
      const nick = (hash(salt + Math.floor(u * 1.5)) & 15) / 50;
      const cover = clamp(flank * broken - Math.abs(v + width * .3 * (t - .5)) - nick + .5) * clamp(Math.min(t, 1 - t) * length);
      if (!cover) continue;
      const x = (ix % size + size) % size, y = (iy % size + size) % size, p = (y * size + x) * 4;
      height[p] = Math.min(height[p], Math.round(255 * (1 - depth * cover)));
      height[p + 1] = Math.max(height[p + 1], Math.round(255 * cover));
      height[p + 2] = Math.max(height[p + 2], Math.round(65 * cover));
      height[p + 3] = Math.max(height[p + 3], Math.round(128 + cover * 60));
    }
  };
  const dent = (cx: number, cy: number, length: number, width: number, angle: number, depth: number) => {
    const c = Math.cos(angle), s = Math.sin(angle), reach = Math.ceil(Math.hypot(length, width) / 2 + 1);
    for (let iy = Math.floor(cy - reach); iy <= Math.ceil(cy + reach); iy++) for (let ix = Math.floor(cx - reach); ix <= Math.ceil(cx + reach); ix++) {
      const dx = ix + .5 - cx, dy = iy + .5 - cy, u = Math.abs((dx * c + dy * s) / (length / 2)), v = Math.abs((-dx * s + dy * c) / (width / 2));
      // A bevelled press mark with a gentle rolled lip, not a round color blotch. Its paint remains intact.
      const edge = clamp(1 - Math.max(u * .82 + v * .18, u * .18 + v * .82));
      if (!edge) continue;
      const bowl = edge * edge * (3 - 2 * edge), x = (ix % size + size) % size, y = (iy % size + size) % size, p = (y * size + x) * 4;
      height[p] = Math.min(height[p], Math.round(255 * (1 - depth * bowl)));
      height[p + 3] = Math.max(height[p + 3], Math.round(128 + bowl * 9));
    }
  };
  // Microscopic paint-edge flakes and directional tool scratches, mixed with rare clearly legible 18–35 mm notches.
  for (let i = 0; i < 700; i++) cut(rand() * size, rand() * size, pixels(1.2 + rand() * 7), .6 + rand() * 1.5, rand() * Math.PI * 2, .24 + rand() * .66, i * 331);
  for (let i = 0; i < 140; i++) cut(rand() * size, rand() * size, pixels(8 + rand() * 28), .35 + rand() * .65, rand() * Math.PI * 2, .15 + rand() * .4, i * 419 + 103);
  for (let i = 0; i < 40; i++) cut(rand() * size, rand() * size, pixels(5 + rand() * 9), pixels(.7 + rand() * .7), rand() * Math.PI * 2, .32 + rand() * .5, i * 613 + 7121);
  for (let i = 0; i < 28; i++) cut(rand() * size, rand() * size, pixels(18 + rand() * 17), pixels(1.0 + rand() * 1.8), rand() * Math.PI * 2, .48 + rand() * .42, i * 733 + 17323);
  for (let i = 0; i < 8; i++) dent(rand() * size, rand() * size, pixels(22 + rand() * 22), pixels(8 + rand() * 9), rand() * Math.PI * 2, .12 + rand() * .13);
  // Explicit boundary-spanning cuts exercise periodic authoring instead of forcing dissimilar border pixels equal.
  cut(0, 317, 31, 1.3, .17, .7, 4001); cut(744, 0, 22, .9, 1.43, .55, 4002);
  const levels: TankReliefLevel[] = [{ size, height, normal: normals(height, size) }];
  while (levels.at(-1)!.size > 1) {
    const previous = levels.at(-1)!, nextSize = previous.size / 2, next = new Uint8Array(nextSize * nextSize * 4);
    for (let y = 0; y < nextSize; y++) for (let x = 0; x < nextSize; x++) for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += previous.height[((y * 2 + dy) * previous.size + x * 2 + dx) * 4 + channel];
      next[(y * nextSize + x) * 4 + channel] = Math.round(sum / 4);
    }
    levels.push({ size: nextSize, height: next, normal: normals(next, nextSize) });
  }
  return levels;
}

/** Two immutable shared RGBA8 textures, including all mips (~10.67 MiB). No per-tank allocation. */
export function createTankReliefTextures(device: GPUDevice, queue: GPUQueue): { heightView: GPUTextureView; normalView: GPUTextureView; sampler: GPUSampler; textures: GPUTexture[] } {
  const levels = buildTankReliefTextureData();
  const textures = ['height-mask', 'normal'].map(label => device.createTexture({ label: `tank-relief:${label}`, size: [TANK_RELIEF_SIZE, TANK_RELIEF_SIZE], mipLevelCount: levels.length,
    format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
  levels.forEach((level, mipLevel) => {
    queue.writeTexture({ texture: textures[0], mipLevel }, level.height, { bytesPerRow: level.size * 4 }, [level.size, level.size]);
    queue.writeTexture({ texture: textures[1], mipLevel }, level.normal, { bytesPerRow: level.size * 4 }, [level.size, level.size]);
  });
  return { heightView: textures[0].createView(), normalView: textures[1].createView(),
    sampler: device.createSampler({ label: 'tank-relief:repeat-anisotropic', addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 4 }), textures };
}
