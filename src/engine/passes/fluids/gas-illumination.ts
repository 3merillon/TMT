/** Smoke receives world illumination; heat remains a separate emissive term. */
import type { EngineServices } from '../../contracts';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { ShaderStage } from '../../gpu/flags';
import { makeModule } from '../../wgsl/module';
import { lightsWgsl } from '../../scene/lights';
import { atmosphereBindingsWgsl, atmosphereFnWgsl } from '../atmosphere/integrate.wgsl';
import { skyLightBindingsWgsl, skyLightFnWgsl } from '../lighting/sky-light';
import { sdfBindingsWgsl } from '../sdf/sdf.wgsl';
import { sdfCastersWgsl } from '../sdf/sdf-casters';
import { cloudShadowSampleWgsl } from '../clouds/shadow.wgsl';
import { punctualVolumeWgsl } from '../volumetrics/punctual.wgsl';

export const gasIlluminationWgsl = makeModule('gas-illumination', /* wgsl */ `
@group(2) @binding(3) var<storage,read> gas_lights: LightList;
@group(2) @binding(12) var gas_cloud_shadow: texture_cube<f32>;
@group(2) @binding(13) var<uniform> gas_cloud_params: CloudParams;
struct GasIllumination { sun:vec3f, fill:vec3f }
/** One bit per light that can light some point of the ray segment o + rd·[ta, tb]: on, bright, in range of the segment
 *  (with a margin for rounding), and seen by the fog of war. A light outside the set fails gas_illumination's tests at
 *  every sample, so iterating the set gives the same choice. */
fn gas_light_candidates(o:vec3f,rd:vec3f,ta:f32,tb:f32)->vec2u{
  var found=vec2u(0u);
  for(var j=0u;j<min(gas_lights.header.x,MAX_LIGHTS);j++){
    let l=gas_lights.lights[j];
    if((l.params.y&1u)==0u || max(l.color_intensity.r,max(l.color_intensity.g,l.color_intensity.b))<=0.0){continue;}
    let q=o+rd*clamp(dot(l.position_range.xyz-o,rd),ta,tb)-l.position_range.xyz;
    if(dot(q,q)>=l.position_range.w*l.position_range.w*1.002+0.001 || punctual_seen(fog_volume,l.position_range.xyz)<0.95){continue;}
    found[j>>5u]|=1u<<(j&31u);
  }
  return found;
}
fn gas_illumination(p:vec3f,rd:vec3f,candidates:vec2u)->GasIllumination{
  var out:GasIllumination;
  let up=p/max(length(p),0.0001);
  let sunvis=atmo_terrain_lit(p,frame.sun_dir,smoothstep(-0.02,0.02,dot(up,frame.sun_dir)));
  if(sunvis>0.0){
    out.sun=frame.sun_radiance*atmo_sun_color(p)*sunvis
      *casters_vis_dir(p,frame.sun_dir,0.035)
      *cloud_shadow_visibility(gas_cloud_shadow,sdf_sampler,gas_cloud_params,p);
  }
  // The same altitude/solar-angle sky as the terrain. No global sun-powered ambient floor at night.
  if(sky_light_valid()){out.fill=sky_irradiance(p,up,up,frame.sun_dir)*0.318309886;}
  var indices=vec2u(0u);var scores=vec2f(0.0);
  for(var w=0u;w<2u;w++){
    var bits=candidates[w];
    while(bits!=0u){
      let j=w*32u+firstTrailingBit(bits);bits&=bits-1u;
      let l=gas_lights.lights[j];let delta=l.position_range.xyz-p;let d2=dot(delta,delta);
      if(d2>=l.position_range.w*l.position_range.w){continue;}
      var cone=1.0;
      if(l.params.x==LIGHT_TYPE_SPOT){let c=unpack_cone_cosines(l.params.z);cone=spot_falloff(-delta/max(sqrt(d2),0.0001),l.direction.xyz,c.x,c.y);}
      let score=max(l.color_intensity.r,max(l.color_intensity.g,l.color_intensity.b))*light_attenuation(max(d2,0.09),l.position_range.w)*cone;
      if(score<=scores.y){continue;}
      if(score>scores.x){scores.y=scores.x;indices.y=indices.x;scores.x=score;indices.x=j;}
      else{scores.y=score;indices.y=j;}
    }
  }
  for(var k=0u;k<2u;k++){
    if(scores[k]<=0.0){break;}
    let l=gas_lights.lights[indices[k]];let delta=l.position_range.xyz-p;let distance2=dot(delta,delta);let d2=max(distance2,0.09);let ld=delta*inverseSqrt(max(distance2,0.000001));
    var cone=1.0;
    if(l.params.x==LIGHT_TYPE_SPOT){let c=unpack_cone_cosines(l.params.z);cone=spot_falloff(-ld,l.direction.xyz,c.x,c.y);}
    var vis=punctual_world_visible(p,l.position_range.xyz);
    if(vis>0.0){vis*=casters_vis_point_emitter(p,l.position_range.xyz,vec3f(0.025,0.015,0.10),l.params.w);}
    out.fill+=l.color_intensity.rgb*(light_attenuation(d2,l.position_range.w)*cone*vis*punctual_phase(dot(rd,ld),0.25));
  }
  return out;
}
`, [lightsWgsl, atmosphereFnWgsl,
  sdfBindingsWgsl(2, { volume: 0, params: 1, sampler: 2 }), sdfCastersWgsl(2, 4, 5),
  atmosphereBindingsWgsl(2, { params: 6, transmittance: 7, multiscatter: 8, sampler: 14 }, true),
  skyLightBindingsWgsl(2, { params: 9, atlas: 10, cube: 11 }), skyLightFnWgsl, cloudShadowSampleWgsl, punctualVolumeWgsl]);

