import { readFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import { RustTerrainCore, encodeRustCore } from '../../src/gpu/terrain/rust-core';
import { residentLattice } from '../../src/gpu/terrain/lattice';
import { NativeMatch } from '../../src/game/native-match';
import { NativeBallistics } from '../../src/game/native-ballistics';
import { NativeCombat } from '../../src/game/native-combat';
import type { GameSimulation } from '../../src/game/simulation';
import type { TankState } from '../../src/game/contracts';
import type { WorldQuery } from '../../src/game/contracts';

export async function testMatchCore(): Promise<RustTerrainCore> {
  const module = await WebAssembly.compile(readFileSync(new URL('../../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
  return RustTerrainCore.createWorld(module, encodeRustCore({ lattice: residentLattice({ min: [0, 0, 0], max: [3, 3, 3] }), sources: [], sourceFields: [], fields: [], canonicalConstruction: true }), 0);
}
/** Opt the existing rules/replay behavior scenarios into the shipped native ABI. */
const journal = process.env.TMT_NATIVE_JOURNAL === '1', observations = process.env.TMT_NATIVE_OBSERVATIONS === '1' || journal, actions = process.env.TMT_NATIVE_ACTIONS === '1' || observations, profiles = process.env.TMT_NATIVE_PROFILES === '1' || actions;
const ai = process.env.TMT_NATIVE_AI === '1' || profiles, combat = process.env.TMT_NATIVE_COMBAT === '1' || actions;
const lifecycle = process.env.TMT_NATIVE_MATCH === '1' || combat || ai;
const shared = lifecycle || process.env.TMT_NATIVE_BALLISTICS === '1' ? await testMatchCore() : undefined;
if (shared) afterAll(() => shared.dispose());
export const testMatchLifecycle: WorldQuery['createMatchLifecycle'] = shared && lifecycle ? (setup, state) => new NativeMatch(shared, setup, state, ai, profiles, actions, observations, journal) : undefined;
export const testBallistics: WorldQuery['createBallistics'] = shared && process.env.TMT_NATIVE_BALLISTICS === '1' ? (setup, gravity) => new NativeBallistics(shared, setup, gravity, 18) : undefined;
export const testCombat: WorldQuery['createCombat'] = shared && combat ? (setup, state, kit) => new NativeCombat(shared, setup, state, kit) : undefined;
/** Explicit fixture edits follow the same admission boundary as restored combat;
 * output snapshot writes must never silently become resident state inputs. */
export function setCombatState(sim: GameSimulation, id: number, changes: Partial<TankState>): void {
  const combat = (sim as unknown as { nativeCombat?: NativeCombat }).nativeCombat;
  if (combat) combat.restore(id, changes); else Object.assign(sim.state.tanks[id], changes);
}
