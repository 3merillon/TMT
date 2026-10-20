/**
 * The generic part-mesh path (plan §5.4), used by the W1 kit sandbox and by tanks in play:
 * - `scene.meshes.create(PartMesh-like desc)` packs positions, normals, partLocal, primAxis, attrs, sub-instances and
 *   indices into slice-arena storage (vertex pulling: no vertex buffers; a dedicated buffer only above the slice limit);
 * - `scene.instances` holds model + prevModel (prev copied automatically at the start of every frame), tint, objectId,
 *   flags, class;
 * - a GBufferDrawer (order 100) writes the G-buffer with the basic PBR material by matId and velocity from prevModel and
 *   the previous view-projection;
 * - a dynamic ShadowCaster draws every shadow-casting instance depth-only with back-face culling.
 * Bind groups: @group(0) frame (or the shadow view), @group(1) mesh data, @group(2) instances + draw list.
 */
import type { EngineServices, GBufferDrawer, InstanceHandle, InstanceInit, MeshDesc, MeshHandle, RenderModule, ShadowCaster, ShadowView, TankSurface } from '../../contracts';
import { OBJECT_ID_VEIL, SHADOW_DEPTH } from '../../contracts';
import { BindGroupResourceCache } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { GpuSliceArena, type GpuSlice } from '../../gpu/slice-arena';
import { partBasicWgsl } from '../../materials/part-basic.wgsl';
import { TANK_SURFACE_WGSL } from '../../materials/tank-surface.wgsl';
import { createTankReliefTextures } from '../../materials/tank-relief-textures';
import { paintTextureMips } from '../../materials/paint-texture';
import { terrainLayersWgsl } from '../../materials/terrain/layers';
import type {} from '../../materials/workshop-textures';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { shadowViewWgsl } from '../../wgsl/common/shadow-view.wgsl';
import { link, makeModule } from '../../wgsl/module';
import { GBUFFER_COLOR_TARGETS, GBUFFER_DEPTH_STENCIL } from './gbuffer';
import { INSTANCE_BYTES, InstanceTable, packMeshData, packTankSurface, tankSurfaceMarks, type DrawLists } from './part-mesh-data';

export const meshCommonWgsl = makeModule('part-mesh', /* wgsl */ `
struct Instance {
  model: mat4x4f,
  prev_model: mat4x4f,
  tint: vec4f,
  ids: vec4u,              // objectId, flags, classId, veil bit 0 | presence (0…255) << 8
}

@group(1) @binding(0) var<storage, read> mesh_data: array<u32>;
@group(1) @binding(1) var mesh_paint: texture_2d<f32>;
@group(1) @binding(2) var mesh_paint_sampler: sampler;
@group(2) @binding(0) var<storage, read> instances: array<Instance>;
@group(2) @binding(1) var<storage, read> draw_list: array<vec2u>;

const NO_STREAM: u32 = 0xFFFFFFFFu;

fn mesh_f3(offset: u32, i: u32) -> vec3f {
  let b = offset + i * 3u;
  return vec3f(bitcast<f32>(mesh_data[b]), bitcast<f32>(mesh_data[b + 1u]), bitcast<f32>(mesh_data[b + 2u]));
}
fn mesh_attrs(vi: u32) -> u32 {
  let off = mesh_data[5];
  if (off == NO_STREAM) { return mesh_data[8]; }
  return mesh_data[off + vi];
}
fn mesh_axis(vi: u32) -> u32 {
  let off = mesh_data[4];
  if (off == NO_STREAM) { return 0u; }
  return mesh_data[off + vi];
}
/** The repeated sub-part transform (row-major 3×4 affine) as a mat4, or identity. */
fn mesh_sub(sub: u32) -> mat4x4f {
  if (mesh_data[7] == 0u) { return mat4x4f(vec4f(1.0, 0.0, 0.0, 0.0), vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0, 0.0, 1.0, 0.0), vec4f(0.0, 0.0, 0.0, 1.0)); }
  let b = mesh_data[6] + sub * 12u;
  var r: array<f32, 12>;
  for (var k = 0u; k < 12u; k++) { r[k] = bitcast<f32>(mesh_data[b + k]); }
  return mat4x4f(vec4f(r[0], r[4], r[8], 0.0), vec4f(r[1], r[5], r[9], 0.0), vec4f(r[2], r[6], r[10], 0.0), vec4f(r[3], r[7], r[11], 1.0));
}
/** Inverse-transpose up to scale (cofactor), sign-corrected for mirrored transforms. */
fn normal_transform(m: mat4x4f, n: vec3f) -> vec3f {
  let c0 = m[0].xyz; let c1 = m[1].xyz; let c2 = m[2].xyz;
  let cof = mat3x3f(cross(c1, c2), cross(c2, c0), cross(c0, c1));
  let det = dot(c0, cross(c1, c2));
  return normalize(cof * n) * select(1.0, -1.0, det < 0.0);
}
`);

