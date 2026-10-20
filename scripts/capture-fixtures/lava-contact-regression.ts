import { emberCollisionWgsl } from '../../src/engine/passes/fluids/ember-collision.wgsl';
import { liquidBarrierWgsl } from '../../src/engine/passes/fluids/liquid-barrier.wgsl';

/** Execute production collision code: fast impacts, resting embers, and a narrow rim between liquid cells. */
export async function lavaContactRegression() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU required');
  const device = await adapter.requestDevice();
  const size = 80;
  const output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = device.createShaderModule({ code: `
      var<private> mode: u32;
      fn sdf_sample(p: vec3f) -> f32 {
        if (mode == 0u) { return p.y - 10.0; }
        if (mode == 1u) { return abs(p.x) - 0.015; }
        let r = length(p);
        return min(r - 10.0, max(abs(p.x) - 0.03, r - 11.0));
      }
      fn sdf_normal(p: vec3f) -> vec3f {
        return select(vec3f(0,1,0), vec3f(sign(p.x),0,0), mode == 1u);
      }
      ${emberCollisionWgsl.code}
      ${liquidBarrierWgsl.code}
      @group(0) @binding(0) var<storage, read_write> out: array<f32>;
      @compute @workgroup_size(1) fn main() {
        mode = 0u;
        let floor = ember_move(vec3f(0,10.4,0), vec3f(2,-40,0), 0.02, 0.05, 0.42);
        out[0] = floor.position.y; out[1] = floor.velocity.y; out[2] = floor.velocity.x;
        var p = vec3f(0,10.025,0); var v = vec3f(0.1,0,0);
        for (var i = 0u; i < 180u; i++) {
          v.y -= 9.81 / 60.0;
          let step = ember_move(p, v, 0.02, 1.0 / 60.0, 0.42);
          p = step.position; v = step.velocity;
        }
        out[3] = p.y; out[4] = length(v);
        mode = 1u;
        let wall = ember_move(vec3f(-0.4,10,0), vec3f(40,0,0), 0.02, 0.05, 0.42);
        out[5] = wall.position.x; out[6] = wall.velocity.x;
        mode = 2u;
        let a = normalize(vec3f(-0.01,1,0)); let b = normalize(vec3f(0.01,1,0));
        let low = liquid_face_crest(a,b,10.7,10.0);
        let high = liquid_face_crest(a,b,11.2,10.0);
        out[7] = liquid_face_share(10.7,0.7,low);
        out[8] = high; out[9] = liquid_face_share(11.2,1.2,high);
        out[10] = liquid_face_crest(b,a,11.2,10.0);
        out[11] = liquid_face_share(10.4,0.4,10.5);
      }` });
    const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(); pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] }));
    pass.dispatchWorkgroups(1); pass.end(); encoder.copyBufferToBuffer(output, 0, read, 0, size); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ); const v = Array.from(new Float32Array(read.getMappedRange().slice(0))); read.unmap();
    if (v.some(x => !Number.isFinite(x))) throw new Error(`Non-finite contact: ${v}`);
    if (v[0] < 10.02 || v[1] <= 0 || v[1] >= 40 || v[2] >= 2) throw new Error(`Floor rebound failed: ${v}`);
    if (v[3] < 10.019 || v[3] > 10.04 || v[4] > 0.2) throw new Error(`Ember did not settle: ${v}`);
    if (v[5] > -0.034 || v[6] >= 0) throw new Error(`Fast ember tunnelled through wall: ${v}`);
    if (v[7] !== 0 || Math.abs(v[8] - 11) > 0.025 || v[9] <= 0 || v[9] > 0.2 || Math.abs(v[8] - v[10]) > 0.00001 || v[11] !== 0) {
      throw new Error(`Rim barrier/overtopping failed: ${v}`);
    }
    return { floorBounce: v.slice(0, 3), settled: v.slice(3, 5), wallBounce: v.slice(5, 7), blockedFlow: v[7], rim: v[8], overtopping: v[9] };
  } finally { output.destroy(); read.destroy(); device.destroy(); }
}
