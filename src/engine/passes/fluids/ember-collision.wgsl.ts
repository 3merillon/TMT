import { makeModule } from '../../wgsl/module';

/** Small cosmetic solids, swept in bounded steps against the live terrain SDF. */
export const emberCollisionWgsl = makeModule('ember-collision', /* wgsl */ `
struct EmberMotion { position: vec3f, velocity: vec3f }

fn ember_rebound(v: vec3f, n: vec3f, restitution: f32) -> vec3f {
  let inward = dot(v, n);
  if (inward >= 0.0) { return v; }
  // Lose tangential energy as well, so an ember settles instead of skating forever.
  return (v - n * inward) * 0.72 - n * inward * restitution;
}

fn ember_move(position: vec3f, velocity: vec3f, radius: f32, dt: f32, restitution: f32) -> EmberMotion {
  var p = position;
  var v = velocity;
  var left = dt;
  // Conservative advancement checks the entire segment, including at low frame rates.
  // If the budget is exhausted, stop here rather than tunnelling through the obstacle.
  for (var step = 0u; step < 16u && left > 0.00001; step++) {
    let distance = sdf_sample(p) - radius;
    if (distance < 0.001) {
      let n = sdf_normal(p);
      p += n * (0.002 - distance);
      v = ember_rebound(v, n, restitution);
    }
    let speed = length(v);
    let safe = max(sdf_sample(p) - radius, 0.001);
    let h = min(left, safe * 0.8 / max(speed, 0.001));
    p += v * h;
    left -= h;
  }
  return EmberMotion(p, v);
}
`);
