/**
 * Compact shipping package for fast workshop entry. Reads the archived full-detail sources (runtime-source geometry and
 * texture-source images, which stay untouched) and replaces the shipping files in public/workshop.
 * node node_modules/tsx/dist/cli.mjs scripts/workshop/pack-compact.ts [--prop-error-mm 8] [--room-error-mm 4] [--dry-run]
 *
 * Geometry: identical vertices are welded, then meshoptimizer removes triangles within a bounded world-space error
 * (authored props may collapse across UV seams within that error; architecture keeps its seams; brick courses are only
 * welded). Original vertices and attributes are kept exactly, then the result is reordered for the vertex cache and
 * written in the existing quant16-gzip format. Textures: prop colour 1K, packed normals 512, ORM 256, surface and gauge
 * maps 512 (colour filtered in linear light, normals renormalized, roughness variance averaged), and the RGBM reflection
 * probe 128 per face, filtered in linear radiance. File names carry a content hash and the manifest names every file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import type { MeshDesc } from '../../src/engine';
import { decodeRoomMesh, type RoomManifest } from '../../src/game/workshop/room';
import { decodeQuantizedRoomMesh, type RoomMeshSpec } from '../../src/game/workshop/mesh-codec';
import { quantizeRoomMesh } from './pack-geometry';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'public/workshop'), geometrySource = resolve(root, 'assets/workshop/runtime-source'), imageSource = resolve(root, 'assets/workshop/texture-source');
const args = process.argv.slice(2);
const option = (name: string, fallback: number) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
const PROP_ERROR = option('--prop-error-mm', 8) / 1000, ROOM_ERROR = option('--room-error-mm', 4) / 1000;
const SIZE = { propColor: 1024, propNormal: 512, propOrm: 256, surface: 512, gauge: 512, probe: 128 };
const QUALITY = { color: 82, surface: 84, gauge: 88, normal: [88, 92, 96] };
const SURFACES = ['architecture-brick', 'architecture-concrete', 'architecture-vault', 'fixture-paint', 'fixture-brass'];
const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
const dryRun = args.includes('--dry-run');
const written = new Set<string>(), report: Record<string, unknown>[] = [];

function emit(stem: string, extension: string, bytes: Uint8Array): string {
  const file = `${stem}.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${extension}`;
  if (!dryRun) writeFileSync(resolve(output, file), bytes);
  written.add(file); return file;
}

// ---- geometry ---------------------------------------------------------------------------------------------------------
/** Every stored bit of one vertex. */
function vertexKey(mesh: MeshDesc, i: number): string {
  return `${[mesh.positions, mesh.normals, mesh.partLocal!].map(a => Array.from(new Uint32Array(a.buffer, a.byteOffset + i * 12, 3)).join(',')).join(',')},${mesh.attrs![i]}`;
}

