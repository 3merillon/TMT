/** Planets lens-flare / sun-shafts reference adapted to TMT's reversed-Z and post-TAA composite.
 * The source is measured from the resolved image. Lens effects never write the scene or TAA history.
 * Sun shafts: a small 'sun window' mask (OPTICS_MASK_SIZE², the square of 1.5 sun radii around the disc) is captured
 * from the resolved scene BEFORE the overlays (the trajectory and rings never occlude the sun), its depth read
 * jitter-corrected and 2×2 supersampled; the composite marches only the part of each pixel's ray that crosses the
 * window, bilinearly, so an occluder casts smooth rays instead of a few stamped low-resolution copies of itself. */
import type { EngineServices, FrameState, LightInit } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { fogParamsBindingWgsl } from '../fog-of-war/fog.wgsl';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { TAA_TEXTURE } from './taa';

export const OPTICS_SOURCE_BYTES = 96;
/** Texels per side of the sun-window mask the shafts march through. */
export const OPTICS_MASK_SIZE = 64;
/** 48 centre-weighted disc samples of lighting.sun_disc at its default radiance30,
 * before atmospheric/cloud attenuation. Avoids a saturation plateau during partial occlusion. */
export const SUN_OPTICAL_REFERENCE = 54.04;
export const OPTICS_PARAMS = wgslStruct('OpticsParams', [
  ['sun', 'vec4f'], // uv, radius in screen-height units, strength
  ['control', 'vec4f'], // aspect, reserved, reference sun luminance, flare/rays bitmask
  ['local_screen', { array: 'vec4f', count: 2 }], // uv, view-depth, strength
  ['local_color', { array: 'vec4f', count: 2 }], // linear optic tint, radius
  ['local_world', { array: 'vec4f', count: 2 }],
]);
export interface OpticalProjection { uv: [number, number]; inFront: boolean; viewDepth: number }
export function projectOpticalSource(m: ArrayLike<number>, p: readonly number[], direction = false): OpticalProjection {
  const w0 = direction ? 0 : 1;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w0;
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w0;
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * w0;
  if (!(w > 1e-6) || !Number.isFinite(x + y + w)) return { uv: [0, 0], inFront: false, viewDepth: 0 };
  return { uv: [0.5 + x / w * 0.5, 0.5 - y / w * 0.5], inFront: true, viewDepth: w };
}
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Admit an on-screen direction. Actual depth and resolved radiance decide occlusion,
 * including excavated views beneath the planet's nominal radius. */
export function sunOpticalVisibility(f: Pick<FrameState, 'eye' | 'sunDir' | 'viewProjNoJitter' | 'display'>): number {
  const p = projectOpticalSource(f.viewProjNoJitter, f.sunDir, true);
  if (!p.inFront) return 0;
  const aspect = f.display[0] / Math.max(1, f.display[1]);
  const edge = Math.min(p.uv[0] * aspect, (1 - p.uv[0]) * aspect, p.uv[1], 1 - p.uv[1]);
  return smooth(-0.06, 0.03, edge);
}
/** The emitter must face the camera within the real outer cone, and its light must be active. */
export function localOpticalStrength(light: Readonly<LightInit>, eye: readonly number[]): number {
  if (light.type !== 'spot' || !(light.intensity > 0) || !light.direction || !(light.range > 0)) return 0;
  const delta = eye.map((v, i) => v - light.position[i]); const distance = Math.hypot(...delta);
  if (distance < 0.05 || distance > light.range * 3) return 0;
  const dl = Math.hypot(...light.direction) || 1;
  const mu = delta.reduce((s, v, i) => s + v * light.direction![i], 0) / (distance * dl);
  const outer = Math.cos(light.outerAngle ?? Math.PI / 4), inner = Math.cos(light.innerAngle ?? (light.outerAngle ?? Math.PI / 4) * 0.8);
  return smooth(outer, Math.max(inner, outer + 1e-4), mu) * Math.min(1, light.intensity / 7.5) / (1 + distance * distance * 0.03);
}

