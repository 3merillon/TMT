/**
 * Terrain surface (plan §4.7, §4.10): a raw-WGSL port of `TERRAIN_MATERIAL_WGSL` (the former three/TSL material, now in
 * src/lab/legacy/terrain-material.ts), writing the frozen G-buffer through `gbuffer_pack(SurfaceSample)`.
 *
 * Kept from the original, line for line where possible:
 * - explicit-gradient triplanar layers (gradients taken once, before any divergent march), pow-4 axis weights;
 * - the 2-layer coating (dune sand / glacial ice / volcanic basalt / temperate slope blend by planet kind);
 * - the 8 + 2 tap parallax (POM) with distance and grazing fades; `detail` toggles it;
 * - analytic normals: carved-sphere faces (source kind 2) point to the crater centre from `surface.source`, planet faces
 *   (kind 1) use the per-seed `tmt_planet_normal` (scene facet `terrainPlanetWGSL`), others keep the flat normal;
 * - the body-fixed biome tint (moisture / basin / upland / summit / polar) on natural layers.
 * Everything is shaded in the page's REST frame (`rest = local + origin`): textures and analytic sources stay glued to a
 * detached body as it moves; the shading normal is rotated to world by the page model.
 *
 * Shader layout:
 *   @group(0) frame uniforms
 *   @group(1) 0 page records (storage)  1 albedo array  2 surface array  3 terrain_sampler (repeat, aniso 8)
 *             4 TerrainParams (uniform)  5 terrain_clamp (linear clamp, for modifiers)
 *   @group(2) the reserved bindings the modifiers read (rb_<name>_<key>)
 * Vertex buffers: 0 position f32x3, 1 flat normal f32x3, 2 surface (stride 32: material f32 @0, source vec4 @4).
 * The page record is read through `instance_index` (= the page slot passed as firstInstance of a direct drawIndexed).
 */
import type { LinkedWgsl, ReservedBindingName, ReservedSlotDecl, WgslModule } from '../../contracts';
import { RESERVED_BINDING_LAYOUT, RESERVED_BINDING_NAMES } from '../../contracts';
import { PENDING_CUTS } from '../../frame/pending-cuts';
import { reservedBindingSlots } from '../../reserved-bindings';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { radialWgsl } from '../../wgsl/common/radial.wgsl';
import { shadowViewWgsl } from '../../wgsl/common/shadow-view.wgsl';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import { terrainLayersWgsl } from './layers';
import { checkModifierName, terrainCtxWgsl, type TerrainModifier } from './modifier-types';

/** Page record (storage array element, 176 B): written by EngineTerrainHost, read through instance_index. */
export const PAGE_RECORD = wgslStruct('PageRecord', [
  ['model', 'mat4x4f'],
  ['prev_model', 'mat4x4f'],
  ['origin', 'vec4f'],      // xyz rest-frame origin of the page's positions, w = 1 for a body page
  ['sphere', 'vec4f'],      // world bounding sphere (centre, radius) at the current pose
  ['ids', 'vec4u'],         // objectId, GB3 flags, newUntilFrame (TAA reject while frame < it), 0
], { uniform: false });
export const PAGE_RECORD_BYTES = PAGE_RECORD.size;
export const PAGE_RECORD_FLOATS = PAGE_RECORD_BYTES / 4;

export const TERRAIN_PARAMS = wgslStruct('TerrainParams', [
  ['config', 'vec4f'],      // x detail (1 = parallax), y planet kind (PLANET_KINDS index), z planet radius, w time
  ['smc', 'vec4f'],         // x SMC size (texels), yzw reserved
]);

/** The page-record + params bindings shared by every terrain shader. */
export const terrainBindingsWgsl = makeModule('terrain-bindings', /* wgsl */ `
@group(1) @binding(0) var<storage, read> pages: array<PageRecord>;
@group(1) @binding(1) var terrain_albedo: texture_2d_array<f32>;
@group(1) @binding(2) var terrain_surface: texture_2d_array<f32>;
@group(1) @binding(3) var terrain_sampler: sampler;
@group(1) @binding(4) var<uniform> terrain: TerrainParams;
@group(1) @binding(5) var terrain_clamp: sampler;

fn page_rotation(rec: PageRecord) -> mat3x3f { return mat3x3f(rec.model[0].xyz, rec.model[1].xyz, rec.model[2].xyz); }
`, [PAGE_RECORD.module, TERRAIN_PARAMS.module]);

