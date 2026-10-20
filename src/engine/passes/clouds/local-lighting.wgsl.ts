/** Punctual cloud scattering from the existing 64-light scene pool, with bounded per-ray selection.
 * Sources retain their real positions, radiance, range and cone. All local cloud lighting casts shadows,
 * including transient flashes whose surface lighting does not request a shadow-map allocation. */
import { makeModule } from '../../wgsl/module';
import type { LightInit, Vec3 } from '../../contracts';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { lightAttenuation, lightsWgsl } from '../../scene/lights';
import { sdfWgsl } from '../sdf/sdf.wgsl';
import { sdfCastersWgsl } from '../sdf/sdf-casters';
import { fogParamsBindingWgsl } from '../fog-of-war/fog.wgsl';
import { cloudDensityWgsl } from './density.wgsl';
import { punctualVolumeWgsl } from '../volumetrics/punctual.wgsl';

/** Host provides its existing world SDF and sampler (bindings 10–12). These bindings are additive. */
export const CLOUD_LOCAL_BINDINGS = { lights: 13, casterAtlas: 14, casterList: 15, visibility: 16, fog: 17 } as const;

export const cloudLocalLightingWgsl = makeModule('cloud-local-lighting', /* wgsl */ `
@group(1) @binding(13) var<storage,read> cloud_light_list: LightList;
@group(1) @binding(16) var cloud_visibility: texture_3d<f32>;
// span: hull of the ray's chords through the admitted lights' range spheres; outside it every selected light is out of range.
struct CloudLocalSelection { index: vec4u, score: vec4f, span: vec2f }
fn cloud_local_seen(p:vec3f)->f32{
  return punctual_seen(cloud_visibility,p);
}
// Maximum cone cosine over a finite ray segment. Testing only its closest point
// would discard beams that enter the cone farther along the cloud ray.
fn cloud_local_cone_max(o:vec3f,rd:vec3f,axis:vec3f,lo:f32,hi:f32)->f32{
  let a=dot(axis,rd);let b=dot(o,rd);let c=dot(axis,o);let d=dot(o,o);
  let v0=o+rd*lo;let v1=o+rd*hi;
  var result=max(dot(axis,v0)/max(length(v0),0.00001),dot(axis,v1)/max(length(v1),0.00001));
  let denom=a*b-c;
  if(abs(denom)>0.000001){
    let t=clamp((c*b-a*d)/denom,lo,hi);let v=o+rd*t;
    result=max(result,dot(axis,v)/max(length(v),0.00001));
  }
  return result;
}
fn cloud_local_select(ro:vec3f,rd:vec3f,bands:array<vec2f,2>)->CloudLocalSelection{
  var result:CloudLocalSelection;result.span=vec2f(1e30,-1e30);
  let budget=min(4u,max(2u,frame_tier()+1u));
  for(var j=0u;j<min(cloud_light_list.header.x,MAX_LIGHTS);j++){
    let l=cloud_light_list.lights[j];let range=l.position_range.w;
    if((l.params.y&1u)==0u || range<=0.0){continue;}
    let power=max(l.color_intensity.r,max(l.color_intensity.g,l.color_intensity.b));
    if(power<=0.0){continue;}
    let o=ro-l.position_range.xyz;let b=dot(o,rd);let lateral=o-rd*b;
    let disc=range*range-dot(lateral,lateral);if(disc<=0.0){continue;}
    let root=sqrt(disc);var score=0.0;
    for(var band=0u;band<2u;band++){
      let lo=max(bands[band].x,-b-root);let hi=min(bands[band].y,-b+root);
      if(hi<=lo){continue;}
      var angular=1.0;
      if(l.params.x==LIGHT_TYPE_SPOT){
        let cones=unpack_cone_cosines(l.params.z);
        let c=cloud_local_cone_max(o,rd,l.direction.xyz,lo,hi);
        angular=clamp((c-cones.y)/max(cones.x-cones.y,0.0001),0.0,1.0);
      }
      let delta=o+rd*clamp(-b,lo,hi);
      score=max(score,power*light_attenuation(max(dot(delta,delta),0.09),range)*angular);
    }
    if(score<=0.00001 || cloud_local_seen(l.position_range.xyz)<0.95){continue;}
    result.span=vec2f(min(result.span.x,-b-root),max(result.span.y,-b+root));
    var index=j;
    for(var k=0u;k<budget;k++){
      if(score>result.score[k]){
        let old=result.score[k];let oldIndex=result.index[k];
        result.score[k]=score;result.index[k]=index;score=old;index=oldIndex;
      }
    }
  }
  return result;
}
fn cloud_local_radiance(selected:CloudLocalSelection,p:vec3f,rd:vec3f,
                        noise:texture_3d<f32>,ns:sampler,cp:CloudParams)->vec3f{
  if(selected.score.x<=0.0){return vec3f(0.0);}
  let seen=cloud_local_seen(p);if(seen<=0.05){return vec3f(0.0);}
  var result=vec3f(0.0);
  for(var k=0u;k<4u;k++){
    if(selected.score[k]<=0.0){break;}
    let l=cloud_light_list.lights[selected.index[k]];
    let delta=l.position_range.xyz-p;let d2=dot(delta,delta);let range=l.position_range.w;
    if(d2>=range*range || d2<0.0001){continue;}
    let distance=sqrt(d2);let ld=delta/distance;var cone=1.0;
    if(l.params.x==LIGHT_TYPE_SPOT){
      let c=unpack_cone_cosines(l.params.z);cone=spot_falloff(-ld,l.direction.xyz,c.x,c.y);
    }
    if(cone<=0.0){continue;}
    // The terrain trace is 0 or 1, so the product does not depend on the order; a flash inside a tank fails the cheaper
    // caster test first.
    var vis=casters_vis_point_emitter(p,l.position_range.xyz,vec3f(0.025,0.015,0.10),l.params.w);
    if(vis>0.0){vis*=punctual_world_visible(p,l.position_range.xyz);}
    if(vis<=0.0){continue;}
    // Local cloud self-extinction, bounded to 2/3/4/4 density lookups per admitted source.
    let n=min(4u,frame_tier()+2u);let ds=distance/f32(n);var tau=0.0;
    for(var j=0u;j<n;j++){tau+=cloud_density(noise,ns,cp,p+ld*((f32(j)+0.5)*ds),false)*ds;}
    let phase=punctual_phase(dot(rd,ld),0.35);
    result+=l.color_intensity.rgb*(light_attenuation(max(d2,0.09),range)*cone*vis*seen*exp(-tau)*phase);
  }
  return result;
}
`, [frameWgsl,lightsWgsl,sdfWgsl,sdfCastersWgsl(1,14,15),fogParamsBindingWgsl(1,17),cloudDensityWgsl,punctualVolumeWgsl]);

