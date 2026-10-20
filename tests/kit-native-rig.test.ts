/** The engine running-gear rig (rust/terrain-core/src/rig.rs) against the TypeScript rig (kit/belt.ts, kit/running.ts):
 * every gear, randomized suspension and phases, no ground, exact terrain envelopes and coarse contacts. The instance
 * buffers are Float32; the engine reproduces them bit for bit. */
import { appendFileSync, readFileSync } from 'node:fs';
import { afterAll, expect, it } from 'vitest';
import { RustTerrainCore, encodeRustCore } from '../src/gpu/terrain/rust-core';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { assembleKit } from '../src/game/kit/assembly';
import { GEARS } from '../src/game/kit/parts';
import { KitPoser, setNativeGear } from '../src/game/kit/pose';
import { nativeGearWords } from '../src/game/kit/running';
import type { TankState } from '../src/game/contracts';
import type { GearId } from '../src/game/kit/parts/types';

const module = WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
let core: RustTerrainCore | undefined;
afterAll(() => { setNativeGear(undefined); core?.dispose(); });

/** Park–Miller: the same cases every run. */
function random(seed: number): () => number { let s = seed; return () => (s = s * 16807 % 2147483647) / 2147483647; }

it.each(Object.keys(GEARS) as GearId[])('%s: engine running gear equals the TypeScript rig', async gear => {
  core ??= await RustTerrainCore.createWorld(await module, encodeRustCore({ lattice: residentLattice({ min: [0, 0, 0], max: [3, 3, 3] }), sources: [], sourceFields: [], fields: [], canonicalConstruction: true }), 0);
  const assembly = assembleKit({ hull: 'bastion', runningGear: gear, turret: 'dome', weapon: 'cannon', utility: 'antenna' });
  const stations = assembly.running.treadStations, next = random(7 + gear.length);
  // The engine accepts this gear (otherwise both posers would run TypeScript).
  expect(core.rigs!.create(nativeGearWords(GEARS[gear]))).toBeGreaterThan(0);
  const ts = new KitPoser(assembly), native = new KitPoser(assembly);
  let largest = 0, exact = 0, total = 0;
  for (let i = 0; i < 160; i++) {
    const ground = i % 3;
    const tank = {
      turretYaw: 0, barrelPitch: 0.1, recoil: 0, velocity: [0, 0, 0], rotation: [0, 0, 0, 1], trackSpeeds: [0, 0], time: i * 0.1,
      wheelSuspension: Array.from({ length: 8 }, () => next()), trackPhases: [next() * 40 - 20, next() * 40 - 20],
      // Coarse contacts may lift the wheels; exact envelopes rise and fall across the belt.
      treadContacts: Array.from({ length: 18 }, () => ground === 2 ? -1 + next() * 0.9 : -1.2),
      treadTerrain: ground === 1 ? [0, 1].map(() => stations.map((z, k) => [z + (k ? next() * 0.05 : 0), -0.85 + next() * 0.35] as [number, number])) : [[], []],
    } as unknown as TankState;
    setNativeGear(undefined); ts.update(tank);
    setNativeGear(core.rigs); native.update(tank);
    for (const key of ['linkInstances', 'wheelInstances'] as const) {
      const a = ts.pose[key], b = native.pose[key];
      expect(b.length).toBe(a.length);
      for (let k = 0; k < a.length; k++) { const d = Math.abs(a[k] - b[k]); largest = Math.max(largest, d); if (a[k] === b[k]) exact++; total++; }
    }
  }
  if (process.env.TMT_RIG_REPORT) appendFileSync(process.env.TMT_RIG_REPORT, `${JSON.stringify({ gear, exact, total, largest })}\n`);
  // The same operations in the same order (V8's and the engine's sin/cos/atan2/asin agree here): bit-identical.
  expect(largest).toBe(0); expect(exact).toBe(total);
});

it('refuses malformed gear words and pose packets', async () => {
  core ??= await RustTerrainCore.createWorld(await module, encodeRustCore({ lattice: residentLattice({ min: [0, 0, 0], max: [3, 3, 3] }), sources: [], sourceFields: [], fields: [], canonicalConstruction: true }), 0);
  const rigs = core.rigs!;
  expect(rigs.create([])).toBe(0);
  expect(rigs.create([9, ...Array(30).fill(1)])).toBe(0);
  const rig = rigs.create(nativeGearWords(GEARS.scout));
  expect(rig).toBeGreaterThan(0);
  const links = new Float32Array(1), wheels = new Float32Array(1);
  expect(() => rigs.pose(rig, [0, 0], links, wheels)).toThrow('Invalid gear rig pose');
  expect(() => rigs.pose(rig, [0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0], links, wheels)).toThrow('Invalid gear rig pose');
  expect(() => rigs.pose(rig + 99, [0, 0], links, wheels)).toThrow('Unknown gear rig');
});
