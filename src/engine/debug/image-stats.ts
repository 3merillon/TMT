/**
 * imageStats(rect): a GPU reduction over the final LDR image (display-encoded values, like a PNG) in a device-pixel rect.
 * Pass 1: 16×16 workgroups write partial sums (luma, luma², count, laplacian, laplacian², count); pass 2: one workgroup
 * folds the partials; the 24 B result comes back through the engine's bounded readback ring. Luma = Rec.709 weights on
 * the encoded values; laplacian = 4c − l − r − u − d over interior pixels of the rect.
 * One request is serviced per frame (queued otherwise); the pass runs only while requests are pending.
 */
import type { EngineServices, RenderModule } from '../contracts';
import { BufferUsage, ShaderStage } from '../gpu/flags';
import type { ReadbackRing } from '../gpu/readback';
import { link, makeModule } from '../wgsl/module';

export interface ImageStats { mean: number; variance: number; laplacianVariance: number; pixels: number; rect: [number, number, number, number] }
export interface StatsRect { x: number; y: number; w: number; h: number }

const statsShader = makeModule('image-stats', /* wgsl */ `
struct StatsParams { rect: vec4u, groups: vec4u }   // rect x, y, w, h; groups.x = partial count, groups.y = groups per row
@group(0) @binding(0) var ldr: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: StatsParams;
@group(0) @binding(2) var<storage, read_write> partials: array<f32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32>;

var<workgroup> s0: array<f32, 256>;
var<workgroup> s1: array<f32, 256>;
var<workgroup> s2: array<f32, 256>;
var<workgroup> s3: array<f32, 256>;
var<workgroup> s4: array<f32, 256>;
var<workgroup> s5: array<f32, 256>;

fn luma(p: vec2u) -> f32 { return dot(textureLoad(ldr, p, 0).rgb, vec3f(0.2126, 0.7152, 0.0722)); }

fn fold(li: u32) {
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (li < s) {
      s0[li] += s0[li + s]; s1[li] += s1[li + s]; s2[li] += s2[li + s];
      s3[li] += s3[li + s]; s4[li] += s4[li + s]; s5[li] += s5[li + s];
    }
    workgroupBarrier();
  }
}

@compute @workgroup_size(16, 16, 1)
fn partial(@builtin(local_invocation_index) li: u32, @builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let r = params.rect;
  let p = r.xy + wid.xy * 16u + lid.xy;
  var a = vec3f(0.0);
  var b = vec3f(0.0);
  if (p.x < r.x + r.z && p.y < r.y + r.w) {
    let l = luma(p);
    a = vec3f(l, l * l, 1.0);
    if (p.x > r.x && p.y > r.y && p.x + 1u < r.x + r.z && p.y + 1u < r.y + r.w) {
      let lap = 4.0 * l - luma(p - vec2u(1u, 0u)) - luma(p + vec2u(1u, 0u)) - luma(p - vec2u(0u, 1u)) - luma(p + vec2u(0u, 1u));
      b = vec3f(lap, lap * lap, 1.0);
    }
  }
  s0[li] = a.x; s1[li] = a.y; s2[li] = a.z; s3[li] = b.x; s4[li] = b.y; s5[li] = b.z;
  workgroupBarrier();
  fold(li);
  if (li == 0u) {
    let o = (wid.y * params.groups.y + wid.x) * 6u;
    partials[o] = s0[0]; partials[o + 1u] = s1[0]; partials[o + 2u] = s2[0];
    partials[o + 3u] = s3[0]; partials[o + 4u] = s4[0]; partials[o + 5u] = s5[0];
  }
}

@compute @workgroup_size(256, 1, 1)
fn reduce(@builtin(local_invocation_index) li: u32) {
  var acc0 = 0.0; var acc1 = 0.0; var acc2 = 0.0; var acc3 = 0.0; var acc4 = 0.0; var acc5 = 0.0;
  for (var i = li; i < params.groups.x; i += 256u) {
    let o = i * 6u;
    acc0 += partials[o]; acc1 += partials[o + 1u]; acc2 += partials[o + 2u];
    acc3 += partials[o + 3u]; acc4 += partials[o + 4u]; acc5 += partials[o + 5u];
  }
  s0[li] = acc0; s1[li] = acc1; s2[li] = acc2; s3[li] = acc3; s4[li] = acc4; s5[li] = acc5;
  workgroupBarrier();
  fold(li);
  if (li == 0u) {
    result[0] = s0[0]; result[1] = s1[0]; result[2] = s2[0]; result[3] = s3[0]; result[4] = s4[0]; result[5] = s5[0];
  }
}
`);

export function imageStatsShader() { return link(statsShader); }

