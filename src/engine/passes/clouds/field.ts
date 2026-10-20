/**
 * The clouds' memory: a persistent field of what blasts did to the deck, so a pushed cloud STAYS pushed and carries on
 * from its new shape (docs: blast and weather impact).
 *
 * - **Frame:** the field lives in the clouds' own (wind-advected) frame, a cube of side 2H around the planet, so damage
 *   drifts with the clouds it belongs to. Each texel holds a departure (rgb: where the cloud now here came from,
 *   relative to here, in that frame) and a log density ratio (a: thinned below 0, compressed above).
 * - **Forcing**, all as real velocities integrated by one semi-Lagrangian step per frame: the shock front (a radial
 *   pulse whose integral is the lasting outward push, with the compression and rarefaction of its divergence), the
 *   smoke solver's projected flow (the fireball and the mushroom carry the deck), turbulence from the smoke (curl noise,
 *   divergence-free, scaled by each blast's energy and decaying), and heat that burns a hole (a density sink).
 * - **Healing:** everything relaxes toward the undisturbed sky with time constant CLOUD_FIELD.heal. It costs nothing:
 *   texels store value / g with g = e^(-t/heal) global, renormalised by one full pass when g gets small.
 * - **Cost:** the update runs only over the box the live forcing reaches (ping-pong, then the box is copied back), and
 *   only while something forces. The renderer reads one texel per density sample, and only on rays crossing a damaged
 *   region (≤ CLOUD_FIELD_REGIONS spheres, merged), so undisturbed skies keep the calm pipeline.
 * Presentation only.
 */
import type { EngineServices, PassContext, QualityTier, Vec3 } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import { GAS_FLOW_MAX, GAS_FLOW_PARAMS } from '../fluids/gas-flow.wgsl';
import type { GasCloudFlowFacet } from '../fluids/gas';
import type { CloudImpactKind } from './params';
import { quatConjugate, quatRotate } from '../../scene/wind';
export { quatAxisAngle, quatIdentity, quatMul, quatNormalize, type Quat } from '../../scene/wind';

export const CLOUD_FIELD_TIERS: Readonly<Record<QualityTier, number>> = { low: 72, medium: 96, high: 112, ultra: 128 };
export const CLOUD_FIELD_REGIONS = 4;
export const CLOUD_FIELD_IMPACTS = 8;
export const CLOUD_FIELD = {
  /** Healing time constant (s): a blasted deck is mostly whole again after about three of these. */
  heal: 120,
  /** Lasting displacement bound (u) and the shell padding rays crossing damage get for it (a lift beyond the padding is
   *  clipped at the padded shell; the march's step budget grows at most 40 % on those rays). */
  maxDisplacement: 2,
  padding: 1.5,
  /** Log density ratio bounds: e^-4 is a hole, e^1.2 a dense compressed band. */
  logMin: -4, logMax: 1.2,
  /** Shock front speed (u/s), as the old pulse. */
  shockSpeed: 7,
  /** Renormalise the stored values when g falls below this. */
  renormalise: 0.3,
} as const;
/** Per munition kind (blast, incendiary, nuclear): lasting push, burn-off (log density at the core), burn time (s), burn
 *  spread (× radius), turbulence speed (u/s per u of radius) and its decay (s). */
export const CLOUD_FIELD_KINDS = [
  { push: 1, burn: 0.5, burnTime: 3, burnSpread: 1.4, turbulence: 0.32, turbulenceDecay: 4 },
  { push: 0.8, burn: 0.9, burnTime: 6, burnSpread: 1.8, turbulence: 0.4, turbulenceDecay: 7 },
  { push: 1.6, burn: 3.2, burnTime: 8, burnSpread: 2.6, turbulence: 0.7, turbulenceDecay: 10 },
] as const;

export interface CloudFieldImpact { position: Vec3; radius: number; time: number; kind: 0 | 1 | 2 }
export const cloudFieldKind = (kind: CloudImpactKind): 0 | 1 | 2 => (kind === 'nuclear' ? 2 : kind === 'incendiary' ? 1 : 0);

/** How long an impact forces the field (s): its shock, its burn and its turbulence, until each is negligible. */
export function cloudFieldImpactLife(kind: 0 | 1 | 2): number {
  const k = CLOUD_FIELD_KINDS[kind];
  return Math.max(3.5, k.burnTime, 1.5 + k.turbulenceDecay * 4);
}

