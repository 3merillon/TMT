/**
 * Stable planet-wide blade sites, rooted in the committed terrain SDF.
 *
 * Every frame 'grass.cull' lists, in root order, the blades and clump shadows that can reach a pixel: a root is dropped
 * only when the vertex shader's own rules give it no height or strength (dead, scorched, buried, faded out, thinned by
 * density, sunless) or its bounding sphere lies outside the jittered frustum. The draws are indirect over those lists,
 * so every surviving blade runs the same vertex code on the same inputs, in the same order, as the full draw did.
 */
import type { RenderModule } from '../../contracts';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage } from '../../gpu/flags';
import { extractFrustumPlanes } from '../../scene/culling';
import { formatConst, makeModule, link } from '../../wgsl/module';
import { frameWgsl, gbufferWgsl } from '../../wgsl/common';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { HDR_FORMAT } from '../lighting/lighting';
import { cubeSphereWgsl } from '../../wgsl/common/cube-sphere.wgsl';
import { materialNoiseWgsl } from '../../wgsl/common/noise.wgsl';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { createFrameBindGroup, GBUFFER_COLOR_TARGETS, GBUFFER_DEPTH_STENCIL } from '../gbuffer/gbuffer';

export const GRASS_GRID = 192;
const COUNT = 6 * GRASS_GRID ** 2;
/** Cull workgroups of 64 roots (4 mark bits each: blades 0-2, clump shadow 3), and emit workgroups of 64 of those. */
const GROUPS = Math.ceil(COUNT / 64), SUPER = Math.ceil(GROUPS / 64);
/** The 18 triangle-list vertices of a blade as its 8 distinct corners (vi = row * 2 + right), in the original order. */
export const GRASS_BLADE_INDICES = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 7, 4, 7, 6];
/**
 * Furthest any blade vertex gets from its root (lift, lean, curl, wind, blast, width): 0.227 + 2.65 × standing height,
 * which grass_height and the hash mix bound by 1.15 × max(1.5 |root.w|, 0.22). Clump shadow corners: 0.175 + 5 × width.
 */
