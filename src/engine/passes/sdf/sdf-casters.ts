/**
 * SDF casters (docs/visibility-architecture.md): small distance-field bricks for the dynamic shadow casters the planet
 * SDF does not hold (tanks). The game hands each rigid group's triangles once (`create`, in the group's local frame),
 * places instances every frame (`set`), and every SDF shadow (sun, moon, punctual lights) and the SDF AO also march the
 * bricks their ray passes near, so tanks cast the same soft, widening shadows as the world and darken the ground under
 * them.
 *
 * - Bricks: 32³ unsigned distances minus a skin of half a voxel (so thin plates still cast) over the group's local box
 *   padded by two voxels; baked on the GPU, one brick per frame, triangles staged through workgroup memory; stored in
 *   one r16float 3D atlas of 8 × 4 × 2 slots.
 * - Instances: up to CASTER_MAX per frame, uploaded as world→local affines with the brick's box and atlas slot and a
 *   world bounding sphere. Shaders test each ray against the sphere before marching the brick.
 * - Tanks never occlude the fog of war (the simulation's rule): the fog shaders do not bind the casters.
 */
import type { EngineServices, RenderModule, Vec3 } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import { triangleWgsl } from './sdf-build.wgsl';

export const CASTER_BRICK = 32;
export const CASTER_ATLAS_SLOTS: readonly [number, number, number] = [8, 4, 2];
export const CASTER_MAX = 48;

export const CASTER_LIST = wgslStruct('SdfCasterList', [
  ['count', 'vec4u'],                                      // x instances
  ['items', { array: 'vec4f', count: CASTER_MAX * 7 }],    // per instance: 3 rows world→local, box min, 1/box size, slot uvw, sphere
]);

export interface SdfCasterHandle { readonly id: number }
export interface SdfCasterInstance { readonly id: number }
export interface SdfCastersFacet {
  /** Bake a brick of a triangle soup given in the group's local frame (null when the atlas is full or it is empty). */
  create(desc: { positions: Float32Array; indices: Uint32Array; label?: string }): SdfCasterHandle | null;
  destroy(h: SdfCasterHandle): void;
  /** Place an instance; model: column-major rigid mat4 (local → world). */
  add(h: SdfCasterHandle, model: ArrayLike<number>): SdfCasterInstance;
  set(i: SdfCasterInstance, model: ArrayLike<number>): void;
  remove(i: SdfCasterInstance): void;
  readonly atlasView: GPUTextureView;
  readonly listBuffer: GPUBuffer;
  stats(): { bricks: number; pendingBakes: number; instances: number; uploaded: number };
}
declare module '../../contracts' {
  interface SceneFacets {
    /** Distance-field bricks of the dynamic shadow casters (tanks). */
    sdfCasters: SdfCastersFacet;
  }
}

const SLOT_UVW = `vec3f(${CASTER_ATLAS_SLOTS.map(n => (1 / n).toFixed(8)).join(', ')})`;

/**
 * Queries (need `caster_atlas`, `caster_list` bindings and the sdf library's `sdf_sampler` and `sdf_penumbra`):
 * - caster_distance(i, p): distance (u) from p to instance i;
 * - casters_vis_dir(p, l, tan_a): soft visibility along a direction (sun, moon), same cone estimator as sdf_vis_dir;
 * - casters_vis_point(p, s, width): soft visibility toward a point light, same width model as sdf_vis_point;
 * - casters_near(p, reach): a bitmask of the first 32 instances whose sphere lies within reach of p (AO).
 */
