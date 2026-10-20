/**
 * Shadow-caster smoke pass (dev): renders every registered ShadowCaster into a small reversed-Z depth map from a planet-
 * wide orthographic sun view, so the depth-only caster path (pipelines, bind groups, SHADOW_DEPTH convention) runs under
 * validation before W1-ENG-LOOK's real sun maps exist. Nothing samples the map.
 */
import { SHADOW_DEPTH } from '../contracts';
import type { EngineServices, RenderModule, ShadowView } from '../contracts';
import { lookAt, multiply } from '../frame/camera';
import { BufferUsage, TextureUsage } from '../gpu/flags';
import { SHADOW_VIEW_UNIFORMS } from '../wgsl/common/shadow-view.wgsl';
import type { Scene } from '../scene/scene-registry';

/** Reversed-Z orthographic projection: depth 1 at `near`, 0 at `far` (view space looks down −Z). */
export function orthoReversed(halfExtent: number, near: number, far: number, out = new Float64Array(16)): Float64Array {
  out.fill(0);
  out[0] = 1 / halfExtent;
  out[5] = 1 / halfExtent;
  out[10] = 1 / (far - near);
  out[14] = far / (far - near);
  out[15] = 1;
  return out;
}

export function shadowSmokeModule(options: { size?: number; radius?: number } = {}): RenderModule {
  const disposers: (() => void)[] = [];
  const size = options.size ?? 512;
  const radius = options.radius ?? 25;
  return {
    name: 'debug.shadow-smoke',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const scene = s.scene as Scene;
      const depth = device.createTexture({ label: 'debug:shadow-smoke', size: [size, size], format: SHADOW_DEPTH.format, usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });
      const view = depth.createView();
      const uniforms = device.createBuffer({ label: 'debug:shadow-smoke-view', size: SHADOW_VIEW_UNIFORMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const bindGroup = device.createBindGroup({ label: 'shadow-smoke-view', layout: s.ctx.layouts.shadowView, entries: [{ binding: 0, resource: { buffer: uniforms } }] });
      const viewProj = new Float32Array(16);
      const shadowView: ShadowView = { kind: 'dynamic', viewProj, bindGroup, cull: () => true };
      const staging = new ArrayBuffer(SHADOW_VIEW_UNIFORMS.size);
      disposers.push(s.graph.addPass({
        name: 'debug.shadow-smoke', slot: 'shadows', order: 1000, reads: [], writes: [],
        enabled: () => scene.shadowCasters.length > 0,
        run(c) {
          const l = c.frame.sunDir;
          const up = Math.abs(l[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
          const v = lookAt([l[0] * radius, l[1] * radius, l[2] * radius], [0, 0, 0], up);
          viewProj.set(multiply(orthoReversed(radius, 0, radius * 2), v));
          SHADOW_VIEW_UNIFORMS.pack({ view_proj: viewProj, light_dir: [...l, (2 * radius) / size], params: [0, 0, 0, 0] }, staging);
          queue.writeBuffer(uniforms, 0, staging);
          const ts = c.timestampWrites('debug.shadow-smoke') as GPURenderPassTimestampWrites | undefined;
          const pass = c.encoder.beginRenderPass({
            label: 'debug.shadow-smoke', colorAttachments: [],
            depthStencilAttachment: { view, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: SHADOW_DEPTH.clear },
            ...(ts ? { timestampWrites: ts } : {}),
          });
          for (const caster of scene.shadowCasters) caster.drawDepth(pass, shadowView);
          pass.end();
        },
      }));
      disposers.push(() => { s.ctx.deferDestroy(depth); s.ctx.deferDestroy(uniforms); });
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
