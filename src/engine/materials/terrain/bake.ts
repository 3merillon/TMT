/*!
 * The layer recipes adapt the periodic modular Worley/domain-warp ideas of looptile.
 * MIT License — Copyright (c) 2026 3merillon (full text in src/engine/wgsl/common/noise.wgsl.ts).
 */
/**
 * Procedural terrain layer bake (raw WebGPU port of the former `procedural-material*.ts`, now in src/lab/legacy/): two
 * rgba8unorm 512² × 6 texture arrays, baked ONCE per engine (the recipes do not depend on the planet seed):
 *   albedo  = linear base colour, a = 1
 *   surface = tangent normal xy (×0.5 + 0.5), roughness, height
 * Pass 1 writes albedo + a temporary rgba16float relief (half float avoids stair-stepped finite-difference normals);
 * pass 2 derives the normals from the relief with wrap-around differences (tiles stay seamless); then the W0 compute
 * mip generator fills both chains. One encoder, one submit, outside the frame (a load-time bake, not per-frame work).
 * Sampled with anisotropy 8 and repeat addressing.
 */
import type { GpuContext } from '../../contracts';
import { ShaderStage, TextureUsage } from '../../gpu/flags';
import { MipGenerator } from '../../gpu/mip-gen';
import { tileNoiseWgsl } from '../../wgsl/common/noise.wgsl';
import { link, makeModule } from '../../wgsl/module';
import { TERRAIN_BAKE_MIPS, TERRAIN_BAKE_SIZE, TERRAIN_LAYER_COUNT, terrainLayersWgsl } from './layers';