/** Final statistics from the six sums (f64 on the CPU). */
export function statsFromSums(sums: ArrayLike<number>, rect: [number, number, number, number]): ImageStats {
  const [sl, sl2, n, sp, sp2, m] = Array.from(sums);
  const mean = n > 0 ? sl / n : 0;
  const variance = n > 0 ? Math.max(0, sl2 / n - mean * mean) : 0;
  const lapMean = m > 0 ? sp / m : 0;
  const laplacianVariance = m > 0 ? Math.max(0, sp2 / m - lapMean * lapMean) : 0;
  return { mean, variance, laplacianVariance, pixels: n, rect };
}

export interface ImageStatsModule extends RenderModule { request(rect: StatsRect | null): Promise<ImageStats> }

export function imageStatsModule(readback: ReadbackRing): ImageStatsModule {
  const disposers: (() => void)[] = [];
  const queue: { rect: StatsRect | null; resolve: (s: ImageStats) => void; reject: (e: unknown) => void }[] = [];
  return {
    name: 'debug.image-stats',
    request(rect) { return new Promise((resolve, reject) => queue.push({ rect, resolve, reject })); },
    install(s: EngineServices) {
      const { device } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const layout = device.createBindGroupLayout({
        label: 'layout:image-stats',
        entries: [
          { binding: 0, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 1, visibility: C, buffer: { type: 'uniform' } },
          { binding: 2, visibility: C, buffer: { type: 'storage' } },
          { binding: 3, visibility: C, buffer: { type: 'storage' } },
        ],
      });
      const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      for (const entryPoint of ['partial', 'reduce']) {
        s.ctx.pipelines.register(`debug:image-stats:${entryPoint}`, 'compute', () => ({
          label: `image-stats:${entryPoint}`, layout: pl,
          compute: { module: s.ctx.pipelines.shaderModule(imageStatsShader(), 'image-stats'), entryPoint },
        }));
      }
      const params = device.createBuffer({ label: 'debug:image-stats-params', size: 32, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const result = device.createBuffer({ label: 'debug:image-stats-result', size: 32, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC });
      let partials: GPUBuffer | null = null;
      let partialBytes = 0;
      disposers.push(s.graph.addPass({
        name: 'debug.image-stats', slot: 'composite', order: 90, reads: ['ldr'], writes: [],
        enabled: () => queue.length > 0,
        run(c) {
          const pa = s.ctx.pipelines.get<GPUComputePipeline>('debug:image-stats:partial');
          const pr = s.ctx.pipelines.get<GPUComputePipeline>('debug:image-stats:reduce');
          if (!pa || !pr) {
            void s.ctx.pipelines.compile('debug:image-stats:partial').catch(() => undefined);
            void s.ctx.pipelines.compile('debug:image-stats:reduce').catch(() => undefined);
            return;
          }
          const req = queue.shift()!;
          const [dw, dh] = c.frame.display;
          const r = req.rect ?? { x: 0, y: 0, w: dw, h: dh };
          const x = Math.max(0, Math.min(dw - 1, Math.floor(r.x))), y = Math.max(0, Math.min(dh - 1, Math.floor(r.y)));
          const w = Math.max(1, Math.min(dw - x, Math.round(r.w))), h = Math.max(1, Math.min(dh - y, Math.round(r.h)));
          const gx = Math.ceil(w / 16), gy = Math.ceil(h / 16);
          const need = gx * gy * 6 * 4;
          if (!partials || partialBytes < need) {
            if (partials) s.ctx.deferDestroy(partials);
            partialBytes = Math.max(need, 64 * 1024);
            partials = device.createBuffer({ label: 'debug:image-stats-partials', size: partialBytes, usage: BufferUsage.STORAGE });
          }
          device.queue.writeBuffer(params, 0, new Uint32Array([x, y, w, h, gx * gy, gx, 0, 0]));
          const group = device.createBindGroup({ label: 'image-stats', layout, entries: [
            { binding: 0, resource: c.resources.view('ldr') }, { binding: 1, resource: { buffer: params } },
            { binding: 2, resource: { buffer: partials } }, { binding: 3, resource: { buffer: result } }] });
          const ts = c.timestampWrites('debug.image-stats') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'debug.image-stats', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setBindGroup(0, group);
          pass.setPipeline(pa);
          pass.dispatchWorkgroups(gx, gy);
          pass.setPipeline(pr);
          pass.dispatchWorkgroups(1);
          pass.end();
          const pending = readback.copy(c.encoder, result, 0, 24);
          if (!pending) { queue.unshift(req); return; }
          pending.then(bytes => req.resolve(statsFromSums(new Float32Array(bytes, 0, 6), [x, y, w, h])), req.reject);
        },
      }));
      disposers.push(() => {
        s.ctx.deferDestroy(params); s.ctx.deferDestroy(result); if (partials) s.ctx.deferDestroy(partials);
        for (const q of queue.splice(0)) q.reject(new Error('image stats disposed'));
      });
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