const sourceStruct = makeModule('optics-source-struct', /* wgsl */ `
struct OpticalSource { screen: vec4f, color: vec4f }
struct OpticalSources { source: array<OpticalSource, 3> }
`);
export const opticsSourceWgsl = makeModule('optics-source', /* wgsl */ `
@group(1) @binding(0) var optical_scene: texture_2d<f32>;
@group(1) @binding(1) var optical_sampler: sampler;
@group(1) @binding(2) var optical_depth: texture_depth_2d;
@group(1) @binding(3) var<uniform> op: OpticsParams;
@group(1) @binding(4) var<storage, read_write> sources: OpticalSources;
@group(1) @binding(5) var optical_fog: texture_3d<f32>;
@group(1) @binding(7) var optical_mask_out: texture_storage_2d<rgba16float, write>;
fn optical_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126,0.7152,0.0722)); }
fn optical_depth_at(uv: vec2f) -> f32 {
  // Scene depth is jittered; resolved colour and emitter projections are unjittered.
  let jitter_uv = vec2f(frame.jitter.x,-frame.jitter.y)*0.5;
  let size=textureDimensions(optical_depth); let px=clamp(vec2i((uv+jitter_uv)*vec2f(size)),vec2i(0),vec2i(size)-1);
  return textureLoad(optical_depth,px,0);
}
/** The bright sky behind the sun window (shaft source), from the resolved scene before overlays. */
@compute @workgroup_size(8,8,1)
fn mask(@builtin(global_invocation_id) gid: vec3u) {
  if(gid.x>=${OPTICS_MASK_SIZE}u||gid.y>=${OPTICS_MASK_SIZE}u){return;}
  let aspect=max(op.control.x,0.1); let window=op.sun.z*1.5;
  var sum=vec3f(0.0);
  for(var j=0u;j<4u;j++){
    let sub=(vec2f(gid.xy)+vec2f(f32(j&1u),f32(j>>1u))*0.5+0.25)/${OPTICS_MASK_SIZE}.0*2.0-1.0;
    let uv=op.sun.xy+sub*window/vec2f(aspect,1.0);
    let edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
    let sr=length(sub)*window;
    if(edge<=0.0||sr>window||optical_depth_at(uv)>0.0){continue;}
    let c=textureSampleLevel(optical_scene,optical_sampler,uv,0.0).rgb; let l=optical_luma(c);
    sum+=c*(max(l-8.0,0.0)/max(l,0.001))*smoothstep(0.0,0.025,edge)*(1.0-smoothstep(op.sun.z,window,sr));
  }
  textureStore(optical_mask_out,vec2i(gid.xy),vec4f(min(sum*0.25,vec3f(60000.0)),1.0));
}
@compute @workgroup_size(1,1,1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index=gid.x; if(index>=3u){return;}
  sources.source[index].screen=vec4f(0.0); sources.source[index].color=vec4f(0.0);
  if(op.control.w<0.5){return;}
  let aspect=max(op.control.x,0.1);
  if(index==0u){
    if(op.sun.w<=0.0){return;}
    var background=vec3f(0.0); var bw=0.0;
    for(var j=0u;j<12u;j++){
      let a=f32(j)*0.52359878;
      let uv=op.sun.xy+vec2f(cos(a)/aspect,sin(a))*op.sun.z*1.8;
      if(any(uv<vec2f(0.0))||any(uv>vec2f(1.0))){continue;}
      background+=textureSampleLevel(optical_scene,optical_sampler,uv,0.0).rgb; bw+=1.0;
    }
    background/=max(bw,1.0);
    var sum=vec3f(0.0); var weight=0.0;
    for(var j=0u;j<48u;j++){
      let radius=sqrt((f32(j)+0.5)/48.0); let angle=f32(j)*2.39996323;
      let uv=op.sun.xy+vec2f(cos(angle)/aspect,sin(angle))*op.sun.z*radius;
      if(any(uv<vec2f(0.0))||any(uv>vec2f(1.0))){continue;}
      let w=1.0-0.65*radius*radius; weight+=w;
      if(optical_depth_at(uv)>0.0){continue;}
      let rgb=textureSampleLevel(optical_scene,optical_sampler,uv,0.0).rgb;
      sum+=max(rgb-background,vec3f(0.0))*w;
    }
    let mean=sum/max(weight,0.001); let luma=optical_luma(mean);
    let coverage=clamp(luma/max(op.control.z,0.001),0.0,1.0);
    let tint=clamp(mean/max(luma,0.001),vec3f(0.0),vec3f(2.0));
    sources.source[0].screen=vec4f(op.sun.xyz,op.sun.w*coverage);
    sources.source[0].color=vec4f(tint,op.control.w);
  }else{
    let k=index-1u; let src=op.local_screen[k]; if(src.w<=0.0){return;}
    if(fog_params.settings.x>0.5){
      let uvw=op.local_world[k].xyz*(0.5/max(fog_params.volume.y,1.0))+0.5;
      if(any(uvw<vec3f(0.0))||any(uvw>vec3f(1.0))){return;}
      if(textureSampleLevel(optical_fog,optical_sampler,uvw,0.0).r>0.05){return;}
    }
    // Subtract the local image background: a bright foreground cloud must not masquerade as a lamp.
    var local_background=0.0;
    for(var j=0u;j<8u;j++){
      let angle=f32(j)*0.78539816;
      let uv=src.xy+vec2f(cos(angle)/aspect,sin(angle))*op.local_color[k].w*1.8;
      local_background+=optical_luma(textureSampleLevel(optical_scene,optical_sampler,uv,0.0).rgb)/8.0;
    }
    var visible=0.0; var brightness=0.0;
    for(var j=0u;j<9u;j++){
      let off=vec2f(f32(j%3u)-1.0,f32(j/3u)-1.0)*0.7/frame_display_size();
      let uv=src.xy+off;
      if(any(uv<vec2f(0.0))||any(uv>vec2f(1.0))){continue;}
      let d=optical_depth_at(uv); let scene_z=frame_near()/max(d,1e-8);
      // Tiny lens/mount thickness only; never range-scaled offsets that can cross a wall.
      if(scene_z+0.06<src.z){continue;}
      visible+=1.0;
      brightness+=max(0.0,optical_luma(textureSampleLevel(optical_scene,optical_sampler,uv,0.0).rgb)-local_background-0.2);
    }
    sources.source[index].screen=vec4f(src.xy,op.local_color[k].w,src.w*(visible/9.0)*clamp(brightness/18.0,0.0,1.0));
    sources.source[index].color=vec4f(op.local_color[k].rgb,1.0);
  }
}
`, [frameWgsl, sourceStruct, OPTICS_PARAMS.module, fogParamsBindingWgsl(1, 6)]);