const REACH = { blade: [0.25, 3.1], shadow: [0.2, 5] } as const;
const f32 = (v: number) => formatConst(v, 'f32');
export const grassBladeReach = (w: number) => REACH.blade[0] + REACH.blade[1] * Math.max(Math.abs(w) * 1.5, 0.22);
export const grassShadowReach = (width: number) => REACH.shadow[0] + REACH.shadow[1] * width;
declare module '../../contracts' { interface SceneFacets { grass: { density: number; readonly sites: number; impact(position: readonly number[], radius: number): void } } }
const declarations = /* wgsl */ `
struct GrassWave { centre: vec4f, timing: vec4f }
// wind: xyz the air field's axis × its ground speed, w the gusts' phase (integrated on the CPU, so a changing wind
// never makes the travelling gusts jump).
// memory: x the trample decay owed but not yet drawn into the surface memory (whole 1/255 steps at 4 Hz).
struct GrassParams { config: vec4f, wind: vec4f, waves: array<GrassWave, 8>, memory: vec4f }
@group(1) @binding(0) var<uniform> grass: GrassParams;
`;
const trample = /* wgsl */ `
@group(1) @binding(6) var grass_memory: texture_2d_array<f32>;
@group(1) @binding(7) var grass_linear: sampler;
@group(1) @binding(8) var grass_water: texture_2d<f32>;
fn grass_compression(p: vec3f) -> f32 {
  let loc = cs_locate(p);
  // Less the decay owed since the last 4 Hz tick: a crushed blade rights itself smoothly, not in steps.
  return max(textureSampleLevel(grass_memory, grass_linear, cs_uv01(loc.xy), i32(loc.z), 0.0).b - grass.memory.x, 0.0);
}
/** The water over a root, bilinear over the level map's cells (atlas texels; gutters cross face seams): x the drawn
 *  surface's height over the root (−1 where a cell has no surface), y the water depth (fronts count as none). */
fn grass_water_at(root: vec3f, size: vec2u) -> vec2f {
  let n = size.x / 3u - 2u;
  let f = cs_face_of(root);
  let tile = vec2f(f32(f % 3u), f32(f / 3u)) * f32(n + 2u);
  let q = tile + 0.5 + (cs_uv(root, f) * 0.5 + 0.5) * f32(n);
  let i = floor(q); let t = q - i;
  var d = vec4f(0.0); var z = vec4f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let w = textureLoad(grass_water, vec2i(i) + vec2i(i32(k & 1u), i32(k >> 1u)), 0);
    d[k] = select(-1.0, w.x - length(root), w.x > 0.0); z[k] = max(w.z, 0.0);
  }
  let row = vec2f(1.0 - t.y, t.y);
  return vec2f(dot(vec2f(mix(d.x, d.y, t.x), mix(d.z, d.w, t.x)), row), dot(vec2f(mix(z.x, z.y, t.x), mix(z.z, z.w, t.x)), row));
}
/** How submerged a root is now (0 land, 1 water weed): the live water over it, bilinear over the cells. Placement never
 *  changes with the water (the roots are fixed); only each blade's form follows it, continuously. */
fn grass_submersion(root: vec3f) -> f32 {
  let size = textureDimensions(grass_water);
  if (size.x <= 8u) { return 0.0; }
  let water = grass_water_at(root, size);
  return smoothstep(0.12, 0.26, water.x) * smoothstep(0.04, 0.12, water.y);
}
/** A blade's standing height: land grass (a water-placed root on land: 0.22), giving way continuously to water weed
 *  (as tall as the water over it allows) as the root is submerged, so no blade pops as waves come and go. */
fn grass_height(root: vec4f) -> f32 {
  if (root.w == 0.0) { return 0.0; }
  let loc = cs_locate(root.xyz);
  // Scorch survives terrain commits, so rerooting cannot grow a new lawn in a fresh crater.
  let burn = textureSampleLevel(grass_memory, grass_linear, cs_uv01(loc.xy), i32(loc.z), 0.0).g;
  let growth = 1.0 - smoothstep(0.16, 0.42, burn);
  let land = select(root.w, 0.22, root.w < 0.0);
  let size = textureDimensions(grass_water);
  if (size.x <= 8u) { return land * growth; }
  let water = grass_water_at(root.xyz, size);
  let k = smoothstep(0.12, 0.26, water.x) * smoothstep(0.04, 0.12, water.y);
  return mix(land, min(max(water.x, 0.0) * 0.7, abs(root.w) * 1.5), k) * growth;
}
fn grass_blast(p: vec3f, time: f32) -> vec3f {
  let up = normalize(p);
  var offset = vec3f(0);
  for (var i = 0u; i < 8u; i++) {
    let w = grass.waves[i]; let age = time - w.timing.x;
    if (w.centre.w <= 0.0 || age < 0.0 || age > 2.8) { continue; }
    let origin = normalize(w.centre.xyz);
    let d = acos(clamp(dot(up, origin), -1.0, 1.0)) * length(p);
    let speed = max(5.0, w.centre.w * 5.0);
    let lag = age - d / speed;
    let reach = 1.0 - smoothstep(w.centre.w * 1.5, w.centre.w * 4.0 + 1.0, d);
    if (lag < 0.0 || reach <= 0.0) { continue; }
    let away = up * dot(up, origin) - origin;
    let direction = away / max(length(away), 0.001);
    let pulse = sin(min(lag * 10.0, 1.5708)) * exp(-lag * 3.5);
    let recoil = sin(lag * 12.0) * exp(-lag * 3.0) * 0.14;
    offset += (direction * (pulse + recoil) - up * pulse * 0.35) * reach;
  }
  return offset / max(1.0, length(offset));
}
`;
export const grassPlaceShader = makeModule('grass-place', /* wgsl */ `
${declarations}
@group(1) @binding(1) var<storage, read_write> roots: array<vec4f>;
@group(1) @binding(5) var<storage, read> band: array<u32>;
@compute @workgroup_size(64)
fn place(@builtin(global_invocation_id) g: vec3u) {
  let id = g.x; if (id >= ${COUNT}u) { return; }
  // Uniform spherical cluster centres: no cube-face rows or polar/hemisphere seams.
  // Four independent roots per loose clump, with variable spread.
  let cluster = id / 4u;
  let salt = u32(grass.config.x);
  let z = cs_hash01(cluster, salt + 11u) * 2.0 - 1.0;
  let phi = cs_hash01(cluster, salt + 29u) * 6.283185;
  let centre = vec3f(sqrt(max(0.0, 1.0 - z*z)) * cos(phi), z, sqrt(max(0.0, 1.0 - z*z)) * sin(phi));
  // Habitat varies on meadow (several units) and clearing scales, independent of tuft size.
  // Cartesian noise remains continuous across every cube-face and hemisphere boundary.
  let habitat = mn_value3(centre * 4.0, salt + 301u) * 0.72 + mn_value3(centre * 13.0, salt + 307u) * 0.28;
  let coverage = smoothstep(0.36, 0.60, habitat);
  if (cs_hash01(cluster, salt + 311u) > coverage) { roots[id] = vec4f(centre * 18.0, 0.0); return; }
  let axis = select(vec3f(0,1,0), vec3f(1,0,0), abs(z) > 0.9);
  let a = normalize(cross(centre, axis)); let b = cross(centre, a);
  let jitter = vec2f(cs_hash01(id, u32(grass.config.x)), cs_hash01(id, u32(grass.config.x) + 97u));
  let spread = mix(0.10, 0.60, cs_hash01(cluster, salt + 53u)) * mix(0.7, 1.3, coverage);
  let offset = sqrt(jitter.x) * spread / 18.0;
  let n = normalize(centre + (a * cos(jitter.y * 6.283185) + b * sin(jitter.y * 6.283185)) * offset);
  var r = 24.0;
  for (var k = 0u; k < 80u; k++) {
    let d = sdf_terrain(n * r);
    if (d < 0.015 || r < 13.0) { break; }
    r -= clamp(d * 0.8, 0.025, 0.7);
  }
  let p = n * r;
  let v = clamp(vec3i((p + sdf_params.grid.z) / sdf_voxel()), vec3i(0), vec3i(i32(sdf_params.grid.x) - 1));
  let size = u32(sdf_params.grid.x);
  let mat = band[(u32(v.z) * size + u32(v.y)) * size + u32(v.x)] & 15u;
  let slope = dot(n, sdf_normal(p));
  let depth = grass.config.z - r;
  let aquatic = depth > 0.18 && depth < 3.5 && slope > 0.78 && (mat == 1u || mat == 4u)
    && cs_hash01(id, 193u) < 0.6;
  let alive = mat == 1u && slope > 0.72 && r > grass.config.z + 0.10 && r > 13.0;
  // Negative height tags seagrass: longer, pliable blades in the sunlit shallows.
  let height = select(select(0.0, 0.16 + cs_hash01(cluster, 173u) * 0.20, alive), -min(depth * 0.75, 0.3 + jitter.x * 0.42), aquatic);
  roots[id] = vec4f(p - n * 0.075, height);
}`, [cubeSphereWgsl, materialNoiseWgsl, sdfBindingsWgsl(1, { volume: 2, params: 3, sampler: 4 }), sdfWgsl]);

