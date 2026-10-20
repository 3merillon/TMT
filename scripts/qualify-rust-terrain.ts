/** Full compiler qualification, separate from game/browser measurements. Outputs belong on the artifact drive. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ResidentArrangement, type OwnershipMask, type TetRequest } from '../src/gpu/terrain/arrangement';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { initialPartitions } from '../src/gpu/terrain/page-workers';
import { packPages, unpackPages, type PackedResidentPages } from '../src/gpu/terrain/page-packet';
import { encodeRustCore, RustTerrainCore, unpackRustPages } from '../src/gpu/terrain/rust-core';
import type { PlanetType } from '../src/game/planet-field';

const wasm = process.argv[2]; assert.ok(wasm, 'Pass the release WASM file');
const mode = process.argv[3] ?? 'fixture', seed = Number(process.argv[4] ?? 7), kind = (process.argv[5] ?? 'temperate') as PlanetType;
const module = await WebAssembly.compile(readFileSync(wasm));
const input = mode === 'planet' ? residentPlanet(seed, undefined, 'resident-f32-game-v3', kind) : structuralFixture('three-bricks');
const lattice = residentLattice(input.bounds), oracle = new ResidentArrangement(lattice, input.sources, 2048, true, true);
const initial = encodeRustCore({ lattice, fields: oracle.preparedFields(0), sources: oracle.boxes, sourceFields: oracle.boxFields });
const all = lattice.brickOrder.map(brick => ({ brick, tets: null })), partitions = mode === 'planet' ? initialPartitions(all, 8) : [all];
const rows: Record<string, unknown>[] = [];
const flat = process.argv.includes('--flat');
const hash = (p: PackedResidentPages) => createHash('sha256').update(JSON.stringify(p.strings)).update(new Uint8Array(p.words.buffer, p.words.byteOffset, p.words.byteLength)).update(new Uint8Array(p.values.buffer, p.values.byteOffset, p.values.byteLength)).digest('hex');
function equal(actual: PackedResidentPages, expected: PackedResidentPages, label: string): void {
  assert.equal(actual.strings.length, expected.strings.length, `${label}: strings length`);
  for (let i = 0; i < expected.strings.length; i++) assert.equal(actual.strings[i], expected.strings[i], `${label}: string ${i}`);
  for (const key of ['words', 'values'] as const) {
    assert.equal(actual[key].length, expected[key].length, `${label}: ${key} length`);
    for (let i = 0; i < expected[key].length; i++) assert.equal(actual[key][i], expected[key][i], `${label}: ${key}[${i}]`);
  }
  assert.equal(hash(actual), hash(expected), `${label}: complete packet bytes`);
}
for (let shard = 0; shard < partitions.length; shard++) {
  const a = new ResidentArrangement(lattice, input.sources, 2048, true, true), start = performance.now();
  const rust = await RustTerrainCore.create(module, lattice, initial), initMs = performance.now() - start, base = a.fields.length;
  const check = (label: string, requests: readonly TetRequest[], truncate: number, fields = a.preparedFields(truncate), masks: readonly OwnershipMask[] = []) => {
    const t0 = performance.now(), packet = packPages(a.compileTets(requests, rows.length + 1, masks)), tsMs = performance.now() - t0;
    a.releaseCaches();
    const t1 = performance.now(), stages: Record<string, number> = {}; let at = t1;
    const numeric = rust.compile(requests, rows.length + 1, masks, truncate, fields, stage => { const now = performance.now(); stages[stage] = now - at; at = now; }, flat), rustMs = performance.now() - t1;
    const bridge = performance.now(), actual = flat ? packPages(unpackRustPages(numeric, lattice, a.boxes, a.fields)) : numeric, bridgeMs = performance.now() - bridge;
    equal(actual, packet, label);
    const row = { label, shard, tsMs, rustMs, bridgeMs, flat, stages, ratio: tsMs / rustMs, initMs, inputBytes: initial.byteLength, wasmMemoryBytes: rust.memoryBytes, words: numeric.words.length, values: numeric.values.length, tsFallbacks: a.fallbackCount, rustFallbacks: rust.fallbackCount, hash: hash(actual) };
    rows.push(row); console.log(JSON.stringify(row)); return actual;
  };
  try {
    check('startup', partitions[shard], base);
    if (mode !== 'planet') {
      const fixture = structuralFixture('three-bricks');
      a.addCut(fixture.cuts[0]); check('cut', partitions[shard], base);
      a.rollbackFields(base, 0); a.addCut({ ...fixture.cuts[0], radius: fixture.cuts[0].radius * .75 }); check('rollback-replace', partitions[shard], base);
      const field = a.addCut({ ...fixture.cuts[1], id: 'partial' }), requests = a.tetRequests(a.dirtyTets(field));
      const dirty = requests.reduce((n, r) => n + r.tets!.length, 0); assert.ok(dirty > 0 && dirty < lattice.tets.length, 'Partial qualification must cover real dirty tets');
      const partial = check('partial', requests, base + 1), region = unpackPages(partial).pages.flatMap(p => p.regions).find(r => !r.anchor);
      assert.ok(region, 'Ownership qualification needs an occupied destructible region');
      check('ownership-mask', requests, a.fields.length, [], [{ tet: region.tet, constraints: region.constraints, body: 1 }]);
    }
  } finally { rust.dispose(); }
}
if (process.argv[6]) writeFileSync(process.argv[6], JSON.stringify({ scope: 'Compatibility compiler: complete packed bytes, single-process sequential qualification; timings are diagnostic, not an ABBA performance claim.', mode, seed, kind, rows }, null, 2));
