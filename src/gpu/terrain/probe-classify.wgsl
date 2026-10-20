// Standalone probe: original f32 lattice classification. Not loaded by the game's render/terrain pipelines.
struct Parameters { positions: u32, count: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> samples: array<f32>;
@group(0) @binding(1) var<storage, read> vertices: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> tasks: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> result: array<u32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global: vec3<u32>) {
  let i = global.x;
  if (i >= parameters.count) { return; }
  let task = tasks[i];
  let offset = task.x * parameters.positions;
  let ids = vertices[task.y];
  let v = vec4<f32>(samples[offset + ids.x], samples[offset + ids.y], samples[offset + ids.z], samples[offset + ids.w]);
  result[i] = select(0u, 1u, any(v < vec4<f32>(0.0))) | select(0u, 2u, any(v > vec4<f32>(0.0)));
}