/** Globals supplied by composite: scene_tex, lin_sampler, lens_depth, optical_sources and optical_mask. */
export const opticsCompositeWgsl = makeModule('optics-composite',/* wgsl */ `
/** Share of open sky under a display pixel: the four jittered depth texels around it (the depth is this frame's
 *  jittered raster; the image is resolved), so the glare fades smoothly at silhouettes instead of in raster blocks. */
fn optical_sky(uv: vec2f)->f32{
  let ds=vec2i(textureDimensions(lens_depth));
  let t=(uv+vec2f(frame.jitter.x,-frame.jitter.y)*0.5)*vec2f(ds)-0.5; let f=fract(t); let b=vec2i(floor(t));
  let s00=select(0.0,1.0,textureLoad(lens_depth,clamp(b,vec2i(0),ds-1),0)<=0.0);
  let s10=select(0.0,1.0,textureLoad(lens_depth,clamp(b+vec2i(1,0),vec2i(0),ds-1),0)<=0.0);
  let s01=select(0.0,1.0,textureLoad(lens_depth,clamp(b+vec2i(0,1),vec2i(0),ds-1),0)<=0.0);
  let s11=select(0.0,1.0,textureLoad(lens_depth,clamp(b+vec2i(1,1),vec2i(0),ds-1),0)<=0.0);
  return mix(mix(s00,s10,f.x),mix(s01,s11,f.x),f.y);
}
fn optical_effects(uv: vec2f)->vec3f{
  let aspect=frame_display_size().x/frame_display_size().y;
  let q=(uv-0.5)*vec2f(aspect,1.0); var result=vec3f(0.0);
  let sky=mix(0.08,1.0,optical_sky(uv));
  for(var i=0u;i<3u;i++){
    let source=optical_sources.source[i]; let gain=source.screen.w;
    if(gain<=0.00001){continue;}
    let sun=(source.screen.xy-0.5)*vec2f(aspect,1.0); let delta=q-sun; let r=length(delta);
    let local=i>0u; let radius=select(0.085,0.012,local);
    let halo=exp(-r/max(radius,0.001))*select(0.65*sky,0.11,local);
    let streak=exp(-abs(delta.y)*select(320.0,700.0,local))*exp(-abs(delta.x)/select(0.10,0.035,local))*select(0.07,0.035,local);
    var ghosts=0.0;
    if(!local){
      for(var j=0u;j<3u;j++){
        let t=0.55+f32(j)*0.65; let center=-sun*t; let size=0.018+f32(j)*0.009;
        let v=(q-center)/size; let hex=max(abs(v.x),max(abs(v.x*0.5+v.y*0.866),abs(v.x*0.5-v.y*0.866)));
        ghosts+=(1.0-smoothstep(0.68,1.0,hex))*0.014;
      }
    }
    if((u32(source.color.w)&1u)!=0u){result+=source.color.rgb*(halo+streak+ghosts)*gain;}
    // Optional complementary SCREEN-SPACE rays, separate from world-space volumetrics.
    // A finite source window excludes the bright Mie sky; border taps are rejected, never clamped into streaks.
    // Only the stretch of the ray toward the sun that crosses the sun window (the mask) can gather light: march
    // that stretch densely and bilinearly. The mean is weighted by the stretch's share of the whole ray, as before.
    if(!local&&(u32(source.color.w)&2u)!=0u&&r<0.55){
      let window=source.screen.z*1.5;
      let s1=r*0.97; let s0=max(0.0,r-window);
      var shaft=vec3f(0.0);
      if(s1>s0){
        let toward=-delta/max(r,1e-6);
        let px=uv*frame_display_size();
        let dither=fract(52.9829189*fract(0.06711056*px.x+0.00583715*px.y));
        for(var j=0u;j<24u;j++){
          let at=delta+toward*mix(s0,s1,(f32(j)+dither)/24.0);
          shaft+=textureSampleLevel(optical_mask,lin_sampler,at/(2.0*window)+0.5,0.0).rgb;
        }
        shaft*=(s1-s0)/max(r,1e-6)/24.0;
      }
      result+=min(shaft,vec3f(4.0))*gain*0.055*sky*(1.0-smoothstep(0.3,0.55,r));
    }
  }
  return min(select(result,vec3f(0.0),result!=result),vec3f(2.0));
}
`, [sourceStruct]);

