import { makeModule, tsConstCode } from '../../wgsl/module';
import { CLOUD_VISIBILITY } from './params';
import { cloudMathWgsl } from './math.wgsl';
import { CLOUD_FIELD_REGIONS, cloudQuatWgsl } from './field';

/** Shared by visible clouds AND world shadow bake. No camera input in physical density. */
export const cloudDensityWgsl = makeModule('cloud-density', /* wgsl */ `
${tsConstCode({ CLOUD_VISIBILITY_FEATHER: { value: CLOUD_VISIBILITY.feather, type: 'f32' }, CLOUD_LOCAL_TAU: { value: CLOUD_VISIBILITY.opticalDepth, type: 'f32' }, CLOUD_FLOW_START: { value: CLOUD_VISIBILITY.flowStart, type: 'f32' }, CLOUD_FLOW_END: { value: CLOUD_VISIBILITY.flowEnd, type: 'f32' }, CLOUD_FLOW_RELEASE: { value: CLOUD_VISIBILITY.flowRelease, type: 'f32' } })}
// False only in the pipeline the host selects while no damaged region exists: the field lookup it removes would add
// exactly nothing there.
override CLOUD_FLOW: bool = true;
/** Whether p lies in a damaged region of the persistent field (field.ts). */
fn cloud_field_near(cp: CloudParams, p: vec3f) -> bool {
  for (var i = 0u; i < min(${CLOUD_FIELD_REGIONS}u, u32(cp.field.z)); i++) {
    let r = cp.regions[i];
    if (dot(p - r.xyz, p - r.xyz) < r.w * r.w) { return true; }
  }
  return false;
}
// Density and real departure magnitude share the same field lookup.
fn cloud_density_flow(noise: texture_3d<f32>, ns: sampler, cp: CloudParams, p: vec3f, detail: bool) -> vec2f {
  return cloud_density_live(noise,ns,cp,p,detail,CLOUD_FLOW && cloud_field_near(cp,p));
}
// live is false only where no damaged region can reach p: there the departure is exactly 0 and the lookup stays at p.
// The deck is sampled in its own frame, turned by the wind so far (world = R · advected); the persistent field lives in
// that frame too, so blast damage drifts with the clouds it belongs to.
fn cloud_density_live(noise: texture_3d<f32>, ns: sampler, cp: CloudParams, p: vec3f, detail: bool, live: bool) -> vec2f {
  if(cp.weather.x<=0.0){return vec2f(0.0);}
  var displaced=cloud_qunrot(cp.wind,p);var compression=1.0;var moved=0.0;
  if(CLOUD_FLOW && live){
    let f=textureSampleLevel(cloud_field,ns,displaced/(2.0*cp.field.x)+0.5,0.0)*cp.control.w;
    displaced+=f.xyz; moved=length(f.xyz); compression=exp(f.w);
  }
  // Profile follows the departure point too: lifted cloud can cross the original
  // deck ceiling instead of being cut off by an undeformed radial shell.
  let h=(length(displaced)-cp.shell.y)/(cp.shell.z-cp.shell.y);
  if(h<=0.0 || h>=1.0){return vec2f(0.0);}
  let uvw = displaced * cp.weather.y + cp.seed.xyz;
  let weather = textureSampleLevel(noise, ns, uvw*0.27, 0.0);
  // A genuinely empty large-scale weather region is essential: adjusting only the
  // per-puff threshold eventually fills every long limb chord with a gray blanket.
  let cover = smoothstep(0.78-cp.weather.x*0.5, 0.92-cp.weather.x*0.5, weather.a);
  if(cover<0.001){return vec2f(0.0);}
  let kind = clamp(cp.weather.z + (weather.b-0.5)*0.5, 0.0, 1.0);
  let shape = textureSampleLevel(noise, ns, uvw, 0.0);
  // Per-puff tower height breaks the otherwise conspicuous concentric shell ceiling.
  let tower = mix(0.48,0.98,smoothstep(0.28,0.76,shape.r))*mix(0.75,1.0,cover);
  let cumulus = smoothstep(0.0, 0.12, h) * (1.0-smoothstep(tower*0.62,tower,h));
  let stratus = smoothstep(0.0,0.07,h) * (1.0-smoothstep(0.21,0.45,h));
  let high = smoothstep(0.64,0.76,h)*(1.0-smoothstep(0.86,1.0,h));
  let profile = mix(stratus,cumulus,kind) + high*cp.weather.w;
  // Smooth coverage threshold keeps thin boundaries from becoming binary stipple.
  let threshold = 0.38 + (0.5-cover)*0.1;
  var density = smoothstep(threshold, threshold+0.3, shape.r*0.72+shape.g*0.28) * profile * cover;
  if (detail && density > 0.001) {
    let d = textureSampleLevel(noise, ns, uvw*3.7 + shape.gba*0.12, 0.0);
    density = max(0.0, density - (1.0-d.b)*0.19*smoothstep(0.12,0.8,h));
  }
  return vec2f(density * cp.shell.w * clamp(compression,0.0,3.4),moved);
}
fn cloud_density(noise: texture_3d<f32>, ns: sampler, cp: CloudParams, p: vec3f, detail: bool) -> f32 {
  return cloud_density_flow(noise,ns,cp,p,detail).x;
}
// Local cloud optical depth is softened, never deleted. This actual 3D region is
// identical on sky/terrain rays and has no minimum distance from the camera.
fn cloud_play_visibility(cp: CloudParams, p: vec3f, departure:f32) -> f32 {
  // Let entrained clouds roll visibly with real fluid. Unmoved weather retains
  // the original protection; domain/lifetime fade also restores it smoothly.
  return (1.0-smoothstep(cp.focus.w,cp.focus.w+CLOUD_VISIBILITY_FEATHER,distance(p,cp.focus.xyz)))*(1.0-CLOUD_FLOW_RELEASE*smoothstep(CLOUD_FLOW_START,CLOUD_FLOW_END,departure));
}
`, [cloudMathWgsl, cloudQuatWgsl]);

