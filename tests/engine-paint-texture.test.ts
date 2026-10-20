import { describe, expect, it } from 'vitest';
import { paintTextureMips } from '../src/engine/materials/paint-texture';
import { packMeshData } from '../src/engine/passes/gbuffer/part-mesh-data';

describe('paint texture rendering data', () => {
  it('packs independent paint UVs without changing existing material coordinates', () => {
    const mesh = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2),
      partLocal: Float32Array.of(9, 8, 7, 6, 5, 4, 3, 2, 1), paintTexture: { width: 1, height: 1, pixels: Uint8Array.of(255, 0, 0, 255), uv: Float32Array.of(.1, .2, .3, .4, .5, .6) } };
    const packed = packMeshData(mesh), floats = new Float32Array(packed.words.buffer);
    expect([...floats.slice(packed.words[3], packed.words[3] + 9)]).toEqual([...mesh.partLocal]);
    expect([...floats.slice(packed.words[11], packed.words[11] + 6)]).toEqual([...mesh.paintTexture.uv]);
    expect(() => packMeshData({ ...mesh, paintTexture: { ...mesh.paintTexture, uv: new Float32Array(2) } })).toThrow(/paint UVs/);
  });
  it('filters premultiplied paint in linear light and limits mips to the padded chart support', () => {
    const pixels = Uint8Array.of(255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0);
    const levels = paintTextureMips(2, 2, pixels);
    expect(levels).toHaveLength(2); expect(levels[1]).toMatchObject({ width: 1, height: 1 });
    expect([...levels[1].pixels]).toEqual([188, 0, 0, 128]);
    expect(paintTextureMips(8, 8, new Uint8Array(256))).toHaveLength(2);
    expect(() => paintTextureMips(4, 4, pixels)).toThrow(/dimensions/);
  });
  it('matches the direct sRGB reference byte for byte across gradients and random coverage', () => {
    const side = 128, pixels = new Uint8Array(side * side * 4); let seed = 719;
    for (let i = 0; i < pixels.length; i++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; pixels[i] = seed >>> 24; }
    const expected = new Uint8Array(pixels.length / 4);
    const decode = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    const encode = (v: number) => Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));
    for (let y = 0; y < side / 2; y++) for (let x = 0; x < side / 2; x++) for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
        const value = pixels[((y * 2 + yy) * side + x * 2 + xx) * 4 + channel] / 255;
        sum += channel === 3 ? value : decode(value);
      }
      expected[(y * side / 2 + x) * 4 + channel] = channel === 3 ? Math.round(sum * 255 / 4) : encode(sum / 4);
    }
    expect(paintTextureMips(side, side, pixels)[1].pixels).toEqual(expected);
  });
});
