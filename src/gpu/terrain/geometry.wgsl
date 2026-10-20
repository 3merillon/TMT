// Recipes: 64 bytes; positions: vec4f, 16 bytes.
// All arithmetic is in fixture-local coordinates. Each canonical intersection is
// evaluated once. Faces from both neighboring bricks reference this same word.
struct Recipe { header: vec4u, bases:vec4u, operands: vec4f, weights:vec4f }
struct Config { level: u32, count: u32, start: u32, unused: u32 }
@group(0) @binding(0) var<storage,read> recipes: array<Recipe>;
@group(0) @binding(1) var<storage,read_write> positions: array<vec4f>;
@group(0) @binding(2) var<uniform> config: Config;
@compute @workgroup_size(64)
fn construct(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + config.start;
  if (i >= config.count) { return; }
  let r = recipes[i];
  if (r.header.z != config.level) { return; }
  if (r.header.w == 0u) { positions[i] = vec4f(r.operands.xyz,1.0); return; }
  if (r.header.w == 2u) {
    let origin=positions[r.bases.x].xyz;
    var delta=vec3f(0.0);
    for(var j=1u;j<4u;j++) { delta=delta+(positions[r.bases[j]].xyz-origin)*r.weights[j]; }
    positions[i]=vec4f(origin+delta,1.0);return;
  }
  let a = positions[r.header.x].xyz;
  let b = positions[r.header.y].xyz;
  let denominator = r.operands.x-r.operands.y;
  let t = r.operands.x/denominator;
  let delta = (b-a)*t;
  positions[i] = vec4f(a+delta,1.0);
}
