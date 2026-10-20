import { describe, expect, it } from 'vitest';
import type { MeshDesc, TankSurfaceMark } from '../src/engine/contracts';
import { packMeshData } from '../src/engine/passes/gbuffer/part-mesh-data';

const mesh: MeshDesc = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) };
const mark: TankSurfaceMark = { position: [.1, .2, .3], normal: [0, 0, 1], radius: .1, opacity: .5, softness: .4, color: [1, 0, 0] };
describe('opt-in bounded vehicle surface stream', () => {
  it('leaves shared scenery unchanged and packs articulated coordinates independently of camouflage coordinates', () => {
    const plain = packMeshData(mesh); expect(plain.words[9]).toBe(0); expect(plain.words[10]).toBe(0);
    const packed = packMeshData({ ...mesh, tankSurface: { colors: [[.2, .3, .4], [.1, .2, .3], [.6, .5, .4]], pattern: 2, scale: 1.2, wear: .4, marks: [mark] } });
    const offset = packed.words[9], f = new Float32Array(packed.words.buffer);
    expect(offset).toBe(plain.words.length); expect(packed.words[10]).toBe(1);
    expect(f[offset + 3]).toBe(2); expect(f[offset + 16 + 2]).toBeCloseTo(.3); expect(f[offset + 16 + 7]).toBe(.5);
    expect(packed.words.length - plain.words.length).toBe(32);
  });
  it('caps storage at 192 player marks plus 24 temporary impact scars', () => {
    const packed = packMeshData({ ...mesh, tankSurface: { colors: [[1, 1, 1], [0, 0, 0], [1, 0, 0]], pattern: 0, scale: 1, wear: 0, marks: Array(1000).fill(mark) } });
    expect(packed.words[10]).toBe(216); expect((packed.words.length - packed.words[9]) * 4).toBe(13888);
  });
});
