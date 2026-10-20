/** Capture actual newly constructed intersection operands, including exact-fallback results, from eight canonical
 * partitions. Capturing is deliberately outside timing. No production instrumentation or synthetic random inputs. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { initialPartitions } from '../src/gpu/terrain/page-workers';
import type { PlanetType } from '../src/game/planet-field';
import type { CoreProbeManifest } from './terrain-core-probe';

const out = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && !existsSync(out), 'Pass a fresh external output directory');
mkdirSync(out, { recursive: true });
const seed = Number(process.argv[3] ?? 7), kind = (process.argv[4] ?? 'temperate') as PlanetType;
const input = residentPlanet(seed, undefined, 'resident-f32-game-v3', kind), lattice = residentLattice(input.bounds);
const records: number[] = [], expected: number[] = [], bytes: Record<string, number> = {};
const save = (name: string, value: ArrayBufferView) => { bytes[name] = value.byteLength; writeFileSync(join(out, `${name}.bin`), new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); };
const first = new ResidentArrangement(lattice, input.sources, 2048, true, true, true);
save('samples', Float32Array.from(first.samples.flatMap(s => Array.from(s))));
save('vertices', Uint32Array.from(lattice.tets.flatMap(t => t.vertices)));
const listed = (first as unknown as { brickStatic: Map<string, number[]> }).brickStatic;
const tasks: number[] = [];
for (const tet of lattice.tets) for (const field of listed.get(tet.brick)!) tasks.push(field, tet.index);
save('tasks', Uint32Array.from(tasks));
let fallbacks = 0;
for (const partition of initialPartitions(lattice.brickOrder.map(brick => ({ brick, tets: null })), 8)) {
  const a = new ResidentArrangement(lattice, input.sources, 2048, true, true, true);
  const probe = a as unknown as { intersection(a: number, b: number, field: number): number; value(id: number, field: number): number };
  const original = probe.intersection.bind(a);
  probe.intersection = (x, y, field) => {
    const before = a.vertices.length, id = original(x, y, field);
    if (id !== before) return id;
    if (x > y) [x, y] = [y, x];
    const v = a.vertices[id], basis = v.basis!;
    assert.ok(basis.length >= 1 && basis.length <= 4);
    records.push(basis.length, probe.value(x, field), probe.value(y, field));
    for (let k = 0; k < 4; k++) {
      const key = basis[k], p = key === undefined ? [0, 0, 0] : lattice.positions[key];
      records.push(a.vertices[x].weights.get(key) ?? 0, a.vertices[y].weights.get(key) ?? 0, p[0], p[1], p[2]);
    }
    for (let k = 0; k < 4; k++) expected.push(v.weights.get(basis[k]) ?? 0);
    for (let k = 0; k < 4; k++) expected.push(v.barycentric![k] ?? 0);
    expected.push(...v.position, ...v.values!);
    return id;
  };
  a.compileTets(partition, 1, []); fallbacks += a.fallbackCount;
}
save('intersections', Float64Array.from(records)); save('expected', Float64Array.from(expected));
const manifest: CoreProbeManifest = { seed, kind, intersections: records.length / 23, tasks: tasks.length / 2, positions: lattice.positions.length, fields: first.fields.length, bytes };
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ ...manifest, fallbacks, scope: 'Eight canonical startup partitions. Arithmetic only; no cache/key/face or exact-predicate implementation is benchmarked.' }, null, 2));
console.log(JSON.stringify({ ...manifest, fallbacks }));
