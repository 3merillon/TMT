import { liquidFloorWgsl } from '../../src/engine/passes/fluids/fluids.wgsl';
import { waterOpticsWgsl } from '../../src/engine/passes/fluids/underwater.wgsl';
import type { FluidsFacet } from '../../src/engine/passes/fluids/fluids';

export async function deepHullRegression(f: Pick<FluidsFacet, 'probe' | 'testHull'>, target: number[]) {
  const r = Math.hypot(...target), up = target.map(v => v / r);
  const tangent = [up[2], 0, -up[0]];
  const t = Math.hypot(...tangent); tangent.forEach((v, i) => { tangent[i] = v / t; });
  const across = [up[1] * tangent[2] - up[2] * tangent[1], up[2] * tangent[0] - up[0] * tangent[2], up[0] * tangent[1] - up[1] * tangent[0]];
  const points = Array.from({ length: 64 }, (_, i) => target.map((v, k) => v + tangent[k] * ((i % 8 - 3.5) * 0.24) + across[k] * ((Math.floor(i / 8) - 3.5) * 0.24)));
  const before = await f.probe(points);
  const from = target.map((v, k) => v - up[k] * 1.2 - tangent[k] * 0.25);
  const to = from.map((v, k) => v + tangent[k] * 0.5);
  f.testHull(from, to, 0.4);
  try {
    await new Promise(resolve => setTimeout(resolve, 3500));
    const after = await f.probe(points);
    const priorFoam = Math.max(...before.map(v => v.foam));
    const foam = Math.max(...after.map(v => v.foam));
    if (foam > priorFoam + 0.01) throw new Error(`Deep hull created surface foam: ${priorFoam} -> ${foam}`);
    return { minimumDepth: Math.min(...before.map(v => v.water)), priorFoam, foam, maxSpeed: Math.max(...after.map(v => Math.hypot(...v.velocity))) };
  } finally { f.testHull(null); }
}

/** Executes the production WGSL against an analytic floor and a suspended roof. */
export async function liquidRegression() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU required');
  const device = await adapter.requestDevice();
  const output = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = device.createShaderModule({ code: `
      fn sdf_sample(p: vec3f) -> f32 { let r = length(p); return min(r - 10.0, abs(r - 15.5) - 0.5); }
      ${liquidFloorWgsl.code}
      ${waterOpticsWgsl.code}
      @group(0) @binding(0) var<storage, read_write> out: array<f32>;
      @compute @workgroup_size(1) fn main() {
        let d = vec3f(0.0, 1.0, 0.0); let outer = liquid_floor(d, 24.0);
        out[0] = outer;
        out[1] = liquid_bed_below(d, outer, 12.0);
        out[2] = liquid_bed_below(d, outer, 15.5);
        out[3] = liquid_bed_below(d, outer, 17.0);
        out[4] = water_fresnel(1.0, WATER_IOR);
        out[5] = water_fresnel(cos(radians(47.0)), WATER_IOR);
        out[6] = water_fresnel(cos(radians(50.0)), WATER_IOR);
        out[7] = water_fresnel(0.0, WATER_IOR);
      }` });
    const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(); pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] }));
    pass.dispatchWorkgroups(1); pass.end(); encoder.copyBufferToBuffer(output, 0, read, 0, 32); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ); const values = Array.from(new Float32Array(read.getMappedRange().slice(0))); read.unmap();
    for (const [i, expected] of [16, 10, 16, 16].entries()) {
      if (Math.abs(values[i] - expected) > 0.006) throw new Error(`Bed fixture ${i}: ${values[i]}, expected ${expected}`);
    }
    if (Math.abs(values[4] - 0.020373) > 0.00001 || values[5] <= values[4] || values[5] >= 1 || values[6] !== 1 || values[7] !== 1) {
      throw new Error(`Snell/Fresnel fixture failed: ${values}`);
    }
    return { roof: values[0], submergedFloor: values[1], solidWall: values[2], aboveRoof: values[3], normalFresnel: values[4], belowCritical: values[5], totalInternalReflection: values[6] };
  } finally { output.destroy(); read.destroy(); device.destroy(); }
}