const visible = /* wgsl */ `@group(1) @binding(9) var<storage, read> grass_visible: array<u32>;`;
export const grassDrawShader = makeModule('grass-draw', /* wgsl */ `
${declarations}
@group(1) @binding(1) var<storage, read> roots: array<vec4f>;
${visible}
${trample}
struct Blade { @builtin(position) pos: vec4f, @location(0) world: vec3f,
  @location(1) normal: vec3f, @location(2) tint: vec3f, @location(3) height: f32,
  @location(4) previous: vec4f, @location(5) current: vec4f,
  @location(6) blade_uv: vec2f, @location(7) width_axis: vec3f }
/**
 * The wind on a blade tip (scene facet wind: the match wind): a steady lean downwind that grows with the air speed,
 * gusts rolling downwind across the lawn as travelling waves, and a little per-blade flutter. Water plants keep their
 * slow sway. Bounded by 0.1375 u (REACH).
 */
fn grass_wind(p: vec3f, lean: vec3f, time: f32, phase: f32, aquatic: bool, h: f32) -> vec3f {
  let flutter_phase = dot(p, vec3f(1.3, 0.5, 0.8)) + h * 6.283185;
  if (aquatic) { return lean * sin(time * 0.38 * 2.1 + flutter_phase) * 0.1375; }
  let air = cross(grass.wind.xyz, p / max(length(p), 1e-6));
  let speed = length(air);
  let calm = clamp(speed / 1.1, 0.0, 1.0);
  let downwind = air / max(speed, 1e-5);
  let along = dot(p, downwind);
  let gust = 0.5 + 0.5 * sin(along * 1.3 - phase) * (0.6 + 0.4 * sin(along * 0.37 - phase * 0.35));
  let steady = select(vec3f(0.0), downwind * ((0.012 + 0.073 * calm) * (0.55 + 0.45 * gust)), speed > 1e-4);
  let flutter = lean * sin(time * 2.6 + flutter_phase) * (0.02 + 0.02 * calm * gust);
  return steady + flutter;
}
/** The wind on land, the water's slow sway submerged, blended by submersion (both only while it is partial). */
fn grass_sway(p: vec3f, lean: vec3f, time: f32, phase: f32, submersion: f32, h: f32) -> vec3f {
  if (submersion <= 0.0) { return grass_wind(p, lean, time, phase, false, h); }
  if (submersion >= 1.0) { return grass_wind(p, lean, time, phase, true, h); }
  return mix(grass_wind(p, lean, time, phase, false, h), grass_wind(p, lean, time, phase, true, h), submersion);
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) slot: u32) -> Blade {
  let id = grass_visible[slot];
  let root = roots[id / 3u]; let h = cs_hash01(id, 37u);
  let up = normalize(root.xyz);
  let axis = select(vec3f(0, 1, 0), vec3f(1, 0, 0), abs(up.y) > 0.9);
  let a = normalize(cross(up, axis)); let b = cross(up, a);
  let tangent = a * cos(h * 6.283185) + b * sin(h * 6.283185);
  let lean = cross(tangent, up);
  let kind = cs_hash01(id / 12u, 83u);
  let broad = kind > 0.64;
  let tuft = kind < 0.25;
  // Indexed corners: row vi / 2 (tip = row / 3, the value every list vertex of that row had), odd vi on the right.
  let side = select(-1.0, 1.0, (vi & 1u) == 1u);
  let tip = f32(vi / 2u) / 3.0;
  let dist = distance(root.xyz, frame.eye_pos);
  // Land grass to water weed by how submerged the root is (height, sway and colour all blend).
  let submersion = grass_submersion(root.xyz);
  var height = grass_height(root) * mix(0.75, 1.15, cs_hash01(id, 103u))
    * select(1.0, 0.72, tuft) * (1.0 - smoothstep(48.0, 64.0, dist));
  let crushed = smoothstep(0.0, 1.0, grass_compression(root.xyz));
  let standing_height = height;
  height *= 1.0 - 0.92 * crushed;
  if (h > grass.config.y || grass.config.w < 0.5 || sdf_sample(root.xyz + up * 0.12) > 0.25) { height = 0.0; }
  // Keep distant blades at least one pixel wide instead of alternating between
  // zero and full coverage under TAA jitter. Reduce unresolved wind motion too.
  // A DISPLAY pixel: below native the upscaler accumulates the thinner coverage.
  let pixel_width = dist * 2.0 / max(frame.proj[1][1] * frame.viewport.w, 1.0);
  let natural_width = select(0.016, 0.028, broad);
  let width = max(natural_width, min(0.055, pixel_width * 0.5));
  let wind_scale = 1.0 - smoothstep(18.0, 45.0, dist) * 0.85;
  let wind = grass_sway(root.xyz, lean, frame.time, grass.wind.w, submersion, h) * wind_scale * (1.0 - crushed);
  let curve = standing_height * select(0.22, 0.65, broad) + standing_height * crushed * 0.8;
  let profile = (1.0 - tip) * (0.65 + tip * 1.2);
  let blast = grass_blast(root.xyz, frame.time) * standing_height * (1.0 - crushed);
  let p = root.xyz + tangent * (h - 0.5) * 0.10 + up * (height * tip + crushed * 0.07)
    + tangent * side * width * profile + (lean * curve + wind) * tip * tip + blast * tip * tip;
  let gust_rate = 1.3 * (0.6 + length(grass.wind.xyz) * 2.5);
  let prev = p + (grass_sway(root.xyz, lean, frame.time - frame.dt, grass.wind.w - frame.dt * gust_rate, submersion, h) * wind_scale * (1.0 - crushed) - wind) * tip * tip
    + (grass_blast(root.xyz, frame.time - frame.dt) * standing_height * (1.0 - crushed) - blast) * tip * tip;
  var o: Blade; o.pos = frame.view_proj * vec4f(p, 1);
  o.world = p; o.normal = normalize(up * (0.65 + tip * 0.2) + lean * 0.35);
  o.tint = mix(vec3f(0.055, 0.15, 0.028), vec3f(0.22, 0.32, 0.065), kind) * (0.7 + tip * 0.5);
  o.tint *= mix(0.85, 1.12, h);
  o.tint = mix(o.tint, vec3f(0.32, 0.27, 0.12), smoothstep(0.9, 1.0, cs_hash01(id, 211u)) * tip * 0.7);
  o.tint = mix(o.tint, mix(vec3f(0.025, 0.12, 0.055), vec3f(0.12, 0.28, 0.10), h) * (0.7 + tip * 0.5), submersion);
  o.blade_uv = vec2f(side, tip); o.width_axis = tangent;
  o.height = height; o.previous = frame.prev_view_proj * vec4f(prev, 1); o.current = frame.view_proj_nojitter * vec4f(p, 1);
  return o;
}
@fragment fn fs(i: Blade) -> GBufferOut {
  if (i.height < 0.002) { discard; }
  // Filter the central rib and fine longitudinal veins away before they become subpixel.
  let footprint = fwidth(i.blade_uv.x);
  let detail = 1.0 - smoothstep(0.25, 0.8, footprint);
  let rib = 1.0 - smoothstep(0.04, 0.16 + footprint, abs(i.blade_uv.x));
  let veins = cos(i.blade_uv.x * 24.0 + sin(i.blade_uv.y * 5.0) * 0.5) * detail;
  var s = surface_default(); s.base_color = i.tint * (1.0 + rib * 0.10 * detail + veins * 0.035);
  s.n_shading = normalize(i.normal + i.width_axis * i.blade_uv.x * 0.16 * detail);
  s.n_geom = normalize(i.world); s.roughness = 0.88; s.class_id = CLASS_GRASS; s.param = 0.65;
  return gbuffer_pack(s, gbuffer_velocity(i.current, i.previous));
}`, [frameWgsl, gbufferWgsl, cubeSphereWgsl, sdfBindingsWgsl(1, { volume: 2, params: 3, sampler: 4 }), sdfWgsl]);

