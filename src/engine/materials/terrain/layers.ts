/**
 * Terrain layer table: the single TS source of the procedural layer bake and the triplanar material (N3). Six layers,
 * indexed by `layer` in both shaders:
 *   0 rock (natural terrain), 1 ochre strata (natural, non-volcanic), 2 concrete (construction, material 3 → layer 2),
 *   3 sand ripples (dune coating), 4 ice crystals (glacial coating), 5 basalt (volcanic).
 * `width` is the world size of one tile (u); `amplitude` is the relief depth (u) of the full height range, shared by the
 * parallax march and the baked normals so the two can never disagree.
 */
import { makeModule } from '../../wgsl/module';

export interface TerrainLayer { readonly name: string; readonly width: number; readonly amplitude: number }

export const TERRAIN_LAYERS: readonly TerrainLayer[] = Object.freeze([
  { name: 'rock', width: 2.5, amplitude: 0.042 },
  { name: 'ochre', width: 2.0, amplitude: 0.032 },
  { name: 'concrete', width: 2.5, amplitude: 0.012 },
  { name: 'sand', width: 3.0, amplitude: 0.025 },
  { name: 'ice', width: 3.0, amplitude: 0.018 },
  { name: 'basalt', width: 2.5, amplitude: 0.048 },
]);

export const TERRAIN_LAYER_COUNT = TERRAIN_LAYERS.length;
/** Bake resolution per layer (texels). */
export const TERRAIN_BAKE_SIZE = 512;
export const TERRAIN_BAKE_MIPS = Math.floor(Math.log2(TERRAIN_BAKE_SIZE)) + 1;
/** Resident bytes of the two rgba8 arrays with their full mip chains. */
export const TERRAIN_BAKE_BYTES = 8 * TERRAIN_LAYER_COUNT * (4 ** TERRAIN_BAKE_MIPS - 1) / 3;

const num = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const arr = (values: readonly number[]) => `array<f32, ${values.length}>(${values.map(num).join(', ')})`;

/** `terrain_layer_scale(layer)` (1 / tile width), `terrain_layer_relief(layer)` and `terrain_layer_width(layer)` from the table. */
export const terrainLayersWgsl = makeModule('terrain-layers', /* wgsl */ `
const TERRAIN_LAYER_COUNT: u32 = ${TERRAIN_LAYER_COUNT}u;
const TERRAIN_BAKE_SIZE: u32 = ${TERRAIN_BAKE_SIZE}u;
fn terrain_layer_width(layer: i32) -> f32 { var w = ${arr(TERRAIN_LAYERS.map(l => l.width))}; return w[layer]; }
fn terrain_layer_scale(layer: i32) -> f32 { var s = ${arr(TERRAIN_LAYERS.map(l => 1 / l.width))}; return s[layer]; }
fn terrain_layer_relief(layer: i32) -> f32 { var r = ${arr(TERRAIN_LAYERS.map(l => l.amplitude))}; return r[layer]; }
`);
