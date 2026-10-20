/**
 * `tracks` terrain modifier (plan §4.10, §4.13): reads the Surface Memory Cube (reserved binding `surfaceMemory`, an
 * rgba8 6-layer equi-angular cube; R track compression, G scorch, B trample, A wetness).
 *
 * - R darkens and compacts the soil and tilts the normal with a 3-tap relief (the compression gradient in face space,
 *   turned into world tangents with the cube mapping), so grousers read as grooves.
 * - G (scorch) darkens and greys the ground it lands on, keeping its texture, and roughens.
 * Sampled with textureSampleLevel (explicit LOD): the SMC has no mips and modifiers must not rely on implicit derivatives.
 * With the 1×1 placeholder bound (no SMC module) the modifier is a no-op.
 */
import { cubeSphereWgsl } from '../../../wgsl/common/cube-sphere.wgsl';
import { makeModule } from '../../../wgsl/module';
import { terrainCtxWgsl, type TerrainModifier } from '../modifier-types';

export const TRACKS = { darken: 0.4, relief: 0.01, scorchKeep: 0.3, scorchGrey: 0.6, scorchTint: [0.96, 0.93, 0.9] } as const;

export const tracksModifier: TerrainModifier = {
  name: 'tracks',
  reserved: ['surfaceMemory'],
  wgsl: () => makeModule('tmod-tracks', /* wgsl */ `
fn tmod_tracks(s: ptr<function, SurfaceSample>, t: TerrainCtx) {
  if (t.is_body != 0u) { return; }
  let size = f32(textureDimensions(rb_surfaceMemory_cube).x);
  if (size < 2.0) { return; }
  let loc = cs_locate(t.world);
  let face = u32(loc.z);
  let uv = cs_uv01(loc.xy);
  let m = textureSampleLevel(rb_surfaceMemory_cube, terrain_clamp, uv, face, 0.0);
  if (m.r + m.g < 0.004) { return; }
  let texel = 1.0 / size;
  let mu = textureSampleLevel(rb_surfaceMemory_cube, terrain_clamp, uv + vec2f(texel, 0.0), face, 0.0).r;
  let mv = textureSampleLevel(rb_surfaceMemory_cube, terrain_clamp, uv + vec2f(0.0, texel), face, 0.0).r;
  // One texel in uv01 is 2 texels of face coordinates.
  let p0 = cs_dir(face, loc.xy);
  let tu = cs_dir(face, loc.xy + vec2f(2.0 * texel, 0.0)) - p0;
  let tv = cs_dir(face, loc.xy + vec2f(0.0, 2.0 * texel)) - p0;
  let radius = length(t.world);
  let lu = max(length(tu) * radius, 1e-6);
  let lv = max(length(tv) * radius, 1e-6);
  // Height h = -relief · R  ⇒  n' = normalize(n + relief · ∇R) (tangential gradient in world units).
  let grad = normalize(tu) * ((mu - m.r) / lu) + normalize(tv) * ((mv - m.r) / lv);
  let fade = 1.0 - smoothstep(10.0, 22.0, t.view_dist);
  (*s).n_shading = normalize((*s).n_shading + grad * (${TRACKS.relief} * fade));
  // Perceptual response: a light pass already reads as a mark; full compression is dark, damp, compacted soil.
  let track = smoothstep(0.04, 0.9, m.r);
  (*s).base_color = (*s).base_color * (1.0 - ${TRACKS.darken} * track);
  (*s).roughness = mix((*s).roughness, 0.72, track * 0.6);
  // Soot over the ground rather than a painted disc: scale and grey the existing albedo, so its cells and grain stay
  // readable, with a response that follows the stamp's falloff instead of saturating early.
  let burn = smoothstep(0.02, 0.85, m.g);
  let grey = vec3f(dot((*s).base_color, vec3f(0.3, 0.55, 0.15))) * vec3f(${TRACKS.scorchTint.join(', ')});
  let charred = mix((*s).base_color, grey, ${TRACKS.scorchGrey}) * ${TRACKS.scorchKeep};
  (*s).base_color = mix((*s).base_color, charred, burn);
  (*s).roughness = mix((*s).roughness, 1.0, burn);
}
`, [terrainCtxWgsl, cubeSphereWgsl]),
};