/** World spheres (centre, radius) an impact forces at `age`: shock shell, burn and turbulence. */
export function cloudFieldImpactReach(i: CloudFieldImpact, age: number): [number, number, number, number][] {
  const k = CLOUD_FIELD_KINDS[i.kind], r = Math.min(8, i.radius), out: [number, number, number, number][] = [];
  const up = (() => { const l = Math.hypot(...i.position) || 1; return i.position.map(v => v / l); })();
  const at = (lift: number) => i.position.map((v, j) => v + up[j] * lift) as Vec3;
  if (age <= 3.5) { const front = r * 0.5 + age * CLOUD_FIELD.shockSpeed; out.push([...i.position, front + 3 * (0.45 + front * 0.1)] as [number, number, number, number]); }
  if (age <= k.burnTime) out.push([...at(Math.min(age * 2, 6)), 3 * r * k.burnSpread] as [number, number, number, number]);
  if (age <= cloudFieldImpactLife(i.kind)) out.push([...at(Math.min(age * 0.8, 5)), 3 * (r * 1.4 + age * 0.5)] as [number, number, number, number]);
  return out;
}

export const cloudQuatWgsl = makeModule('cloud-quat', /* wgsl */ `
/** R · v for a unit quaternion (xyz, w). */
fn cloud_qrot(q: vec4f, v: vec3f) -> vec3f { let t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
/** Rᵀ · v. */
fn cloud_qunrot(q: vec4f, v: vec3f) -> vec3f { return cloud_qrot(vec4f(-q.xyz, q.w), v); }
`);

export const CLOUD_FIELD_PARAMS = wgslStruct('CloudFieldParams', [
  ['rot', 'vec4f'],     // the clouds' rotation (world = R · advected)
  ['grid', 'vec4f'],    // x N, y half extent H (u), z dt (s), w time (s)
  ['lo', 'vec4u'],      // xyz first texel of the box, w forcing on
  ['hi', 'vec4u'],      // xyz end texel (exclusive), w impacts
  ['scale', 'vec4f'],   // x read scale (g), y write scale (1/g), z shell inner, w shell outer (u)
  ['gas', 'vec4f'],     // x gas flow on
  ['impacts', { array: 'vec4f', count: CLOUD_FIELD_IMPACTS * 2 }], // centre + radius; age, kind, seed, 0
]);

/** The field's sampling module for the clouds: `cloud_field` at (group, binding), read with the clouds' sampler. */
export function cloudFieldBindingWgsl(group: number, binding: number) {
  return makeModule(`cloud-field-binding:${group}:${binding}`, `@group(${group}) @binding(${binding}) var cloud_field: texture_3d<f32>;`);
}

const kindsWgsl = CLOUD_FIELD_KINDS.map(k => `vec4f(${k.push}, ${k.burn}, ${k.burnTime}, ${k.burnSpread})`).join(', ');
const turbWgsl = CLOUD_FIELD_KINDS.map(k => `vec2f(${k.turbulence}, ${k.turbulenceDecay})`).join(', ');

