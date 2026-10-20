/** Reproducible shipping package. Run after Blender export; retained sources never lose vertices or triangles. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { MeshDesc } from '../../src/engine';
import { decodeRoomMesh, type RoomManifest } from '../../src/game/workshop/room';
import { decodeQuantizedRoomMesh, ROOM_MESH_HEADER, ROOM_MESH_MAGIC, type RoomMeshSpec } from '../../src/game/workshop/mesh-codec';

export function quantizeRoomMesh(mesh: MeshDesc, spec: RoomMeshSpec): ArrayBuffer {
  const n = spec.vertexCount, m = spec.indexCount, local = mesh.partLocal!;
  const shared = local.every((v, i) => v === mesh.positions[i]), uv = spec.material === 13;
  const bounds = (array: Float32Array) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    array.forEach((v, i) => { min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v); });
    return [...min, ...max.map((v, i) => v - min[i])];
  };
  const limits = [...bounds(mesh.positions), ...bounds(local)];
  const bytes = new ArrayBuffer(ROOM_MESH_HEADER + n * (shared ? 14 : 20) + m * 4), view = new DataView(bytes);
  [ROOM_MESH_MAGIC, n, m, (shared ? 1 : 0) | (uv ? 2 : 0)].forEach((v, i) => view.setUint32(i * 4, v, true));
  limits.forEach((v, i) => view.setFloat32(16 + i * 4, v, true));
  let at = ROOM_MESH_HEADER;
  const quant = (value: number, axis: number, base: number) => Math.max(0, Math.min(65535, Math.round((value - limits[base + axis]) / (limits[base + 3 + axis] || 1) * 65535)));
  mesh.positions.forEach((v, i) => { view.setUint16(at, quant(v, i % 3, 0), true); at += 2; });
  for (let i = 0; i < n; i++) {
    const nx = mesh.normals[i * 3], ny = mesh.normals[i * 3 + 1], nz = mesh.normals[i * 3 + 2];
    const sum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
    if (!Number.isFinite(sum) || sum < .1) throw new Error('Invalid authored normal.');
    let x = nx / sum, y = ny / sum;
    if (nz < 0) { const oldX = x; x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1); y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1); }
    view.setInt16(at, Math.round(x * 32767), true); view.setInt16(at + 2, Math.round(y * 32767), true); at += 4;
  }
  if (!shared) local.forEach((v, i) => { view.setUint16(at, uv && i % 3 === 2 ? Math.round(v) : quant(v, i % 3, 6), true); at += 2; });
  mesh.attrs!.forEach(v => { view.setUint32(at, v, true); at += 4; });
  let previous = 0;
  mesh.indices.forEach(v => { const delta = v - previous; view.setUint32(at, ((delta << 1) ^ (delta >> 31)) >>> 0, true); previous = v; at += 4; });
  return bytes;
}

export function packageGeometry(root: string) {
  const output = resolve(root, 'public/workshop'), source = resolve(root, 'assets/workshop/runtime-source');
  mkdirSync(source, { recursive: true });
  const current = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8')) as RoomManifest;
  if (current.version === 1) {
    for (const spec of [...current.meshes, ...(current.fanRotor ?? [])]) {
      if (!/^[a-z0-9._-]+\.bin$/i.test(spec.file)) throw new Error('Invalid source path.');
      copyFileSync(resolve(output, spec.file), resolve(source, spec.file));
    }
    writeFileSync(resolve(source, 'manifest.json'), JSON.stringify(current, null, 2) + '\n');
  }
  const raw = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8')) as RoomManifest;
  const report = { sourceBytes: 0, packedBytes: 0, triangles: 0, maxPositionErrorMeters: 0, maxNormalErrorDegrees: 0, meshes: [] as object[] };
  const pack = (spec: RoomMeshSpec): RoomMeshSpec => {
    const input = readFileSync(resolve(source, spec.file)), original = decodeRoomMesh(spec, input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    const encoded = quantizeRoomMesh(original, spec), decoded = decodeQuantizedRoomMesh(spec, encoded);
    let positionError = 0, normalError = 0;
    for (let i = 0; i < spec.vertexCount; i++) {
      positionError = Math.max(positionError, Math.hypot(...[0, 1, 2].map(j => original.positions[i * 3 + j] - decoded.positions[i * 3 + j])));
      let dot = 0, length = 0;
      for (let j = 0; j < 3; j++) { dot += original.normals[i * 3 + j] * decoded.normals[i * 3 + j]; length += original.normals[i * 3 + j] ** 2; }
      normalError = Math.max(normalError, Math.acos(Math.min(1, Math.max(-1, dot / Math.sqrt(length)))) * 180 / Math.PI);
    }
    if (positionError > .001 || normalError > .03 || original.indices.some((v, i) => decoded.indices[i] !== v) || original.attrs!.some((v, i) => decoded.attrs![i] !== v)) throw new Error(`Packing changed geometry outside tolerance: ${spec.file}`);
    const compressed = gzipSync(new Uint8Array(encoded), { level: 9 });
    const hash = createHash('sha256').update(compressed).digest('hex').slice(0, 12), file = spec.file.replace('.bin', `.${hash}.wmesh`);
    writeFileSync(resolve(output, file), compressed);
    report.sourceBytes += input.length; report.packedBytes += compressed.length; report.triangles += spec.indexCount / 3;
    report.maxPositionErrorMeters = Math.max(report.maxPositionErrorMeters, positionError); report.maxNormalErrorDegrees = Math.max(report.maxNormalErrorDegrees, normalError);
    report.meshes.push({ file, triangles: spec.indexCount / 3, sourceBytes: input.length, packedBytes: compressed.length, positionError, normalError });
    return { ...spec, file, encoding: 'quant16-gzip' };
  };
  // Texture packing may already have updated the current manifest; retain that independent work.
  const manifest = { ...raw, ...current, version: 2, meshes: raw.meshes.map(pack), fanRotor: raw.fanRotor?.map(pack) };
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest));
  const live = new Set([...manifest.meshes, ...(manifest.fanRotor ?? [])].map(spec => spec.file));
  // Only superseded geometry packages in this explicit output directory are removed. Authored sources remain intact.
  for (const file of readdirSync(output)) if (/^(room|fan)-[a-z0-9.-]+\.(bin|wmesh)$/i.test(file) && !live.has(file)) unlinkSync(resolve(output, file));
  writeFileSync(resolve(source, 'geometry-package-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (!existsSync(resolve(root, 'public/workshop/manifest.json'))) throw new Error('Run the Blender room export first.');
  console.log(JSON.stringify(packageGeometry(root), null, 2));
}
