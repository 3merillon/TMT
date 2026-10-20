import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { encodeRustCore, RustTerrainCore, unpackRustPages } from '../src/gpu/terrain/rust-core';
import { auditBoundary, terrainConnectivity } from '../src/game/terrain-connectivity';
import type { OccupiedRegion } from '../src/gpu/terrain/contracts';
import type { ResidentWorldInput } from '../src/gpu/terrain/fixtures';

// Captured from a real online startup. Tet -12,-6,-15/0 has one planet sample
// at -3.913537e-6; f32 publication collapses a side face of its single-plane cap.
it('preserves the closed native planet around a collapsed cap', async () => {
  const input = residentPlanet(1420208847, undefined, 'resident-f32-game-v3'), lattice = residentLattice(input.bounds);
  const arrangement = new ResidentArrangement(lattice, input.sources, 2048, true, true);
  const regions: OccupiedRegion[] = [];
  {
    const initial = encodeRustCore({ lattice, fields: arrangement.preparedFields(0), sources: arrangement.boxes, sourceFields: arrangement.boxFields, canonicalConstruction: true });
    const module = await WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
    const core = await RustTerrainCore.create(module, lattice, initial);
    const world = await RustTerrainCore.createWorld(module, initial, arrangement.fields.length);
    try {
      world.begin(1);
      for (const brick of lattice.brickOrder) {
        const packet = core.compile([{ brick, tets: null }], 1, [], arrangement.fields.length, [], undefined, true);
        world.ingest(packet);
        for (const page of arrangement.acceptCompiled(unpackRustPages(packet, lattice, arrangement.boxes, arrangement.fields))) regions.push(...page.regions);
        core.resetConstruction();
      }
      world.connect(); world.commit();
    } finally { core.dispose(); world.dispose(); }
  }
  expect(regions.length).toBeGreaterThan(0);
  expect(regions.every(region => Number.isFinite(region.volume) && region.volume > 0)).toBe(true);
  const boundary = terrainConnectivity(regions, arrangement).boundary;
  expect(auditBoundary(boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
  for (const { face } of boundary) {
    const points = face.vertices.map(id => arrangement.vertices[id].position), a = points[0];
    expect(points.slice(1, -1).some((b, i) => {
      const c = points[i + 2], u = b.map((v, j) => v - a[j]), v = c.map((n, j) => n - a[j]);
      return u[1] * v[2] - u[2] * v[1] !== 0 || u[2] * v[0] - u[0] * v[2] !== 0 || u[0] * v[1] - u[1] * v[0] !== 0;
    })).toBe(true);
  }
}, 30000);

it('still refuses a non-dyadic source whose physical boundary cannot close', async () => {
  const { fixture } = JSON.parse(readFileSync(new URL('./fixtures/terrain/resident-rejected-neighborhood.json', import.meta.url), 'utf8')) as { fixture: ResidentWorldInput };
  const lattice = residentLattice(fixture.bounds), arrangement = new ResidentArrangement(lattice, fixture.sources, 2048, true, true);
  const initial = encodeRustCore({ lattice, fields: arrangement.preparedFields(0), sources: arrangement.boxes, sourceFields: arrangement.boxFields, canonicalConstruction: true });
  const module = await WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
  const core = await RustTerrainCore.create(module, lattice, initial), world = await RustTerrainCore.createWorld(module, initial, arrangement.fields.length);
  try {
    const before = world.worldStats;
    world.begin(1);
    for (const brick of lattice.brickOrder) {
      world.ingest(core.compile([{ brick, tets: null }], 1, [], arrangement.fields.length, [], undefined, true)); core.resetConstruction();
    }
    expect(() => world.connect()).toThrow(/Resident boundary has .*unpaired edges/);
    world.abort();
    expect(world.worldStats).toEqual(before);
  } finally { core.dispose(); world.dispose(); }
});