function compactGeometry(mesh: MeshDesc, spec: RoomMeshSpec): { mesh: MeshDesc; error: number } {
  const n = spec.vertexCount, ids = new Map<string, number>(), remap = new Uint32Array(n), first: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = vertexKey(mesh, i);
    let id = ids.get(key);
    if (id === undefined) { id = first.length; ids.set(key, id); first.push(i); }
    remap[i] = id;
  }
  const count = first.length, positions = new Float32Array(count * 3), attributes = new Float32Array(count * 6);
  first.forEach((source, i) => {
    positions.set(mesh.positions.subarray(source * 3, source * 3 + 3), i * 3);
    attributes.set(mesh.normals.subarray(source * 3, source * 3 + 3), i * 6); attributes.set(mesh.partLocal!.subarray(source * 3, source * 3 + 3), i * 6 + 3);
  });
  let indices: Uint32Array = Uint32Array.from(mesh.indices, v => remap[v]), error = 0;
  const prop = spec.material === 13, bricks = spec.material === 15 || spec.material === 17;
  if (!bricks) {
    // UVs (13) and baked linear colour (9..17) are weighted; rest-space fixture coordinates follow their position.
    const weighted = prop || spec.material <= 17 ? .5 : 0, scale = MeshoptSimplifier.getScale(positions, 3);
    const [simplified, relative] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, 6,
      [.5, .5, .5, weighted, weighted, prop ? 0 : weighted], null, 0, (prop ? PROP_ERROR : ROOM_ERROR) / scale, prop ? ['Permissive'] : []);
    indices = simplified; error = relative * scale;
  }
  const kept = indices.slice(), [order, unique] = MeshoptEncoder.reorderMesh(indices, true, false);
  const out = { positions: new Float32Array(unique * 3), normals: new Float32Array(unique * 3), partLocal: new Float32Array(unique * 3), attrs: new Uint32Array(unique) };
  // The remap only spans vertices up to the highest one still referenced.
  for (let i = 0; i < order.length; i++) {
    const target = order[i];
    if (target === 0xffffffff) continue;
    out.positions.set(positions.subarray(i * 3, i * 3 + 3), target * 3);
    out.normals.set(attributes.subarray(i * 6, i * 6 + 3), target * 3); out.partLocal.set(attributes.subarray(i * 6 + 3, i * 6 + 6), target * 3);
    out.attrs[target] = mesh.attrs![first[i]];
  }
  const shared = out.partLocal.every((v, i) => v === out.positions[i]);
  const result = { ...out, partLocal: shared ? out.positions : out.partLocal, indices, label: mesh.label };
  // Reordering and compaction must hand back exactly the simplified triangles, winding included.
  const triangles = (list: Uint32Array, key: (vertex: number) => string) => {
    const counts = new Map<string, number>();
    for (let t = 0; t < list.length; t += 3) {
      const corners = [key(list[t]), key(list[t + 1]), key(list[t + 2])], start = corners.indexOf([...corners].sort()[0]);
      const id = [0, 1, 2].map(k => corners[(start + k) % 3]).join('|');
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  };
  const expected = triangles(kept, vertex => vertexKey(mesh, first[vertex])), actual = triangles(indices, vertex => vertexKey(result, vertex));
  if (expected.size !== actual.size || [...expected].some(([id, n]) => actual.get(id) !== n)) throw new Error(`Compaction changed triangles: ${spec.file}`);
  return { mesh: result, error };
}

function packGeometry(spec: RoomMeshSpec): RoomMeshSpec {
  const stem = spec.file.replace(/\.bin$/, ''), input = readFileSync(resolve(geometrySource, spec.file));
  const original = decodeRoomMesh(spec, input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  const { mesh, error } = compactGeometry(original, spec);
  const packedSpec: RoomMeshSpec = { ...spec, vertexCount: mesh.positions.length / 3, indexCount: mesh.indices.length, encoding: 'quant16-gzip' };
  const encoded = quantizeRoomMesh(mesh, packedSpec), decoded = decodeQuantizedRoomMesh(packedSpec, encoded);
  let quantization = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) quantization = Math.max(quantization, Math.hypot(...[0, 1, 2].map(j => mesh.positions[i + j] - decoded.positions[i + j])));
  if (quantization > .001 || decoded.attrs!.some((v, i) => v !== mesh.attrs![i])) throw new Error(`Packing changed geometry outside tolerance: ${spec.file}`);
  const file = emit(stem, 'wmesh', gzipSync(new Uint8Array(encoded), { level: 9 }));
  report.push({ file, triangles: [spec.indexCount / 3, packedSpec.indexCount / 3], vertices: [spec.vertexCount, packedSpec.vertexCount],
    simplificationErrorMm: +(error * 1000).toFixed(2), quantizationErrorMm: +(quantization * 1000).toFixed(3), bytes: readSize(file) });
  return { ...packedSpec, file };
}

// ---- images -----------------------------------------------------------------------------------------------------------
const srgbToLinear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
/** Stored 8-bit values exactly as authored: no colour management or alpha premultiplication. */
async function raw(file: string, channels: 3 | 4) {
  const image = sharp(resolve(imageSource, file)), { data, info } = await (channels === 4 ? image : image.removeAlpha()).raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== channels) throw new Error(`${file}: expected ${channels} channels, found ${info.channels}`);
  return { data, width: info.width, height: info.height };
}
/** Integer box reduction; `map` turns stored bytes into the quantity averaged, per channel. */
function box(source: { data: Uint8Array; width: number; height: number }, channels: number, size: number, map: (v: number, channel: number) => number) {
  const factor = source.width / size;
  if (!Number.isInteger(factor) || source.height / factor !== size) throw new Error(`Box reduction needs an integer factor (${source.width} to ${size}).`);
  const out = new Float32Array(size * size * channels), lut = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: 256 }, (_, v) => map(v, c)));
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const s = (y * source.width + x) * channels, d = (Math.floor(y / factor) * size + Math.floor(x / factor)) * channels;
    for (let c = 0; c < channels; c++) out[d + c] += lut[c][source.data[s + c]];
  }
  for (let i = 0; i < out.length; i++) out[i] /= factor * factor;
  return out;
}
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Albedo filtered in linear light (16-bit pipeline), encoded back to sRGB. */
async function color(source: string, stem: string, size: number, quality: number): Promise<string> {
  const bytes = await sharp(resolve(imageSource, source)).pipelineColourspace('rgb16').resize(size, size, { kernel: 'lanczos3' })
    .toColourspace('srgb').webp({ quality, effort: 6, smartSubsample: true }).toBuffer();
  return emit(stem, 'webp', bytes);
}

