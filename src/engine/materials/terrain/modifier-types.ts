/**
 * Terrain modifier contract (plan §4.10, §7.2 "Terrain FS": other streams plug in through the modifier chain).
 *
 * A modifier is a WGSL module defining
 *     fn tmod_<name>(s: ptr<function, SurfaceSample>, t: TerrainCtx)
 * called by the terrain FS after the base triplanar surface, in `TERRAIN_MODIFIERS` registry order (modifiers.ts,
 * append-only). It may also define a vertex hook (`vertex: true`)
 *     fn tmodv_<name>(world: vec3f, t: TerrainVertexCtx) -> vec3f
 * applied to the world-space vertex position in registry order (the pending crater uses it).
 *
 * Rules:
 * - Reserved bindings a modifier reads are listed in `reserved`; the terrain pipeline binds the union of them in
 *   @group(2) (RESERVED_BINDING_LAYOUT order) and declares each slot as `rb_<name>_<key>` (e.g. `rb_pendingCuts_cuts`,
 *   `rb_surfaceMemory_cube`). Uniform slots without a known struct are `array<vec4f, size / 16>`.
 * - Use explicit-LOD/gradient sampling only (textureSampleLevel / textureSampleGrad / textureLoad): modifiers may run
 *   after non-uniform control flow. `terrain_clamp` (linear, clamp-to-edge) and `terrain_sampler` (repeat, aniso) are
 *   available from @group(1).
 * - Never write `class_id`, `object_id` or `flags` (they belong to the page) and never read geometry buffers.
 */
import type { ReservedBindingName, WgslModule } from '../../contracts';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { makeModule } from '../../wgsl/module';

export interface TerrainModifier {
  /** Snake-case identifier: the module defines `tmod_<name>` (and `tmodv_<name>` when `vertex`). */
  readonly name: string;
  /** The modifier's WGSL module (built lazily; deps included). */
  readonly wgsl: () => WgslModule;
  /** Reserved bindings read by the modifier (bound in @group(2)). */
  readonly reserved?: readonly ReservedBindingName[];
  /** True when the module also defines the vertex hook `tmodv_<name>`. */
  readonly vertex?: boolean;
}

/** Per-fragment context handed to every modifier (function address space: no layout constraints). */
export const terrainCtxWgsl = makeModule('terrain-ctx', /* wgsl */ `
struct TerrainCtx {
  world: vec3f,        // world position (after vertex hooks)
  rest: vec3f,         // body rest-frame position: the material space (static pages: world)
  n_geom: vec3f,       // world geometric (flat) normal
  up: vec3f,           // radial up at world
  view_dist: f32,      // camera distance
  material: f32,       // terrain material id (1 natural, 2 exposed, 3 construction)
  kind: f32,           // analytic source kind of the face (0 plane, 1 planet, 2 carved sphere)
  time: f32,           // seconds (frame.time)
  page: u32,           // page slot
  is_body: u32,        // 1 for a detached body page
}

struct TerrainVertexCtx {
  rest: vec3f,         // rest-frame position of the vertex
  is_body: u32,
  normal: vec3f,       // world vertex normal, unit, pointing out of the solid (radial up when degenerate)
  material: u32,       // terrain material id of the vertex's face (1 natural, 2 exposed, 3 construction)
}
`, [gbufferWgsl]);

const IDENT = /^[a-z][a-z0-9_]*$/;
export function checkModifierName(name: string): string {
  if (!IDENT.test(name)) throw new Error(`terrain modifier name "${name}" must be snake_case`);
  return name;
}