export const cloudFieldUpdateWgsl = makeModule('cloud-field-update', /* wgsl */ `
@group(0) @binding(0) var<uniform> P: CloudFieldParams;
@group(0) @binding(1) var field_prev: texture_3d<f32>;
@group(0) @binding(2) var field_lin: sampler;
@group(0) @binding(3) var field_out: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var gas_velocity: texture_3d<f32>;
@group(0) @binding(5) var<uniform> gas_flow: GasCloudFlowParams;

const FIELD_KINDS = array<vec4f, 3>(${kindsWgsl});
const FIELD_TURB = array<vec2f, 3>(${turbWgsl});

/** The smoke solver's projected velocity at world x (u/s), blended over live domains as the old departure map was. */
fn field_gas_velocity(x: vec3f) -> vec3f {
  if (P.gas.x < 0.5 || gas_flow.header.w < 0.5) { return vec3f(0.0); }
  var vel = vec3f(0.0); var weight = 0.0;
  for (var i = 0u; i < min(${GAS_FLOW_MAX}u, u32(gas_flow.header.z)); i++) {
    let center = gas_flow.domains[i * 4u]; let right = gas_flow.domains[i * 4u + 1u];
    let up = gas_flow.domains[i * 4u + 2u]; let fwd = gas_flow.domains[i * 4u + 3u];
    let q = (x - center.xyz) / center.w;
    let uv = vec3f(dot(q, right.xyz), dot(q, up.xyz), dot(q, fwd.xyz)) + 0.5;
    if (any(uv <= vec3f(0.0)) || any(uv >= vec3f(1.0))) { continue; }
    let fade = (1.0 - smoothstep(0.32, 0.49, length(uv.xz - 0.5))) * smoothstep(0.0, 0.04, uv.y) * (1.0 - smoothstep(0.86, 0.99, uv.y)) * up.w;
    if (fade <= 0.0) { continue; }
    let n = gas_flow.header.x;
    let tex = vec3f(clamp(uv.xy, vec2f(0.5 / n), vec2f(1.0 - 0.5 / n)), (right.w * n + clamp(uv.z * n, 0.5, n - 0.5)) / (n * gas_flow.header.y));
    let v = textureSampleLevel(gas_velocity, field_lin, tex, 0.0).xyz;
    vel += (right.xyz * v.x + up.xyz * v.y + fwd.xyz * v.z) * (center.w * fade); weight += fade;
  }
  return vel / max(1.0, weight);
}

/** A smooth vector potential (two octaves of travelling waves); its curl is divergence-free turbulence. */
fn field_potential(p: vec3f, t: f32, s: f32) -> vec3f {
  let a = vec3f(sin(p.y * 0.9 + t * 0.7 + s) * cos(p.z * 0.7 - t * 0.5), sin(p.z * 0.9 + t * 0.6 + s * 1.7) * cos(p.x * 0.7 + t * 0.4),
    sin(p.x * 0.9 - t * 0.5 + s * 2.3) * cos(p.y * 0.7 + t * 0.3));
  let q = p * 2.1 + vec3f(3.1, 1.7, 5.3);
  let b = vec3f(sin(q.y + t * 1.1 + s) * cos(q.z), sin(q.z + t * 0.9 + s * 1.3) * cos(q.x), sin(q.x - t + s * 0.7) * cos(q.y));
  return a + b * 0.45;
}
fn field_curl(p: vec3f, t: f32, s: f32) -> vec3f {
  let e = 0.15;
  let dx = (field_potential(p + vec3f(e, 0.0, 0.0), t, s) - field_potential(p - vec3f(e, 0.0, 0.0), t, s)) / (2.0 * e);
  let dy = (field_potential(p + vec3f(0.0, e, 0.0), t, s) - field_potential(p - vec3f(0.0, e, 0.0), t, s)) / (2.0 * e);
  let dz = (field_potential(p + vec3f(0.0, 0.0, e), t, s) - field_potential(p - vec3f(0.0, 0.0, e), t, s)) / (2.0 * e);
  return vec3f(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) * 0.8;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let texel = P.lo.xyz + g;
  if (any(texel >= P.hi.xyz)) { return; }
  let n = P.grid.x; let h = P.grid.y; let dt = P.grid.z;
  let a = ((vec3f(texel) + 0.5) / n * 2.0 - 1.0) * h;
  let ra = length(a);
  if (P.lo.w == 0u || ra < P.scale.z - 3.0 || ra > P.scale.w + 3.0) {
    // Outside the deck (or a renormalisation): the value carries over, rescaled.
    textureStore(field_out, texel, textureLoad(field_prev, texel, 0) * (P.scale.x * P.scale.y));
    return;
  }
  let x = cloud_qrot(P.rot, a);
  var vel = field_gas_velocity(x);
  var div = 0.0; var burn = 0.0;
  for (var i = 0u; i < min(P.hi.w, ${CLOUD_FIELD_IMPACTS}u); i++) {
    let head = P.impacts[i * 2u]; let info = P.impacts[i * 2u + 1u];
    let age = info.x; let kind = FIELD_KINDS[u32(info.y)]; let turb = FIELD_TURB[u32(info.y)];
    let r = head.w; let up = normalize(head.xyz);
    // The shock: a radial velocity pulse whose time integral is the lasting outward push.
    if (age <= 3.5) {
      let delta = x - head.xyz; let d = max(length(delta), 0.3);
      let front = r * 0.5 + age * ${CLOUD_FIELD.shockSpeed}.0; let width = 0.45 + front * 0.1; let q = (d - front) / width;
      if (abs(q) < 3.0) {
        let net = min(1.2, r * 0.3) * kind.x * r / (r + front * 0.25);
        let f = net * ${CLOUD_FIELD.shockSpeed}.0 / (width * 1.7724539) * exp(-q * q) * (1.0 - smoothstep(3.0, 3.5, age));
        vel += delta / d * f;
        div += f * (-2.0 * q / width) + 2.0 * f / d;
      }
    }
    // Heat burns cloud off around the rising core.
    if (age <= kind.z) {
      let core = head.xyz + up * min(age * 2.0, 6.0); let sigma = r * kind.w; let d2 = dot(x - core, x - core);
      burn += kind.y / kind.z * exp(-d2 / (2.0 * sigma * sigma));
    }
    // The smoke stirs the deck: divergence-free turbulence, strongest a second or two in, then dying away.
    let env = smoothstep(0.4, 1.5, age) * exp(-age / turb.y);
    if (env > 0.002) {
      let core = head.xyz + up * min(age * 0.8, 5.0); let sigma = r * 1.4 + age * 0.5; let d2 = dot(x - core, x - core);
      let w = env * exp(-d2 / (2.0 * sigma * sigma));
      if (w > 0.003) { vel += field_curl(x, P.grid.w * 0.6, info.z) * (turb.x * r * w); }
    }
  }
  // One semi-Lagrangian step in the clouds' frame: the departure of the cloud now here, and its density.
  let va = cloud_qunrot(P.rot, vel);
  let back = a - va * dt;
  let prev = textureSampleLevel(field_prev, field_lin, back / (2.0 * h) + 0.5, 0.0) * P.scale.x;
  var departure = prev.xyz - va * dt;
  departure *= min(1.0, ${CLOUD_FIELD.maxDisplacement} / max(length(departure), 1e-5));
  let density = clamp(prev.w - (div + burn) * dt, ${CLOUD_FIELD.logMin}.0, ${CLOUD_FIELD.logMax});
  textureStore(field_out, texel, vec4f(departure, density) * P.scale.y);
}
`, [CLOUD_FIELD_PARAMS.module, GAS_FLOW_PARAMS.module, cloudQuatWgsl]);

