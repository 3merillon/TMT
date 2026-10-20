/**
 * Sandbox OverlayDrawer: an additive ring around the focus in the local tangent plane, drawn on top. Exercises the
 * 'overlay' forward pass (display-size HDR post input, no depth attachment since CC-013, @group(0) frame); the game's
 * rings test depth in their fragment shader instead (scene/overlays.ts).
 */
import type { EngineServices, OverlayDrawer, Vec3 } from '../contracts';
import { BufferUsage, ShaderStage } from '../gpu/flags';
import { FORWARD_BLEND_ADD, FORWARD_COLOR_TARGET } from '../passes/forward/forward';
import { frameWgsl } from '../wgsl/common/frame.wgsl';
import { link, makeModule, wgslStruct } from '../wgsl/module';
import { surfaceFrame } from './geometry';

const SEGMENTS = 96;
const RING = wgslStruct('FocusRing', [['center', 'vec4f'], ['tangent', 'vec4f'], ['bitangent', 'vec4f'], ['up', 'vec4f'], ['color', 'vec4f']]);

const ringShader = makeModule('sandbox-focus-ring', /* wgsl */ `
@group(1) @binding(0) var<uniform> ring: FocusRing;
const SEGMENTS: u32 = ${SEGMENTS}u;

@vertex
fn vs_ring(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let seg = vi / 6u;
  let corner = vi % 6u;
  let along = select(0u, 1u, corner == 1u || corner == 4u || corner == 5u);
  let across = select(0u, 1u, corner == 2u || corner == 3u || corner == 5u);
  let a = f32(seg + along) / f32(SEGMENTS) * 6.28318530718;
  let r = ring.center.w + (f32(across) - 0.5) * ring.tangent.w;
  let p = ring.center.xyz + (cos(a) * ring.tangent.xyz + sin(a) * ring.bitangent.xyz) * r + ring.up.xyz * ring.up.w;
  return frame.view_proj_nojitter * vec4f(p, 1.0);
}

@fragment
fn fs_ring() -> @location(0) vec4f { return vec4f(ring.color.rgb, 1.0); }
`, [frameWgsl, RING.module]);

export function focusRingShader() { return link(ringShader); }

export function focusRingDrawer(s: EngineServices, center: Vec3, radius: number, color: Vec3): OverlayDrawer {
  const { device, queue } = s.ctx;
  const layout = device.createBindGroupLayout({ label: 'layout:focus-ring', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
  const key = 'sandbox:focus-ring';
  s.ctx.pipelines.register(key, 'render', () => {
    const module = s.ctx.pipelines.shaderModule(focusRingShader(), key);
    return {
      label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
      vertex: { module, entryPoint: 'vs_ring' },
      fragment: { module, entryPoint: 'fs_ring', targets: [{ ...FORWARD_COLOR_TARGET, blend: FORWARD_BLEND_ADD }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    };
  });
  void s.ctx.pipelines.compile(key).catch(() => undefined);
  const { u, t, b } = surfaceFrame(center);
  const buffer = device.createBuffer({ label: 'sandbox:focus-ring', size: RING.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
  queue.writeBuffer(buffer, 0, RING.pack({ center: [...center, radius], tangent: [...t, 0.07], bitangent: [...b, 0], up: [...u, 0.03], color: [...color, 0] }));
  const group = device.createBindGroup({ label: 'focus-ring', layout, entries: [{ binding: 0, resource: { buffer } }] });
  return {
    name: 'sandbox.focus-ring',
    draw(pass) {
      const pipeline = s.ctx.pipelines.get<GPURenderPipeline>(key);
      if (!pipeline) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, group);
      pass.draw(SEGMENTS * 6);
    },
  };
}