/** Soft world-space clump shadows, filtered to the receiver's pixel footprint. */
export const grassShadowShader = makeModule('grass-shadow', /* wgsl */ `
${declarations}
${trample}
@group(1) @binding(1) var<storage, read> roots: array<vec4f>;
${visible}
@group(2) @binding(0) var grass_depth: texture_depth_2d;
@group(2) @binding(1) var grass_ids: texture_2d<u32>;
struct Shadow { @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) root: vec3f, @location(1) @interpolate(flat) axis: vec3f,
  @location(2) @interpolate(flat) shape: vec3f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) slot: u32) -> Shadow {
  let root = roots[grass_visible[slot]]; let up = normalize(root.xyz);
  let sun_up = dot(up, frame.sun_dir);
  let projection = -(frame.sun_dir - up * sun_up);
  let fallback = normalize(cross(up, select(vec3f(0, 1, 0), vec3f(1, 0, 0), abs(up.y) > 0.9)));
  let axis = select(fallback, projection / max(length(projection), 1e-5), length(projection) > 0.001);
  let side = cross(up, axis);
  let crushed = smoothstep(0.0, 1.0, grass_compression(root.xyz));
  let height = abs(grass_height(root)) * (1.0 - crushed * 0.92);
  // Local root contact only: long repeated projections read as stripes at planet scale.
  let reach = min(0.10, height * length(projection) * 0.35);
  let dist = distance(root.xyz, frame.eye_pos);
  let pixel = dist * 2.0 / max(frame.proj[1][1] * frame.viewport.y, 1.0);
  let width = sqrt(0.065 * 0.065 + pixel * pixel * 0.4);
  let q = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(1,1), vec2f(-1,-1), vec2f(1,1), vec2f(-1,1))[vi];
  let centre = root.xyz + up * 0.075;
  let p = centre + axis * (reach * 0.5 + q.x * (reach * 0.5 + width * 2.5)) + side * q.y * width * 2.5;
  var strength = 0.12 * grass.config.y * smoothstep(0.05, 0.3, sun_up) * (1.0 - smoothstep(16.0, 30.0, dist));
  strength *= 0.065 * 0.065 / (width * width);
  if (height < 0.005 || grass.config.w < 0.5) { strength = 0.0; }
  // A clump shades only ground the sun reaches: multiplied over terrain already in shadow it made blotches darker than
  // the shadow itself. One short trace per clump, at its root (the lighting's own sun trace, coarser).
  if (strength > 0.0 && sdf_valid()) {
    strength *= sdf_vis_dir(root.xyz + up * 0.15, frame.sun_dir, 0.035, sdf_voxel() * 0.5, 16u);
  }
  var o: Shadow; o.position = frame.view_proj * vec4f(p, 1); o.root = centre; o.axis = axis;
  o.shape = vec3f(reach, width, strength); return o;
}
@fragment fn fs(i: Shadow) -> @location(0) vec4f {
  let px = vec2i(i.position.xy);
  if (i.shape.z <= 0.0 || gbuffer_class(textureLoad(grass_ids, px, 0).r) != CLASS_TERRAIN) { discard; }
  let depth = textureLoad(grass_depth, px, 0);
  let p = world_pos_from_depth(i.position.xy / frame_internal_size(), depth);
  let up = normalize(i.root);
  let delta = p - i.root;
  if (abs(dot(delta, up)) > 0.12) { discard; }
  let along = dot(delta, i.axis);
  let across = dot(delta, cross(up, i.axis));
  let end = along - clamp(along, 0.0, i.shape.x);
  let opacity = i.shape.z * exp(-(across * across + end * end) / (i.shape.y * i.shape.y));
  return vec4f(vec3f(1.0 - opacity), 1.0);
}`, [frameWgsl, gbufferWgsl, depthWgsl, cubeSphereWgsl, sdfBindingsWgsl(1, { volume: 2, params: 3, sampler: 4 }), sdfWgsl]);