const gbufferShader = makeModule('part-mesh-gbuffer', /* wgsl */ `
${TANK_SURFACE_WGSL}
override WORKSHOP_SPECULAR_AA: bool = false;
@group(3) @binding(0) var rubble_albedo: texture_2d_array<f32>;
@group(3) @binding(1) var rubble_surface: texture_2d_array<f32>;
@group(3) @binding(2) var rubble_sampler: sampler;
@group(3) @binding(3) var authored_orm: texture_2d_array<f32>;
@group(3) @binding(4) var gauge_face: texture_2d<f32>;
@group(3) @binding(5) var workshop_surfaces: texture_2d_array<f32>;
@group(3) @binding(6) var tank_height: texture_2d<f32>;
@group(3) @binding(7) var tank_normal: texture_2d<f32>;
@group(3) @binding(8) var tank_relief_sampler: sampler;

struct WorkshopPlane { color: vec3f, slope: vec2f }
fn workshop_height(color: vec3f) -> f32 { return dot(color, vec3f(0.2126, 0.7152, 0.0722)); }
fn workshop_plane(uv: vec2f, gx: vec2f, gy: vec2f, layer: i32) -> WorkshopPlane {
  var plane: WorkshopPlane;
  plane.color = textureSampleGrad(workshop_surfaces, rubble_sampler, uv, layer, gx, gy).rgb;
  // Central finite differences of the authored pores/scratches. The sample footprint follows the mip
  // footprint, so distant grain converges smoothly instead of flickering at sub-pixel frequency.
  let texel = 2.0 / vec2f(textureDimensions(workshop_surfaces));
  let step = max(texel, abs(gx) + abs(gy));
  let left = workshop_height(textureSampleGrad(workshop_surfaces, rubble_sampler, uv - vec2f(step.x, 0.0), layer, gx, gy).rgb);
  let right = workshop_height(textureSampleGrad(workshop_surfaces, rubble_sampler, uv + vec2f(step.x, 0.0), layer, gx, gy).rgb);
  let bottom = workshop_height(textureSampleGrad(workshop_surfaces, rubble_sampler, uv - vec2f(0.0, step.y), layer, gx, gy).rgb);
  let top = workshop_height(textureSampleGrad(workshop_surfaces, rubble_sampler, uv + vec2f(0.0, step.y), layer, gx, gy).rgb);
  plane.slope = vec2f(right - left, top - bottom) / (step * 2.0);
  return plane;
}
struct WorkshopSurface { color: vec3f, gradient: vec3f }
fn workshop_surface(p: vec3f, n: vec3f, gx: vec3f, gy: vec3f, layer: i32, scale: f32) -> WorkshopSurface {
  let w0 = pow(abs(n), vec3f(6.0));
  let initial_weights = w0 / max(dot(w0, vec3f(1.0)), 1e-6);
  let active_weights = select(vec3f(0.0), initial_weights, initial_weights > vec3f(0.005));
  let w = active_weights / max(dot(active_weights, vec3f(1.0)), 1e-6);
  var a = WorkshopPlane(vec3f(0.0), vec2f(0.0));
  var b = WorkshopPlane(vec3f(0.0), vec2f(0.0));
  var c = WorkshopPlane(vec3f(0.0), vec2f(0.0));
  // Flat floors and walls only need one projection. Explicit gradients remain valid inside these branches.
  if (w.x > 0.0) { a = workshop_plane(p.zy * scale, gx.zy * scale, gy.zy * scale, layer); }
  if (w.y > 0.0) { b = workshop_plane(p.xz * scale, gx.xz * scale, gy.xz * scale, layer); }
  if (w.z > 0.0) { c = workshop_plane(p.xy * scale, gx.xy * scale, gy.xy * scale, layer); }
  var surface: WorkshopSurface;
  surface.color = a.color * w.x + b.color * w.y + c.color * w.z;
  surface.gradient = (vec3f(0.0, a.slope.y, a.slope.x) * w.x
    + vec3f(b.slope.x, 0.0, b.slope.y) * w.y + vec3f(c.slope.x, c.slope.y, 0.0) * w.z) * scale;
  return surface;
}
struct PartOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) part_local: vec3f,
  @location(3) @interpolate(flat) attrs: u32,
  @location(4) @interpolate(flat) instance: u32,
  @location(5) clip_nojitter: vec4f,
  @location(6) clip_prev: vec4f,
  @location(7) local_position: vec3f,
  @location(8) local_normal: vec3f,
  @location(9) paint_uv: vec2f,
}

@vertex
fn vs_part(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PartOut {
  let entry = draw_list[ii];
  let inst = instances[entry.x];
  let sub = mesh_sub(entry.y);
  let model = inst.model * sub;
  let prev_model = inst.prev_model * sub;
  let p = vec4f(mesh_f3(mesh_data[1], vi), 1.0);
  let world = model * p;
  var out: PartOut;
  out.position = frame.view_proj * world;
  out.world = world.xyz;
  out.normal = normal_transform(model, mesh_f3(mesh_data[2], vi));
  out.part_local = mesh_f3(mesh_data[3], vi);
  out.local_position = p.xyz;
  out.local_normal = mesh_f3(mesh_data[2], vi);
  out.paint_uv = vec2f(0.0);
  if (mesh_data[11] != 0u) { let uv = mesh_data[11] + vi * 2u; out.paint_uv = vec2f(bitcast<f32>(mesh_data[uv]), bitcast<f32>(mesh_data[uv + 1u])); }
  out.attrs = mesh_attrs(vi);
  out.instance = entry.x;
  out.clip_nojitter = frame.view_proj_nojitter * world;
  out.clip_prev = frame.prev_view_proj * (prev_model * p);
  return out;
}

@fragment
fn fs_part(in: PartOut, @builtin(front_facing) front: bool) -> GBufferOut {
  // Display-pixel footprints: below native render scale the temporal upscaler rebuilds display-resolution detail.
  let lod = min(frame_render_scale(), 1.0);
  let dx = dpdx(in.world) * lod;
  let dy = dpdy(in.world) * lod;
  let local_dx = dpdx(in.part_local) * lod;
  let local_dy = dpdy(in.part_local) * lod;
  let rigid_dx = dpdx(in.local_position) * lod;
  let rigid_dy = dpdy(in.local_position) * lod;
  let paint_dx = dpdx(in.paint_uv) * lod;
  let paint_dy = dpdy(in.paint_uv) * lod;
  // Pixel-footprint variance broadens highlights on fine curved screws and machined edges.
  // Derivatives are evaluated before material branches/discards; the pipeline opts interiors in.
  let normal_dx = dpdx(normalize(in.normal)) * lod;
  let normal_dy = dpdy(normalize(in.normal)) * lod;
  let geometric_variance = dot(normal_dx, normal_dx) + dot(normal_dy, normal_dy);
  let inst = instances[in.instance];
  // A sim-gated enemy dissolves in and out with a dithered discard (TAA smooths it). The fog of war never clips a
  // drawn tank: the parts no team sensor can see are veiled in lighting (OBJECT_ID_VEIL).
  let presence = f32((inst.ids.w >> 8u) & 0xffu) / 255.0;
  if (presence < 1.0) {
    let noise = fract(52.9829189 * fract(0.06711056 * in.position.x + 0.00583715 * in.position.y) + 0.61803399 * f32(frame_index() % 16u));
    if (noise >= presence) { discard; }
  }
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  var ng = cross(dy, dx);
  let ngl = length(ng);
  ng = select(n, ng / max(ngl, 1e-20), ngl > 1e-20);
  if (dot(ng, n) < 0.0) { ng = -ng; }
  var s = part_basic_surface(part_attr_mat(in.attrs), inst.tint.rgb, in.attrs);
  // Imported workshop materials 9..12 carry baked linear albedo in partLocal rather than rest coordinates.
  // Keep every existing kit/terrain material's interpretation of this stream unchanged.
  if (part_attr_mat(in.attrs) >= 9u && part_attr_mat(in.attrs) <= 12u) {
    s.base_color *= clamp(in.part_local, vec3f(0.0), vec3f(1.0));
  }
  s.n_shading = n;
  s.n_geom = ng;
  if (mesh_data[9] != 0u) {
    let footprint = max(length(local_dx), length(local_dy));
    var relief=TankRelief(vec4f(1.0,0.0,0.0,0.49),n);
    if (part_attr_mat(in.attrs) == 0u) {
      relief=tank_relief(in.part_local,local_dx,local_dy,dx,dy,n,normalize(frame.eye_pos-in.world),footprint,tank_float(mesh_data[9]+11u));
    }
    s.n_shading=relief.normal;
    var paint = vec4f(0.0);
    if (mesh_data[11] != 0u) { paint = textureSampleGrad(mesh_paint, mesh_paint_sampler, in.paint_uv, paint_dx, paint_dy); }
    s = tank_surface(s, in.part_local, in.local_position, normalize(in.local_normal), rigid_dx,rigid_dy,dx,dy,normalize(frame.eye_pos-in.world), in.attrs, footprint,relief.mask,paint);
  }
  if (part_attr_mat(in.attrs) == 13u) {
    // Authored PBR. partLocal is (u, 1-v, layer); source maps remain in the asset archive.
    let uv = in.part_local.xy;
    let layer = i32(clamp(in.part_local.z, 0.0, f32(textureNumLayers(rubble_albedo) - 1u)) + 0.5);
    let albedo = textureSampleGrad(rubble_albedo, rubble_sampler, uv, layer, local_dx.xy, local_dy.xy);
    let normal_map = textureSampleGrad(rubble_surface, rubble_sampler, uv, layer, local_dx.xy, local_dy.xy).xyz * 2.0 - 1.0;
    let orm = textureSampleGrad(authored_orm, rubble_sampler, uv, layer, local_dx.xy, local_dy.xy).rgb;
    s.base_color = albedo.rgb * inst.tint.rgb;
    // glTF metallicRoughness leaves red unspecified; these originals have no occlusionTexture.
    // Keep the authored vertex AO, then let interior AO/contact shadows provide the room occlusion.
    s.roughness = clamp(orm.g, 0.045, 1.0); s.metalness = clamp(orm.b, 0.0, 1.0);
    if (WORKSHOP_SPECULAR_AA) {
      // Averaged tangent normals lose length at distant mips: retain their unresolved variance
      // in the specular lobe instead of renormalizing it into a flickering polished surface.
      let variance = min(max(1.0 - length(normal_map), 0.0) * 0.18, 0.06);
      s.roughness = pow(min(pow(s.roughness, 4.0) + variance, 1.0), 0.25);
    }
    let determinant = local_dx.x * local_dy.y - local_dx.y * local_dy.x;
    if (abs(determinant) > 1e-10) {
      let orientation = select(-1.0, 1.0, determinant > 0.0);
      let tangent0 = (dx * local_dy.y - dy * local_dx.y) * orientation;
      let bitangent0 = (dy * local_dx.x - dx * local_dy.x) * orientation;
      let tangent = normalize(tangent0 - n * dot(n, tangent0));
      let bitangent = normalize(bitangent0 - n * dot(n, bitangent0));
      // Export flips UV V to bitmap row order; invert the original OpenGL normal map's green axis once.
      s.n_shading = normalize(tangent * normal_map.x - bitangent * normal_map.y + n * normal_map.z);
    }
  }
  if (part_attr_mat(in.attrs) == 14u) {
    s.base_color = textureSampleGrad(gauge_face, rubble_sampler, in.part_local.xy, local_dx.xy, local_dy.xy).rgb * inst.tint.rgb;
  }
  let material_id = part_attr_mat(in.attrs);
  if (material_id >= 15u && material_id <= 19u) {
    let layer = i32(material_id - 15u);
    var scale = 1.6666667;
    var depth = 0.0018;
    if (material_id == 15u) { scale = 2.5; depth = 0.002; }
    if (material_id == 16u) { scale = 0.6666667; depth = 0.003; }
    var coordinate = in.world;
    var coordinate_n = n;
    var coordinate_dx = dx;
    var coordinate_dy = dy;
    var rotation = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0));
    if (material_id >= 18u) {
      // Painted robot links, piston bodies and brass fittings retain their rest-space texture while
      // their parent pivots. Column lengths keep texel density correct on scaled CAD primitives.
      let dimensions = vec3f(length(inst.model[0].xyz), length(inst.model[1].xyz), length(inst.model[2].xyz));
      rotation = mat3x3f(inst.model[0].xyz / max(dimensions.x, 1e-8), inst.model[1].xyz / max(dimensions.y, 1e-8), inst.model[2].xyz / max(dimensions.z, 1e-8));
      coordinate = in.part_local * dimensions;
      coordinate_n = transpose(rotation) * n;
      coordinate_dx = local_dx * dimensions;
      coordinate_dy = local_dy * dimensions;
      depth = select(0.0006, 0.00025, material_id == 19u);
    }
    let detail = workshop_surface(coordinate, coordinate_n, coordinate_dx, coordinate_dy, layer, scale);
    // A second physical scale retains shallow cast-metal/masonry variation from the normal workshop
    // orbit distance; the original fine pits/scratches still resolve during close inspection.
    let broad = workshop_surface(coordinate + vec3f(0.17, 0.29, 0.41), coordinate_n, coordinate_dx, coordinate_dy, layer, scale * 0.25);
    let gradient = rotation * (detail.gradient + broad.gradient * 3.5) * depth;
    s.n_shading = normalize(n - (gradient - n * dot(gradient, n)));
    s.base_color = detail.color;
    let height = workshop_height(detail.color);
    if (material_id <= 17u) {
      s.base_color *= clamp(in.part_local, vec3f(0.0), vec3f(1.0)) * inst.tint.rgb;
      s.roughness = clamp(0.98 - height * 0.09, 0.9, 0.99);
      s.metalness = 0.0;
    } else if (material_id == 18u) {
      // Tiny desaturated chips expose steel; the paint itself stays dielectric.
      let saturation = max(detail.color.r, max(detail.color.g, detail.color.b)) - min(detail.color.r, min(detail.color.g, detail.color.b));
      let chip = 1.0 - smoothstep(0.012, 0.033, saturation);
      s.base_color *= vec3f(0.60, 0.74, 0.80);
      s.metalness = chip * 0.72;
      s.roughness = clamp(0.60 - height * 0.45 + chip * 0.16, 0.44, 0.74);
      s.param = 0.04;
    } else {
      let polish = smoothstep(0.28, 0.8, part_attr_edge(in.attrs));
      s.base_color *= vec3f(0.70, 0.76, 0.88);
      s.base_color = mix(s.base_color, vec3f(0.52, 0.37, 0.18), polish * 0.05);
      s.metalness = 0.84;
      s.roughness = clamp(0.68 - height * 0.5 - polish * 0.05, 0.44, 0.65);
      s.param = 0.0;
    }
  }
  if (part_attr_mat(in.attrs) == 8u) {
    // The exact terrain bake, sampled in the shard's original rest coordinates.
    // Textures travel with the fragment instead of sliding through it.
    let rotation = mat3x3f(inst.model[0].xyz, inst.model[1].xyz, inst.model[2].xyz);
    let local_n = normalize(transpose(rotation) * n);
    let weights0 = pow(abs(local_n), vec3f(4.0));
    let weights = weights0 / max(dot(weights0, vec3f(1.0)), 1e-6);
    let layer = i32(min(part_attr_flags(in.attrs), 5u));
    let scale = terrain_layer_scale(layer);
    let p = in.part_local * scale; let gx = local_dx * scale; let gy = local_dy * scale;
    let ax = textureSampleGrad(rubble_albedo, rubble_sampler, p.zy, layer, gx.zy, gy.zy).rgb;
    let ay = textureSampleGrad(rubble_albedo, rubble_sampler, p.xz, layer, gx.xz, gy.xz).rgb;
    let az = textureSampleGrad(rubble_albedo, rubble_sampler, p.xy, layer, gx.xy, gy.xy).rgb;
    let sx = textureSampleGrad(rubble_surface, rubble_sampler, p.zy, layer, gx.zy, gy.zy);
    let sy = textureSampleGrad(rubble_surface, rubble_sampler, p.xz, layer, gx.xz, gy.xz);
    let sz = textureSampleGrad(rubble_surface, rubble_sampler, p.xy, layer, gx.xy, gy.xy);
    s.base_color = ax * weights.x + ay * weights.y + az * weights.z;
    s.roughness = dot(vec3f(sx.z, sy.z, sz.z), weights);
    let bump = vec3f(0.0, sx.g * 2.0 - 1.0, sx.r * 2.0 - 1.0) * weights.x
      + vec3f(sy.r * 2.0 - 1.0, 0.0, sy.g * 2.0 - 1.0) * weights.y
      + vec3f(sz.r * 2.0 - 1.0, sz.g * 2.0 - 1.0, 0.0) * weights.z;
    s.n_shading = normalize(rotation * normalize(local_n + bump * 0.55));
  }
  if (WORKSHOP_SPECULAR_AA) {
    s.roughness = pow(min(pow(s.roughness, 4.0) + min(geometric_variance * 0.3, 0.12), 1.0), 0.25);
  }
  s.object_id = (inst.ids.x & ${OBJECT_ID_VEIL - 1}u) | select(0u, ${OBJECT_ID_VEIL}u, (inst.ids.w & 1u) != 0u);
  s.flags = inst.ids.y;
  s.class_id = inst.ids.z;
  return gbuffer_pack(s, gbuffer_velocity(in.clip_nojitter, in.clip_prev));
}
`, [frameWgsl, gbufferWgsl, partBasicWgsl, meshCommonWgsl, terrainLayersWgsl]);

