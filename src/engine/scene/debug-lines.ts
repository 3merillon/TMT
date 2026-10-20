/**
 * Debug lines (overlay slot, always on top; display size, no depth state, CC-013): world-space segments expanded to
 * screen-space quads of `width` CSS px.
 * Replaces the three `tank-debug.ts` edge boxes (the vehicle debug view feeds the collision boxes here). Scene facet
 * `debugLines`: `set(segments, colors?)` with 6 floats (a, b) per segment and optionally 3 floats of colour per segment.
 */
import type { EngineServices, OverlayDrawer, RenderModule, Vec3 } from '../contracts';
import { BufferUsage, ShaderStage } from '../gpu/flags';
import { FORWARD_COLOR_TARGET } from '../passes/forward/forward';
import { frameWgsl } from '../wgsl/common/frame.wgsl';
import { link, makeModule } from '../wgsl/module';
import './facets';

export const MAX_DEBUG_SEGMENTS = 4096;

export interface DebugLinesFacet {
  /** Replace every segment: 6 floats per segment (ax, ay, az, bx, by, bz); colours 3 floats per segment (default cyan). */
  set(segments: Float32Array, colors?: Float32Array | Vec3): void;
  clear(): void;
  readonly count: number;
}

const linesShader = makeModule('debug-lines', /* wgsl */ `
struct Segment { a: vec4f, b: vec4f, color: vec4f }
@group(1) @binding(0) var<storage, read> segments: array<Segment>;
struct LineOut { @builtin(position) position: vec4f, @location(0) color: vec3f }

@vertex
fn vs_line(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
  let s = segments[ii];
  let ca = frame.view_proj_nojitter * vec4f(s.a.xyz, 1.0);
  let cb = frame.view_proj_nojitter * vec4f(s.b.xyz, 1.0);
  var out: LineOut;
  out.color = s.color.rgb / max(frame.exposure, 1e-4);
  if (ca.w <= 1e-4 || cb.w <= 1e-4) { out.position = vec4f(0.0, 0.0, -1.0, 1.0); return out; }
  let size = frame_display_size();
  let sa = ca.xy / ca.w * size;
  let sb = cb.xy / cb.w * size;
  var d = sb - sa;
  let l = length(d);
  d = select(vec2f(1.0, 0.0), d / l, l > 1e-6);
  let n = vec2f(-d.y, d.x) * s.color.w;
  var corner = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let k = corner[vi];
  let c = select(ca, cb, k.x > 0.5);
  let offset = n * k.y * 2.0 / size;
  out.position = vec4f(c.xy + offset * c.w, c.z, c.w);
  return out;
}

@fragment
fn fs_line(in: LineOut) -> @location(0) vec4f { return vec4f(in.color, 1.0); }
`, [frameWgsl]);

export function debugLinesShader() { return link(linesShader); }

export interface DebugLinesModule extends RenderModule { readonly facet: DebugLinesFacet | null }

export function debugLinesModule(options: { width?: number } = {}): DebugLinesModule {
  const disposers: (() => void)[] = [];
  let facet: DebugLinesFacet | null = null;
  return {
    name: 'scene.debug-lines',
    get facet() { return facet; },
    async install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const cache = s.ctx.pipelines;
      const layout = device.createBindGroupLayout({ label: 'layout:debug-lines', entries: [{ binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
      cache.register('debug:lines', 'render', () => {
        const module = cache.shaderModule(debugLinesShader(), 'debug:lines');
        return {
          label: 'debug:lines', layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
          vertex: { module, entryPoint: 'vs_line' }, fragment: { module, entryPoint: 'fs_line', targets: [FORWARD_COLOR_TARGET] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
        };
      });
      await cache.compile('debug:lines');
      const buffer = device.createBuffer({ label: 'debug:lines', size: MAX_DEBUG_SEGMENTS * 48, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
      disposers.push(() => s.ctx.deferDestroy(buffer));
      const group = device.createBindGroup({ label: 'debug:lines', layout, entries: [{ binding: 0, resource: { buffer } }] });
      const staging = new Float32Array(MAX_DEBUG_SEGMENTS * 12);
      let count = 0, dpr = 1;
      const halfWidth = () => (options.width ?? 1.5) * dpr * 0.5;
      disposers.push(s.events.on('resize', e => { dpr = e.dpr || 1; }));
      facet = {
        get count() { return count; },
        set(segments, colors) {
          const n = Math.min(Math.floor(segments.length / 6), MAX_DEBUG_SEGMENTS);
          const w = halfWidth();
          for (let i = 0; i < n; i++) {
            const o = i * 12;
            staging[o] = segments[i * 6]; staging[o + 1] = segments[i * 6 + 1]; staging[o + 2] = segments[i * 6 + 2]; staging[o + 3] = 1;
            staging[o + 4] = segments[i * 6 + 3]; staging[o + 5] = segments[i * 6 + 4]; staging[o + 6] = segments[i * 6 + 5]; staging[o + 7] = 1;
            const c = colors instanceof Float32Array ? [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]] : colors ?? [0.44, 0.96, 0.88];
            staging[o + 8] = c[0]; staging[o + 9] = c[1]; staging[o + 10] = c[2]; staging[o + 11] = w;
          }
          count = n;
          if (n) queue.writeBuffer(buffer, 0, staging.buffer, 0, n * 48);
        },
        clear() { count = 0; },
      };
      s.scene.provide('debugLines', facet);
      const drawer: OverlayDrawer = {
        name: 'debug-lines',
        draw(pass) {
          if (!count) return;
          const pipeline = cache.get<GPURenderPipeline>('debug:lines');
          if (!pipeline) return;
          pass.setPipeline(pipeline);
          pass.setBindGroup(1, group);
          pass.draw(6, count);
        },
      };
      disposers.push(s.scene.addOverlayDrawer(drawer));
    },
    dispose() { for (const d of disposers.splice(0)) d(); facet = null; },
  };
}
