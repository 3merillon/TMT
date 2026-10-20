/** Room-scale dust and short pressure releases, rendered through the engine's depth-tested transparent pass. */
import type { EngineServices, Vec3 } from '../../engine/contracts';
import { BufferUsage, ShaderStage } from '../../engine/gpu/flags';
import { FORWARD_BLEND_OVER, FORWARD_COLOR_TARGET, FORWARD_DEPTH_STENCIL } from '../../engine/passes/forward/forward';
import { frameWgsl } from '../../engine/wgsl/common/frame.wgsl';
import { link, makeModule } from '../../engine/wgsl/module';

const DUST_COUNT = 64;
const PUFF_COUNT = 24;
const MAX_RELEASES = 6;
const MAX_PARTICLES = DUST_COUNT + PUFF_COUNT * (3 + MAX_RELEASES);
const FLOATS_PER_PARTICLE = 12;
const BOILER: Vec3 = [4.8, 2.5, -4];
const LIFT: Vec3 = [-1.3, 0.35, 0.8];
/** Explicit bleed fittings on the real copper header collars, not arbitrary leaking geometry. */
export const WORKSHOP_STEAM_VALVES: readonly { base: Vec3; tip: Vec3; direction: Vec3 }[] = [
  { base: [6.37, 3.755, -4], tip: [6.35, 3.86, -4], direction: [-.18, .984, 0] },
  { base: [-6.37, 3.755, 2], tip: [-6.35, 3.86, 2], direction: [.18, .984, 0] },
];
export interface SteamRelease { at: number; position: Vec3; direction?: Vec3; strength?: number; seed?: number }
const AMBIENT_CYCLES = [{ period: 9, offset: 6 }, { period: 13, offset: 7 }, { period: 17, offset: 7 }];
const hash = (i: number) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export interface WorkshopParticle {
  position: Vec3;
  radius: number;
  color: Vec3;
  opacity: number;
  kind: 0 | 1;
  phase: number;
}

/** Deterministic particle state; no global timer, random generator, or background simulation survives teardown. */
export function workshopAtmosphericParticles(time: number, reducedMotion: boolean, release?: SteamRelease | readonly SteamRelease[], boiler: Vec3 = BOILER): WorkshopParticle[] {
  if (reducedMotion) return [];
  const particles: WorkshopParticle[] = [];
  for (let i = 0; i < DUST_COUNT; i++) {
    const phase = hash(i + 1) * Math.PI * 2;
    const x = (hash(i + 201) - 0.5) * 10 + Math.sin(time * 0.12 + phase) * 0.23;
    const y = 0.65 + (hash(i + 501) * 5.7 + time * (0.022 + hash(i + 901) * 0.016)) % 5.7;
    const z = (hash(i + 701) - 0.5) * 13 + Math.cos(time * 0.09 + phase) * 0.19;
    const lamp = 0.2 + 0.8 * Math.exp(-(x * x + (y - 4) ** 2) * 0.11);
    particles.push({ position: [x, y, z], radius: 0.007 + hash(i + 301) * 0.009,
      color: [1.9, 1.46, 0.83], opacity: lamp * (0.12 + 0.1 * hash(i + 401)), kind: 0, phase });
  }
  const plume = (origin: Vec3, age: number, direction: Vec3, strength: number, seed: number) => {
    if (age < 0 || age > 3.4) return;
    for (let i = 0; i < PUFF_COUNT; i++) {
      const t = age - i * .036, life = 2.35;
      if (t <= 0 || t >= life) continue;
      const phase = hash(i + seed) * Math.PI * 2;
      // Fast, narrow pressure jet loses momentum; entrained air rolls it into a rising, expanding plume.
      const jet = (1 - Math.exp(-t * 3.4)) * .28 * strength;
      const spread = (.008 + t * .064) * strength;
      const curl = phase + t * 2.3;
      const position: Vec3 = [origin[0] + direction[0] * jet + Math.sin(curl) * spread + t * .055,
        origin[1] + direction[1] * jet + t * .26 + Math.sin(curl * .7) * spread * .35,
        origin[2] + direction[2] * jet + Math.cos(curl * .86) * spread];
      const opacity = Math.min(t / .095, 1) * (1 - t / life) ** 1.35 * .125 * Math.sqrt(strength);
      particles.push({ position, radius: (.025 + Math.sqrt(t) * .17) * strength,
        color: [1.12, 1.19, 1.22], opacity, kind: 1, phase: phase + t * .42 });
    }
  };
  plume(boiler, (time + 6) % 9, [0, 1, 0], 1, 1201);
  WORKSHOP_STEAM_VALVES.forEach((valve, i) => {
    const cycle = AMBIENT_CYCLES[i + 1];
    plume(valve.tip, (time + cycle.offset) % cycle.period, valve.direction, .65, 1601 + i * 97);
  });
  const releases = release ? Array.isArray(release) ? release : [release as SteamRelease] : [];
  for (const r of releases.slice(-MAX_RELEASES)) plume(r.position, time - r.at, r.direction ?? [0, 1, 0], r.strength ?? .65, r.seed ?? 1901);
  return particles;
}