/** The triplanar material itself (port of TERRAIN_MATERIAL_WGSL). Returns (colour, rest-frame normal, (roughness, 0, 0)). */
export const terrainSurfaceWgsl = makeModule('terrain-surface', /* wgsl */ `
fn tmt_terrain_surface(p: vec3f, source_normal: vec3f, camera_delta: vec3f, material_id: f32, detail: f32, source: vec4f, planet_kind: f32) -> mat3x3f {
  var n = normalize(source_normal);
  if (source.w > 1.5) { n = normalize(source.xyz - p); }
  else if (source.w > 0.5) { n = tmt_planet_normal(p); }
  // Display-pixel footprint: below native render scale the temporal upscaler rebuilds display-resolution detail.
  let lod = min(frame_render_scale(), 1.0);
  let dx = dpdx(p) * lod;
  let dy = dpdy(p) * lod;
  var layer = i32(clamp(floor(material_id + 0.5) - 1.0, 0.0, 2.0));
  if (layer == 1 && planet_kind < 0.5) { layer = 5; }
  var coating = 3;
  var blend = 0.0;
  if (material_id < 1.5) {
    let slope = smoothstep(0.62, 0.93, dot(n, normalize(p)));
    if (planet_kind < 0.5) { layer = 5; coating = 1; blend = slope * 0.25; }
    else if (planet_kind < 1.5) { coating = 3; blend = slope; }
    else if (planet_kind < 2.5) { coating = 4; blend = slope; }
    else { blend = slope * (1.0 - smoothstep(-1.7, -0.2, length(p) - terrain.config.z)); }
  }
  if (blend > 0.99) { return tmt_terrain_layer(p, n, camera_delta, coating, detail, dx, dy); }
  let base = tmt_terrain_layer(p, n, camera_delta, layer, detail, dx, dy);
  if (blend < 0.01) { return base; }
  let coat = tmt_terrain_layer(p, n, camera_delta, coating, detail, dx, dy);
  return mat3x3f(mix(base[0], coat[0], blend), normalize(mix(base[1], coat[1], blend)), mix(base[2], coat[2], blend));
}

fn tmt_terrain_layer(p: vec3f, n: vec3f, camera_delta: vec3f, layer: i32, detail: f32, position_dx: vec3f, position_dy: vec3f) -> mat3x3f {
  let axis_sign = select(vec3f(-1.0), vec3f(1.0), n >= vec3f(0.0));
  // A tile covers a few tank lengths. Scale and relief are independent physical quantities.
  let scale = terrain_layer_scale(layer);
  let q = p * scale;
  let grad_x = position_dx * scale;
  let grad_y = position_dy * scale;
  let raw_weights = n * n * n * n;
  let weights = raw_weights / (raw_weights.x + raw_weights.y + raw_weights.z);
  let camera_distance = length(camera_delta);
  let view = camera_delta / max(camera_distance, 0.0001);
  let distance_fade = 1.0 - smoothstep(8.0, 18.0, camera_distance);
  let grazing_fade = smoothstep(0.22, 0.45, dot(n, view));
  let relief = terrain_layer_relief(layer) * scale * distance_fade * grazing_fade;

  // Each UV pair and tangent pair form the same right-handed basis on both signed faces.
  var uv_x = vec2f(-q.z * axis_sign.x, q.y);
  var uv_y = vec2f(q.x, -q.z * axis_sign.y);
  var uv_z = vec2f(q.x * axis_sign.z, q.y);
  let dx_x = vec2f(-grad_x.z * axis_sign.x, grad_x.y);
  let dy_x = vec2f(-grad_y.z * axis_sign.x, grad_y.y);
  let dx_y = vec2f(grad_x.x, -grad_x.z * axis_sign.y);
  let dy_y = vec2f(grad_y.x, -grad_y.z * axis_sign.y);
  let dx_z = vec2f(grad_x.x * axis_sign.z, grad_x.y);
  let dy_z = vec2f(grad_y.x * axis_sign.z, grad_y.y);

  if (detail > 0.5 && relief > 0.00001) {
    let axis_relief = vec3f(relief) * smoothstep(vec3f(0.02), vec3f(0.08), weights);
    if (weights.x > 0.02) {
      uv_x = tmt_terrain_parallax(uv_x, layer, dx_x, dy_x, vec3f(-view.z * axis_sign.x, view.y, view.x * axis_sign.x), axis_relief.x);
    }
    if (weights.y > 0.02) {
      uv_y = tmt_terrain_parallax(uv_y, layer, dx_y, dy_y, vec3f(view.x, -view.z * axis_sign.y, view.y * axis_sign.y), axis_relief.y);
    }
    if (weights.z > 0.02) {
      uv_z = tmt_terrain_parallax(uv_z, layer, dx_z, dy_z, vec3f(view.x * axis_sign.z, view.y, view.z * axis_sign.z), axis_relief.z);
    }
  }

  let ax = textureSampleGrad(terrain_albedo, terrain_sampler, uv_x, layer, dx_x, dy_x).rgb;
  let ay = textureSampleGrad(terrain_albedo, terrain_sampler, uv_y, layer, dx_y, dy_y).rgb;
  let az = textureSampleGrad(terrain_albedo, terrain_sampler, uv_z, layer, dx_z, dy_z).rgb;
  let sx = textureSampleGrad(terrain_surface, terrain_sampler, uv_x, layer, dx_x, dy_x);
  let sy = textureSampleGrad(terrain_surface, terrain_sampler, uv_y, layer, dx_y, dy_y);
  let sz = textureSampleGrad(terrain_surface, terrain_sampler, uv_z, layer, dx_z, dy_z);
  let mapped_x = tmt_terrain_decode_normal(sx.rg);
  let mapped_y = tmt_terrain_decode_normal(sy.rg);
  let mapped_z = tmt_terrain_decode_normal(sz.rg);
  let nx = tmt_terrain_reorient(n, vec3f(0.0, mapped_x.y, -mapped_x.x * axis_sign.x), mapped_x.z);
  let ny = tmt_terrain_reorient(n, vec3f(mapped_y.x, 0.0, -mapped_y.y * axis_sign.y), mapped_y.z);
  let nz = tmt_terrain_reorient(n, vec3f(mapped_z.x * axis_sign.z, mapped_z.y, 0.0), mapped_z.z);
  let base_color = ax * weights.x + ay * weights.y + az * weights.z;
  let color = tmt_terrain_region_color(base_color, p, n, layer);
  let mapped_normal = normalize(nx * weights.x + ny * weights.y + nz * weights.z);
  let roughness = clamp(dot(vec3f(sx.b, sy.b, sz.b), weights), 0.42, 1.0);
  return mat3x3f(color, mapped_normal, vec3f(roughness, 0.0, 0.0));
}

fn tmt_terrain_region_color(base: vec3f, p: vec3f, n: vec3f, layer: i32) -> vec3f {
  // Construction keeps its authored reflectance, including walls far from the planet center.
  if (layer >= 2) { return base; }
  let radius = max(length(p), 0.001);
  let radial = p / radius;
  let elevation = radius - terrain.config.z;
  let latitude = abs(radial.y);
  // Use geometric slope, not the tile's normal map: a small chip cannot paint a biome.
  let steep = 1.0 - smoothstep(0.68, 0.94, dot(n, radial));
  let basin = 1.0 - smoothstep(-1.80, -0.25, elevation);
  let upland = smoothstep(0.90, 2.80, elevation);
  let summit = smoothstep(2.60, 4.40, elevation);
  // One broad, smooth geographic moisture field, fixed to the body.
  let geography = radial.x * 0.65 + radial.z * 0.40 + radial.y * radial.z * 0.60;
  let moisture = (1.0 - smoothstep(-0.50, 0.65, geography)) * (1.0 - smoothstep(0.68, 0.95, latitude));
  let lowland_tint = mix(vec3f(1.02, 0.95, 0.80), vec3f(0.76, 0.91, 0.67), moisture);
  let rock_tint = mix(vec3f(1.04, 1.025, 1.00), vec3f(1.20, 1.19, 1.13), summit);
  var tint = mix(lowland_tint, vec3f(1.14, 0.96, 0.76), basin);
  tint = mix(tint, rock_tint, max(steep * 0.88, upland));
  // Latitude gently cools exposed polar stone; bright high ground remains mineral, not snow.
  let polar = smoothstep(0.72, 0.98, latitude) * (1.0 - basin) * 0.30;
  tint = mix(tint, vec3f(1.03, 1.055, 1.045), polar);
  return clamp(base * tint, vec3f(0.03), vec3f(0.65));
}

fn tmt_terrain_decode_normal(encoded: vec2f) -> vec3f {
  let xy = encoded * 2.0 - vec2f(1.0);
  return normalize(vec3f(xy, sqrt(max(1.0 - dot(xy, xy), 0.001))));
}

fn tmt_terrain_reorient(n: vec3f, tangent: vec3f, height_normal: f32) -> vec3f {
  // Project perturbations into the real surface plane: flat maps preserve every input slope.
  return normalize(n * max(height_normal, 0.05) + tangent - n * dot(n, tangent));
}

fn tmt_terrain_parallax(uv: vec2f, layer: i32, dx: vec2f, dy: vec2f, view: vec3f, relief: f32) -> vec2f {
  // The projected face can be back-facing even when the real surface faces the eye: fade before skipping it.
  let plane_fade = smoothstep(0.20, 0.40, view.z);
  if (plane_fade <= 0.001) { return uv; }
  let offset = view.xy / max(view.z, 0.20) * relief * plane_fade;
  let top = uv + offset * 0.5;
  var lower = 0.0;
  var upper = 1.0;
  // At most eight linear height reads and two refinement reads for this projection.
  for (var i = 1; i <= 8; i++) {
    let depth = f32(i) * 0.125;
    let height = textureSampleGrad(terrain_surface, terrain_sampler, top - offset * depth, layer, dx, dy).a;
    if (1.0 - depth <= height) { upper = depth; break; }
    lower = depth;
  }
  for (var i = 0; i < 2; i++) {
    let depth = (lower + upper) * 0.5;
    let height = textureSampleGrad(terrain_surface, terrain_sampler, top - offset * depth, layer, dx, dy).a;
    if (1.0 - depth <= height) { upper = depth; } else { lower = depth; }
  }
  return top - offset * ((lower + upper) * 0.5);
}
`, [terrainBindingsWgsl, terrainLayersWgsl]);