const depthShader = makeModule('part-mesh-depth', /* wgsl */ `
struct PartDepthOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) instance: u32,
}
@vertex
fn vs_part_depth(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PartDepthOut {
  let entry = draw_list[ii];
  let model = instances[entry.x].model * mesh_sub(entry.y);
  let world = model * vec4f(mesh_f3(mesh_data[1], vi), 1.0);
  var out: PartDepthOut;
  out.position = shadow_view.view_proj * world;
  out.world = world.xyz;
  out.instance = entry.x;
  return out;
}
`, [shadowViewWgsl, meshCommonWgsl]);

export function partMeshGbufferShader() { return link(gbufferShader); }
export function partMeshDepthShader() { return link(depthShader); }

interface GpuMesh {
  handle: MeshHandle;
  vertex: GpuSlice | GPUBuffer;
  index: GpuSlice | GPUBuffer;
  vertexBytes: number;
  indexBytes: number;
  subCount: number;
  bindGroup: GPUBindGroup;
  /** Where the vertex words and the index range live (resolved once: drawn every frame). */
  words: { buffer: GPUBuffer; offset: number; size: number };
  indices: { buffer: GPUBuffer; offset: number; size: number };
  /** Word offset of the tank surface block (0: none) and how many marks fit in the room allocated for it. */
  surfaceWord: number;
  markRoom: number;
  paintTexture?: GPUTexture;
}