export function sdfCastersWgsl(group: number, atlas: number, list: number) {
  return makeModule(`sdf-casters:${group}:${atlas},${list}`, /* wgsl */ `
@group(${group}) @binding(${atlas}) var caster_atlas: texture_3d<f32>;
@group(${group}) @binding(${list}) var<uniform> caster_list: SdfCasterList;

const CASTER_MAX: u32 = ${CASTER_MAX}u;
const CASTER_SLOT_UVW = ${SLOT_UVW};
const CASTER_HALF_TEXEL: f32 = ${(0.5 / CASTER_BRICK).toFixed(8)};

fn caster_count() -> u32 { return min(caster_list.count.x, CASTER_MAX); }
fn caster_sphere(i: u32) -> vec4f { return caster_list.items[i * 7u + 6u]; }

fn caster_distance(i: u32, p: vec3f) -> f32 {
  let b = i * 7u;
  let q4 = vec4f(p, 1.0);
  let q = vec3f(dot(caster_list.items[b], q4), dot(caster_list.items[b + 1u], q4), dot(caster_list.items[b + 2u], q4));
  let box_min = caster_list.items[b + 3u].xyz;
  let box_inv = caster_list.items[b + 4u].xyz;
  let u = (q - box_min) * box_inv;
  let uc = clamp(u, vec3f(CASTER_HALF_TEXEL), vec3f(1.0 - CASTER_HALF_TEXEL));
  let outside = length((u - uc) / box_inv);
  let d = textureSampleLevel(caster_atlas, sdf_sampler, caster_list.items[b + 5u].xyz + uc * CASTER_SLOT_UVW, 0.0).r;
  return d + outside;
}

/** Ray (p, unit dir) against instance i's sphere: the (entry, exit) distances, exit < entry when missed. */
fn caster_interval(i: u32, p: vec3f, dir: vec3f) -> vec2f {
  let s = caster_sphere(i);
  let oc = p - s.xyz;
  let b = dot(oc, dir);
  let h2 = b * b - (dot(oc, oc) - s.w * s.w);
  if (h2 < 0.0) { return vec2f(1.0, -1.0); }
  let h = sqrt(h2);
  return vec2f(-b - h, -b + h);
}

fn casters_vis_dir(p: vec3f, l: vec3f, tan_a: f32) -> f32 {
  var res = 1.0;
  let n = caster_count();
  for (var i = 0u; i < n; i++) {
    let iv = caster_interval(i, p, l);
    if (iv.y <= max(iv.x, 0.0)) { continue; }
    var t = max(iv.x, 0.01);
    for (var k = 0u; k < 32u; k++) {
      if (t > iv.y) { break; }
      let d = caster_distance(i, p + l * t);
      // These are thickened UNSIGNED surface distances, not a signed solid.
      // A ray that reaches the skin has hit opaque geometry. Feeding its shallow
      // negative distance to the signed-field penumbra left plates translucent.
      if (d <= 0.0) { return 0.0; }
      res = min(res, d / max(tan_a * t, 1e-4));
      if (res < -1.0) { break; }
      t += clamp(d, 0.01, 0.4);
    }
    if (res < -1.0) { break; }
  }
  return sdf_penumbra(res);
}

fn casters_vis_point(p: vec3f, s: vec3f, width: vec3f) -> f32 {
  let dv = s - p;
  let L = length(dv);
  if (L < 1e-3) { return 1.0; }
  let rd = dv / L;
  var res = 1.0;
  let n = caster_count();
  for (var i = 0u; i < n; i++) {
    let iv = caster_interval(i, p, rd);
    let t1 = min(iv.y, L);
    if (t1 <= max(iv.x, 0.0)) { continue; }
    var t = max(iv.x, 0.01);
    for (var k = 0u; k < 32u; k++) {
      if (t > t1) { break; }
      let d = caster_distance(i, p + rd * t);
      let w = max(min(width.x * (0.4 + 0.6 * min(t / (3.0 * width.x), 1.0)) + width.y * t, width.z), 1e-3);
      if (d <= 0.0) { return 0.0; }
      res = min(res, 2.0 * d / w);
      if (res < -1.0) { break; }
      t += clamp(d, 0.01, 0.4);
    }
    if (res < -1.0) { break; }
  }
  return sdf_penumbra(res);
}

/** Mounted emitters can sit inside their own brick's conservative voxel skin.
 * Only the identified owner may escape that connected skin, within 3.5 voxel diagonals / .3u.
 * All foreign casters and every subsequent hit remain opaque; failure to find air is dark. */
fn casters_vis_point_emitter(p: vec3f, s: vec3f, width: vec3f, owner: u32) -> f32 {
  let dv=s-p;let L=length(dv);if(L<0.001){return 1.0;}let rd=dv/L;
  var res=1.0;
  for(var i=0u;i<caster_count();i++){
    let iv=caster_interval(i,p,rd);var t1=min(iv.y,L);
    if(t1<=max(iv.x,0.0)){continue;}
    if(owner!=0u&&u32(caster_list.items[i*7u+3u].w)==owner&&caster_distance(i,s)<=0.0){
      let voxel=length(1.0/caster_list.items[i*7u+4u].xyz)/32.0;
      let reach=min(0.3,3.5*voxel);var escape=-1.0;var air=false;
      for(var k=1u;k<=24u;k++){
        let t=reach*f32(k)/24.0;
        let d=caster_distance(i,s-rd*t);
        if(d>0.0){air=true;if(d>min(0.025,voxel*0.2)){escape=t;break;}}
        else if(air){return 0.0;}
      }
      if(escape<0.0||escape>=L){return 0.0;}
      t1=min(t1,L-escape);
    }
    var t=max(iv.x,0.01);
    for(var k=0u;k<32u;k++){
      if(t>t1){break;}
      let d=caster_distance(i,p+rd*t);
      // A small lamp behind a plate is hidden; an area light (a fire) still lights around the plate's edges.
      if(d<=0.0 && width.z<0.6){return 0.0;}
      let w=max(min(width.x*(0.4+0.6*min(t/(3.0*width.x),1.0))+width.y*t,width.z),0.001);
      res=min(res,2.0*d/w);if(res< -1.0){return 0.0;}t+=clamp(d,0.01,0.4);
    }
    if(t<=t1){return 0.0;}
  }
  return sdf_penumbra(res);
}

fn casters_near(p: vec3f, reach: f32) -> u32 {
  var mask = 0u;
  let n = min(caster_count(), 32u);
  for (var i = 0u; i < n; i++) {
    let s = caster_sphere(i);
    if (length(p - s.xyz) < s.w + reach) { mask |= 1u << i; }
  }
  return mask;
}

/** The nearest caster in mask at p (1e9 when none). */
fn casters_distance(mask: u32, p: vec3f) -> f32 {
  var d = 1e9;
  var m = mask;
  while (m != 0u) {
    let i = firstTrailingBit(m);
    m &= m - 1u;
    d = min(d, caster_distance(i, p));
  }
  return d;
}
`, [CASTER_LIST.module]);
}