// ───────────────────────────── Modifier chain assembly ─────────────────────────────

/** Known WGSL struct types for reserved uniform slots (everything else is `array<vec4f, size / 16>`). */
const RESERVED_UNIFORM_TYPES: Readonly<Record<string, { type: string; module: WgslModule }>> = {
  'pendingCuts.cuts': { type: 'PendingCuts', module: PENDING_CUTS.module },
};

/** Reserved binding names bound in @group(2) for these modifiers (RESERVED_BINDING_LAYOUT order). */
export function terrainReservedNames(modifiers: readonly TerrainModifier[]): ReservedBindingName[] {
  const wanted = new Set(modifiers.flatMap(m => m.reserved ?? []));
  return RESERVED_BINDING_NAMES.filter(n => wanted.has(n));
}

function slotDeclaration(name: ReservedBindingName, slot: ReservedSlotDecl, binding: number): { code: string; deps: WgslModule[] } {
  const v = `rb_${name}_${slot.key}`;
  const at = `@group(2) @binding(${binding})`;
  switch (slot.type) {
    case 'uniform': {
      const known = RESERVED_UNIFORM_TYPES[`${name}.${slot.key}`];
      if (known) return { code: `${at} var<uniform> ${v}: ${known.type};`, deps: [known.module] };
      return { code: `${at} var<uniform> ${v}: array<vec4f, ${Math.max(1, Math.floor((slot.size ?? 256) / 16))}>;`, deps: [] };
    }
    case 'storage': return { code: `${at} var<storage, read> ${v}: array<vec4f>;`, deps: [] };
    case 'texture-2d': return { code: `${at} var ${v}: texture_2d<f32>;`, deps: [] };
    case 'texture-2d-array': return { code: `${at} var ${v}: texture_2d_array<f32>;`, deps: [] };
    case 'texture-cube': return { code: `${at} var ${v}: texture_cube<f32>;`, deps: [] };
    case 'texture-3d': return { code: `${at} var ${v}: texture_3d<f32>;`, deps: [] };
    case 'depth-2d': return { code: `${at} var ${v}: texture_depth_2d;`, deps: [] };
    case 'sampler': return { code: `${at} var ${v}: sampler;`, deps: [] };
    case 'sampler-comparison': return { code: `${at} var ${v}: sampler_comparison;`, deps: [] };
  }
}

