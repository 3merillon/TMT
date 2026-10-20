/** One transparent draw for short-lived shell smoke. Fixed storage, soft depth intersections and world-space fog. */
import type { EngineServices } from '../../engine/contracts';
import { BufferUsage, ShaderStage } from '../../engine/gpu/flags';
import { FORWARD_BLEND_OVER, FORWARD_COLOR_TARGET, FORWARD_DEPTH_STENCIL } from '../../engine/passes/forward/forward';
import { FOG_PARAMS } from '../../engine/passes/fog-of-war/fog.wgsl';
import { frameWgsl } from '../../engine/wgsl/common/frame.wgsl';
import { link, makeModule } from '../../engine/wgsl/module';
import { PROJECTILE_TRAIL, TRAIL_STYLE, type ProjectileTrailState, type TrailPuff } from './projectile-trail-state';

export const projectileTrailShader = makeModule('projectile-trails', /* wgsl */ `
struct TrailParticle { center_radius: vec4f, color_opacity: vec4f, detail: vec4f }
@group(1) @binding(0) var<storage, read> particles: array<TrailParticle>;
@group(1) @binding(1) var scene_depth: texture_depth_2d;
@group(1) @binding(2) var fog_volume: texture_3d<f32>;
@group(1) @binding(3) var fog_linear: sampler;
@group(1) @binding(4) var<uniform> fog: FogOfWarParams;
struct TrailOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
  @location(2) @interpolate(flat) detail: vec2f,
}
@vertex fn vs_trail(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TrailOut {
  let corners = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(-1,1), vec2f(1,-1), vec2f(1,1));
  let p = particles[ii];
  let radial = normalize(p.center_radius.xyz);
  // Puffs stay on the travelled path, then gently rise and roll as they disperse.
  let center = p.center_radius.xyz + radial * p.detail.y * .09;
  let right = vec3f(frame.view[0][0], frame.view[1][0], frame.view[2][0]);
  let up = vec3f(frame.view[0][1], frame.view[1][1], frame.view[2][1]);
  let uv = corners[vi];
  let world = center + (right * uv.x + up * uv.y) * p.center_radius.w;
  var seen = 1.0;
  if (fog.settings.x > .5 && all(abs(center) < vec3f(fog.volume.y))) {
    let hidden = textureSampleLevel(fog_volume, fog_linear, center / (2.0 * fog.volume.y) + .5, 0.0).r;
    seen = 1.0 - smoothstep(.08, .85, hidden);
  }
  let day = smoothstep(-.15, .35, dot(radial, frame.sun_dir));
  let light = mix(vec3f(.24, .28, .35), vec3f(1.65, 1.62, 1.55), day);
  var out: TrailOut;
  out.position = frame.view_proj * vec4f(world, 1.0);
  out.uv = uv;
  out.color = vec4f(p.color_opacity.rgb * light, p.color_opacity.w * seen);
  out.detail = vec2f(p.detail.x + p.detail.y * .55, p.center_radius.w);
  return out;
}
fn trail_hash(p: vec2f) -> f32 {
  let q = fract(vec3f(p.xyx) * .1031);
  let r = q + dot(q, q.yzx + 33.33);
  return fract((r.x + r.y) * r.z);
}
fn trail_noise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(trail_hash(i), trail_hash(i + vec2f(1,0)), u.x),
    mix(trail_hash(i + vec2f(0,1)), trail_hash(i + vec2f(1,1)), u.x), u.y);
}
@fragment fn fs_trail(v: TrailOut) -> @location(0) vec4f {
  let r2 = dot(v.uv, v.uv);
  if (r2 >= 1.0 || v.color.a < .001) { discard; }
  let c = cos(v.detail.x); let s = sin(v.detail.x);
  let uv = vec2f(c * v.uv.x - s * v.uv.y, s * v.uv.x + c * v.uv.y);
  let noise = trail_noise(uv * 3.2 + v.detail.x) * .7 + trail_noise(uv * 7.3 - v.detail.x) * .3;
  let density = exp(-r2 * 2.1) * (1.0 - smoothstep(.45, 1.0, r2)) * (.5 + noise);
  let pixel = clamp(vec2i(v.position.xy), vec2i(0), vec2i(textureDimensions(scene_depth)) - vec2i(1));
  let opaque = frame_near() / max(textureLoad(scene_depth, pixel, 0), 1e-7);
  let depth = frame_near() / max(v.position.z, 1e-7);
  let soft = smoothstep(0.0, .035 + v.detail.y * .5, opaque - depth) * smoothstep(.15, .7, depth);
  return vec4f(v.color.rgb, v.color.a * density * soft);
}
`, [frameWgsl, FOG_PARAMS.module]);