/** One-time tileable 64³ noise bake; no megabyte bundled noise assets or per-frame procedural hash work. */
export const cloudNoiseWgsl = makeModule('cloud-noise', /* wgsl */ `
@group(0) @binding(0) var noise_out: texture_storage_3d<rgba8unorm, write>;
fn nh(p: vec3u) -> f32 {
  var h = p.x*374761393u + p.y*668265263u + p.z*2246822519u + 1013904223u;
  h = (h^(h>>13u))*1274126177u; h = h^(h>>16u);
  return f32(h & 16777215u)/16777215.0;
}
fn nv(p: vec3f, period: u32) -> f32 {
  let cell = vec3u(floor(p)); let f = fract(p); let u = f*f*(3.0-2.0*f);
  var sum = 0.0;
  for(var z=0u;z<2u;z++){for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
    let o=vec3u(x,y,z); let w=select(vec3f(1.0)-u,u,vec3<bool>(x!=0u,y!=0u,z!=0u));
    sum += nh((cell+o)%vec3u(period))*w.x*w.y*w.z;
  }}}
  return sum;
}
fn nw(p:vec3f,period:i32)->f32{
  let cell=vec3i(floor(p)); var nearest=10.0;
  for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let c=cell+vec3i(x,y,z); let wrapped=vec3u((c%vec3i(period)+vec3i(period))%vec3i(period));
    let feature=vec3f(c)+vec3f(nh(wrapped),nh(wrapped+vec3u(17u,53u,97u)),nh(wrapped+vec3u(71u,13u,29u)));
    let delta=feature-p; nearest=min(nearest,dot(delta,delta));
  }}}
  return clamp(1.0-sqrt(nearest),0.0,1.0);
}
@compute @workgroup_size(4,4,4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim=textureDimensions(noise_out); if(any(id>=dim)){return;}
  let p=(vec3f(id)+0.5)/vec3f(dim);
  let a=nv(p*8.0,8u); let b=nv(p*16.0,16u); let c=nv(p*32.0,32u);
  // Perlin/value-Worley hybrid gives the macro field rounded billows, with independent erosion.
  let billow=nw(p*8.0,8);
  textureStore(noise_out,vec3i(id),vec4f(clamp(a*0.8+billow*0.38-0.06,0.0,1.0),b,c,nv(p*4.0,4u)));
}
`);