/** The @group(2) declarations of the reserved bindings the modifiers read. */
export function terrainReservedModule(modifiers: readonly TerrainModifier[]): WgslModule {
  const names = terrainReservedNames(modifiers);
  const deps: WgslModule[] = [];
  const lines: string[] = [];
  for (const s of reservedBindingSlots(names)) {
    const d = slotDeclaration(s.name, s.slot, s.binding);
    lines.push(d.code);
    for (const m of d.deps) if (!deps.includes(m)) deps.push(m);
  }
  return makeModule(`terrain-reserved:${names.join(',') || 'none'}`, lines.join('\n'), deps);
}

export interface TerrainShaderOptions {
  /** The planet normal module (`planetNormalModule(facet)` or `planetFallbackNormalWgsl`). */
  planet: WgslModule;
  modifiers: readonly TerrainModifier[];
}

function modifierModules(modifiers: readonly TerrainModifier[]): WgslModule[] {
  const seen = new Set<string>();
  return modifiers.map(m => {
    checkModifierName(m.name);
    if (seen.has(m.name)) throw new Error(`terrain modifier "${m.name}" is registered twice`);
    seen.add(m.name);
    const module = m.wgsl();
    if (!new RegExp(`fn\\s+tmod_${m.name}\\s*\\(`).test(module.code)) throw new Error(`terrain modifier "${m.name}" must define fn tmod_${m.name}`);
    if (m.vertex && !new RegExp(`fn\\s+tmodv_${m.name}\\s*\\(`).test(module.code)) throw new Error(`terrain modifier "${m.name}" declares a vertex hook but has no fn tmodv_${m.name}`);
    return module;
  });
}

