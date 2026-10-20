/** Thin analytic 3D pressure fronts, after TAA and before every gameplay overlay.
 * Reads the existing TAA resolve directly, so no HDR copy, volume texture, or per-shot GPU allocation is needed.
 */
import type { EngineServices, RenderModule } from '../../contracts';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage } from '../../gpu/flags';
import { drawFullscreenTriangle } from '../../gpu/fullscreen';
import { link } from '../../wgsl/module';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { HDR_FORMAT } from '../lighting/lighting';
import { POST_TEXTURE, TAA_TEXTURE } from '../post/taa';
import { MAX_SHOCKWAVES, ShockwavePool, shockwaveState, type ShockwaveKind } from './shockwave-pool';
import { SHOCKWAVE_UNIFORMS, shockwavesWgsl } from './shockwaves.wgsl';

export interface ShockwaveFacet {
  enabled: boolean;
  emit(position: readonly number[], normal: readonly number[], radius: number, kind?: ShockwaveKind): void;
  clear(): void;
  stats(): { live: number; capacity: number; emitted: number; replaced: number; bytes: number; drawn: number };
}
declare module '../../contracts' { interface SceneFacets { shockwaves: ShockwaveFacet } }

/**
 * The display rectangle every live wave can change, or null for all of it: a pixel whose ray misses each wave's sphere out
 * to its contact wake (front + band / 4) gets the scene colour back unchanged. Each sphere's bounding cube is projected
 * (null when a corner is behind the eye) and padded by two pixels for the raster jitter and rounding.
 */
