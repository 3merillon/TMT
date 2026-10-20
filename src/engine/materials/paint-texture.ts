const toLinear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const linearBytes = Float64Array.from({ length: 256 }, (_, v) => toLinear(v / 255));
// A 64 KiB starting estimate followed by exact byte-rounding thresholds avoids powers in the upload loop.
const srgbBytes = Uint8Array.from({ length: 65536 }, (_, i) => {
  const v = i / 65535; return Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));
});
const thresholds = Float64Array.from({ length: 255 }, (_, v) => toLinear((v + .5) / 255));
function encodeLinear(value: number): number {
  let byte = srgbBytes[Math.round(value * 65535)];
  if (byte < 255 && value >= thresholds[byte]) byte++;
  else if (byte > 0 && value < thresholds[byte - 1]) byte--;
  return byte;
}

/** One filtered mip fits inside the paint atlas's two-texel chart gutters. Coarser mesh LODs have their own atlases. */
export function paintTextureMips(width: number, height: number, pixels: Uint8Array): { width: number; height: number; pixels: Uint8Array }[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || pixels.length !== width * height * 4)
    throw Error('Invalid paint texture dimensions.');
  const result = [{ width, height, pixels }];
  if (width < 2 || height < 2) return result;
  const w = Math.floor(width / 2), h = Math.floor(height / 2), down = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    const top = (y * 2 * width + x * 2) * 4 + c, bottom = top + width * 4;
    const a = pixels[top], b = pixels[top + 4], d = pixels[bottom], e = pixels[bottom + 4];
    down[(y * w + x) * 4 + c] = a === b && a === d && a === e ? a : c === 3 ? Math.round((a / 255 + b / 255 + d / 255 + e / 255) * 255 / 4)
      : encodeLinear((linearBytes[a] + linearBytes[b] + linearBytes[d] + linearBytes[e]) / 4);
  }
  result.push({ width: w, height: h, pixels: down }); return result;
}
