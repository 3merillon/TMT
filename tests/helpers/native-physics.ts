import { readFileSync } from 'node:fs';
import { StructuralPhysics } from '../../src/game/structural-physics';
import { RustTerrainCore, encodeRustCore } from '../../src/gpu/terrain/rust-core';
import { residentLattice } from '../../src/gpu/terrain/lattice';
import type { Vec3 } from '../../src/core/types';
let module: Promise<WebAssembly.Module> | undefined;
/** Run existing behavioral scenarios against either backend with identical budgets. */
export async function testPhysics(center: Vec3): Promise<StructuralPhysics> {
  if (process.env.TMT_NATIVE_PHYSICS !== '1') return StructuralPhysics.create(center);
  module ??= WebAssembly.compile(readFileSync(new URL('../../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
  const initial = encodeRustCore({ lattice: residentLattice({ min: [0, 0, 0], max: [3, 3, 3] }), sources: [], sourceFields: [], fields: [], canonicalConstruction: true });
  const core = await RustTerrainCore.createWorld(await module, initial, 0);
  try {
    const physics = StructuralPhysics.createNative(core, center), dispose = physics.dispose.bind(physics);
    physics.dispose = () => { dispose(); core.dispose(); }; return physics;
  } catch (error) { core.dispose(); throw error; }
}