export function shockwaveRect(viewProj: Float32Array, display: readonly [number, number], uniforms: Float32Array, count: number): [number, number, number, number] | null {
  const [width, height] = display;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const centers = SHOCKWAVE_UNIFORMS.offsets.centers / 4, motions = SHOCKWAVE_UNIFORMS.offsets.motions / 4;
  for (let i = 0; i < count; i++) {
    const c = centers + i * 4, reach = (uniforms[c + 3] + 0.25 * Math.max(0.06, uniforms[motions + i * 4 + 2] * 0.1)) * 1.01 + 0.02;
    for (let k = 0; k < 8; k++) {
      const x = uniforms[c] + (k & 1 ? reach : -reach), y = uniforms[c + 1] + (k & 2 ? reach : -reach), z = uniforms[c + 2] + (k & 4 ? reach : -reach);
      const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
      if (!(w > 1e-4)) return null;
      const u = ((viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) / w * 0.5 + 0.5) * width;
      const v = (0.5 - (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) / w * 0.5) * height;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
  }
  const left = Math.min(width, Math.max(0, Math.floor(x0) - 2)), top = Math.min(height, Math.max(0, Math.floor(y0) - 2));
  const right = Math.max(left, Math.min(width, Math.ceil(x1) + 2)), bottom = Math.max(top, Math.min(height, Math.ceil(y1) + 2));
  if (left <= 0 && top <= 0 && right >= width && bottom >= height) return null;
  return [left, top, right - left, bottom - top];
}

export function shockwavesModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'shockwaves',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const pool = new ShockwavePool();
      pool.setTier(s.settings.tier);
      const buffer = device.createBuffer({ label: 'shockwaves:uniforms', size: SHOCKWAVE_UNIFORMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const staging = new Float32Array(SHOCKWAVE_UNIFORMS.size / 4);
      const sampler = device.createSampler({ label: 'shockwaves:linear', magFilter: 'linear', minFilter: 'linear' });
      const groups = new BindGroupResourceCache(4);
      const layout = device.createBindGroupLayout({ label: 'layout:shockwaves', entries: [
        { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 6, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ] });
      const key = 'shockwaves';
      s.ctx.pipelines.register(key, 'render', () => {
        const module = s.ctx.pipelines.shaderModule(link(shockwavesWgsl), key);
        return { label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
          vertex: { module, entryPoint: 'vs_fullscreen' }, fragment: { module, entryPoint: 'fs_shockwave', targets: [{ format: HDR_FORMAT }] },
          primitive: { topology: 'triangle-list' } };
      });
      void s.ctx.pipelines.compile(key).catch(() => undefined);
      const frameGroup = createFrameBindGroup(s, 'shockwaves');
      let drawn = 0;
      const facet: ShockwaveFacet = {
        enabled: true,
        emit(position, normal, radius, kind = 'explosive') { pool.emit(position, normal, radius, kind); },
        clear() { pool.clear(); drawn = 0; },
        stats: () => ({ live: pool.waves.length, capacity: pool.capacity, emitted: pool.emitted, replaced: pool.replaced, bytes: SHOCKWAVE_UNIFORMS.size, drawn }),
      };
      s.scene.provide('shockwaves', facet);
      disposers.push(s.events.on('planetChanged', () => facet.clear()));
      disposers.push(s.events.on('tierChanged', e => pool.setTier(e.tier)));
      disposers.push(s.events.on('resize', () => groups.clear()));
      disposers.push(s.graph.addPass({
        name: 'shockwaves.update', slot: 'upload', order: 48, reads: [], writes: [],
        run(c) {
          pool.advance(c.frame.dt);
          drawn = 0;
          staging[0] = pool.waves.length;
          staging[1] = c.frame.tier === 'low' ? 0 : 1;
          const fluids = s.scene.get('fluids');
          staging[2] = fluids?.toggles.liquids ? 1 : 0;
          const centers = SHOCKWAVE_UNIFORMS.offsets.centers / 4;
          const shapes = SHOCKWAVE_UNIFORMS.offsets.shapes / 4;
          const motions = SHOCKWAVE_UNIFORMS.offsets.motions / 4;
          for (let i = 0; i < pool.waves.length; i++) {
            const wave = pool.waves[i], state = shockwaveState(wave), p = state.profile, c = centers + i * 4, h = shapes + i * 4, m = motions + i * 4;
            staging[c] = wave.center[0]; staging[c + 1] = wave.center[1]; staging[c + 2] = wave.center[2]; staging[c + 3] = state.radius;
            staging[h] = state.thickness; staging[h + 1] = p.pressure * state.fade; staging[h + 2] = p.condensation * state.fade; staging[h + 3] = p.dust * state.fade;
            staging[m] = state.t; staging[m + 1] = wave.serial % 97; staging[m + 2] = wave.radius; staging[m + 3] = 0;
          }
          if (pool.waves.length > 0 && facet.enabled) queue.writeBuffer(buffer, 0, staging);
          s.telemetry.gauge('shockwaves.live', pool.waves.length);
          s.telemetry.gauge('shockwaves.capacity', pool.capacity);
          s.telemetry.gauge('shockwaves.bytes', SHOCKWAVE_UNIFORMS.size);
          s.telemetry.gauge('shockwaves.emitted', pool.emitted);
        },
      }));
      disposers.push(s.graph.addPass({
        name: 'shockwaves', slot: 'taa', order: 15,
        reads: ['frameUniforms', TAA_TEXTURE, POST_TEXTURE, 'depth', 'ids'], writes: [POST_TEXTURE],
        enabled: () => facet.enabled && pool.waves.length > 0,
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPURenderPipeline>(key);
          if (!pipeline) return;
          const color = c.resources.view(TAA_TEXTURE), depth = c.resources.view('depth'), ids = c.resources.view('ids');
          const water = s.bindings.get('waterSurface');
          const groupKey = groups.begin(); groupKey.push(color, depth, ids, sampler, buffer, water.surface);
          pushBindingKey(groupKey, water.params);
          const group = groups.get(() => device.createBindGroup({ label: 'shockwaves', layout, entries: [
            { binding: 0, resource: color }, { binding: 1, resource: depth }, { binding: 2, resource: ids },
            { binding: 3, resource: sampler }, { binding: 4, resource: { buffer } },
            { binding: 5, resource: water.surface }, { binding: 6, resource: water.params },
          ] }));
          const ts = c.timestampWrites('shockwaves') as GPURenderPassTimestampWrites | undefined;
          const rect = shockwaveRect(c.frame.viewProjNoJitter, c.frame.display, staging, pool.waves.length);
          // Outside the rect the shader returns the TAA colour with alpha 1, which taa.present has already copied there.
          const pass = c.encoder.beginRenderPass({ label: 'shockwaves',
            colorAttachments: [{ view: c.resources.view(POST_TEXTURE), loadOp: rect ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            ...(ts ? { timestampWrites: ts } : {}),
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, group);
          if (rect) pass.setScissorRect(rect[0], rect[1], rect[2], rect[3]);
          drawFullscreenTriangle(pass); pass.end();
          drawn = Math.min(MAX_SHOCKWAVES, pool.waves.length);
        },
      }));
      disposers.push(() => { facet.clear(); groups.clear(); s.ctx.deferDestroy(buffer); });
    },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); },
  };
}