/** All lighting resources are borrowed; the cache follows resize and scene-resource replacement. */
export class GasIllumination {
  readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly groups = new BindGroupResourceCache(2);
  constructor(private readonly s: EngineServices) {
    const visibility = ShaderStage.FRAGMENT;
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type: 'uniform' } });
    const tex = (binding: number, viewDimension: GPUTextureViewDimension = '2d'): GPUBindGroupLayoutEntry => ({ binding, visibility, texture: { sampleType: 'float', viewDimension } });
    this.layout = s.ctx.device.createBindGroupLayout({ label: 'gas:illumination', entries: [tex(0, '3d'), uniform(1),
      { binding: 2, visibility, sampler: { type: 'filtering' } }, { binding: 3, visibility, buffer: { type: 'read-only-storage' } },
      tex(4, '3d'), uniform(5), uniform(6), tex(7), tex(8), uniform(9), tex(10), tex(11, 'cube'), tex(12, 'cube'), uniform(13),
      { binding: 14, visibility, sampler: { type: 'filtering' } }] });
    this.sampler = s.ctx.device.createSampler({ label: 'gas:light-sampler', minFilter: 'linear', magFilter: 'linear' });
  }
  group(): GPUBindGroup {
    const { s } = this, sdf = s.bindings.get('sdf'), atmo = s.bindings.get('atmosphere'), sky = s.bindings.get('skyLight'), cloud = s.bindings.get('cloudShadow');
    const casters = s.scene.get('sdfCasters');
    if (!casters) throw new Error('Gas illumination requires SDF casters.');
    const resources: GPUBindingResource[] = [sdf.volume, sdf.params, this.sampler, s.bindings.get('lights').list,
      casters.atlasView, { buffer: casters.listBuffer }, atmo.params, atmo.transmittance, atmo.multiscatter, sky.sh, sky.dfg, sky.cube,
      cloud.cube, cloud.params, this.sampler];
    const key = this.groups.begin(); for (const r of resources) pushBindingKey(key, r);
    return this.groups.get(() => s.ctx.device.createBindGroup({ label: 'gas:illumination', layout: this.layout, entries: resources.map((resource, binding) => ({ binding, resource })) }));
  }
}