interface Region { center: Vec3; radius: number; last: number }

/** Smallest sphere holding two spheres. */
function mergeSpheres(a: Region, b: { center: Vec3; radius: number }): void {
  const d = Math.hypot(...a.center.map((v, i) => v - b.center[i]));
  if (d + b.radius <= a.radius) return;
  if (d + a.radius <= b.radius) { a.center = [...b.center]; a.radius = b.radius; return; }
  const radius = (d + a.radius + b.radius) / 2, t = (radius - a.radius) / Math.max(d, 1e-6);
  a.center = a.center.map((v, i) => v + (b.center[i] - v) * t) as Vec3; a.radius = radius;
}

export class CloudField {
  n = 0;
  half = 28;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private readonly params: GPUBuffer;
  private readonly noFlow: GPUBuffer;
  private tier: QualityTier = 'high';
  private readonly staging = new ArrayBuffer(CLOUD_FIELD_PARAMS.size);
  private readonly layout: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly groups = new BindGroupResourceCache(2);
  private readonly key = 'clouds:field';
  private impacts: CloudFieldImpact[] = [];
  private regionList: Region[] = [];
  /** Time origin of g = e^(-(t - t0)/heal). */
  private t0 = 0;
  private time = 0;
  /** The textures must be replaced by fresh (zeroed) ones before the next update. */
  private stale = false;
  /** True on frames whose update changed the field (the clouds' history then follows faster). */
  updating = false;

  constructor(private readonly s: EngineServices) {
    const { device } = s.ctx, C = ShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({ label: 'layout:cloud-field', entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 2, visibility: C, sampler: { type: 'filtering' } },
      { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
      { binding: 4, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 5, visibility: C, buffer: { type: 'uniform' } }] });
    this.params = device.createBuffer({ label: 'cloud:field-params', size: CLOUD_FIELD_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.noFlow = device.createBuffer({ label: 'cloud:field-no-gas', size: GAS_FLOW_PARAMS.size, usage: BufferUsage.UNIFORM });
    this.sampler = device.createSampler({ label: 'cloud:field-linear', minFilter: 'linear', magFilter: 'linear' });
    s.ctx.pipelines.register(this.key, 'compute', () => ({ label: this.key,
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: s.ctx.pipelines.shaderModule(link(cloudFieldUpdateWgsl), this.key), entryPoint: 'main' } }));
    void s.ctx.pipelines.compile(this.key).catch(() => undefined);
  }