const VERTEX_INPUT = /* wgsl */ `
struct TerrainVertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) material: f32,
  @location(3) source: vec4f,
}
`;

/** The G-buffer terrain shader: VS (pending hooks) + FS (surface + modifier chain + gbuffer_pack). */
export function terrainGBufferModule(o: TerrainShaderOptions): WgslModule {
  const mods = modifierModules(o.modifiers);
  const vertexCalls = o.modifiers.filter(m => m.vertex).map(m => `  world = tmodv_${m.name}(world, vctx);`).join('\n');
  const fragmentCalls = o.modifiers.map(m => `  tmod_${m.name}(&s, t);`).join('\n');
  return makeModule(`terrain-gbuffer:${o.modifiers.map(m => m.name).join(',')}`, /* wgsl */ `
${VERTEX_INPUT}
struct TerrainVsOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) rest: vec3f,
  @location(2) local_normal: vec3f,
  @location(3) @interpolate(flat) material: f32,
  @location(4) @interpolate(flat) source: vec4f,
  @location(5) @interpolate(flat) page: u32,
  @location(6) clip_nojitter: vec4f,
  @location(7) clip_prev: vec4f,
}

@vertex
fn vs_terrain(in: TerrainVertexIn, @builtin(instance_index) slot: u32) -> TerrainVsOut {
  let rec = pages[slot];
  let local = vec4f(in.position, 1.0);
  let world0 = (rec.model * local).xyz;
  var world = world0;
  let r = page_rotation(rec);
  var vctx: TerrainVertexCtx;
  vctx.rest = in.position + rec.origin.xyz;
  vctx.is_body = select(0u, 1u, rec.origin.w > 0.5);
  let n_world = r * in.normal;
  vctx.normal = select(normalize(world0), normalize(n_world), dot(n_world, n_world) > 1e-12);
  vctx.material = u32(max(round(in.material), 0.0));
${vertexCalls}
  let delta = world - world0;
  var out: TerrainVsOut;
  out.position = frame.view_proj * vec4f(world, 1.0);
  out.world = world;
  out.rest = vctx.rest + transpose(r) * delta;
  out.local_normal = in.normal;
  out.material = in.material;
  out.source = in.source;
  out.page = slot;
  out.clip_nojitter = frame.view_proj_nojitter * vec4f(world, 1.0);
  out.clip_prev = frame.prev_view_proj * vec4f((rec.prev_model * local).xyz + delta, 1.0);
  return out;
}

@fragment
fn fs_terrain(in: TerrainVsOut) -> GBufferOut {
  let rec = pages[in.page];
  let r = page_rotation(rec);
  let camera_rest = transpose(r) * (frame.eye_pos - rec.model[3].xyz) + rec.origin.xyz;
  let res = tmt_terrain_surface(in.rest, in.local_normal, camera_rest - in.rest, in.material, terrain.config.x, in.source, terrain.config.y);
  var s = surface_default();
  s.base_color = res[0];
  s.n_shading = normalize(r * res[1]);
  s.roughness = res[2].x;
  s.metalness = 0.0;
  s.ao = 1.0;
  s.class_id = CLASS_TERRAIN;
  s.object_id = rec.ids.x;
  s.flags = rec.ids.y | select(0u, GB_FLAG_NEW_GEOMETRY, frame_index() < rec.ids.z);
  s.n_geom = normalize(r * in.local_normal);
  var t: TerrainCtx;
  t.world = in.world;
  t.rest = in.rest;
  t.n_geom = s.n_geom;
  t.up = radial_up(in.world);
  t.view_dist = distance(frame.eye_pos, in.world);
  t.material = in.material;
  t.kind = in.source.w;
  t.time = frame.time;
  t.page = in.page;
  t.is_body = select(0u, 1u, rec.origin.w > 0.5);
${fragmentCalls}
  return gbuffer_pack(s, gbuffer_velocity(in.clip_nojitter, in.clip_prev));
}
`, [frameWgsl, gbufferWgsl, radialWgsl, terrainBindingsWgsl, terrainSurfaceWgsl, terrainCtxWgsl, o.planet, terrainReservedModule(o.modifiers), ...mods]);
}

export function terrainGBufferShader(o: TerrainShaderOptions): LinkedWgsl { return link(terrainGBufferModule(o)); }

/** Depth-only shadow caster shader (no modifiers: pending craters are cosmetic and never cast). @group(0) = ShadowView. */
export const terrainDepthModule = makeModule('terrain-depth', /* wgsl */ `
@group(1) @binding(0) var<storage, read> pages: array<PageRecord>;
@vertex
fn vs_terrain_depth(@location(0) position: vec3f, @builtin(instance_index) slot: u32) -> @builtin(position) vec4f {
  return shadow_view.view_proj * (pages[slot].model * vec4f(position, 1.0));
}
`, [shadowViewWgsl, PAGE_RECORD.module]);

export function terrainDepthShader(): LinkedWgsl { return link(terrainDepthModule); }

/** GPUVertexBufferLayouts for the page buffers (render-host.ts PageBuffers). */
export const TERRAIN_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 32, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }, { shaderLocation: 3, offset: 4, format: 'float32x4' }] },
];
export const TERRAIN_DEPTH_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [TERRAIN_VERTEX_BUFFERS[0]];

void RESERVED_BINDING_LAYOUT;
