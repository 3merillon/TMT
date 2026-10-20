/** Persistent departure map advected by the same velocity/backtrace as the gas solver.
 * Clouds sample this map in world space; their density and sun-shadow paths share the result. */
import { makeModule,wgslStruct } from '../../wgsl/module';
export const GAS_FLOW_MAX=12;
export const GAS_FLOW_PARAMS=wgslStruct('GasCloudFlowParams',[
  ['header','vec4f'], // n, atlas slots, live domains, enabled
  ['domains',{array:'vec4f',count:GAS_FLOW_MAX*4}], // center/edge, right/slot, up/fade, forward/reserved
]);
export function gasFlowBindingsWgsl(group:number,atlas:number,params:number){
  return makeModule(`gas-flow-bindings:${group}:${atlas}:${params}`,/* wgsl */ `
@group(${group}) @binding(${atlas}) var gas_departure:texture_3d<f32>;
@group(${group}) @binding(${params}) var<uniform> gas_flow:GasCloudFlowParams;
`,[gasFlowWgsl]);
}
export const gasFlowWgsl=makeModule('gas-cloud-flow',/* wgsl */ `
fn gas_cloud_displacement(world:vec3f,samp:sampler)->vec3f{
  if(gas_flow.header.w<0.5){return vec3f(0.0);}
  var displacement=vec3f(0.0);var weight=0.0;
  for(var i=0u;i<min(${GAS_FLOW_MAX}u,u32(gas_flow.header.z));i++){
    let center=gas_flow.domains[i*4u];let right=gas_flow.domains[i*4u+1u];
    let up=gas_flow.domains[i*4u+2u];let fwd=gas_flow.domains[i*4u+3u];
    let q=(world-center.xyz)/center.w;
    let uv=vec3f(dot(q,right.xyz),dot(q,up.xyz),dot(q,fwd.xyz))+0.5;
    if(any(uv<=vec3f(0.0)) || any(uv>=vec3f(1.0))){continue;}
    let fade=(1.0-smoothstep(0.32,0.49,length(uv.xz-0.5)))
      *smoothstep(0.0,0.04,uv.y)*(1.0-smoothstep(0.86,0.99,uv.y))*up.w;
    // A zero fade adds exactly nothing to either sum.
    if(fade<=0.0){continue;}
    let n=gas_flow.header.x;
    let tex=vec3f(clamp(uv.xy,vec2f(0.5/n),vec2f(1.0-0.5/n)),
      (right.w*n+clamp(uv.z*n,0.5,n-0.5))/(n*gas_flow.header.y));
    let d=textureSampleLevel(gas_departure,samp,tex,0.0).xyz;
    displacement+=(right.xyz*d.x+up.xyz*d.y+fwd.xyz*d.z)*(center.w*fade);weight+=fade;
  }
  // Overlapping live domains blend their flow instead of multiplying displacement without bound.
  return displacement/max(1.0,weight);
}
`,[GAS_FLOW_PARAMS.module]);
const gasFlowCommonWgsl=makeModule('gas-flow-common',/* wgsl */ `
struct GasFlowGlobals { n:u32,slots:u32,dt:f32,time:f32 }
@group(0) @binding(0) var<uniform> G:GasFlowGlobals;
@group(0) @binding(2) var<storage,read> flow_slots:array<u32>;
fn flow_at(slot:u32,p:vec3i)->vec3i{
  let q=clamp(p,vec3i(0),vec3i(i32(G.n)-1));return vec3i(q.xy,q.z+i32(slot*G.n));
}
fn flow_uv(slot:u32,p:vec3f)->vec3f{
  let n=f32(G.n);return vec3f(clamp(p.xy,vec2f(0.5/n),vec2f(1.0-0.5/n)),
    (f32(slot)*n+clamp(p.z*n,0.5,n-0.5))/(n*f32(G.slots)));
}
`);
export const gasFlowAdvectWgsl=makeModule('gas-flow-advect',/* wgsl */ `
@group(1) @binding(0) var velocity:texture_3d<f32>;
@group(1) @binding(1) var departure:texture_3d<f32>;
@group(1) @binding(2) var obstacles:texture_3d<f32>;
@group(1) @binding(3) var lin:sampler;
@group(1) @binding(4) var output:texture_storage_3d<rgba16float,write>;
@group(1) @binding(5) var<storage,read> geometry:array<vec4f>;
@compute @workgroup_size(4,4,4)
fn cs_flow(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=G.n || id.y>=G.n){return;}
  let slot=flow_slots[id.z/G.n];let p=vec3i(vec3u(id.xy,id.z%G.n));let at=flow_at(slot,p);
  if(textureLoad(obstacles,at,0).w< -0.5){textureStore(output,at,vec4f(0.0));return;}
  let uv=(vec3f(p)+0.5)/f32(G.n);
  let mid=uv-textureLoad(velocity,at,0).xyz*G.dt*0.5;
  var back=uv-textureSampleLevel(velocity,lin,flow_uv(slot,mid),0.0).xyz*G.dt;
  for(var k=1u;k<=8u;k++){
    if(textureLoad(obstacles,flow_at(slot,vec3i(floor(mix(uv,back,f32(k)*0.125)*f32(G.n)))),0).w< -0.5){back=uv;break;}
  }
  var d=textureSampleLevel(departure,lin,flow_uv(slot,back),0.0).xyz+back-uv;
  // Bound deformation to a fraction of the physical domain, preserving direction and continuity.
  let limit=min(0.22,3.0/max(geometry[slot*4u].w,0.001));
  d*=min(1.0,limit/max(length(d),0.00001));
  textureStore(output,at,vec4f(d,1.0));
}
`,[gasFlowCommonWgsl]);
export const gasFlowClearWgsl=makeModule('gas-flow-clear',/* wgsl */ `
@group(1) @binding(0) var a:texture_storage_3d<rgba16float,write>;
@group(1) @binding(1) var b:texture_storage_3d<rgba16float,write>;
@compute @workgroup_size(4,4,4)
fn cs_clear_flow(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=G.n || id.y>=G.n){return;}
  let at=flow_at(flow_slots[id.z/G.n],vec3i(vec3u(id.xy,id.z%G.n)));
  textureStore(a,at,vec4f(0.0));textureStore(b,at,vec4f(0.0));
}
`,[gasFlowCommonWgsl]);
