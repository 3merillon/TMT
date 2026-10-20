/**
 * Forward passes that call the scene's TransparentDrawers ('transparent' slot) and OverlayDrawers ('overlay' slot, after
 * TAA/DOF so overlays stay sharp). Enabled only while drawers are registered. @group(0) = frame uniforms is bound before
 * every drawer.
 * - 'transparent': one render pass into 'hdr' (internal size, loadOp 'load') with the G-buffer depth attached read-only.
 *   Drawer pipelines use FORWARD_COLOR_TARGET / FORWARD_DEPTH_STENCIL (reversed-Z test, no depth writes).
 *   W2-FX extends the transparent path (HDR/depth copies, reactive mask, volume depth).
 * - 'overlay' (CC-013): one render pass into the post chain's input 'postColor' (DISPLAY size, loadOp 'load'; TAA's
 *   'taa.present' fills it, bloom and composite read it), with NO depth attachment, so the overlays never enter the TAA
 *   history and stay sharp at any render scale. Drawer pipelines use FORWARD_COLOR_TARGET without a depthStencil state
 *   and test depth in the fragment shader against `overlayDepth()` (scene/overlays.ts), scaling display pixels to the
 *   internal depth size; they project with `view_proj_nojitter` (the resolve is unjittered).
 */
import type { EngineServices, FrameState, PassContext, RenderModule } from '../../contracts';
import { GBUFFER } from '../../contracts';
import type { Scene } from '../../scene/scene-registry';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { HDR_FORMAT } from '../lighting/lighting';
import { POST_TEXTURE } from '../post/taa';

export const FORWARD_COLOR_TARGET: GPUColorTargetState = { format: HDR_FORMAT };
export const FORWARD_BLEND_ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};
export const FORWARD_BLEND_OVER: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
export const FORWARD_DEPTH_STENCIL: GPUDepthStencilState = { format: GBUFFER.depth, depthWriteEnabled: false, depthCompare: 'greater' };

export function forwardModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'forward',
    install(s: EngineServices) {
      const scene = s.scene as Scene;
      const frameGroup = createFrameBindGroup(s, 'forward');
      const encode = (c: PassContext, name: string, draw: (pass: GPURenderPassEncoder, f: FrameState) => void) => {
        const ts = c.timestampWrites(name) as GPURenderPassTimestampWrites | undefined;
        const pass = c.encoder.beginRenderPass({
          label: name,
          colorAttachments: [{ view: c.resources.view('hdr'), loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: c.resources.view('depth'), depthReadOnly: true },
          ...(ts ? { timestampWrites: ts } : {}),
        });
        draw(pass, c.frame);
        pass.end();
      };
      disposers.push(s.graph.addPass({
        name: 'transparent', slot: 'transparent', order: 0, reads: ['frameUniforms', 'hdr', 'depth'], writes: ['hdr'],
        enabled: () => scene.transparentDrawers.length > 0,
        run: c => encode(c, 'transparent', (pass, f) => { for (const d of scene.transparentDrawers) { pass.setBindGroup(0, frameGroup); d.draw(pass, f); } }),
      }));
      disposers.push(s.graph.addPass({
        name: 'overlay', slot: 'overlay', order: 0, reads: ['frameUniforms', POST_TEXTURE, 'depth'], writes: [POST_TEXTURE],
        enabled: () => scene.overlayDrawers.length > 0,
        run: c => {
          const ts = c.timestampWrites('overlay') as GPURenderPassTimestampWrites | undefined;
          const pass = c.encoder.beginRenderPass({
            label: 'overlay',
            colorAttachments: [{ view: c.resources.view(POST_TEXTURE), loadOp: 'load', storeOp: 'store' }],
            ...(ts ? { timestampWrites: ts } : {}),
          });
          for (const d of scene.overlayDrawers) { pass.setBindGroup(0, frameGroup); d.draw(pass, c.frame); }
          pass.end();
        },
      }));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
