import { makeModule } from '../../wgsl/module';

/** Lowest open layer across a grid face, including geometry between column centres. */
export const liquidBarrierWgsl = makeModule('liquid-barrier', /* wgsl */ `
fn liquid_face_crest(a: vec3f, b: vec3f, head: f32, bed: f32) -> f32 {
  if (head <= bed + 0.003) { return bed; }
  var crest = bed;
  for (var j = 1u; j <= 3u; j++) {
    let d = normalize(mix(a, b, f32(j) * 0.25));
    // A solid rim above the free surface closes this connection completely.
    if (sdf_sample(d * (head - 0.002)) < 0.0) { return head + 0.002; }
    // A deep open column has no geometry near the surface; avoid unnecessary bisection.
    if (sdf_sample(d * (bed + 0.002)) >= 0.0) { continue; }
    var low = bed; var high = head;
    for (var i = 0u; i < 6u; i++) {
      let mid = (low + high) * 0.5;
      if (sdf_sample(d * mid) < 0.0) { low = mid; } else { high = mid; }
    }
    crest = max(crest, high);
  }
  return crest;
}
fn liquid_face_share(head: f32, depth: f32, crest: f32) -> f32 {
  return clamp((head - crest) / max(depth, 0.004), 0.0, 1.0);
}
`);