const BAKE = wgslStruct('CasterBake', [
  ['box_min', 'vec4f'],   // xyz local box min, w skin (u)
  ['box_size', 'vec4f'],  // xyz local box size
  ['slot', 'vec4u'],      // xyz atlas voxel origin, w triangle count
]);

function bakeShader(format: GPUTextureFormat) {
  return makeModule(`sdf-caster-bake:${format}`, /* wgsl */ `
${triangleWgsl}
@group(0) @binding(0) var<uniform> B: CasterBake;
@group(0) @binding(1) var<storage, read> tris: array<vec4f>;
@group(0) @binding(2) var atlas_out: texture_storage_3d<${format}, write>;
var<workgroup> tile: array<vec4f, 192>;

@compute @workgroup_size(4, 4, 4)
fn bake(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) li: u32) {
  let c = B.box_min.xyz + (vec3f(g) + 0.5) / ${CASTER_BRICK}.0 * B.box_size.xyz;
  var best = 1e18;
  let count = B.slot.w;
  for (var base = 0u; base < count; base += 64u) {
    workgroupBarrier();
    let k = base + li;
    if (k < count) { tile[li * 3u] = tris[k * 3u]; tile[li * 3u + 1u] = tris[k * 3u + 1u]; tile[li * 3u + 2u] = tris[k * 3u + 2u]; }
    workgroupBarrier();
    let m = min(64u, count - base);
    for (var j = 0u; j < m; j++) {
      let q = c - closest_on_triangle(c, tile[j * 3u].xyz, tile[j * 3u + 1u].xyz, tile[j * 3u + 2u].xyz);
      best = min(best, dot(q, q));
    }
  }
  textureStore(atlas_out, B.slot.xyz + g, vec4f(sqrt(best) - B.box_min.w, 0.0, 0.0, 0.0));
}
`, [BAKE.module]);
}

interface Brick { id: number; slot: number; boxMin: Vec3; boxSize: Vec3; center: Vec3; radius: number; ready: boolean; tris: Float32Array<ArrayBuffer> | null; label: string }
interface Instance { id: number; brick: number; model: Float64Array }

