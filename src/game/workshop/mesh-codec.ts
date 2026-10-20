/** Loss-bounded room geometry. Triangle order, material attributes and seams are preserved. */
import type { MeshDesc } from '../../engine';

export interface RoomMeshSpec { file: string; material: number; tint: [number, number, number]; vertexCount: number; indexCount: number; encoding?: 'quant16-gzip' }
export const ROOM_MESH_MAGIC = 0x31514d57; // WMQ1, little endian
export const ROOM_MESH_HEADER = 64;

export function validateRoomMeshCounts(spec: RoomMeshSpec): void {
  if (!Number.isInteger(spec.vertexCount) || spec.vertexCount < 3 || spec.vertexCount > 3000000
    || !Number.isInteger(spec.indexCount) || spec.indexCount < 3 || spec.indexCount % 3 || spec.indexCount > 6000000) throw new Error(`Invalid workshop mesh: ${spec.file}`);
}

/** Decode quantized positions/UVs, octahedral normals and delta-coded indices into the engine's existing mesh contract. */
export function decodeQuantizedRoomMesh(spec: RoomMeshSpec, buffer: ArrayBuffer): MeshDesc {
  validateRoomMeshCounts(spec);
  const view = new DataView(buffer), n = spec.vertexCount, m = spec.indexCount;
  if (buffer.byteLength < ROOM_MESH_HEADER || view.getUint32(0, true) !== ROOM_MESH_MAGIC
    || view.getUint32(4, true) !== n || view.getUint32(8, true) !== m) throw new Error(`Invalid packed workshop mesh: ${spec.file}`);
  const flags = view.getUint32(12, true), shared = !!(flags & 1), uv = !!(flags & 2);
  if (flags > 3 || buffer.byteLength !== ROOM_MESH_HEADER + n * (shared ? 14 : 20) + m * 4) throw new Error(`Invalid packed workshop length: ${spec.file}`);
  const bounds = Array.from({ length: 12 }, (_, i) => view.getFloat32(16 + i * 4, true));
  if (bounds.some(v => !Number.isFinite(v)) || [3, 4, 5, 9, 10, 11].some(i => bounds[i] < 0)) throw new Error(`Invalid packed workshop bounds: ${spec.file}`);
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), partLocal = shared ? positions : new Float32Array(n * 3);
  const attrs = new Uint32Array(n), indices = new Uint32Array(m);
  let at = ROOM_MESH_HEADER;
  for (let i = 0; i < positions.length; i++, at += 2) positions[i] = bounds[i % 3] + view.getUint16(at, true) / 65535 * bounds[3 + i % 3];
  for (let i = 0; i < n; i++, at += 4) {
    let x = view.getInt16(at, true) / 32767, y = view.getInt16(at + 2, true) / 32767;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) { const oldX = x; x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1); y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1); }
    const length = Math.hypot(x, y, z);
    normals.set([x / length, y / length, z / length], i * 3);
  }
  if (!shared) for (let i = 0; i < partLocal.length; i++, at += 2) {
    const q = view.getUint16(at, true);
    partLocal[i] = uv && i % 3 === 2 ? q : bounds[6 + i % 3] + q / 65535 * bounds[9 + i % 3];
  }
  for (let i = 0; i < n; i++, at += 4) attrs[i] = view.getUint32(at, true);
  let previous = 0;
  for (let i = 0; i < m; i++, at += 4) {
    const q = view.getUint32(at, true), index = previous + ((q >>> 1) ^ -(q & 1));
    if (index < 0 || index >= n) throw new Error(`Corrupt packed workshop index: ${spec.file}`);
    indices[i] = previous = index;
  }
  return { positions, normals, partLocal, attrs, indices, label: `workshop:${spec.file}` };
}

/** Bounded streaming inflate prevents malformed assets from allocating an unbounded decoded buffer. */
export async function inflateRoomMesh(spec: RoomMeshSpec, compressed: ArrayBuffer, signal?: AbortSignal): Promise<ArrayBuffer> {
  validateRoomMeshCounts(spec);
  const limit = ROOM_MESH_HEADER + spec.vertexCount * 20 + spec.indexCount * 4;
  if (compressed.byteLength > limit + 65536) throw new Error('Oversized packed workshop asset.');
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Oversized decoded workshop asset.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  signal?.throwIfAborted();
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}