export async function createProjectileTrails(s: EngineServices, state: ProjectileTrailState): Promise<{ dispose(): void }> {
  const { device, queue, pipelines } = s.ctx, V = ShaderStage.VERTEX, F = ShaderStage.FRAGMENT;
  const layout = device.createBindGroupLayout({ label: 'projectile-trails', entries: [
    { binding: 0, visibility: V, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: F, texture: { sampleType: 'depth' } },
    { binding: 2, visibility: V, texture: { sampleType: 'float', viewDimension: '3d' } },
    { binding: 3, visibility: V, sampler: { type: 'filtering' } },
    { binding: 4, visibility: V, buffer: { type: 'uniform' } },
  ] });
  const key = 'projectile:trails';
  pipelines.register(key, 'render', () => {
    const module = pipelines.shaderModule(link(projectileTrailShader), key);
    return { label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
      vertex: { module, entryPoint: 'vs_trail' }, fragment: { module, entryPoint: 'fs_trail', targets: [{ ...FORWARD_COLOR_TARGET, blend: FORWARD_BLEND_OVER }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: FORWARD_DEPTH_STENCIL };
  });
  await pipelines.compile(key);
  const buffer = device.createBuffer({ label: 'projectile-trails', size: PROJECTILE_TRAIL.capacity * 48, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
  const staging = new Float32Array(PROJECTILE_TRAIL.capacity * 12), sorted: TrailPuff[] = [];
  let group: GPUBindGroup | undefined, oldDepth: GPUTextureView | undefined, oldFog: GPUTextureView | undefined, disposed = false;
  const removeDepth = s.graph.addPass({ name: 'projectile.trail-depth', slot: 'transparent', order: -1, reads: ['depth'], writes: [],
    enabled: () => state.particles.length > 0,
    run(c) {
      const depth = c.resources.view('depth'), fog = s.scene.get('fogOfWar');
      if (!fog || (depth === oldDepth && fog.volumeView === oldFog)) return;
      oldDepth = depth; oldFog = fog.volumeView;
      group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: depth },
        { binding: 2, resource: fog.volumeView }, { binding: 3, resource: sampler }, { binding: 4, resource: { buffer: fog.paramsBuffer } }] });
    },
  });
  const removeDraw = s.scene.addTransparentDrawer({ name: 'projectile.trails', order: 30, draw(pass, frame) {
    if (disposed || !group || !state.particles.length) return;
    sorted.length = 0; sorted.push(...state.particles);
    const distance = (p: TrailPuff) => (p.position[0] - frame.eye[0]) ** 2 + (p.position[1] - frame.eye[1]) ** 2 + (p.position[2] - frame.eye[2]) ** 2;
    sorted.sort((a, b) => distance(b) - distance(a));
    sorted.forEach((p, i) => {
      const style = TRAIL_STYLE[p.munition], age = p.age / style.life;
      const opacity = style.opacity * Math.min(1, p.age / .025) * (1 - age) ** 1.35;
      staging.set([...p.position, style.radius * (1 + 2 * age), ...style.color, opacity, p.phase, p.age, 0, 0], i * 12);
    });
    queue.writeBuffer(buffer, 0, staging.buffer, 0, sorted.length * 48);
    pass.setPipeline(pipelines.get<GPURenderPipeline>(key)!); pass.setBindGroup(1, group); pass.draw(6, sorted.length);
  } });
  return { dispose() {
    if (disposed) return;
    disposed = true; removeDraw(); removeDepth(); state.clear(); sorted.length = 0; group = undefined;
    s.ctx.deferDestroy(buffer);
  } };
}
