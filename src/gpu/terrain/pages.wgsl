// Tri: 32 bytes: vertex IDs + material, then owner region and padding.
struct Tri { ids: vec4u, info: vec4u }
struct Config { triangles: u32, capacity: u32, vertexCount: u32, unused: u32, origin: vec4f }
@group(0) @binding(0) var<storage,read> positions: array<vec4f>;
@group(0) @binding(1) var<storage,read> triangles: array<Tri>;
@group(0) @binding(2) var<storage,read_write> counts: array<u32>;
@group(0) @binding(3) var<storage,read> offsets: array<u32>;
@group(0) @binding(4) var<storage,read_write> vertices: array<f32>;
@group(0) @binding(5) var<storage,read_write> normals: array<f32>;
@group(0) @binding(6) var<storage,read_write> surface: array<f32>;
@group(0) @binding(7) var<storage,read_write> status: array<atomic<u32>>;
@group(0) @binding(8) var<uniform> config: Config;
@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3u) {
  let i=id.x; if (i>=config.triangles) { return; }
  let t=triangles[i].ids;
  let n=cross(positions[t.y].xyz-positions[t.x].xyz,positions[t.z].xyz-positions[t.x].xyz);
  // A fan triangle may collapse to zero area in f32 even though its source
  // polygon and occupied region are valid. The scan and index pass omit it.
  if (!(dot(n,n)>0.0)) { counts[i]=0u; return; }
  counts[i]=3u;
}
@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) id: vec3u) {
  // Vertex references bind at slot 1 for this pass. Each polygon corner is
  // constructed once and shared by its fan's indices, without concurrent writes.
  let i=id.x; if (i>=config.vertexCount) { return; }
  let t=triangles[i].ids;
  let n=normalize(cross(positions[t.z].xyz-positions[t.y].xyz,positions[t.w].xyz-positions[t.y].xyz));
  let material=triangles[i].info.x & 65535u;
  let source_kind=triangles[i].info.x >> 16u;
  var color=vec3f(.32,.40,.32);
  if(material==2u) { color=vec3f(.52,.37,.25); }
  if(material==3u) { color=vec3f(.30,.57,.69); }
  let p=positions[t.x].xyz-config.origin.xyz;
  for(var a=0u;a<3u;a++) { vertices[i*3u+a]=p[a]; normals[i*3u+a]=n[a]; surface[i*8u+5u+a]=color[a]; }
  surface[i*8u]=f32(material);
  surface[i*8u+1u]=bitcast<f32>(triangles[i].info.y);
  surface[i*8u+2u]=bitcast<f32>(triangles[i].info.z);
  surface[i*8u+3u]=bitcast<f32>(triangles[i].info.w);
  surface[i*8u+4u]=f32(source_kind);
}