function sliceParts(r: GpuSlice | GPUBuffer, bytes: number): { buffer: GPUBuffer; offset: number; size: number } {
  return 'offset' in r && 'reserved' in r ? { buffer: r.buffer, offset: r.offset, size: r.size } : { buffer: r as GPUBuffer, offset: 0, size: bytes };
}

export interface PartMeshSystem {
  readonly table: InstanceTable;
  readonly meshCount: number;
  setTint(h: InstanceHandle, tint: [number, number, number]): void;
}

/** Part-mesh operations beyond SceneRegistry.meshes / instances (scene facet `partMeshes`). */
export interface PartMeshFacet {
  /** `scene.meshes.create`, with room for `extraMarks` more tank-surface marks than the description carries. */
  create(desc: MeshDesc, extraMarks: number): MeshHandle;
  /**
   * Rewrite a mesh's tank surface (palette and marks) in place: the words a new mesh with this surface would hold.
   * False when the mesh has no surface block or the marks outgrow its room.
   */
  updateSurface(h: MeshHandle, surface: TankSurface): boolean;
  /** The instance's next drawn frame starts its motion history afresh (prevModel = model), as a new instance's does. */
  restart(h: InstanceHandle): void;
}
declare module '../../contracts' { interface SceneFacets { partMeshes: PartMeshFacet } }