/**
 * Marks per root what can reach a pixel. Each test errs toward keeping: the margins cover blade reach, filtering and
 * float differences between this pass and the vertex shaders that decide the same thing exactly.
 */
export const grassCullShader = makeModule('grass-cull', /* wgsl */ `
${declarations}
@group(1) @binding(1) var<storage, read> roots: array<vec4f>;
@group(1) @binding(6) var grass_memory: texture_2d_array<f32>;
@group(1) @binding(7) var grass_linear: sampler;
@group(1) @binding(9) var<uniform> grass_frustum: array<vec4f, 5>;
@group(1) @binding(10) var<storage, read_write> marks: array<u32>;
@group(1) @binding(11) var<storage, read_write> counts: array<u32>;
var<workgroup> group_marks: array<atomic<u32>, 8>;
fn grass_outside(c: vec3f, r: f32) -> bool {
  for (var i = 0u; i < 5u; i++) { if (dot(grass_frustum[i].xyz, c) + grass_frustum[i].w < -r) { return true; } }
  return false;
}
fn grass_mark(id: u32) -> u32 {
  if (id >= ${COUNT}u) { return 0u; }
  let root = roots[id];
  if (root.w == 0.0) { return 0u; }
  let dist = distance(root.xyz, frame.eye_pos);
  let up = normalize(root.xyz);
  // Height fades to exactly 0 from 64 u; clump shadows to 0 from 30 u and with the sun at or below 0.05.
  var blades = dist < 64.01 && !grass_outside(root.xyz, ${f32(REACH.blade[0])} + ${f32(REACH.blade[1])} * max(abs(root.w) * 1.5, 0.22));
  let pixel = dist * 2.0 / max(frame.proj[1][1] * frame.viewport.y, 1.0);
  let shadow = dist < 30.01 && dot(up, frame.sun_dir) > 0.0499
    && !grass_outside(root.xyz, ${f32(REACH.shadow[0])} + ${f32(REACH.shadow[1])} * sqrt(0.065 * 0.065 + pixel * pixel * 0.4));
  if (!blades && !shadow) { return 0u; }
  // Scorch from 0.42 leaves no growth; burial above 0.25 flattens the blades.
  let loc = cs_locate(root.xyz);
  if (textureSampleLevel(grass_memory, grass_linear, cs_uv01(loc.xy), i32(loc.z), 0.0).g > 0.43) { return 0u; }
  if (blades && sdf_sample(root.xyz + up * 0.12) > 0.26) { blades = false; }
  var m = select(0u, 8u, shadow);
  for (var b = 0u; b < 3u; b++) { if (blades && cs_hash01(id * 3u + b, 37u) <= grass.config.y + 1e-6) { m |= 1u << b; } }
  return m;
}
@compute @workgroup_size(64)
fn cull(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  atomicOr(&group_marks[li / 8u], grass_mark(wg.x * 64u + li) << (li % 8u * 4u));
  workgroupBarrier();
  if (li < 8u) { marks[wg.x * 8u + li] = atomicLoad(&group_marks[li]); }
  if (li == 0u) {
    var blades = 0u; var shadows = 0u;
    for (var k = 0u; k < 8u; k++) {
      let w = atomicLoad(&group_marks[k]);
      blades += countOneBits(w & 0x77777777u); shadows += countOneBits(w & 0x88888888u);
    }
    counts[wg.x] = blades | (shadows << 16u);
  }
}`, [frameWgsl, cubeSphereWgsl, sdfBindingsWgsl(1, { volume: 2, params: 3, sampler: 4 }), sdfWgsl]);