/** Averaged unit vectors, renormalized, packed as two grayscale planes plus an exact Z-sign alpha (workshop-textures.ts). */
async function normal(source: string, stem: string): Promise<string> {
  const size = SIZE.propNormal, averaged = box(await raw(source, 3), 3, size, v => v / 127.5 - 1);
  const packed = Buffer.alloc(size * 2 * size * 4), wanted = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const x = averaged[i * 3], y = averaged[i * 3 + 1], z = averaged[i * 3 + 2], length = Math.hypot(x, y, z) || 1;
    wanted.set([x / length, y / length, z / length], i * 3);
    const row = Math.floor(i / size), column = i % size, alpha = z < 0 ? 254 : 255;
    for (const [plane, value] of [[0, x / length], [1, y / length]] as const) {
      const p = (row * size * 2 + plane * size + column) * 4, v = byte(value * .5 + .5);
      packed[p] = packed[p + 1] = packed[p + 2] = v; packed[p + 3] = alpha;
    }
  }
  for (const quality of QUALITY.normal) {
    const bytes = await sharp(packed, { raw: { width: size * 2, height: size, channels: 4 } }).webp({ quality, alphaQuality: 100, effort: 6 }).toBuffer();
    const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer(); // an all-opaque image omits its alpha chunk
    const errors: number[] = [];
    for (let i = 0; i < size * size; i++) {
      const row = Math.floor(i / size), column = i % size, l = (row * size * 2 + column) * 4, r = l + size * 4;
      if (decoded[l + 3] !== packed[l + 3]) throw new Error(`${source}: normal sign alpha changed`);
      const x = decoded[l] / 127.5 - 1, y = decoded[r] / 127.5 - 1, z = Math.sqrt(Math.max(0, 1 - x * x - y * y)) * (decoded[l + 3] < 255 ? -1 : 1), length = Math.hypot(x, y, z);
      errors.push(Math.acos(Math.min(1, (x * wanted[i * 3] + y * wanted[i * 3 + 1] + z * wanted[i * 3 + 2]) / length)) * 180 / Math.PI);
    }
    errors.sort((a, b) => a - b);
    const p95 = errors[Math.floor(errors.length * .95)];
    if (p95 < 2.5 || quality === QUALITY.normal.at(-1)) { report.push({ source, quality, p95AngularErrorDegrees: +p95.toFixed(3) }); return emit(stem, 'webp', bytes); }
  }
  throw new Error('unreachable');
}

/** glTF metallicRoughness: G roughness (variance-averaged), B metallic; R is unused. Six-bit steps, lossless. */
async function orm(source: string, stem: string): Promise<string> {
  const size = SIZE.propOrm, averaged = box(await raw(source, 3), 3, size, (v, c) => c === 1 ? (v / 255) ** 2 : v / 255);
  const six = (v: number) => Math.round(Math.round(Math.max(0, Math.min(1, v)) * 63) / 63 * 255);
  const pixels = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) { pixels[i * 3 + 1] = six(Math.sqrt(averaged[i * 3 + 1])); pixels[i * 3 + 2] = six(averaged[i * 3 + 2]); }
  return emit(stem, 'webp', await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).webp({ lossless: true, effort: 6 }).toBuffer());
}

