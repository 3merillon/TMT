/** One 16³ quadrature per live blast, reduced to its actual emission centroid and RGB power.
 * The same simulated heat, detail erosion, obstacles, boundary fade and flame response drive the visible gas.
 * Only light records reserved by the CPU are written; no readback, light proxy outside the existing pool, or history. */
import { makeModule } from '../../wgsl/module';
import { lightsWgsl } from '../../scene/lights';
import { gasEmissionProfileWgsl } from './gas-emission-profile.wgsl';

export const gasEmissionWgsl = makeModule('gas-emission', /* wgsl */ `
struct GasEmissionSource {
  center:vec4f, right:vec4f, up:vec4f, fwd:vec4f,
  control:vec4f, // packed light index, atlas slot, fade, steam
  look:vec4f, // n, slot count, sim age, emission scale
}
@group(0) @binding(0) var<storage,read> sources:array<GasEmissionSource>;
@group(0) @binding(1) var field:texture_3d<f32>;
@group(0) @binding(2) var obstacles:texture_3d<f32>;
@group(0) @binding(3) var noise:texture_3d<f32>;
@group(0) @binding(4) var lin:sampler;
@group(0) @binding(5) var rep:sampler;
@group(0) @binding(6) var<storage,read_write> light_list:LightList;
var<workgroup> moments:array<vec4f,128>;
var<workgroup> emission:array<vec4f,128>;
fn emission_uv(slot:f32,n:f32,count:f32,p:vec3f)->vec3f{
  return vec3f(clamp(p.xy,vec2f(0.0),vec2f(1.0)),(slot*n+clamp(p.z*n,0.5,n-0.5))/(n*count));
}
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let source=sources[group.x];let index=u32(source.control.x);
  var moment=vec4f(0.0);var power=vec4f(0.0);
  if(source.control.z>0.0 && source.control.w<1.0){
    for(var cell=lane;cell<4096u;cell+=128u){
      let p=(vec3f(f32(cell%16u),f32((cell/16u)%16u),f32(cell/256u))+0.5)/16.0;
      let tex=emission_uv(source.control.y,source.look.x,source.look.y,p);
      let solid=smoothstep(-0.55,0.05,textureSampleLevel(obstacles,lin,tex,0.0).w);
      let fade=(1.0-smoothstep(0.32,0.48,length(p.xz-vec2f(0.5))))
        *(1.0-smoothstep(0.76,0.98,p.y))*smoothstep(0.0,0.025,p.y)*solid;
      if(fade<=0.0){continue;}
      let drift=vec3f(0.03,-0.55,0.07)*source.look.z;
      let nz=textureSampleLevel(noise,rep,p*6.0+drift,0.0);
      let nz2=textureSampleLevel(noise,rep,p*16.2+drift*1.9+nz.yzw*0.4,0.0);
      let detail=mix(nz.x,nz2.x,0.4);let erosion=(1.0-detail)*0.6;
      let f=textureSampleLevel(field,lin,emission_uv(source.control.y,source.look.x,source.look.y,p+(nz.yzw-0.5)*0.12),0.0);
      let heat=gas_flame_heat(f.y,erosion,fade,source.control.w);
      let rgb=gas_flame_ramp(heat)*smoothstep(0.04,0.35,heat)*(0.5+detail);
      let weight=dot(rgb,vec3f(0.2126,0.7152,0.0722));
      let q=(p-0.5)*source.center.w;
      moment+=vec4f(q*weight,weight);power+=vec4f(rgb,dot(q,q)*weight);
    }
  }
  moments[lane]=moment;emission[lane]=power;workgroupBarrier();
  for(var stride=64u;stride>0u;stride/=2u){
    if(lane<stride){moments[lane]+=moments[lane+stride];emission[lane]+=emission[lane+stride];}
    workgroupBarrier();
  }
  if(lane==0u){
    let m=moments[0];let e=emission[0];let q=m.xyz/max(m.w,0.00001);
    let radius=sqrt(max(0.0,e.w/max(m.w,0.00001)-dot(q,q)));
    // Flame rolling along the ground puts the centroid at (or under) the surface it burns on: a point light there threw
    // every tank and bump's shadow across the field. Lift it into the flames' body.
    let center=source.center.xyz+source.right.xyz*q.x+source.up.xyz*(q.y+clamp(radius*0.6,0.3,2.0))+source.fwd.xyz*q.z;
    // The raymarch integrates in domain widths: integrated world emission therefore scales with edge².
    let rgb=e.rgb*(source.look.w*source.center.w*source.center.w/4096.0)*source.control.z;
    light_list.lights[index].position_range=vec4f(center,min(40.0,max(3.0,radius*4.0+2.0)));
    light_list.lights[index].color_intensity=vec4f(rgb,0.0);
    // The emission's spread makes this an area light: lighting softens its shadows to match (light_penumbra).
    light_list.lights[index].direction=vec4f(source.up.xyz,radius);
  }
}
`,[lightsWgsl,gasEmissionProfileWgsl]);
