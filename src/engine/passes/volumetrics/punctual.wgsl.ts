/** Shared air-sample visibility and phase for haze and cloud punctual scattering.
 * Host binds fog_params, its visibility texture, and the existing world SDF. */
import { makeModule } from '../../wgsl/module';
import { sdfWgsl } from '../sdf/sdf.wgsl';

export const punctualWorldVisibilityWgsl = makeModule('punctual-world-visibility', /* wgsl */ `
fn punctual_world_visible(p:vec3f,source:vec3f)->f32{
  if(!sdf_valid()){return 0.0;}
  let delta=source-p;let distance=length(delta);if(distance<0.025){return 1.0;}
  let rd=delta/distance;var t=0.015;
  for(var i=0u;i<32u;i++){
    if(t>=distance){return 1.0;}
    let d=sdf_sample(p+rd*t);if(d<0.01){return 0.0;}
    t+=clamp(d*0.85,0.015,1.0);
  }
  // Unknown or exhausted air paths cannot leak a local light through terrain.
  return select(0.0,1.0,t>=distance);
}
`, [sdfWgsl]);

export const punctualVolumeWgsl = makeModule('punctual-volume', /* wgsl */ `
fn punctual_phase(mu:f32,g:f32)->f32{
  let d=max(1.0+g*g-2.0*g*mu,0.001);
  return (1.0-g*g)/(12.5663706*d*sqrt(d));
}
fn punctual_seen(visibility:texture_3d<f32>,p:vec3f)->f32{
  if(fog_params.settings.x<0.5){return 1.0;}
  let uvw=p*(0.5/max(fog_params.volume.y,1.0))+0.5;
  if(any(uvw<vec3f(0.0)) || any(uvw>vec3f(1.0))){return 0.0;}
  return 1.0-textureSampleLevel(visibility,sdf_sampler,uvw,0.0).r;
}
`, [punctualWorldVisibilityWgsl]);
