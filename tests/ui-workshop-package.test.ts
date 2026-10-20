import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { MeshDesc } from '../src/engine';
import { decodeQuantizedRoomMesh, inflateRoomMesh, type RoomMeshSpec } from '../src/game/workshop/mesh-codec';
import { quantizeRoomMesh } from '../scripts/workshop/pack-geometry';

const spec: RoomMeshSpec = { file: 'quality.wmesh', material: 13, tint: [1, 1, 1], vertexCount: 6, indexCount: 6, encoding: 'quant16-gzip' };
const mesh: MeshDesc = {
  positions: Float32Array.from([-.135, 3.141, -8.92, 13.621, -.52, 4.11, 0, 0, 0, 0, 0, 0, 1.49, .87, .51, -2.02, 4.19, -12.12]),
  normals: Float32Array.from([0, 0, 1, 0, 0, -1, 1, 0, 0, -1, 0, 0, 0, -1, 0, .3, .4, Math.sqrt(.75)]),
  partLocal: Float32Array.from([0, 0, 0, 1, 1, 6, .7321, .5799, 3, .7319, .0021, 2, -.01, 1.01, 5, .3, .7, 4]),
  attrs: Uint32Array.from([0xff0deba2, 0xff0dab32, 0xff0d5b14, 0xff0d0055, 0xff0d69ff, 0xff0d0021]),
  indices: Uint32Array.from([0, 2, 1, 3, 4, 5]),
};
describe('shipping geometry package', () => {
  it('preserves winding, UV seams, exact material/layer metadata and submillimetre shape', async () => {
    const packed = quantizeRoomMesh(mesh, spec), gzip = gzipSync(new Uint8Array(packed));
    const decoded = decodeQuantizedRoomMesh(spec, await inflateRoomMesh(spec, Uint8Array.from(gzip).buffer));
    expect(decoded.indices).toEqual(mesh.indices); expect(decoded.attrs).toEqual(mesh.attrs);
    for (let i = 0; i < spec.vertexCount; i++) {
      const p = i * 3;
      expect(Math.hypot(...[0, 1, 2].map(j => decoded.positions[p + j] - mesh.positions[p + j]))).toBeLessThan(.0003);
      expect(Math.hypot(...decoded.normals.slice(p, p + 3))).toBeCloseTo(1, 6);
      expect(decoded.partLocal![p + 2]).toBe(mesh.partLocal![p + 2]);
      for (const j of [0, 1]) expect(Math.abs(decoded.partLocal![p + j] - mesh.partLocal![p + j])).toBeLessThan(.00001);
    }
    expect(decoded.positions.slice(6, 9)).toEqual(decoded.positions.slice(9, 12));
    expect(decoded.partLocal!.slice(6, 9)).not.toEqual(decoded.partLocal!.slice(9, 12));
  });
  it('can reuse position coordinates for worn fixture materials without losing their rest-space mapping', () => {
    const source = { ...mesh, partLocal: mesh.positions }, packed = quantizeRoomMesh(source, { ...spec, material: 19 });
    const decoded = decodeQuantizedRoomMesh({ ...spec, material: 19 }, packed);
    expect(decoded.partLocal).toBe(decoded.positions); expect(decoded.indices).toEqual(mesh.indices);
  });
  it('rejects truncated geometry, invalid indices, oversized inflation and cancelled work', async () => {
    const packed = quantizeRoomMesh(mesh, spec);
    expect(() => decodeQuantizedRoomMesh(spec, packed.slice(0, -1))).toThrow();
    const corrupt = packed.slice(0); new DataView(corrupt).setUint32(corrupt.byteLength - 4, 0xffffffff, true);
    expect(() => decodeQuantizedRoomMesh(spec, corrupt)).toThrow();
    const huge = Uint8Array.from(gzipSync(new Uint8Array(10000))).buffer;
    await expect(inflateRoomMesh(spec, huge)).rejects.toThrow('Oversized');
    const controller = new AbortController(); controller.abort();
    await expect(inflateRoomMesh(spec, Uint8Array.from(gzipSync(new Uint8Array(packed))).buffer, controller.signal)).rejects.toThrow();
  });
});