/** RGBM (range 32, linear): decoded radiance is box-filtered, then re-encoded exactly into lossless WebP. */
async function probeFace(face: string): Promise<string> {
  const size = SIZE.probe, source = await raw(`reflection-${face}.png`, 4), factor = source.width / size;
  if (!Number.isInteger(factor)) throw new Error('Reflection faces need an integer reduction.');
  const radiance = new Float32Array(size * size * 3);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const s = (y * source.width + x) * 4, d = (Math.floor(y / factor) * size + Math.floor(x / factor)) * 3, m = source.data[s + 3] / 255 * 32;
    for (let c = 0; c < 3; c++) radiance[d + c] += source.data[s + c] / 255 * m / (factor * factor);
  }
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const peak = Math.max(radiance[i * 3], radiance[i * 3 + 1], radiance[i * 3 + 2]), alpha = Math.max(1, Math.min(255, Math.ceil(peak / 32 * 255)));
    for (let c = 0; c < 3; c++) pixels[i * 4 + c] = byte(radiance[i * 3 + c] / (alpha / 255 * 32));
    pixels[i * 4 + 3] = alpha;
  }
  return emit(`reflection-${face}`, 'webp', await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).webp({ lossless: true, effort: 6 }).toBuffer());
}

function readSize(file: string): number { return dryRun ? 0 : readFileSync(resolve(output, file)).length; }

// ---- package ----------------------------------------------------------------------------------------------------------
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const sourceManifest = JSON.parse(readFileSync(resolve(geometrySource, 'manifest.json'), 'utf8')) as RoomManifest;
const current = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8')) as RoomManifest & Record<string, unknown>;
const meshes = sourceManifest.meshes.map(packGeometry), fanRotor = sourceManifest.fanRotor?.map(packGeometry);
const textures = [];
for (let i = 0; i < (current.textures?.length ?? 0); i++) {
  textures.push({ baseColor: await color(`prop-${i}-baseColor.jpg`, `prop-${i}-baseColor`, SIZE.propColor, QUALITY.color),
    normal: await normal(`prop-${i}-normal.png`, `prop-${i}-normal`), orm: await orm(`prop-${i}-orm.jpg`, `prop-${i}-orm`), normalEncoding: 'xy-gray' as const });
}
const surfaces: string[] = [];
for (const name of SURFACES) surfaces.push(await color(`${name}.png`, name, SIZE.surface, QUALITY.surface));
const gaugeFace = await color('gauge-face.png', 'gauge-face', SIZE.gauge, QUALITY.gauge);
const faces: string[] = [];
for (const face of FACES) faces.push(await probeFace(face));
const probe = JSON.parse(readFileSync(resolve(geometrySource, 'reflection-probe.json'), 'utf8'));
probe.size = SIZE.probe;
probe.faces = probe.faces.map((entry: { face: string }) => ({ ...entry, file: faces[FACES.indexOf(entry.face as typeof FACES[number])] }));
probe.imageCodec = `lossless WebP; RGBM re-encoded after ${512 / SIZE.probe}x${512 / SIZE.probe} linear-radiance box filtering`;
const triangles = [...meshes, ...(fanRotor ?? [])].reduce((sum, spec) => sum + spec.indexCount / 3, 0);
const manifest = { ...current, version: 2, meshes, fanRotor, textures, surfaces, gaugeFace, reflection: { size: SIZE.probe, faces }, triangles,
  textureEncoding: 'WebP; 1K colour, 512 XY-gray normals, 256 six-bit ORM, 512 surfaces; exact RGBM probe at 128',
  source: `${current.source}; compact package (scripts/workshop/pack-compact.ts)` };
if (!dryRun) {
  writeFileSync(resolve(geometrySource, 'reflection-probe.json'), JSON.stringify(probe));
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest));
  // Only superseded packaged geometry and images in this output directory are removed; sources remain intact.
  for (const file of readdirSync(output)) if (/\.(wmesh|bin|webp)$/i.test(file) && !written.has(file)) unlinkSync(resolve(output, file));
}
const total = dryRun ? 0 : [...written].reduce((sum, file) => sum + readSize(file), 0);
writeFileSync(resolve(geometrySource, 'compact-package-report.json'), JSON.stringify({ createdAt: new Date().toISOString(), propErrorMm: PROP_ERROR * 1000, roomErrorMm: ROOM_ERROR * 1000,
  sizes: SIZE, triangles, files: written.size, bytes: total, details: report }, null, 2) + '\n');
console.log(JSON.stringify({ triangles, files: written.size, megabytes: +(total / 1048576).toFixed(2), output: existsSync(output) ? output : null }));