/** CPU oracle for geometric admission tests and capture fixtures; shader uses packed scene-light values. */
export function cloudLocalConeMaximum(origin: Vec3, direction: Vec3, axis: Vec3, lo: number, hi: number): number {
  const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const a=dot(axis,direction),b=dot(origin,direction),c=dot(axis,origin),d=dot(origin,origin);
  const cosine=(t:number)=>{const v=origin.map((x,i)=>x+direction[i]*t) as Vec3;return dot(axis,v)/Math.max(Math.hypot(...v),1e-5);};
  const denom=a*b-c;
  return Math.max(cosine(lo),cosine(hi),Math.abs(denom)>1e-6?cosine(Math.max(lo,Math.min(hi,(c*b-a*d)/denom))):-1);
}
export function cloudLocalRayScore(light: LightInit, origin: Vec3, direction: Vec3, bands: readonly (readonly [number,number])[], seen=1): number {
  const power=Math.max(...light.color)*light.intensity,range=light.range;
  if(range<=0 || power<=0 || seen<.95)return 0;
  const o=origin.map((x,i)=>x-light.position[i]) as Vec3,b=o.reduce((s,x,i)=>s+x*direction[i],0);
  const disc=range*range-o.reduce((s,x,i)=>s+(x-direction[i]*b)**2,0);if(disc<=0)return 0;
  const root=Math.sqrt(disc);let result=0;
  for(const band of bands){
    const lo=Math.max(band[0],-b-root),hi=Math.min(band[1],-b+root);if(hi<=lo)continue;
    let angular=1;
    if(light.type==='spot'){
      const direction0=light.direction??[0,-1,0],length=Math.hypot(...direction0)||1,axis=direction0.map(x=>x/length) as Vec3;
      const outer=light.outerAngle??Math.PI/4,inner=Math.min(light.innerAngle??outer*.8,outer);
      angular=Math.max(0,Math.min(1,(cloudLocalConeMaximum(o,direction,axis,lo,hi)-Math.cos(outer))/Math.max(Math.cos(inner)-Math.cos(outer),1e-4)));
    }
    const t=Math.max(lo,Math.min(hi,-b)),d2=o.reduce((s,x,i)=>s+(x+direction[i]*t)**2,0);
    result=Math.max(result,power*lightAttenuation(Math.max(d2,.09),range)*angular);
  }
  return result;
}
