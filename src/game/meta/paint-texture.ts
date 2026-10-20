/** Lossless, JSON-safe paint pixels. Tiles are immutable; history shares their compressed strings. */
export type PaintSlot = 'hull' | 'runningGear' | 'turret' | 'weapon' | 'utility';
export interface PaintTextureTile { key: string; width: number; height: number; data: string }
export interface PaintTextureLayer {
  version: 1; slot: PaintSlot; partId: string; group: string; lod: 0 | 1 | 2; tiles: PaintTextureTile[];
}
export const PAINT_TILE_SIZE = 512;
const decoded = new Map<string, Uint8Array>();
let decodedBytes = 0;
const CACHE_BYTES = 16 * 1024 * 1024;

/** PackBits over RGBA pixels: repeated runs or literal runs, each at most 128 pixels. */
export function encodePaintPixels(pixels: Uint8Array): string {
  if (pixels.length % 4) throw Error('Paint pixels must be RGBA.');
  const out: number[] = [], count = pixels.length / 4;
  const equal = (a: number, b: number) => [0, 1, 2, 3].every(k => pixels[a * 4 + k] === pixels[b * 4 + k]);
  let at = 0;
  while (at < count) {
    let run = 1;
    while (run < 128 && at + run < count && equal(at, at + run)) run++;
    if (run > 1) { out.push(127 + run, ...pixels.subarray(at * 4, at * 4 + 4)); at += run; continue; }
    const start = at++;
    while (at < count && at - start < 128 && !(at + 1 < count && equal(at, at + 1))) at++;
    out.push(at - start - 1);
    for (let i = start * 4; i < at * 4; i++) out.push(pixels[i]);
  }
  let binary = '';
  for (let i = 0; i < out.length; i += 8192) binary += String.fromCharCode(...out.slice(i, i + 8192));
  return btoa(binary);
}

/** Validates lengths before allocation. The returned cached bytes must never be mutated. */
export function decodePaintPixels(tile: Pick<PaintTextureTile, 'width' | 'height' | 'data'>): Uint8Array | null {
  const { width, height, data } = tile;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > PAINT_TILE_SIZE || height > PAINT_TILE_SIZE
    || typeof data !== 'string' || data.length % 4 !== 0 || data.length > Math.ceil((width * height * 5 + 1) / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const key = `${width}:${height}:${data}`, cached = decoded.get(key); if (cached) return cached;
  let binary: string; try { binary = atob(data); } catch { return null; }
  const result = new Uint8Array(width * height * 4); let input = 0, output = 0;
  while (input < binary.length) {
    const header = binary.charCodeAt(input++), count = (header & 127) + 1, repeat = header >= 128;
    const bytes = repeat ? 4 : count * 4;
    if (input + bytes > binary.length || output + count * 4 > result.length) return null;
    for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) result[output++] = binary.charCodeAt(input + (repeat ? c : i * 4 + c));
    input += bytes;
  }
  if (output !== result.length) return null;
  while (decodedBytes + result.length > CACHE_BYTES && decoded.size) { const first = decoded.keys().next().value!; decodedBytes -= decoded.get(first)!.length; decoded.delete(first); }
  decoded.set(key, result); decodedBytes += result.length;
  return result;
}

/** Keeps every valid tile; storage/network limits report an error at their boundary instead of cropping artwork. */
export function sanitizePaintTextures(value: unknown): PaintTextureLayer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || raw.version !== 1 || !['hull', 'runningGear', 'turret', 'weapon', 'utility'].includes(raw.slot)
      || typeof raw.partId !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(raw.partId) || typeof raw.group !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(raw.group)
      || ![0, 1, 2].includes(raw.lod) || !Array.isArray(raw.tiles)) return [];
    const keys = new Set<string>(), tiles: PaintTextureTile[] = [];
    for (const tile of raw.tiles) {
      if (!tile || typeof tile.key !== 'string' || !/^p1-[0-9a-f]{16}$/.test(tile.key) || keys.has(tile.key) || !decodePaintPixels(tile)) continue;
      keys.add(tile.key); tiles.push({ key: tile.key, width: tile.width, height: tile.height, data: tile.data });
    }
    return [{ version: 1, slot: raw.slot, partId: raw.partId, group: raw.group, lod: raw.lod, tiles } as PaintTextureLayer];
  });
}