/** Lists the marked blade ids and shadow roots in ascending order (the full draw's order), and the indirect args. */
export const grassEmitShader = makeModule('grass-emit', /* wgsl */ `
@group(0) @binding(0) var<storage, read> marks: array<u32>;
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var<storage, read_write> blades: array<u32>;
@group(0) @binding(3) var<storage, read_write> shadows: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<u32, 9>;
var<workgroup> group_counts: array<u32, 64>;
var<workgroup> base_blades: atomic<u32>;
var<workgroup> base_shadows: atomic<u32>;
@compute @workgroup_size(64)
fn emit(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let g = wg.x * 64u + li;
  group_counts[li] = select(0u, counts[min(g, ${GROUPS - 1}u)], g < ${GROUPS}u);
  // Earlier workgroups' totals, one residue class per invocation; integer sums are order-independent.
  var b = 0u; var s = 0u;
  for (var k = li; k < wg.x * 64u; k += 64u) { b += counts[k] & 0xffffu; s += counts[k] >> 16u; }
  atomicAdd(&base_blades, b); atomicAdd(&base_shadows, s);
  workgroupBarrier();
  var ob = atomicLoad(&base_blades); var os = atomicLoad(&base_shadows);
  for (var k = 0u; k < li; k++) { ob += group_counts[k] & 0xffffu; os += group_counts[k] >> 16u; }
  if (g >= ${GROUPS}u) { return; }
  for (var w = g * 8u; w < g * 8u + 8u; w++) {
    var bits = marks[w];
    while (bits != 0u) {
      let bit = countTrailingZeros(bits); bits &= bits - 1u;
      let root = w * 8u + bit / 4u;
      if (bit % 4u == 3u) { shadows[os] = root; os++; } else { blades[ob] = root * 3u + bit % 4u; ob++; }
    }
  }
  if (g == ${GROUPS - 1}u) {
    args[0] = ${GRASS_BLADE_INDICES.length}u; args[1] = ob; args[2] = 0u; args[3] = 0u; args[4] = 0u;
    args[5] = 6u; args[6] = os; args[7] = 0u; args[8] = 0u;
  }
}`);