const bakeMaterialsWgsl = makeModule('terrain-bake-materials', /* wgsl */ `
@group(0) @binding(0) var albedo_out: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(1) var relief_out: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn bake_materials(@builtin(global_invocation_id) gid: vec3u) {
  let size = TERRAIN_BAKE_SIZE;
  let layer = gid.z;
  if (gid.x >= size || gid.y >= size || layer >= TERRAIN_LAYER_COUNT) { return; }
  let pixel = gid.xy;
  let uv = (vec2f(pixel) + vec2f(0.5)) / f32(size);
  let seed = 137u + layer * 971u;
  let warp = vec2f(tile_fbm(uv, 4, seed), tile_fbm(uv, 4, seed + 51u)) - vec2f(0.5);
  let p = uv + warp * 0.13;
  let broad = tile_fbm(p, 4, seed + 20u);
  let fine = tile_fbm(p, 16, seed + 70u);
  let grit = tile_noise(uv, 192, seed + 300u);
  var color = vec3f(0.3);
  var rough = 0.85;
  var height = 0.5;

  if (layer == 0u) {
    // Sparse, interrupted fractures over broad eroded rock: no regular paving pattern.
    let cell = tile_worley(p, 9, seed);
    let plate_edge = cell.y - cell.x;
    let fracture_gate = smoothstep(0.30, 0.56, tile_noise(p, 5, seed + 9u));
    let fracture = (1.0 - smoothstep(0.023, 0.105, plate_edge)) * fracture_gate;
    let crease = (1.0 - smoothstep(0.035, 0.24, plate_edge)) * fracture_gate;
    let weathered_plate = smoothstep(0.04, 0.35, plate_edge);
    let ridge = 1.0 - abs(2.0 * tile_noise(p, 11, seed + 201u) - 1.0);
    let facets = smoothstep(0.24, 0.76, tile_noise(p, 24, seed + 80u));
    let chips = 1.0 - abs(2.0 * tile_noise(p, 47, seed + 181u) - 1.0);
    let chip_mask = smoothstep(0.40, 0.69, fine);
    let moisture = smoothstep(0.33, 0.68, tile_fbm(p, 3, seed + 42u));
    let depression = crease * 0.75 + (1.0 - ridge) * 0.16 + (1.0 - broad) * 0.15;
    let moss = smoothstep(0.25, 0.65, depression) * moisture;
    height = 0.25 + broad * 0.26 + ridge * 0.18 + facets * 0.16
      + (chips - 0.5) * chip_mask * 0.12 + (fine - 0.5) * 0.11
      + (grit - 0.5) * 0.038 - fracture * 0.34 + moss * 0.020;
    let mineral = clamp(broad * 0.66 + weathered_plate * 0.18 + ridge * 0.16, 0.0, 1.0);
    color = mix(vec3f(0.150, 0.161, 0.143), vec3f(0.290, 0.300, 0.269), mineral);
    color = mix(color, vec3f(0.120, 0.145, 0.076), moss * 0.56);
    let deposit = (1.0 - smoothstep(0.012, 0.061, plate_edge)) * fracture_gate * (0.50 + broad * 0.50);
    color = mix(color, vec3f(0.108, 0.118, 0.096), deposit * 0.43);
    color += vec3f((grit - 0.5) * 0.012);
    rough = clamp(0.82 + (1.0 - ridge) * 0.06 + moss * 0.09 + (grit - 0.5) * 0.015, 0.80, 0.98);
  } else if (layer == 1u) {
    // Integer shear preserves the tile period while bending narrow mineral strata.
    let strata_uv = vec2f(p.x + p.y, p.y);
    let strata = tile_noise(strata_uv * vec2f(1.0, 4.0), 8, seed + 88u);
    let mineral = 1.0 - abs(tile_noise(p, 7, seed + 91u) * 2.0 - 1.0);
    let vein = smoothstep(0.83, 0.96, mineral) * smoothstep(0.33, 0.58, broad);
    let cell = tile_worley(p, 7, seed + 102u);
    let fracture = (1.0 - smoothstep(0.008, 0.05, cell.y - cell.x)) * smoothstep(0.31, 0.62, strata);
    height = 0.28 + broad * 0.32 + strata * 0.20 + (fine - 0.5) * 0.12
      + (grit - 0.5) * 0.025 + vein * 0.05 - fracture * 0.16;
    color = mix(vec3f(0.245, 0.186, 0.125), vec3f(0.400, 0.313, 0.210), broad * 0.55 + strata * 0.30 + fine * 0.15);
    color = mix(color, vec3f(0.420, 0.335, 0.218), vein * 0.45);
    color += vec3f((grit - 0.5) * 0.026);
    rough = 0.77 + fine * 0.15 - vein * 0.065;
  } else if (layer == 3u) {
    let ripples = sin((uv.y * 18.0 + tile_noise(uv, 4, seed) * 0.5) * 6.2831853);
    height = 0.45 + ripples * 0.13 + (fine - 0.5) * 0.12 + (grit - 0.5) * 0.05;
    color = mix(vec3f(0.30, 0.18, 0.075), vec3f(0.52, 0.37, 0.19), broad);
    color += vec3f((grit - 0.5) * 0.04);
    rough = 0.94;
  } else if (layer == 4u) {
    let crystals = tile_worley(uv, 32, seed + 91u);
    height = 0.50 + (broad - 0.5) * 0.22 + (fine - 0.5) * 0.14 - crystals.x * 0.12;
    color = mix(vec3f(0.37, 0.48, 0.54), vec3f(0.64, 0.68, 0.70), broad);
    rough = mix(0.46, 0.86, fine);
  } else if (layer == 5u) {
    let plates = tile_worley(uv, 9, seed + 45u);
    let fissure = 1.0 - smoothstep(0.015, 0.09, plates.y - plates.x);
    height = 0.35 + broad * 0.30 + fine * 0.14 - fissure * 0.27;
    color = mix(vec3f(0.045, 0.049, 0.052), vec3f(0.15, 0.13, 0.11), broad);
    color = mix(color, vec3f(0.08, 0.041, 0.022), fissure * 0.4);
    rough = 0.82 + fine * 0.14;
  } else {
    let aggregate = tile_worley(uv, 76, seed + 73u);
    let pit = (1.0 - smoothstep(0.035, 0.15, aggregate.x)) * smoothstep(0.30, 0.64, tile_noise(uv, 55, seed + 65u));
    let stone = smoothstep(0.27, 0.41, aggregate.x) * smoothstep(0.49, 0.68, fine);
    let board = fract(uv.y * 5.0 + tile_noise(uv, 8, seed + 61u) * 0.006);
    let seam_distance = min(board, 1.0 - board);
    let joint = 1.0 - smoothstep(0.0025, 0.010, seam_distance);
    let grain = tile_noise(uv * vec2f(1.0, 8.0), 16, seed + 81u);
    height = 0.47 + (broad - 0.5) * 0.10 + (fine - 0.5) * 0.16
      + (grit - 0.5) * 0.055 + (grain - 0.5) * 0.025 + stone * 0.05 - pit * 0.22 - joint * 0.12;
    color = mix(vec3f(0.245, 0.261, 0.253), vec3f(0.360, 0.374, 0.363), smoothstep(0.30, 0.70, broad * 0.45 + fine * 0.55));
    color = mix(color, vec3f(0.170, 0.187, 0.179), stone * 0.44);
    color = mix(color, vec3f(0.153, 0.168, 0.160), pit * 0.48);
    color = mix(color, vec3f(0.186, 0.201, 0.191), joint * 0.30);
    color += vec3f((grit - 0.5) * 0.035);
    rough = clamp(0.79 + fine * 0.12 + pit * 0.04, 0.77, 0.97);
  }
  textureStore(albedo_out, vec2i(pixel), i32(layer), vec4f(clamp(color, vec3f(0.03), vec3f(0.7)), 1.0));
  textureStore(relief_out, vec2i(pixel), i32(layer), vec4f(0.0, 0.0, rough, clamp(height, 0.0, 1.0)));
}
`, [tileNoiseWgsl, terrainLayersWgsl]);

