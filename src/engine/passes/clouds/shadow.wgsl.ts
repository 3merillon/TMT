import { makeModule } from '../../wgsl/module';
import { cloudMathWgsl } from './math.wgsl';
import { cloudFieldBindingWgsl } from './field';
import { cloudDensityWgsl } from './density.wgsl';

/** Whole-sphere, planet-anchored cumulative opacity; Planets' four radial knots adapted to miniature units. */
export const cloudShadowSampleWgsl = makeModule('cloud-shadow-sample', /* wgsl */ `
fn cloud_shadow_visibility(tex: texture_cube<f32>, samp: sampler, cp: CloudParams, world: vec3f) -> f32 {
  if(cp.control.x<0.5 || cp.control.y<0.5){return 1.0;}
  let bounds=cloud_bounds(cp);let r=length(world);if(r>=bounds.y){return 1.0;}
  let b=dot(world,cp.sun.xyz); let t=-b+sqrt(max(0.0,b*b-(r-bounds.y)*(r+bounds.y)));
  let profile=textureSampleLevel(tex,samp,normalize(world+cp.sun.xyz*t),0.0);
  let x=clamp((bounds.y-r)/(bounds.y-bounds.x),0.0,1.0)*4.0;
  let w=clamp(vec4f(x)-vec4f(0.0,1.0,2.0,3.0),vec4f(0.0),vec4f(1.0));
  let occ=dot(w,vec4f(profile.x,profile.y-profile.x,profile.z-profile.y,profile.w-profile.z));
  return max(cp.tint.w,1.0-occ);
}
`, [cloudMathWgsl]);

export const cloudShadowBakeWgsl = makeModule('cloud-shadow-bake', /* wgsl */ `
@group(0) @binding(0) var<uniform> cp: CloudParams;
@group(0) @binding(1) var noise: texture_3d<f32>;
@group(0) @binding(2) var ns: sampler;
@group(0) @binding(3) var shadow_out: texture_storage_2d_array<rgba16float,write>;
fn cloud_face(face:u32,uv:vec2f)->vec3f{
  switch(face){
    case 0u:{return normalize(vec3f(1.0,-uv.y,-uv.x));}
    case 1u:{return normalize(vec3f(-1.0,-uv.y,uv.x));}
    case 2u:{return normalize(vec3f(uv.x,1.0,uv.y));}
    case 3u:{return normalize(vec3f(uv.x,-1.0,-uv.y));}
    case 4u:{return normalize(vec3f(uv.x,-uv.y,1.0));}
    default:{return normalize(vec3f(-uv.x,-uv.y,-1.0));}
  }
}
fn cloud_shadow_t(b:f32,r:f32)->f32{
  let top=cloud_bounds(cp).y;return max(0.0,b-sqrt(max(0.0,b*b-(top-r)*(top+r))));
}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
  let dim=textureDimensions(shadow_out); if(any(id.xy>=dim)){return;}
  let dir=cloud_face(id.z,(vec2f(id.xy)+0.5)/vec2f(dim)*2.0-1.0);
  var knots=vec4f(0.0);
  if(cp.control.x>0.5 && cp.control.y>0.5 && dot(dir,cp.sun.xyz)>0.0){
    let bounds=cloud_bounds(cp);let q=dir*bounds.y; let b=dot(q,cp.sun.xyz);
    // The deck around the gameplay focus is softened in view (cloud_play_visibility); its shadow follows the same rule,
    // so no dark blotch falls from cloud the player cannot see.
    var far=0.0; var local=0.0; var start=0.0;
    let n=max(2u,min(32u,u32(ceil(cp.quality.z*(bounds.y-bounds.x)/(cp.shell.z-cp.shell.y)/4.0))));
    for(var knot=0u;knot<4u;knot++){
      let r=mix(bounds.y,bounds.x,f32(knot+1u)*0.25);
      let end=cloud_shadow_t(b,r); let ds=(end-start)/f32(n);
      for(var i=0u;i<n;i++){
        let p=q-cp.sun.xyz*(start+(f32(i)+0.5)*ds);
        let sample=cloud_density_flow(noise,ns,cp,p,false);
        let protect=cloud_play_visibility(cp,p,sample.y);
        far+=sample.x*ds*(1.0-protect); local+=sample.x*ds*protect;
      }
      knots[knot]=1.0-exp(-(far+CLOUD_LOCAL_TAU*(1.0-exp(-local/CLOUD_LOCAL_TAU)))); start=end;
    }
  }
  textureStore(shadow_out,vec2i(id.xy),i32(id.z),knots);
}
`,[cloudDensityWgsl,cloudFieldBindingWgsl(0,4)]);