export const workshopAtmosphericsShader = makeModule('workshop-atmospherics', /* wgsl */ `
struct WorkshopParticle {
  center_radius: vec4f,
  color_opacity: vec4f,
  details: vec4f,
}
@group(1) @binding(0) var<storage, read> particles: array<WorkshopParticle>;
@group(1) @binding(1) var scene_depth: texture_depth_2d;
struct ParticleOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color_opacity: vec4f,
  @location(2) details: vec3f,
}
@vertex
fn vs_particle(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ParticleOut {
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let particle = particles[ii];
  let uv = corners[vi];
  let right = vec3f(frame.view[0][0], frame.view[1][0], frame.view[2][0]);
  let up = vec3f(frame.view[0][1], frame.view[1][1], frame.view[2][1]);
  let world = particle.center_radius.xyz + (right * uv.x + up * uv.y) * particle.center_radius.w;
  var out: ParticleOut;
  out.position = frame.view_proj * vec4f(world, 1.0);
  out.uv = uv;
  out.color_opacity = particle.color_opacity;
  out.details = vec3f(particle.details.xy, particle.center_radius.w);
  return out;
}
fn steam_hash(p: vec3f) -> f32 {
  let q = fract(p * .1031);
  let r = q + dot(q, q.yzx + 33.33);
  return fract((r.x + r.y) * r.z);
}
fn steam_noise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(steam_hash(i), steam_hash(i + vec3f(1,0,0)), u.x),
                 mix(steam_hash(i + vec3f(0,1,0)), steam_hash(i + vec3f(1,1,0)), u.x), u.y),
             mix(mix(steam_hash(i + vec3f(0,0,1)), steam_hash(i + vec3f(1,0,1)), u.x),
                 mix(steam_hash(i + vec3f(0,1,1)), steam_hash(i + vec3f(1,1,1)), u.x), u.y), u.z);
}
@fragment
fn fs_particle(in: ParticleOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  if (r2 >= 1.0) { discard; }
  var shape = exp(-r2 * 6.0) * (1.0 - smoothstep(0.6, 1.0, r2));
  if (in.details.x > 0.5) {
    let phase = in.details.y;
    let c = cos(phase); let s = sin(phase);
    let uv = vec2f(c * in.uv.x - s * in.uv.y, s * in.uv.x + c * in.uv.y);
    let p = vec3f(uv * 3.2, phase);
    let broad = steam_noise(p);
    let detail = steam_noise(p * 2.13 + vec3f(5.3, 1.7, -phase * .2));
    let density = smoothstep(.19, .78, broad * .72 + detail * .28);
    shape = exp(-r2 * 2.5) * (1.0 - smoothstep(.55, 1.0, r2)) * (.38 + density * .88);
  }
  let px = clamp(vec2i(in.position.xy), vec2i(0), vec2i(textureDimensions(scene_depth)) - vec2i(1));
  let opaque = frame_near() / max(textureLoad(scene_depth, px, 0), 1e-7);
  let distance = frame_near() / max(in.position.z, 1e-7);
  // Soft intersections eliminate billboard slices against machinery; near-camera fade avoids full-screen clouds.
  let soft = smoothstep(0.0, .09 + in.details.z * .65, opaque - distance) * smoothstep(.15, .65, distance);
  return vec4f(in.color_opacity.rgb, shape * in.color_opacity.w * soft);
}
`, [frameWgsl]);

export interface WorkshopAtmospherics {
  update(dt: number, time: number, reducedMotion: boolean): void;
  /** Bounded short releases; no catch-up bursts when resuming the room. */
  release(position?: Vec3, direction?: Vec3, strength?: number): void;
  snapshot(): { time: number; particles: number; steam: number; releases: number };
  dispose(): void;
}