const bakeNormalsWgsl = makeModule('terrain-bake-normals', /* wgsl */ `
@group(0) @binding(0) var relief: texture_2d_array<f32>;
@group(0) @binding(1) var surface_out: texture_storage_2d_array<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn bake_normals(@builtin(global_invocation_id) gid: vec3u) {
  let size = i32(TERRAIN_BAKE_SIZE);
  let layer = i32(gid.z);
  if (i32(gid.x) >= size || i32(gid.y) >= size || gid.z >= TERRAIN_LAYER_COUNT) { return; }
  let p = vec2i(gid.xy);
  let xm = vec2i((p.x + size - 1) % size, p.y);
  let xp = vec2i((p.x + 1) % size, p.y);
  let ym = vec2i(p.x, (p.y + size - 1) % size);
  let yp = vec2i(p.x, (p.y + 1) % size);
  let dx = textureLoad(relief, xp, layer, 0).a - textureLoad(relief, xm, layer, 0).a;
  let dy = textureLoad(relief, yp, layer, 0).a - textureLoad(relief, ym, layer, 0).a;
  let slope_scale = terrain_layer_relief(layer) * f32(size) / (2.0 * terrain_layer_width(layer));
  let normal = normalize(vec3f(-dx * slope_scale, -dy * slope_scale, 1.0));
  let source = textureLoad(relief, p, layer, 0);
  textureStore(surface_out, p, layer, vec4f(normal.xy * 0.5 + vec2f(0.5), source.b, source.a));
}
`, [terrainLayersWgsl]);

export function terrainBakeMaterialsShader() { return link(bakeMaterialsWgsl); }
export function terrainBakeNormalsShader() { return link(bakeNormalsWgsl); }

export interface TerrainTextures {
  readonly albedo: GPUTexture;
  readonly surface: GPUTexture;
  readonly albedoView: GPUTextureView;
  readonly surfaceView: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly bakeMs: number;
  readonly bytes: number;
  destroy(): void;
}

