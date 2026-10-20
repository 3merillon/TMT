// Compaction gather: surviving vertex i takes its old constructed position. Recipes are never re-executed for
// already constructed vertices, so only positions move (no recipe re-upload).
@group(0) @binding(0) var<storage,read> source: array<vec4f>;
@group(0) @binding(1) var<storage,read> oldIds: array<u32>;
@group(0) @binding(2) var<storage,read_write> gathered: array<vec4f>;
@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&oldIds)) { return; }
  gathered[i] = source[oldIds[i]];
}
