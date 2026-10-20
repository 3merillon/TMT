/** Flat TS vs Rust/WASM, one input copy then repeated batches in the SAME linear memory. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { classifyFlat, intersectFlat, type CoreProbeExports, type CoreProbeManifest } from './terrain-core-probe';

const [directory, wasmFile, outputFile] = process.argv.slice(2);
assert.ok(directory && wasmFile && outputFile, 'Pass capture directory, WASM file, output JSON');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as CoreProbeManifest;
const wasmBytes = readFileSync(wasmFile), start = performance.now();
const { instance } = await WebAssembly.instantiate(wasmBytes);
const api = instance.exports as unknown as CoreProbeExports, instantiateMs = performance.now() - start;
const entries = Object.entries(manifest.bytes), pointers: Record<string, number> = {};
const inputs = new Map(entries.map(([name]) => [name, readFileSync(join(directory, `${name}.bin`))]));
for (const [name, size] of entries) pointers[name] = api.allocate(size);
const ip = api.allocate(manifest.intersections * 13 * 8), cp = api.allocate(manifest.tasks * 4);
const copied = performance.now();
for (const [name, size] of entries) new Uint8Array(api.memory.buffer, pointers[name], size).set(inputs.get(name)!);
const copyMs = performance.now() - copied;
const data = new Float64Array(api.memory.buffer, pointers.intersections, manifest.intersections * 23), result = new Float64Array(api.memory.buffer, ip, manifest.intersections * 13);
const samples = new Float32Array(api.memory.buffer, pointers.samples, manifest.bytes.samples / 4), vertices = new Uint32Array(api.memory.buffer, pointers.vertices, manifest.bytes.vertices / 4);
const tasks = new Uint32Array(api.memory.buffer, pointers.tasks, manifest.tasks * 2), classified = new Uint32Array(api.memory.buffer, cp, manifest.tasks);
const expected = readFileSync(join(directory, 'expected.bin'));
const bytes = (array: ArrayBufferView) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
const classificationReference = new Uint32Array(manifest.tasks);
classifyFlat(samples, vertices, tasks, classificationReference, manifest.positions);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const measure = (a: () => void, b: () => void, check: () => void) => {
  const cold: number[] = []; for (const run of [a, b]) { const at = performance.now(); run(); cold.push(performance.now() - at); check(); }
  for (let i = 0; i < 5; i++) { a(); b(); }
  const ts: number[] = [], wasm: number[] = [];
  for (let block = 0; block < 5; block++) for (const arm of [0, 1, 1, 0]) {
    const at = performance.now(); (arm ? b : a)(); (arm ? wasm : ts).push(performance.now() - at); check();
  }
  return { coldTsMs: cold[0], coldWasmMs: cold[1], tsMs: ts, wasmMs: wasm, medianTsMs: median(ts), medianWasmMs: median(wasm), speedup: median(ts) / median(wasm) };
};
const intersections = measure(() => intersectFlat(data, result, manifest.intersections), () => api.intersections(pointers.intersections, ip, manifest.intersections), () => assert.ok(bytes(result).equals(expected), 'Intersection output differs from captured TS oracle'));
const classification = measure(() => classifyFlat(samples, vertices, tasks, classified, manifest.positions), () => api.classify(pointers.samples, pointers.vertices, pointers.tasks, cp, manifest.positions, manifest.tasks), () => assert.ok(bytes(classified).equals(bytes(classificationReference)), 'Classification differs'));
const resultData = { node: process.version, cpu: cpus()[0].model, manifest, wasmFile, wasmBytes: wasmBytes.length,
  wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'), instantiateMs, copyMs, wasmMemoryBytes: api.memory.buffer.byteLength,
  intersections, classification, identity: 'Every output byte checked after every timed batch', scope: 'Arithmetic and original-sample classification only. Excludes allocation, hash caches, exact predicate reconstruction, faces, connectivity and production integration.' };
writeFileSync(outputFile, JSON.stringify(resultData, null, 2));
console.log(JSON.stringify({ instantiateMs, copyMs, wasmBytes: wasmBytes.length, memory: api.memory.buffer.byteLength, intersections: intersections.speedup, classification: classification.speedup }));
for (const [name, size] of entries) api.release(pointers[name], size);
api.release(ip, manifest.intersections * 13 * 8); api.release(cp, manifest.tasks * 4);