export function createWorkshopAtmospherics(s: EngineServices, boiler: Vec3 = BOILER, onVent?: (position: Vec3) => void): WorkshopAtmospherics {
  const { device, queue } = s.ctx;
  const layout = device.createBindGroupLayout({ label: 'workshop:atmospherics', entries: [
    { binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
  ] });
  const buffer = device.createBuffer({ label: 'workshop:particles', size: MAX_PARTICLES * FLOATS_PER_PARTICLE * 4, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
  let group: GPUBindGroup | undefined, depthView: GPUTextureView | undefined;
  const removeDepth = s.graph.addPass({ name: 'workshop.particle-depth', slot: 'transparent', order: -9, reads: ['depth'], writes: [], run: c => {
    const view = c.resources.view('depth');
    if (view === depthView) return;
    depthView = view;
    group = device.createBindGroup({ label: 'workshop:particles', layout, entries: [
      { binding: 0, resource: { buffer } }, { binding: 1, resource: view },
    ] });
  } });
  const key = 'workshop:atmospherics';
  s.ctx.pipelines.register(key, 'render', () => {
    const shader = s.ctx.pipelines.shaderModule(link(workshopAtmosphericsShader), key);
    return {
      label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
      vertex: { module: shader, entryPoint: 'vs_particle' },
      fragment: { module: shader, entryPoint: 'fs_particle', targets: [{ ...FORWARD_COLOR_TARGET, blend: FORWARD_BLEND_OVER }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: FORWARD_DEPTH_STENCIL,
    };
  });
  void s.ctx.pipelines.compile(key).catch(() => undefined);
  const staging = new Float32Array(MAX_PARTICLES * FLOATS_PER_PARTICLE);
  let clock = 0, hidden = false, disposed = false;
  let releases: SteamRelease[] = [], serial = 0;
  let particles: WorkshopParticle[] = [];
  const unregister = s.scene.addTransparentDrawer({
    name: 'workshop.atmospherics', order: 40,
    draw(pass, frame) {
      const pipeline = s.ctx.pipelines.get<GPURenderPipeline>(key);
      if (disposed || hidden || !pipeline || !group || particles.length === 0) return;
      const distanceSq = (p: WorkshopParticle) => (p.position[0] - frame.eye[0]) ** 2 + (p.position[1] - frame.eye[1]) ** 2 + (p.position[2] - frame.eye[2]) ** 2;
      particles.sort((a, b) => distanceSq(b) - distanceSq(a));
      particles.forEach((p, i) => {
        const base = i * FLOATS_PER_PARTICLE;
        staging.set([...p.position, p.radius, ...p.color, p.opacity, p.kind, p.phase, 0, 0], base);
      });
      queue.writeBuffer(buffer, 0, staging.buffer, 0, particles.length * FLOATS_PER_PARTICLE * 4);
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, group);
      pass.draw(6, particles.length);
    },
  });
  return {
    update(dt, _time, reducedMotion) {
      if (disposed) return;
      hidden = reducedMotion;
      // Freeze time under reduced motion. Resuming never catches up missed vents or sends a burst of particles.
      const before = clock;
      if (!hidden) clock += Math.min(Math.max(dt, 0), 0.1);
      else releases = [];
      AMBIENT_CYCLES.forEach((cycle, i) => {
        if (Math.floor((before + cycle.offset) / cycle.period) !== Math.floor((clock + cycle.offset) / cycle.period))
          onVent?.(i === 0 ? boiler : WORKSHOP_STEAM_VALVES[i - 1].tip);
      });
      releases = releases.filter(r => clock - r.at < 3.4);
      particles = workshopAtmosphericParticles(clock, hidden, releases, boiler);
    },
    release(position = LIFT, direction = [0, 1, 0], strength = .65) {
      if (!disposed && !hidden) {
        releases.push({ at: clock, position: [...position], direction: [...direction], strength: Math.max(.25, Math.min(1.2, strength)), seed: 1901 + serial++ * 31 });
        releases = releases.slice(-MAX_RELEASES); onVent?.(position);
      }
    },
    snapshot() { return { time: clock, particles: particles.length, steam: particles.filter(p => p.kind === 1).length, releases: releases.length }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      unregister(); removeDepth();
      particles = []; releases = []; group = undefined; depthView = undefined;
      s.ctx.deferDestroy(buffer);
    },
  };
}