export function installOptics(s: EngineServices): { buffer: GPUBuffer; mask: GPUTextureView; dispose(): void } {
  const { device, queue } = s.ctx; const C = ShaderStage.COMPUTE;
  const buffer = device.createBuffer({ label: 'optics:sources', size: OPTICS_SOURCE_BYTES, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
  const params = device.createBuffer({ label: 'optics:params', size: OPTICS_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const maskTexture = device.createTexture({ label: 'optics:sun-window', size: [OPTICS_MASK_SIZE, OPTICS_MASK_SIZE], format: 'rgba16float', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
  const mask = maskTexture.createView();
  const fog = s.scene.get('fogOfWar'); if (!fog) throw new Error('Optics requires fog visibility.');
  const layout = device.createBindGroupLayout({ label: 'optics:source', entries: [
    { binding: 0, visibility: C, texture: { sampleType: 'float' } }, { binding: 1, visibility: C, sampler: { type: 'filtering' } },
    { binding: 2, visibility: C, texture: { sampleType: 'depth' } }, { binding: 3, visibility: C, buffer: { type: 'uniform' } },
    { binding: 4, visibility: C, buffer: { type: 'storage' } }, { binding: 5, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
    { binding: 6, visibility: C, buffer: { type: 'uniform' } },
    { binding: 7, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
  ] });
  const key = 'optics:source'; s.ctx.pipelines.register(key, 'compute', () => ({ label: key,
    layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }), compute: { module: s.ctx.pipelines.shaderModule(link(opticsSourceWgsl), key), entryPoint: 'main' } }));
  void s.ctx.pipelines.compile(key).catch(() => undefined);
  const maskKey = 'optics:mask'; s.ctx.pipelines.register(maskKey, 'compute', () => ({ label: maskKey,
    layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }), compute: { module: s.ctx.pipelines.shaderModule(link(opticsSourceWgsl), key), entryPoint: 'mask' } }));
  void s.ctx.pipelines.compile(maskKey).catch(() => undefined);
  const frameGroup = createFrameBindGroup(s, 'optics'); const groups = new BindGroupResourceCache(4); const staging = new ArrayBuffer(OPTICS_PARAMS.size);
  const dispose = s.graph.addPass({ name: 'optics.source', slot: 'post.bloom', order: 20, reads: ['frameUniforms', TAA_TEXTURE, 'depth'], writes: [], run(c) {
    const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(key); if (!pipeline) { c.encoder.clearBuffer(buffer); return; }
    const post = s.scene.get('post'); const f = c.frame;
    const enabled = !!(post?.flare || post?.godRays) && !s.scene.get('interior') && s.settings.gbufferView === 'none' && s.scene.get('lighting')?.view === 'none';
    const projection = projectOpticalSource(f.viewProjNoJitter, f.sunDir, true);
    const strength = enabled ? Math.max(0, Math.min(2, post.flareStrength)) : 0;
    const visibility = sunOpticalVisibility(f);
    const sunRadius = Math.max(0.0001, (s.scene.get('atmosphere')?.preset.sunAngularRadius ?? 0.035) * f.proj[5] * 0.5);
    const screen = new Float32Array(8), color = new Float32Array(8), world = new Float32Array(8);
    if (enabled && post.flare) {
      const candidates = (s.scene.get('lightSystem')?.shadowCasters() ?? []).map(({ light }) => ({ light, strength: localOpticalStrength(light, f.eye), projection: projectOpticalSource(f.viewProjNoJitter, light.position) }))
        .filter(v => v.strength > 0 && v.projection.inFront && v.projection.uv.every(x => x > 0.01 && x < 0.99)).sort((a, b) => b.strength - a.strength).slice(0, 2);
      candidates.forEach((v, i) => { screen.set([...v.projection.uv, v.projection.viewDepth, v.strength * strength], i * 4); color.set([...v.light.color, Math.max(2 / f.display[1], 0.032 * f.proj[5] * 0.5 / v.projection.viewDepth)], i * 4); world.set([...v.light.position, 0], i * 4); });
    }
    OPTICS_PARAMS.pack({ sun: [...projection.uv, sunRadius, strength * visibility], control: [f.display[0] / Math.max(1, f.display[1]), 0, SUN_OPTICAL_REFERENCE, enabled ? Number(post.flare) + 2 * Number(post.godRays) : 0], local_screen: screen, local_color: color, local_world: world }, staging);
    queue.writeBuffer(params, 0, staging);
    const resources: GPUBindingResource[] = [c.resources.view(TAA_TEXTURE), sampler, c.resources.view('depth'), { buffer: params }, { buffer }, fog.volumeView, { buffer: fog.paramsBuffer }, mask];
    const cacheKey = groups.begin(); for (const resource of resources) pushBindingKey(cacheKey, resource);
    const group = groups.get(() => device.createBindGroup({ label: key, layout, entries: resources.map((resource, binding) => ({ binding, resource })) }));
    const ts = c.timestampWrites('optics.source') as GPUComputePassTimestampWrites | undefined;
    const pass = c.encoder.beginComputePass({ label: key, ...(ts ? { timestampWrites: ts } : {}) }); pass.setPipeline(pipeline); pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, group); pass.dispatchWorkgroups(3);
    const maskPipeline = s.ctx.pipelines.get<GPUComputePipeline>(maskKey);
    if (maskPipeline && enabled && post.godRays && visibility > 0) { pass.setPipeline(maskPipeline); pass.dispatchWorkgroups(OPTICS_MASK_SIZE / 8, OPTICS_MASK_SIZE / 8); }
    pass.end();
  } });
  return { buffer, mask, dispose() { dispose(); s.ctx.deferDestroy(buffer); s.ctx.deferDestroy(params); s.ctx.deferDestroy(maskTexture); } };
}
