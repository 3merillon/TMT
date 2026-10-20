struct Tri { ids:vec4u, corners:vec4u }
@group(0) @binding(0) var<storage,read> triangles:array<Tri>;
@group(0) @binding(1) var<storage,read> offsets:array<u32>;
@group(0) @binding(2) var<storage,read_write> indices:array<u32>;
@group(0) @binding(3) var<storage,read> counts:array<u32>;
@compute @workgroup_size(64)
fn emitIndices(@builtin(global_invocation_id) id:vec3u){
  let i=id.x;if(i>=arrayLength(&triangles)||counts[i]==0u){return;}
  let dst=offsets[i];if(dst+3u>arrayLength(&indices)){return;}
  for(var j=0u;j<3u;j++){indices[dst+j]=triangles[i].corners[j];}
}