  /** The current field (sampled by the clouds). */
  get view(): GPUTextureView | null { return this.views[0] ?? null; }
  get impactCount(): number { return this.impacts.length; }
  /** g: multiplies every stored value. */
  gain(time = this.time): number { return Math.exp(-(time - this.t0) / CLOUD_FIELD.heal); }

  allocate(tier: QualityTier): void {
    this.tier = tier;
    const n = CLOUD_FIELD_TIERS[tier];
    if (n === this.n && this.textures.length && !this.stale) return;
    this.stale = false;
    for (const t of this.textures) this.s.ctx.deferDestroy(t);
    this.n = n;
    this.textures = [0, 1].map(i => this.s.ctx.device.createTexture({ label: `cloud:field-${i}`, size: [n, n, n], dimension: '3d', format: 'rgba16float',
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING | TextureUsage.COPY_SRC | TextureUsage.COPY_DST }));
    this.views = this.textures.map(t => t.createView({ dimension: '3d' }));
    this.groups.clear();
    this.impacts = []; this.regionList = []; this.t0 = this.time;
  }

  /** Forget every blast (a new planet, a reset). */
  clear(): void { this.impacts = []; this.regionList = []; this.stale = true; this.t0 = this.time; }

  impact(position: readonly number[], radius: number, time: number, kind: CloudImpactKind): void {
    if (this.impacts.length >= CLOUD_FIELD_IMPACTS) this.impacts.shift();
    this.impacts.push({ position: [position[0], position[1], position[2]], radius: Math.min(8, radius), time, kind: cloudFieldKind(kind) });
  }

  /** World spheres of the damaged regions this frame (the clouds' ray gate), for rotation q. */
  regions(q: readonly number[]): [number, number, number, number][] {
    return this.regionList.map(r => [...quatRotate(q, r.center), r.radius] as [number, number, number, number]);
  }

