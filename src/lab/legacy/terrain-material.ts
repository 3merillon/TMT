/** Shared, body-fixed terrain shading. Texture detail never changes authoritative geometry. */
import { Vector3, type DataArrayTexture } from 'three';
import { MeshStandardNodeMaterial, type StorageArrayTexture } from 'three/webgpu';
import {
  attribute, cameraPosition, int, modelWorldMatrixInverse, normalLocal, positionLocal,
  sampler, texture, transformNormalToView, uniform, vec4, wgslFn,
} from 'three/tsl';
import { TERRAIN_RADIUS } from '../../game/terrain-config';
import { planetNormalWGSL } from '../../game/planet-field';

export type TerrainDetail = 'normal' | 'parallax';

/**
 * Explicit gradients remain valid inside the optional divergent march. The returned matrix
 * packs color / body-local normal / roughness, so all PBR inputs share one sampling call.
 */
export const TERRAIN_MATERIAL_WGSL = /* wgsl */`
fn tmt_terrain_surface(
  albedo: texture_2d_array<f32>, surface: texture_2d_array<f32>,
  albedo_sampler: sampler, surface_sampler: sampler,
  p: vec3<f32>, source_normal: vec3<f32>, camera_delta: vec3<f32>,
  material_id: f32, detail: f32, source: vec4<f32>, planet_kind: f32
) -> mat3x3<f32> {
  var n = normalize(source_normal);
  if (source.w > 1.5) { n = normalize(source.xyz - p); }
  else if (source.w > 0.5) { n = tmt_planet_normal(p); }
  let dx = dpdx(p);
  let dy = dpdy(p);
  var layer = i32(clamp(floor(material_id + 0.5) - 1.0, 0.0, 2.0));
  if (layer == 1 && planet_kind < 0.5) { layer = 5; }
  var coating = 3;
  var blend = 0.0;
  if (material_id < 1.5) {
    let slope = smoothstep(0.62, 0.93, dot(n, normalize(p)));
    if (planet_kind < 0.5) { layer = 5; coating = 1; blend = slope * 0.25; }
    else if (planet_kind < 1.5) { coating = 3; blend = slope; }
    else if (planet_kind < 2.5) { coating = 4; blend = slope; }
    else { blend = slope * (1.0 - smoothstep(-1.7, -0.2, length(p) - ${TERRAIN_RADIUS.toFixed(1)})); }
  }
  if (blend > 0.99) { return tmt_terrain_layer(albedo, surface, albedo_sampler, surface_sampler,
    p, n, camera_delta, coating, detail, dx, dy); }
  let base = tmt_terrain_layer(albedo, surface, albedo_sampler, surface_sampler,
    p, n, camera_delta, layer, detail, dx, dy);
  if (blend < 0.01) { return base; }
  let coat = tmt_terrain_layer(albedo, surface, albedo_sampler, surface_sampler,
    p, n, camera_delta, coating, detail, dx, dy);
  return mat3x3<f32>(mix(base[0], coat[0], blend), normalize(mix(base[1], coat[1], blend)), mix(base[2], coat[2], blend));
}

fn tmt_terrain_layer(
  albedo: texture_2d_array<f32>, surface: texture_2d_array<f32>,
  albedo_sampler: sampler, surface_sampler: sampler,
  p: vec3<f32>, n: vec3<f32>, camera_delta: vec3<f32>, layer: i32, detail: f32,
  position_dx: vec3<f32>, position_dy: vec3<f32>
) -> mat3x3<f32> {
  let axis_sign = select(vec3<f32>(-1.0), vec3<f32>(1.0), n >= vec3<f32>(0.0));
  // A tile covers a few tank lengths. Scale and relief are independent physical quantities.
  let tile_scales = array<f32, 6>(0.40, 0.50, 0.40, 0.33333333, 0.33333333, 0.40);
  let relief_depths = array<f32, 6>(0.042, 0.032, 0.012, 0.025, 0.018, 0.048);
  let scale = tile_scales[layer];
  let q = p * scale;
  let grad_x = position_dx * scale;
  let grad_y = position_dy * scale;
  let raw_weights = n * n * n * n;
  let weights = raw_weights / (raw_weights.x + raw_weights.y + raw_weights.z);
  let camera_distance = length(camera_delta);
  let view = camera_delta / max(camera_distance, 0.0001);
  let distance_fade = 1.0 - smoothstep(8.0, 18.0, camera_distance);
  let grazing_fade = smoothstep(0.22, 0.45, dot(n, view));
  let relief = relief_depths[layer] * scale * distance_fade * grazing_fade;

  // Each UV pair and tangent pair form the same right-handed basis on both signed faces.
  var uv_x = vec2<f32>(-q.z * axis_sign.x, q.y);
  var uv_y = vec2<f32>(q.x, -q.z * axis_sign.y);
  var uv_z = vec2<f32>(q.x * axis_sign.z, q.y);
  let dx_x = vec2<f32>(-grad_x.z * axis_sign.x, grad_x.y);
  let dy_x = vec2<f32>(-grad_y.z * axis_sign.x, grad_y.y);
  let dx_y = vec2<f32>(grad_x.x, -grad_x.z * axis_sign.y);
  let dy_y = vec2<f32>(grad_y.x, -grad_y.z * axis_sign.y);
  let dx_z = vec2<f32>(grad_x.x * axis_sign.z, grad_x.y);
  let dy_z = vec2<f32>(grad_y.x * axis_sign.z, grad_y.y);

  if (detail > 0.5 && relief > 0.00001) {
    let axis_relief = vec3<f32>(relief) * smoothstep(vec3<f32>(0.02), vec3<f32>(0.08), weights);
    if (weights.x > 0.02) {
      uv_x = tmt_terrain_parallax(surface, surface_sampler, uv_x, layer, dx_x, dy_x,
        vec3<f32>(-view.z * axis_sign.x, view.y, view.x * axis_sign.x), axis_relief.x);
    }
    if (weights.y > 0.02) {
      uv_y = tmt_terrain_parallax(surface, surface_sampler, uv_y, layer, dx_y, dy_y,
        vec3<f32>(view.x, -view.z * axis_sign.y, view.y * axis_sign.y), axis_relief.y);
    }
    if (weights.z > 0.02) {
      uv_z = tmt_terrain_parallax(surface, surface_sampler, uv_z, layer, dx_z, dy_z,
        vec3<f32>(view.x * axis_sign.z, view.y, view.z * axis_sign.z), axis_relief.z);
    }
  }

  let ax = textureSampleGrad(albedo, albedo_sampler, uv_x, layer, dx_x, dy_x).rgb;
  let ay = textureSampleGrad(albedo, albedo_sampler, uv_y, layer, dx_y, dy_y).rgb;
  let az = textureSampleGrad(albedo, albedo_sampler, uv_z, layer, dx_z, dy_z).rgb;
  let sx = textureSampleGrad(surface, surface_sampler, uv_x, layer, dx_x, dy_x);
  let sy = textureSampleGrad(surface, surface_sampler, uv_y, layer, dx_y, dy_y);
  let sz = textureSampleGrad(surface, surface_sampler, uv_z, layer, dx_z, dy_z);
  let mapped_x = tmt_terrain_decode_normal(sx.rg);
  let mapped_y = tmt_terrain_decode_normal(sy.rg);
  let mapped_z = tmt_terrain_decode_normal(sz.rg);
  let nx = tmt_terrain_reorient(n,
    vec3<f32>(0.0, mapped_x.y, -mapped_x.x * axis_sign.x), mapped_x.z);
  let ny = tmt_terrain_reorient(n,
    vec3<f32>(mapped_y.x, 0.0, -mapped_y.y * axis_sign.y), mapped_y.z);
  let nz = tmt_terrain_reorient(n,
    vec3<f32>(mapped_z.x * axis_sign.z, mapped_z.y, 0.0), mapped_z.z);
  let base_color = ax * weights.x + ay * weights.y + az * weights.z;
  let color = tmt_terrain_region_color(base_color, p, n, layer);
  let mapped_normal = normalize(nx * weights.x + ny * weights.y + nz * weights.z);
  let roughness = clamp(dot(vec3<f32>(sx.b, sy.b, sz.b), weights), 0.42, 1.0);
  return mat3x3<f32>(color, mapped_normal, vec3<f32>(roughness, 0.0, 0.0));
}

fn tmt_terrain_region_color(base: vec3<f32>, p: vec3<f32>, n: vec3<f32>, layer: i32) -> vec3<f32> {
  // Construction keeps its authored reflectance, including walls far from the planet center.
  if (layer == 2) { return base; }
  if (layer >= 3) { return base; }
  let radius = max(length(p), 0.001);
  let radial = p / radius;
  let elevation = radius - ${TERRAIN_RADIUS.toFixed(1)};
  let latitude = abs(radial.y);
  // Use geometric slope, not the tile's normal map: a small chip cannot paint a biome.
  let steep = 1.0 - smoothstep(0.68, 0.94, dot(n, radial));
  let basin = 1.0 - smoothstep(-1.80, -0.25, elevation);
  let upland = smoothstep(0.90, 2.80, elevation);
  let summit = smoothstep(2.60, 4.40, elevation);
  // One broad, smooth geographic moisture field, fixed to the body. No fragment noise,
  // extra textures, longitude seam, temporal term or small-scale pigment thresholds.
  let geography = radial.x * 0.65 + radial.z * 0.40 + radial.y * radial.z * 0.60;
  let moisture = (1.0 - smoothstep(-0.50, 0.65, geography))
    * (1.0 - smoothstep(0.68, 0.95, latitude));
  let lowland_tint = mix(vec3<f32>(1.02, 0.95, 0.80), vec3<f32>(0.76, 0.91, 0.67), moisture);
  let rock_tint = mix(vec3<f32>(1.04, 1.025, 1.00), vec3<f32>(1.20, 1.19, 1.13), summit);
  var tint = mix(lowland_tint, vec3<f32>(1.14, 0.96, 0.76), basin);
  tint = mix(tint, rock_tint, max(steep * 0.88, upland));
  // Latitude gently cools exposed polar stone; bright high ground remains mineral, not snow.
  let polar = smoothstep(0.72, 0.98, latitude) * (1.0 - basin) * 0.30;
  tint = mix(tint, vec3<f32>(1.03, 1.055, 1.045), polar);
  // Multiplication preserves all fracture deposits, moss and mineral detail in the baked tile.
  return clamp(base * tint, vec3<f32>(0.03), vec3<f32>(0.65));
}

fn tmt_terrain_decode_normal(encoded: vec2<f32>) -> vec3<f32> {
  let xy = encoded * 2.0 - vec2<f32>(1.0);
  return normalize(vec3<f32>(xy, sqrt(max(1.0 - dot(xy, xy), 0.001))));
}

fn tmt_terrain_reorient(n: vec3<f32>, tangent: vec3<f32>, height_normal: f32) -> vec3<f32> {
  // Project perturbations into the real surface plane: flat maps preserve every input slope.
  return normalize(n * max(height_normal, 0.05) + tangent - n * dot(n, tangent));
}

fn tmt_terrain_parallax(
  surface: texture_2d_array<f32>, surface_sampler: sampler, uv: vec2<f32>, layer: i32,
  dx: vec2<f32>, dy: vec2<f32>, view: vec3<f32>, relief: f32
) -> vec2<f32> {
  // The projected face can be back-facing even when the real surface faces the eye.
  // Fade before skipping it, so a changing camera cannot make a visible UV discontinuity.
  let plane_fade = smoothstep(0.20, 0.40, view.z);
  if (plane_fade <= 0.001) { return uv; }
  let offset = view.xy / max(view.z, 0.20) * relief * plane_fade;
  let top = uv + offset * 0.5;
  var lower = 0.0;
  var upper = 1.0;
  // At most eight linear height reads and two refinement reads for this projection.
  for (var i = 1; i <= 8; i++) {
    let depth = f32(i) * 0.125;
    let height = textureSampleGrad(surface, surface_sampler, top - offset * depth, layer, dx, dy).a;
    if (1.0 - depth <= height) { upper = depth; break; }
    lower = depth;
  }
  for (var i = 0; i < 2; i++) {
    let depth = (lower + upper) * 0.5;
    let height = textureSampleGrad(surface, surface_sampler, top - offset * depth, layer, dx, dy).a;
    if (1.0 - depth <= height) { upper = depth; } else { lower = depth; }
  }
  return top - offset * ((lower + upper) * 0.5);
}
`;