export function sdfCastersModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'sdf-casters',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const format: GPUTextureFormat = device.features.has('texture-formats-tier1') ? 'r16float' : 'rgba16float';
      const [sx, sy, sz] = CASTER_ATLAS_SLOTS;
      const atlas = device.createTexture({ label: 'sdf-casters:atlas', size: [sx * CASTER_BRICK, sy * CASTER_BRICK, sz * CASTER_BRICK], dimension: '3d',
        format, usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
      const atlasView = atlas.createView({ dimension: '3d' });
      const listBuffer = device.createBuffer({ label: 'sdf-casters:list', size: CASTER_LIST.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const bakeParams = device.createBuffer({ label: 'sdf-casters:bake', size: BAKE.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      let trisBuffer: GPUBuffer | null = null;
      const bakeLayout = device.createBindGroupLayout({ label: 'layout:sdf-caster-bake', entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, storageTexture: { access: 'write-only', format, viewDimension: '3d' } },
      ] });
      const key = `sdf-caster-bake:${format}`;
      s.ctx.pipelines.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [bakeLayout] }),
        compute: { module: s.ctx.pipelines.shaderModule(link(bakeShader(format)), key), entryPoint: 'bake' },
      }));
      void s.ctx.pipelines.compile(key).catch(() => undefined);

      const bricks = new Map<number, Brick>();
      const instances = new Map<number, Instance>();
      const freeSlots = Array.from({ length: sx * sy * sz }, (_, i) => i).reverse();
      const pending: Brick[] = [];
      let nextId = 1, uploaded = 0;
      const staging = new ArrayBuffer(CASTER_LIST.size);
      const items = new Float32Array(CASTER_MAX * 28);
      const count = new Uint32Array(4);

      const facet: SdfCastersFacet = {
        atlasView, listBuffer,
        create(desc) {
          const { positions, indices } = desc;
          const n = Math.floor(indices.length / 3);
          if (n === 0 || freeSlots.length === 0) return null;
          const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
          const tris = new Float32Array(n * 12);
          for (let t = 0; t < n; t++) for (let v = 0; v < 3; v++) {
            const i = indices[t * 3 + v] * 3;
            for (let a = 0; a < 3; a++) {
              const x = positions[i + a];
              tris[t * 12 + v * 4 + a] = x;
              lo[a] = Math.min(lo[a], x); hi[a] = Math.max(hi[a], x);
            }
          }
          // Pad by two voxels (of the padded box) on every side, so the field reaches beyond the surface.
          const size = hi.map((h, a) => Math.max(h - lo[a], 0.02)) as Vec3;
          const pad = size.map(e => 2 * e / (CASTER_BRICK - 4)) as Vec3;
          const boxMin = lo.map((l, a) => l - pad[a]) as Vec3;
          const boxSize = size.map((e, a) => e + 2 * pad[a]) as Vec3;
          const center = boxMin.map((m, a) => m + boxSize[a] / 2) as Vec3;
          const brick: Brick = { id: nextId++, slot: freeSlots.pop()!, boxMin, boxSize, center, radius: Math.hypot(...boxSize) / 2,
            ready: false, tris, label: desc.label ?? 'caster' };
          bricks.set(brick.id, brick);
          pending.push(brick);
          return { id: brick.id };
        },
        destroy(h) {
          const b = bricks.get(h.id);
          if (!b) return;
          bricks.delete(h.id);
          freeSlots.push(b.slot);
          const i = pending.indexOf(b);
          if (i >= 0) pending.splice(i, 1);
          for (const [id, inst] of instances) if (inst.brick === h.id) instances.delete(id);
        },
        add(h, model) {
          const inst: Instance = { id: nextId++, brick: h.id, model: new Float64Array(model) };
          instances.set(inst.id, inst);
          return { id: inst.id };
        },
        set(i, model) { instances.get(i.id)?.model.set(model); },
        remove(i) { instances.delete(i.id); },
        stats: () => ({ bricks: bricks.size, pendingBakes: pending.length, instances: instances.size, uploaded }),
      };
      s.scene.provide('sdfCasters', facet);

      // ── Bake: one brick per frame ──
      disposers.push(s.graph.addPass({
        name: 'sdf-casters.bake', slot: 'compute.commit', order: 20, reads: [], writes: [],
        enabled: () => pending.length > 0,
        run(c) {
          const pipe = s.ctx.pipelines.get<GPUComputePipeline>(key);
          const b = pending[0];
          if (!pipe || !b || !b.tris) return;
          pending.shift();
          const bytes = b.tris.byteLength;
          if (!trisBuffer || trisBuffer.size < bytes) {
            s.ctx.deferDestroy(trisBuffer);
            trisBuffer = device.createBuffer({ label: 'sdf-casters:triangles', size: Math.ceil(bytes * 1.5 / 256) * 256, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
          }
          queue.writeBuffer(trisBuffer, 0, b.tris);
          const slot = [b.slot % sx, Math.floor(b.slot / sx) % sy, Math.floor(b.slot / (sx * sy))].map(v => v * CASTER_BRICK);
          // Trilinear reconstruction can overestimate an unsigned distance by
          // half the voxel diagonal. The minimum axis misses thin armor plates.
          const voxel = Math.hypot(...b.boxSize) / CASTER_BRICK;
          const data = new ArrayBuffer(BAKE.size);
          BAKE.pack({ box_min: [...b.boxMin, 0.5 * voxel], box_size: [...b.boxSize, 0], slot: [...slot, b.tris.length / 12] }, data);
          queue.writeBuffer(bakeParams, 0, data);
          const ts = c.timestampWrites('sdf-casters.bake') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'sdf-casters.bake', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipe);
          pass.setBindGroup(0, device.createBindGroup({ layout: bakeLayout, entries: [
            { binding: 0, resource: { buffer: bakeParams } }, { binding: 1, resource: { buffer: trisBuffer, size: bytes } }, { binding: 2, resource: atlasView }] }));
          const g = CASTER_BRICK / 4;
          pass.dispatchWorkgroups(g, g, g);
          pass.end();
          b.ready = true;
          b.tris = null;
        },
      }));

      // ── Instances → the uniform list, every frame ──
      const invRigid = (m: Float64Array, out: Float32Array, o: number) => {
        // Rigid: the inverse rotation is the transpose; rows of the world→local 3×4.
        const t = [m[12], m[13], m[14]];
        for (let r = 0; r < 3; r++) {
          const col = [m[r * 4], m[r * 4 + 1], m[r * 4 + 2]];
          out[o + r * 4] = col[0]; out[o + r * 4 + 1] = col[1]; out[o + r * 4 + 2] = col[2];
          out[o + r * 4 + 3] = -(col[0] * t[0] + col[1] * t[1] + col[2] * t[2]);
        }
      };
      disposers.push(s.graph.addPass({
        name: 'sdf-casters.upload', slot: 'upload', order: 30, reads: [], writes: [],
        run() {
          let n = 0;
          for (const inst of instances.values()) {
            if (n >= CASTER_MAX) break;
            const b = bricks.get(inst.brick);
            if (!b?.ready) continue;
            const o = n * 28, m = inst.model;
            invRigid(m, items, o);
            items.set([...b.boxMin, inst.id], o + 12);
            items.set([1 / b.boxSize[0], 1 / b.boxSize[1], 1 / b.boxSize[2], 0], o + 16);
            items.set([(b.slot % sx) / sx, (Math.floor(b.slot / sx) % sy) / sy, Math.floor(b.slot / (sx * sy)) / sz, 0], o + 20);
            const c = b.center;
            items.set([m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13],
              m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14], b.radius], o + 24);
            n++;
          }
          uploaded = n;
          count[0] = n;
          CASTER_LIST.pack({ count, items: items.subarray(0, Math.max(n, 1) * 28) }, staging);
          queue.writeBuffer(listBuffer, 0, staging, 0, 16 + Math.max(n, 1) * 112);
        },
      }));
      disposers.push(() => { s.ctx.deferDestroy(atlas); s.ctx.deferDestroy(listBuffer); s.ctx.deferDestroy(bakeParams); s.ctx.deferDestroy(trisBuffer); });
    },
    dispose() { for (const d of disposers.splice(0).reverse()) d(); },
  };
}