  /**
   * One frame: drop spent impacts and healed regions, then integrate the forcing over the box it reaches.
   * `q` is the clouds' rotation, `shell` its (inner, outer) radii.
   */
  update(c: PassContext, q: readonly number[], shell: readonly [number, number], flow: GasCloudFlowFacet | undefined, enabled: boolean): void {
    const time = c.frame.time, dt = Math.min(Math.max(c.frame.dt, 0), 0.1);
    if (time < this.time - 1) this.clear();
    this.time = time;
    this.half = shell[1] + CLOUD_FIELD.padding + 1;
    this.updating = false;
    const pipeline = this.s.ctx.pipelines.get<GPUComputePipeline>(this.key);
    if (!pipeline || !this.textures.length) return;
    // WebGPU zero-initialises new textures: a cleared field is simply a fresh pair.
    if (this.stale) this.allocate(this.tier);
    this.impacts = this.impacts.filter(i => time >= i.time && time - i.time <= cloudFieldImpactLife(i.kind));
    this.regionList = this.regionList.filter(r => time - r.last < CLOUD_FIELD.heal * Math.log(60));
    if (!this.regionList.length && !this.impacts.length) this.t0 = time;
    let g = this.gain(time);
    if (g < CLOUD_FIELD.renormalise && this.regionList.length) {
      this.dispatch(c, pipeline, q, [0, 0, 0], [this.n, this.n, this.n], g, 1, 0, null);
      this.t0 = time; g = 1;
    }
    if (!enabled) return;
    // What forces this frame: the impacts' shells, burns and turbulence, and the smoke domains reaching the deck.
    const reach: [number, number, number, number][] = [];
    for (const i of this.impacts) reach.push(...cloudFieldImpactReach(i, time - i.time));
    for (const d of flow?.domains ?? []) reach.push([d[0], d[1], d[2], d[3]]);
    const deck = reach.filter(s => Math.hypot(s[0], s[1], s[2]) + s[3] > shell[0] - 3);
    if (!deck.length) return;
    const inv = quatConjugate(q), n = this.n, h = this.half;
    const lo = [n, n, n], hi = [0, 0, 0];
    for (const s of deck) {
      const center = quatRotate(inv, s), radius = Math.min(s[3], 2 * h);
      this.addRegion(center, radius, time);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], Math.max(0, Math.floor((center[k] - radius + h) / (2 * h) * n) - 1));
        hi[k] = Math.max(hi[k], Math.min(n, Math.ceil((center[k] + radius + h) / (2 * h) * n) + 1));
      }
    }
    if (hi.some((v, k) => v <= lo[k])) return;
    this.dispatch(c, pipeline, q, lo, hi, g, 1 / g, dt, flow ?? null, time, shell);
    this.updating = true;
  }

  private addRegion(center: Vec3, radius: number, time: number): void {
    const hit = this.regionList.find(r => Math.hypot(...r.center.map((v, i) => v - center[i])) < r.radius + radius * 0.5);
    if (hit) { mergeSpheres(hit, { center, radius }); hit.last = time; return; }
    this.regionList.push({ center: [...center], radius, last: time });
    while (this.regionList.length > CLOUD_FIELD_REGIONS) {
      let best = [0, 1], bestD = Infinity;
      for (let i = 0; i < this.regionList.length; i++) for (let j = i + 1; j < this.regionList.length; j++) {
        const a = this.regionList[i], b = this.regionList[j];
        const d = Math.hypot(...a.center.map((v, k) => v - b.center[k])) + a.radius + b.radius;
        if (d < bestD) { bestD = d; best = [i, j]; }
      }
      const [a, b] = [this.regionList[best[0]], this.regionList[best[1]]];
      mergeSpheres(a, b); a.last = Math.max(a.last, b.last); this.regionList.splice(best[1], 1);
    }
  }

  private dispatch(c: PassContext, pipeline: GPUComputePipeline, q: readonly number[], lo: readonly number[], hi: readonly number[], read: number, write: number,
    dt: number, flow: GasCloudFlowFacet | null, time = this.time, shell: readonly [number, number] = [0, 1e9]): void {
    const impacts = new Float32Array(CLOUD_FIELD_IMPACTS * 8);
    const live = dt > 0 ? this.impacts : [];
    live.forEach((i, k) => impacts.set([...i.position, i.radius, time - i.time, i.kind, (k * 7.31 + i.time * 0.13) % 6.283, 0], k * 8));
    const gas = flow && dt > 0 && flow.domains.length > 0;
    CLOUD_FIELD_PARAMS.pack({
      rot: [...q], grid: [this.n, this.half, dt, time], lo: [lo[0], lo[1], lo[2], dt > 0 ? 1 : 0], hi: [hi[0], hi[1], hi[2], live.length],
      scale: [read, write, shell[0], shell[1]], gas: [gas ? 1 : 0, 0, 0, 0], impacts,
    }, this.staging);
    this.s.ctx.queue.writeBuffer(this.params, 0, this.staging);
    const resources: GPUBindingResource[] = [{ buffer: this.params }, this.views[0], this.sampler, this.views[1],
      // Without smoke, the current field stands in for the velocity atlas (never the storage target).
      gas ? flow!.velocityView : this.views[0], { buffer: gas ? flow!.paramsBuffer : this.noFlow }];
    const key = this.groups.begin(); for (const r of resources) pushBindingKey(key, r);
    const group = this.groups.get(() => this.s.ctx.device.createBindGroup({ label: 'cloud:field', layout: this.layout,
      entries: resources.map((resource, binding) => ({ binding, resource })) }));
    const ts = c.timestampWrites('clouds.field') as GPUComputePassTimestampWrites | undefined;
    const pass = c.encoder.beginComputePass({ label: 'clouds.field', ...(ts ? { timestampWrites: ts } : {}) });
    pass.setPipeline(pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil((hi[0] - lo[0]) / 4), Math.ceil((hi[1] - lo[1]) / 4), Math.ceil((hi[2] - lo[2]) / 4));
    pass.end();
    c.encoder.copyTextureToTexture({ texture: this.textures[1], origin: [lo[0], lo[1], lo[2]] }, { texture: this.textures[0], origin: [lo[0], lo[1], lo[2]] },
      [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]);
  }

  dispose(): void { for (const t of this.textures) this.s.ctx.deferDestroy(t); this.s.ctx.deferDestroy(this.params); this.s.ctx.deferDestroy(this.noFlow); }
}