/** Bake the layer arrays (own encoder + one submit, awaited). Every resource is freed through ctx.deferDestroy (N6). */
export async function bakeTerrainTextures(ctx: GpuContext): Promise<TerrainTextures> {
  const started = performance.now();
  const { device, pipelines } = ctx;
  const size = TERRAIN_BAKE_SIZE, layers = TERRAIN_LAYER_COUNT;
  const usage = TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING;
  const make = (name: string) => device.createTexture({ label: `terrain:${name}`, size: [size, size, layers], format: 'rgba8unorm', mipLevelCount: TERRAIN_BAKE_MIPS, usage, dimension: '2d' });
  const albedo = make('albedo'), surface = make('surface');
  const relief = device.createTexture({ label: 'terrain:relief-temp', size: [size, size, layers], format: 'rgba16float', usage, dimension: '2d' });
  const materialsLayout = device.createBindGroupLayout({ label: 'layout:terrain-bake-materials', entries: [
    { binding: 0, visibility: ShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } },
    { binding: 1, visibility: ShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
  ] });
  const normalsLayout = device.createBindGroupLayout({ label: 'layout:terrain-bake-normals', entries: [
    { binding: 0, visibility: ShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d-array' } },
    { binding: 1, visibility: ShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } },
  ] });
  const [materials, normals] = await Promise.all([
    pipelines.compute('terrain:bake-materials', () => ({ label: 'terrain:bake-materials', layout: device.createPipelineLayout({ bindGroupLayouts: [materialsLayout] }),
      compute: { module: pipelines.shaderModule(terrainBakeMaterialsShader(), 'terrain-bake-materials'), entryPoint: 'bake_materials' } })),
    pipelines.compute('terrain:bake-normals', () => ({ label: 'terrain:bake-normals', layout: device.createPipelineLayout({ bindGroupLayouts: [normalsLayout] }),
      compute: { module: pipelines.shaderModule(terrainBakeNormalsShader(), 'terrain-bake-normals'), entryPoint: 'bake_normals' } })),
  ]);
  const mip = MipGenerator.for(ctx);
  await mip.ready();
  const level0 = (t: GPUTexture) => t.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 });
  const encoder = device.createCommandEncoder({ label: 'terrain:bake' });
  const groups = Math.ceil(size / 8);
  let pass = encoder.beginComputePass({ label: 'terrain:bake-materials' });
  pass.setPipeline(materials);
  pass.setBindGroup(0, device.createBindGroup({ layout: materialsLayout, entries: [{ binding: 0, resource: level0(albedo) }, { binding: 1, resource: relief.createView({ dimension: '2d-array' }) }] }));
  pass.dispatchWorkgroups(groups, groups, layers);
  pass.end();
  pass = encoder.beginComputePass({ label: 'terrain:bake-normals' });
  pass.setPipeline(normals);
  pass.setBindGroup(0, device.createBindGroup({ layout: normalsLayout, entries: [{ binding: 0, resource: relief.createView({ dimension: '2d-array' }) }, { binding: 1, resource: level0(surface) }] }));
  pass.dispatchWorkgroups(groups, groups, layers);
  pass.end();
  if (!mip.generate(encoder, albedo, { dimension: '2d-array' }) || !mip.generate(encoder, surface, { dimension: '2d-array' })) throw new Error('terrain bake: mip generator not ready');
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  ctx.deferDestroy(relief);
  const sampler = device.createSampler({
    label: 'terrain:layers', addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8,
  });
  let destroyed = false;
  return {
    albedo, surface, sampler, bakeMs: performance.now() - started,
    albedoView: albedo.createView({ dimension: '2d-array' }), surfaceView: surface.createView({ dimension: '2d-array' }),
    bytes: 8 * layers * (4 ** TERRAIN_BAKE_MIPS - 1) / 3,
    destroy() { if (destroyed) return; destroyed = true; ctx.deferDestroy(albedo); ctx.deferDestroy(surface); },
  };
}
