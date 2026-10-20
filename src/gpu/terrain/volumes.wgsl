// Once-per-edit descriptor verification. No render mesh is mapped.
// Region: u32 triangle start/count + pad (16 B), output volume/min area/error (16 B).
struct Region { start:u32, count:u32, unused:u32, pad:u32 }
@group(0) @binding(0) var<storage,read> positions:array<vec4f>;
@group(0) @binding(1) var<storage,read> triangles:array<vec4u>;
@group(0) @binding(2) var<storage,read> regions:array<Region>;
@group(0) @binding(3) var<storage,read_write> descriptors:array<vec4f>;
@compute @workgroup_size(64)
fn volumes(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x; if (i>=arrayLength(&regions)) { return; }
  let r=regions[i]; let origin=positions[triangles[r.start].x].xyz;
  var volume=0.0; var minimum=1e30;
  for(var j=0u;j<r.count;j++) {
    let t=triangles[r.start+j];
    let a=positions[t.x].xyz-origin; let b=positions[t.y].xyz-origin; let c=positions[t.z].xyz-origin;
    // A source polygon can contain a fan triangle that collapses after f32
    // construction. Its zero area contributes no volume or visible surface.
    let n=cross(b-a,c-a); minimum=min(minimum,length(n)*.5);
    volume+=dot(a,cross(b,c))/6.0;
  }
  descriptors[i]=vec4f(volume,minimum,select(1.0,0.0,volume>0.0),0.0);
}