export function grassModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return { name: 'grass', async install(s) {
    const { device, queue } = s.ctx;
    const roots = device.createBuffer({ label: 'grass:roots', size: COUNT * 16, usage: BufferUsage.STORAGE });
    const paramData = new Float32Array(8 + 8 * 8 + 4);
    const params = device.createBuffer({ label: 'grass:params', size: paramData.byteLength, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const visibility = ShaderStage.COMPUTE | ShaderStage.VERTEX;
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility, buffer: { type: 'uniform' } },
      { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility, texture: { viewDimension: '3d' } },
      { binding: 3, visibility, buffer: { type: 'uniform' } },
      { binding: 4, visibility, sampler: { type: 'filtering' } },
      { binding: 6, visibility: ShaderStage.VERTEX, texture: { viewDimension: '2d-array' } },
      { binding: 7, visibility: ShaderStage.VERTEX, sampler: { type: 'filtering' } },
      { binding: 8, visibility: ShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
    ];
    const drawLayout = device.createBindGroupLayout({ entries: [...entries, { binding: 9, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
    const placeLayout = device.createBindGroupLayout({ entries: [...entries.map(e => e.binding === 1 ?
      { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: 'storage' as const } } : e),
      { binding: 5, visibility: ShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }] });
    const cullLayout = device.createBindGroupLayout({ entries: [...entries.filter(e => e.binding !== 8).map(e => ({ ...e, visibility: ShaderStage.COMPUTE })),
      { binding: 9, visibility: ShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 10, visibility: ShaderStage.COMPUTE, buffer: { type: 'storage' } }, { binding: 11, visibility: ShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
    const emitLayout = device.createBindGroupLayout({ entries: [0, 1, 2, 3, 4].map(binding =>
      ({ binding, visibility: ShaderStage.COMPUTE, buffer: { type: binding < 2 ? 'read-only-storage' as const : 'storage' as const } })) });
    const cache = s.ctx.pipelines;
    const shadowLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
    ] });
    cache.register('grass:shadow', 'render', () => { const module = cache.shaderModule(link(grassShadowShader), 'grass:shadow'); return {
      layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, drawLayout, shadowLayout] }), vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: {
        color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      } }] }, primitive: { topology: 'triangle-list', cullMode: 'none' },
    }; });
    cache.register('grass:place', 'compute', () => ({ layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, placeLayout] }),
      compute: { module: cache.shaderModule(link(grassPlaceShader), 'grass:place'), entryPoint: 'place' } }));
    cache.register('grass:draw', 'render', () => { const module = cache.shaderModule(link(grassDrawShader), 'grass:draw'); return {
      layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, drawLayout] }), vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: GBUFFER_COLOR_TARGETS }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: GBUFFER_DEPTH_STENCIL,
    }; });
    cache.register('grass:cull', 'compute', () => ({ layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, cullLayout] }),
      compute: { module: cache.shaderModule(link(grassCullShader), 'grass:cull'), entryPoint: 'cull' } }));
    cache.register('grass:emit', 'compute', () => ({ layout: device.createPipelineLayout({ bindGroupLayouts: [emitLayout] }),
      compute: { module: cache.shaderModule(link(grassEmitShader), 'grass:emit'), entryPoint: 'emit' } }));
    await Promise.all(['grass:place', 'grass:draw', 'grass:shadow', 'grass:cull', 'grass:emit'].map(key => cache.compile(key)));
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const buffer = (name: string, size: number, usage: number) => device.createBuffer({ label: `grass:${name}`, size, usage });
    const frustum = new Float32Array(20), frustumBuffer = buffer('frustum', frustum.byteLength, BufferUsage.UNIFORM | BufferUsage.COPY_DST);
    const marks = buffer('marks', GROUPS * 32, BufferUsage.STORAGE), counts = buffer('counts', GROUPS * 4, BufferUsage.STORAGE);
    const blades = buffer('blades', COUNT * 12, BufferUsage.STORAGE), shadowRoots = buffer('shadow-roots', COUNT * 4, BufferUsage.STORAGE);
    const args = buffer('args', 36, BufferUsage.STORAGE | BufferUsage.INDIRECT);
    const indices = buffer('indices', GRASS_BLADE_INDICES.length * 2, BufferUsage.INDEX | BufferUsage.COPY_DST);
    queue.writeBuffer(indices, 0, new Uint16Array(GRASS_BLADE_INDICES));
    let serial = -1, seed = -1, sea = -1, placed = false, culled = -1;
    let time = 0, waveIndex = 0, gustPhase = 0;
    const facet = { density: 1, get sites() { return placed ? COUNT : 0; }, impact(position: readonly number[], radius: number) {
      if (!(radius > 0) || !Number.isFinite(radius) || position.length < 3 || !position.slice(0, 3).every(Number.isFinite) || Math.hypot(...position) < 1) return;
      paramData.set([position[0], position[1], position[2], radius, time, 0, 0, 0], 8 + (waveIndex++ % 8) * 8);
    } }; s.scene.provide('grass', facet);
    const frameGroup = createFrameBindGroup(s, 'grass');
    const groups = { place: new BindGroupResourceCache(), draw: new BindGroupResourceCache(), shadow: new BindGroupResourceCache(),
      cull: new BindGroupResourceCache(), emit: new BindGroupResourceCache(), depth: new BindGroupResourceCache() };
    /** Reuses the group while every bound resource is the same object (SDF, SMC and water views swap on tier changes). */
    const group = (cached: BindGroupResourceCache, layout: GPUBindGroupLayout, entries: GPUBindGroupEntry[]) => {
      const key = cached.begin(); for (const e of entries) pushBindingKey(key, e.resource);
      return cached.get(() => device.createBindGroup({ layout, entries }));
    };
    const shared = (): GPUBindGroupEntry[] => { const sdf = s.scene.get('sdf')!; return [
      { binding: 0, resource: { buffer: params } }, { binding: 2, resource: sdf.volumeView }, { binding: 3, resource: { buffer: sdf.paramsBuffer } },
      { binding: 4, resource: sampler }, { binding: 6, resource: s.bindings.get('surfaceMemory').cube }, { binding: 7, resource: sampler }]; };
    const drawGroup = (cached: BindGroupResourceCache, list: GPUBuffer) => group(cached, drawLayout, [...shared(), { binding: 1, resource: { buffer: roots } },
      { binding: 8, resource: s.bindings.get('waterSurface').surface }, { binding: 9, resource: { buffer: list } }]);
    const live = () => placed && facet.density > 0 && s.scene.get('planet')?.kind === 'temperate';
    disposers.push(s.events.on('planetChanged', () => { serial = -1; placed = false; paramData.fill(0); waveIndex = 0; }));
    disposers.push(s.graph.addPass({ name: 'grass.place', slot: 'compute.commit', order: 90, reads: [], writes: [], run(c) {
      const planet = s.scene.get('planet'), sdf = s.scene.get('sdf'); if (!planet || !sdf?.valid) return;
      const enabled = planet.kind === 'temperate';
      const level = s.scene.get('fluids')?.seaLevel ?? 0;
      time = c.frame.time;
      const wind = s.scene.get('wind'), speed = wind?.speed ?? 0, axis = wind?.axis ?? [0, 1, 0];
      // The gusts travel downwind faster in a stronger wind: integrate their phase so a gust never makes them jump.
      gustPhase = (gustPhase + Math.min(Math.max(c.frame.dt, 0), 0.1) * 1.3 * (0.6 + speed * 2.5)) % (Math.PI * 2 * 1000);
      paramData.set([planet.seed, Math.min(1, Math.max(0, facet.density)), level, enabled ? 1 : 0, axis[0] * speed, axis[1] * speed, axis[2] * speed, gustPhase]);
      paramData[8 + 8 * 8] = s.scene.get('surfaceMemory')?.pendingDecay('trample') ?? 0;
      queue.writeBuffer(params, 0, paramData);
      if (!enabled || (seed === planet.seed && serial === sdf.serial && sea === level)) return;
      const pass = c.encoder.beginComputePass({ label: 'grass.place', timestampWrites: c.timestampWrites('grass.place') });
      pass.setPipeline(cache.get<GPUComputePipeline>('grass:place')!);
      pass.setBindGroup(0, frameGroup);
      pass.setBindGroup(1, group(groups.place, placeLayout, [...shared(), { binding: 1, resource: { buffer: roots } },
        { binding: 5, resource: { buffer: sdf.band } }, { binding: 8, resource: s.bindings.get('waterSurface').surface }]));
      pass.dispatchWorkgroups(Math.ceil(COUNT / 64)); pass.end();
      seed = planet.seed; serial = sdf.serial; sea = level; placed = true;
    } }));
    disposers.push(s.graph.addPass({ name: 'grass.cull', slot: 'compute.commit', order: 95, reads: ['frameUniforms'], writes: [], enabled: live, run(c) {
      const planes = extractFrustumPlanes(c.frame.viewProj);
      [0, 1, 2, 3, 5].forEach((p, i) => frustum.set(planes[p], i * 4));
      queue.writeBuffer(frustumBuffer, 0, frustum);
      const pass = c.encoder.beginComputePass({ label: 'grass.cull', timestampWrites: c.timestampWrites('grass.cull') });
      pass.setPipeline(cache.get<GPUComputePipeline>('grass:cull')!);
      pass.setBindGroup(0, frameGroup);
      pass.setBindGroup(1, group(groups.cull, cullLayout, [...shared(), { binding: 1, resource: { buffer: roots } }, { binding: 9, resource: { buffer: frustumBuffer } },
        { binding: 10, resource: { buffer: marks } }, { binding: 11, resource: { buffer: counts } }]));
      pass.dispatchWorkgroups(GROUPS);
      pass.setPipeline(cache.get<GPUComputePipeline>('grass:emit')!);
      pass.setBindGroup(0, group(groups.emit, emitLayout, [marks, counts, blades, shadowRoots, args].map((b, binding) => ({ binding, resource: { buffer: b } }))));
      pass.dispatchWorkgroups(SUPER); pass.end();
      culled = c.frame.index;
    } }));
    disposers.push(s.scene.addGBufferDrawer({ name: 'grass', slot: 'gbuffer.foliage', order: 200, draw(pass, f) {
      if (culled !== f.index) return;
      pass.setPipeline(cache.get<GPURenderPipeline>('grass:draw')!); pass.setBindGroup(1, drawGroup(groups.draw, blades));
      pass.setIndexBuffer(indices, 'uint16'); pass.drawIndexedIndirect(args, 0);
    } }));
    disposers.push(s.graph.addPass({ name: 'grass.shadows', slot: 'lighting', order: 20, reads: ['frameUniforms', 'hdr', 'depth', 'ids'], writes: ['hdr'],
      enabled: f => culled === f.index,
      run(c) {
        const pass = c.encoder.beginRenderPass({ label: 'grass.shadows', colorAttachments: [{ view: c.resources.view('hdr'), loadOp: 'load', storeOp: 'store' }],
          timestampWrites: c.timestampWrites('grass.shadows') });
        pass.setPipeline(cache.get<GPURenderPipeline>('grass:shadow')!);
        pass.setBindGroup(0, frameGroup);
        pass.setBindGroup(1, drawGroup(groups.shadow, shadowRoots));
        pass.setBindGroup(2, group(groups.depth, shadowLayout, [{ binding: 0, resource: c.resources.view('depth') }, { binding: 1, resource: c.resources.view('ids') }]));
        pass.drawIndirect(args, 20); pass.end();
      },
    }));
    disposers.push(() => { for (const b of [roots, params, frustumBuffer, marks, counts, blades, shadowRoots, args, indices]) s.ctx.deferDestroy(b); });
  }, dispose() { disposers.splice(0).reverse().forEach(f => f()); } };
}