export function partMeshModule(onReady?: (system: PartMeshSystem) => void): RenderModule {
  const disposers: (() => void)[] = [];
  let services: EngineServices | null = null;
  let vertexArena: GpuSliceArena | null = null;
  let indexArena: GpuSliceArena | null = null;
  const meshes = new Map<number, GpuMesh>();
  return {
    name: 'part-mesh',
    install(s) {
      services = s;
      const { device, queue } = s.ctx;
      const cache = s.ctx.pipelines;
      const scene = s.scene as import('../../scene/scene-registry').Scene;
      const table = new InstanceTable(64);
      const destroyBuffer = (b: GPUBuffer) => s.ctx.deferDestroy(b);
      vertexArena = new GpuSliceArena(device, { label: 'mesh:vertex', usage: BufferUsage.STORAGE | BufferUsage.COPY_DST, chunkBytes: 8 << 20, maxSliceBytes: 2 << 20, tick: () => s.ctx.tickIndex, destroyBuffer, zeroOnAlloc: false });
      indexArena = new GpuSliceArena(device, { label: 'mesh:index', usage: BufferUsage.INDEX | BufferUsage.COPY_DST, chunkBytes: 4 << 20, maxSliceBytes: 1 << 20, tick: () => s.ctx.tickIndex, destroyBuffer, zeroOnAlloc: false });

      const meshLayout = device.createBindGroupLayout({ label: 'layout:part-mesh', entries: [
        { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
        { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ] });
      const emptyPaint = device.createTexture({ label: 'mesh:empty-paint', size: [1, 1], format: 'rgba8unorm-srgb', usage: TextureUsage.TEXTURE_BINDING });
      const emptyPaintView = emptyPaint.createView();
      const paintSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      disposers.push(() => s.ctx.deferDestroy(emptyPaint));
      const instLayout = device.createBindGroupLayout({
        label: 'layout:part-instances',
        entries: [
          { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      const gbufferKey = 'part-mesh:gbuffer', depthKey = 'part-mesh:depth';
      const textureLayout = device.createBindGroupLayout({ label: 'layout:part-terrain-textures', entries: [
        { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 4, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
        { binding: 5, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 6, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
        { binding: 7, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
        { binding: 8, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ] });
      let textureGroup: GPUBindGroup | undefined;
      let textureSource: unknown;
      // Generic mesh-only sandboxes need a valid unused binding too.
      const fallbackTexture = device.createTexture({ label: 'mesh:unused-terrain', size: [1, 1, 6], format: 'rgba8unorm', usage: TextureUsage.TEXTURE_BINDING });
      const fallbackView = fallbackTexture.createView({ dimension: '2d-array' });
      const fallbackGaugeView = fallbackTexture.createView({ dimension: '2d', baseArrayLayer: 0, arrayLayerCount: 1 });
      const fallbackSampler = device.createSampler();
      const tankRelief = createTankReliefTextures(device, queue);
      disposers.push(() => { for (const texture of tankRelief.textures) s.ctx.deferDestroy(texture); });
      disposers.push(() => s.ctx.deferDestroy(fallbackTexture));
      cache.register(gbufferKey, 'render', () => {
        const module = cache.shaderModule(partMeshGbufferShader(), gbufferKey);
        return {
          label: gbufferKey, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, meshLayout, instLayout, textureLayout] }),
          vertex: { module, entryPoint: 'vs_part' },
          fragment: { module, entryPoint: 'fs_part', targets: GBUFFER_COLOR_TARGETS, constants: { WORKSHOP_SPECULAR_AA: s.scene.get('interior') ? 1 : 0 } },
          primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
          depthStencil: GBUFFER_DEPTH_STENCIL,
        };
      });
      cache.register(depthKey, 'render', () => ({
        label: depthKey, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.shadowView, meshLayout, instLayout] }),
        vertex: { module: cache.shaderModule(partMeshDepthShader(), depthKey), entryPoint: 'vs_part_depth' },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        // Reversed-Z shadow maps: the bias pushes casters AWAY from the light, i.e. toward smaller depth (plan §4.8: 2 / 1.0).
        depthStencil: { format: SHADOW_DEPTH.format, depthWriteEnabled: true, depthCompare: SHADOW_DEPTH.compare, depthBias: -2, depthBiasSlopeScale: -1.0 },
      }));
      void cache.compile(gbufferKey).catch(() => undefined);
      void cache.compile(depthKey).catch(() => undefined);

      let nextMeshId = 1;
      let instanceBuffer: GPUBuffer | null = null;
      let instanceCapacity = 0;
      const lists: { gbuffer: DrawLists; shadow: DrawLists; gbufferBuf: GPUBuffer | null; shadowBuf: GPUBuffer | null; gbufferCap: number; shadowCap: number } =
        { gbuffer: { entries: new Uint32Array(2), draws: [] }, shadow: { entries: new Uint32Array(2), draws: [] }, gbufferBuf: null, shadowBuf: null, gbufferCap: 0, shadowCap: 0 };
      // Only sun-shadow map passes draw the shadow list (and none once the SDF is valid): it is built when one asks.
      let shadowListStale = true;
      const gbufferGroups = new BindGroupResourceCache();
      const shadowGroups = new BindGroupResourceCache();
      const subCounts = new Map<number, number>();

      const createMesh = (desc: MeshDesc, extraMarks = 0): MeshHandle => {
        const packed = packMeshData(desc);
        const id = nextMeshId++;
        const surfaceWord = packed.words[9], room = surfaceWord ? Math.max(0, Math.min(extraMarks, 216 - packed.words[10])) : 0;
        const vertexBytes = packed.words.byteLength + room * 64;
        const indexBytes = desc.indices.byteLength;
        const vertex = vertexArena!.alloc(vertexBytes) ?? device.createBuffer({ label: `mesh:vertex-${desc.label ?? id}`, size: vertexBytes, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
        const index = indexArena!.alloc(indexBytes) ?? device.createBuffer({ label: `mesh:index-${desc.label ?? id}`, size: indexBytes, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
        const v = sliceParts(vertex, vertexBytes), ix = sliceParts(index, indexBytes);
        queue.writeBuffer(v.buffer, v.offset, packed.words.buffer, packed.words.byteOffset, packed.words.byteLength);
        queue.writeBuffer(ix.buffer, ix.offset, desc.indices.buffer, desc.indices.byteOffset, indexBytes);
        const handle: MeshHandle = Object.freeze({ id, vertexCount: packed.vertexCount, indexCount: packed.indexCount, bounds: packed.bounds });
        let paintTexture: GPUTexture | undefined;
        if (desc.paintTexture) {
          const levels = paintTextureMips(desc.paintTexture.width, desc.paintTexture.height, desc.paintTexture.pixels);
          paintTexture = device.createTexture({ label: `mesh:paint-${desc.label ?? id}`, size: [desc.paintTexture.width, desc.paintTexture.height], mipLevelCount: levels.length,
            format: 'rgba8unorm-srgb', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
          levels.forEach((level, mipLevel) => queue.writeTexture({ texture: paintTexture!, mipLevel }, level.pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: level.width * 4 }, [level.width, level.height]));
        }
        const bindGroup = device.createBindGroup({ label: `mesh:${desc.label ?? id}`, layout: meshLayout, entries: [
          { binding: 0, resource: { buffer: v.buffer, offset: v.offset, size: v.size } },
          { binding: 1, resource: paintTexture?.createView() ?? emptyPaintView }, { binding: 2, resource: paintSampler },
        ] });
        meshes.set(id, { handle, vertex, index, vertexBytes, indexBytes, subCount: packed.subCount, bindGroup, words: v, indices: ix,
          surfaceWord, markRoom: packed.words[10] + room, paintTexture });
        subCounts.set(id, packed.subCount);
        return handle;
      };
      const destroyMesh = (h: MeshHandle) => {
        const m = meshes.get(h.id);
        if (!m) return;
        for (const slot of table.slotsOf(h.id)) table.remove(slot);
        for (const [r, arena] of [[m.vertex, vertexArena], [m.index, indexArena]] as const) {
          if ('reserved' in r) arena!.free(r as GpuSlice); else s.ctx.deferDestroy(r as GPUBuffer);
        }
        meshes.delete(h.id);
        if (m.paintTexture) s.ctx.deferDestroy(m.paintTexture);
        subCounts.delete(h.id);
      };
      const updateSurface = (h: MeshHandle, surface: TankSurface): boolean => {
        const m = meshes.get(h.id);
        const marks = tankSurfaceMarks(surface);
        if (!m || !m.surfaceWord || marks.length > m.markRoom) return false;
        const block = new Float32Array(16 + marks.length * 16);
        packTankSurface(surface, marks, block, 0);
        queue.writeBuffer(m.words.buffer, m.words.offset + m.surfaceWord * 4, block);
        queue.writeBuffer(m.words.buffer, m.words.offset + 40, Uint32Array.of(marks.length));
        return true;
      };
      const instances = {
        add: (m: MeshHandle, i: InstanceInit): InstanceHandle => {
          if (!meshes.has(m.id)) throw new Error(`instances.add: unknown mesh ${m.id}`);
          return { id: table.add(m.id, i) };
        },
        set: (h: InstanceHandle, model: Float32Array, flags?: number) => table.set(h.id, model, flags),
        remove: (h: InstanceHandle) => table.remove(h.id),
        setVisibility: (h: InstanceHandle, v: number) => table.setVisibility(h.id, v),
      };
      scene.attachMeshes({ create: createMesh, destroy: destroyMesh }, instances);
      s.scene.provide('partMeshes', { create: createMesh, updateSurface, restart: h => table.restart(h.id) });

      const ensureBuffer = (buf: GPUBuffer | null, cap: number, need: number, label: string): [GPUBuffer, number] => {
        if (buf && cap >= need) return [buf, cap];
        if (buf) s.ctx.deferDestroy(buf);
        let n = Math.max(cap, 4096);
        while (n < need) n *= 2;
        return [device.createBuffer({ label, size: n, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST }), n];
      };

      disposers.push(s.graph.addPass({
        name: 'part-mesh.upload', slot: 'upload', order: 10, reads: [], writes: [],
        run: () => {
          table.beginFrame();
          if (table.count === 0) return;
          const previous = instanceBuffer;
          [instanceBuffer, instanceCapacity] = ensureBuffer(instanceBuffer, instanceCapacity, table.highWater * INSTANCE_BYTES, 'mesh:instances');
          // Slots outside the dirty range hold what the buffer already holds; a new buffer holds nothing yet.
          if (instanceBuffer !== previous) table.dataDirty = true;
          if (table.dataDirty) {
            const first = table.dirtyFirst * INSTANCE_BYTES;
            queue.writeBuffer(instanceBuffer, first, table.data.buffer, first, (table.dirtyEnd - table.dirtyFirst) * INSTANCE_BYTES);
            table.dataDirty = false;
          }
          if (table.membershipDirty) {
            lists.gbuffer = table.buildDrawLists(subCounts, false);
            [lists.gbufferBuf, lists.gbufferCap] = ensureBuffer(lists.gbufferBuf, lists.gbufferCap, lists.gbuffer.entries.byteLength, 'mesh:draw-list');
            queue.writeBuffer(lists.gbufferBuf, 0, lists.gbuffer.entries);
            shadowListStale = true;
            table.membershipDirty = false;
          }
        },
      }));

      const instGroup = (cacheG: BindGroupResourceCache, list: GPUBuffer | null): GPUBindGroup | null => {
        if (!instanceBuffer || !list) return null;
        const k = cacheG.begin(); k.push(instanceBuffer, list);
        return cacheG.get(() => device.createBindGroup({ label: 'mesh:instances', layout: instLayout, entries: [
          { binding: 0, resource: { buffer: instanceBuffer! } }, { binding: 1, resource: { buffer: list } }] }));
      };

      // Index slices share arena chunks: a chunk is bound once and each draw starts at its slice (the same indices).
      const drawLists = (pass: GPURenderPassEncoder, dl: DrawLists) => {
        let bound: GPUBuffer | null = null;
        for (const d of dl.draws) {
          const m = meshes.get(d.mesh);
          if (!m || d.count === 0) continue;
          pass.setBindGroup(1, m.bindGroup);
          if (m.indices.buffer !== bound) { bound = m.indices.buffer; pass.setIndexBuffer(bound, 'uint32'); }
          pass.drawIndexed(m.handle.indexCount, d.count, m.indices.offset / 4, 0, d.first);
        }
      };

      const drawer: GBufferDrawer = {
        name: 'part-mesh', slot: 'gbuffer.opaque', order: 100,
        draw(pass) {
          const pipeline = cache.get<GPURenderPipeline>(gbufferKey);
          const group = instGroup(gbufferGroups, lists.gbufferBuf);
          if (!pipeline || !group || table.count === 0) return;
          const authored = scene.get('workshopTextures');
          const terrain = scene.get('terrainTextures');
          const tex = authored ?? terrain;
          if (!textureGroup || textureSource !== tex) {
            textureSource = tex;
            textureGroup = device.createBindGroup({ label: 'mesh:terrain-textures', layout: textureLayout, entries: [
              { binding: 0, resource: tex?.albedoView ?? fallbackView },
              { binding: 1, resource: authored?.normalView ?? terrain?.surfaceView ?? fallbackView },
              { binding: 2, resource: tex?.sampler ?? fallbackSampler }, { binding: 3, resource: authored?.ormView ?? fallbackView },
              { binding: 4, resource: authored?.gaugeView ?? fallbackGaugeView },
              { binding: 5, resource: authored?.surfaceView ?? fallbackView },
              { binding: 6, resource: tankRelief.heightView },
              { binding: 7, resource: tankRelief.normalView },
              { binding: 8, resource: tankRelief.sampler },
            ] });
          }
          pass.setPipeline(pipeline);
          pass.setBindGroup(2, group);
          pass.setBindGroup(3, textureGroup);
          drawLists(pass, lists.gbuffer);
        },
      };
      const caster: ShadowCaster = {
        name: 'part-mesh', dynamic: true,
        drawDepth(pass: GPURenderPassEncoder, v: ShadowView) {
          const pipeline = cache.get<GPURenderPipeline>(depthKey);
          if (!pipeline || table.count === 0) return;
          if (shadowListStale) {
            lists.shadow = table.buildDrawLists(subCounts, true);
            [lists.shadowBuf, lists.shadowCap] = ensureBuffer(lists.shadowBuf, lists.shadowCap, lists.shadow.entries.byteLength, 'mesh:shadow-list');
            queue.writeBuffer(lists.shadowBuf, 0, lists.shadow.entries);
            shadowListStale = false;
          }
          const group = instGroup(shadowGroups, lists.shadowBuf);
          if (!group) return;
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, v.bindGroup);
          pass.setBindGroup(2, group);
          drawLists(pass, lists.shadow);
        },
      };
      disposers.push(scene.addGBufferDrawer(drawer));
      disposers.push(scene.addShadowCaster(caster));
      disposers.push(() => {
        if (instanceBuffer) s.ctx.deferDestroy(instanceBuffer);
        if (lists.gbufferBuf) s.ctx.deferDestroy(lists.gbufferBuf);
        if (lists.shadowBuf) s.ctx.deferDestroy(lists.shadowBuf);
      });
      onReady?.({
        table, get meshCount() { return meshes.size; },
        setTint: (h, tint) => table.setTint(h.id, tint),
      });
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      for (const m of [...meshes.values()]) { if (!('reserved' in m.vertex)) services?.ctx.deferDestroy(m.vertex as GPUBuffer); if (!('reserved' in m.index)) services?.ctx.deferDestroy(m.index as GPUBuffer); if (m.paintTexture) services?.ctx.deferDestroy(m.paintTexture); }
      meshes.clear();
      vertexArena?.destroy(); indexArena?.destroy();
    },
  };
}