export interface TerrainMaterialHandle {
  material: MeshStandardNodeMaterial;
  setDetail(mode: TerrainDetail): void;
  setSeed(seed: number): void;
  dispose(): void;
}

/** Owns the baker's final arrays; accepts synthetic data arrays for offline graph verification. */
export function createTerrainMaterialFromTextures(
  albedo: DataArrayTexture | StorageArrayTexture, surface: DataArrayTexture | StorageArrayTexture,
): TerrainMaterialHandle {
  const detail = uniform(1);
  const kind = uniform(3);
  const zeroOrigin = new Vector3();
  const origin = uniform(new Vector3()).onObjectUpdate(({ object }) => object?.userData.terrainOrigin ?? zeroOrigin);
  const material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.9 });
  let currentSeed = -1;
  const configure = (seed: number): void => {
    if (seed === currentSeed) return;
    const sampleSurface = wgslFn(TERRAIN_MATERIAL_WGSL + planetNormalWGSL(seed));
    const bodyCamera = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const result = sampleSurface({
      albedo: texture(albedo), surface: texture(surface),
      albedo_sampler: sampler(albedo), surface_sampler: sampler(surface),
      p: positionLocal.add(origin), source_normal: normalLocal,
      camera_delta: bodyCamera.sub(positionLocal),
      material_id: attribute('terrainMaterial', 'float'), detail, source: attribute('terrainSource', 'vec4'), planet_kind: kind,
    }).toVar('tmtTerrainSample');
    material.name = 'TMT terrain triplanar PBR';
    material.colorNode = vec4(result.element(int(0)), 1);
    material.normalNode = transformNormalToView(result.element(int(1)));
    material.roughnessNode = result.element(int(2)).x;
    material.needsUpdate = true;
    kind.value = seed >>> 0 & 3;
    currentSeed = seed;
  };
  configure(7);
  let disposed = false;
  return {
    material,
    setDetail(mode) { if (!disposed) detail.value = mode === 'parallax' ? 1 : 0; },
    setSeed(seed) { if (!disposed) configure(seed); },
    dispose() {
      if (disposed) return;
      disposed = true;
      material.dispose();
      albedo.dispose();
      surface.dispose();
    },
  };
}
