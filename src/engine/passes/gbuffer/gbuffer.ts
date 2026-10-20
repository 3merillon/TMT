// Ported from Pinionfall src/gpu/gbuffer-flags.ts (MIT, same owner)
/**
 * G-buffer module (plan §4.6): declares the MRT targets per GBUFFER, owns the 'gbuffer.opaque' and 'gbuffer.foliage'
 * passes and calls the registered GBufferDrawers in `order`.
 *
 * - depth32float cleared to 0 (reversed-Z), pipelines use compare 'greater' (GBUFFER_DEPTH_STENCIL);
 * - the ids target is cleared to the SKY class (15), everything else to 0;
 * - @group(0) is the frame block (ctx.layouts.frame) and is (re)bound before every drawer: drawers use groups 1..3.
 * The GB3 flag layout adapted from Pinionfall's G2 flags lives in contracts GBUFFER_FLAG + wgsl/common/gbuffer.wgsl.ts.
 */
import { GBUFFER } from '../../contracts';
import type { EngineServices, FrameState, PassContext, RenderModule } from '../../contracts';
import { TextureUsage } from '../../gpu/flags';
import { GBUFFER_CLEAR_IDS } from '../../wgsl/common/gbuffer.wgsl';
import type { Scene } from '../../scene/scene-registry';

export const GBUFFER_COLOR_NAMES = ['albedoAo', 'normals', 'material', 'ids', 'velocity'] as const;
export const GBUFFER_NAMES = [...GBUFFER_COLOR_NAMES, 'depth'] as const;

export const GBUFFER_COLOR_TARGETS: GPUColorTargetState[] = GBUFFER_COLOR_NAMES.map(n => ({ format: GBUFFER[n] }));
export const GBUFFER_DEPTH_STENCIL: GPUDepthStencilState = { format: GBUFFER.depth, depthWriteEnabled: true, depthCompare: 'greater' };

const USAGE = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING;

export function createFrameBindGroup(s: Pick<EngineServices, 'ctx' | 'frameUniforms'>, label: string): GPUBindGroup {
  return s.ctx.device.createBindGroup({ label: `frame-group:${label}`, layout: s.ctx.layouts.frame, entries: [{ binding: 0, resource: { buffer: s.frameUniforms } }] });
}

export function gbufferModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'gbuffer',
    install(s) {
      const scene = s.scene as Scene;
      for (const n of GBUFFER_NAMES) s.graph.declareTexture(n, { format: GBUFFER[n], size: 'internal', usage: USAGE });
      const frameGroup = createFrameBindGroup(s, 'gbuffer');

      const encode = (c: PassContext, slot: 'gbuffer.opaque' | 'gbuffer.foliage', load: boolean, tankPass = false) => {
        const r = c.resources;
        const ts = c.timestampWrites(tankPass ? 'gbuffer.tanks' : slot) as GPURenderPassTimestampWrites | undefined;
        const loadOp: GPULoadOp = load ? 'load' : 'clear';
        const pass = c.encoder.beginRenderPass({
          label: slot,
          colorAttachments: GBUFFER_COLOR_NAMES.map(n => ({
            view: r.view(n), loadOp, storeOp: 'store' as GPUStoreOp,
            clearValue: n === 'ids' ? { r: GBUFFER_CLEAR_IDS, g: 0, b: 0, a: 0 } : { r: 0, g: 0, b: 0, a: 0 },
          })),
          depthStencilAttachment: { view: r.view('depth'), depthLoadOp: loadOp, depthStoreOp: 'store', depthClearValue: 0 },
          ...(ts ? { timestampWrites: ts } : {}),
        });
        for (const d of scene.drawersFor(slot)) {
          if (slot === 'gbuffer.opaque' && (d.name === 'part-mesh') !== tankPass) continue;
          pass.setBindGroup(0, frameGroup);
          d.draw(pass, c.frame);
        }
        pass.end();
      };

      disposers.push(s.graph.addPass({
        name: 'gbuffer.opaque', slot: 'gbuffer.opaque', order: 0,
        reads: ['frameUniforms'], writes: [...GBUFFER_NAMES],
        run: c => encode(c, 'gbuffer.opaque', false),
      }));
      // Resolve observer visibility after terrain; tanks use that clip mask in the next pass.
      disposers.push(s.graph.addPass({
        name: 'gbuffer.tanks', slot: 'gbuffer.opaque', order: 2,
        reads: ['frameUniforms', ...GBUFFER_NAMES], writes: [...GBUFFER_NAMES],
        run: c => encode(c, 'gbuffer.opaque', true, true),
      }));
      disposers.push(s.graph.addPass({
        name: 'gbuffer.foliage', slot: 'gbuffer.foliage', order: 0,
        reads: ['frameUniforms', ...GBUFFER_NAMES], writes: [...GBUFFER_NAMES],
        enabled: (_f: FrameState) => scene.drawersFor('gbuffer.foliage').length > 0,
        run: c => encode(c, 'gbuffer.foliage', true),
      }));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
