import { makeModule } from '../../wgsl/module';

export const lavaOpticsWgsl = makeModule('lava-optics', /* wgsl */ `
// Molten rock is optically thick: a few hundredths of a world unit hide the scene.
fn lava_transmittance(distance: f32) -> vec3f {
  return exp(-vec3f(180.0, 260.0, 380.0) * max(distance, 0.0));
}
`);

/** Linked into the composite with the live liquid atlas, including near-plane crossings. */
export const lavaImmersionWgsl = makeModule('lava-immersion', /* wgsl */ `
fn lava_column(p: vec3f) -> vec4f {
  let a = liq_bilerp(liq_atlas, liq_atlas_px(p));
  return vec4f(a.y, a.y - a.w, a.w, length(p) - a.y);
}
fn lava_contains(p: vec3f) -> bool {
  let a = lava_column(p);
  return a.z > liq.lava.z && a.w < 0.0 && length(p) > a.y - 0.03;
}
fn lava_near_hit(eye: vec3f, dir: vec3f, inside: bool) -> f32 {
  let a = lava_column(eye);
  if (a.z <= liq.lava.z || (!inside && abs(a.w) > 0.3)) { return -1.0; }
  let b = dot(eye, dir);
  let disc = b * b - dot(eye, eye) + a.x * a.x;
  if (disc < 0.0) { return -1.0; }
  var t = select(-b - sqrt(disc), -b + sqrt(disc), inside);
  if (t < 0.0 || t > 50.0) { return -1.0; }
  for (var k = 0u; k < 10u; k++) {
    let p = eye + dir * t;
    let slope = dot(normalize(p), dir);
    if (abs(slope) < 0.025) { break; }
    t = max(0.00001, t - clamp(lava_column(p).w / slope, -0.5, 0.5));
  }
  let end = lava_column(eye + dir * t);
  if (end.z <= liq.lava.z || abs(end.w) > 0.015) { return -1.0; }
  return t;
}
`, [lavaOpticsWgsl]);
