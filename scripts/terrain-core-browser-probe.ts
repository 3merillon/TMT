/** Browser/worker half of the standalone experiment. Served by benchmark-terrain-core-browser.ts only. */
import { classifyFlat, intersectFlat, type CoreProbeExports, type CoreProbeManifest } from './terrain-core-probe';

export function calibration(): { milliseconds: number; checksum: number } {
  let x = 7; const start = performance.now();
  for (let i = 0; i < 8_000_000; i++) x = Math.imul(x ^ i, 1664525) + 1013904223 | 0;
  return { milliseconds: performance.now() - start, checksum: x };
}
export async function cpuProbe() {
  const manifest: CoreProbeManifest = await (await fetch('/manifest.json')).json();
  const inputs: Record<string, ArrayBuffer> = {};
  for (const name of Object.keys(manifest.bytes)) inputs[name] = await (await fetch(`/${name}.bin`)).arrayBuffer();
  const wasm = await (await fetch('/core.wasm')).arrayBuffer(), start = performance.now();
  const { instance } = await WebAssembly.instantiate(wasm), api = instance.exports as unknown as CoreProbeExports;
  const instantiateMs = performance.now() - start, pointers: Record<string, number> = {};
  for (const [name, size] of Object.entries(manifest.bytes)) pointers[name] = api.allocate(size);
  const ip = api.allocate(manifest.intersections * 13 * 8), cp = api.allocate(manifest.tasks * 4), copying = performance.now();
  for (const [name, input] of Object.entries(inputs)) new Uint8Array(api.memory.buffer, pointers[name], input.byteLength).set(new Uint8Array(input));
  const copyMs = performance.now() - copying;
  const data = new Float64Array(api.memory.buffer, pointers.intersections, manifest.intersections * 23), output = new Float64Array(api.memory.buffer, ip, manifest.intersections * 13);
  const samples = new Float32Array(api.memory.buffer, pointers.samples, manifest.bytes.samples / 4), vertices = new Uint32Array(api.memory.buffer, pointers.vertices, manifest.bytes.vertices / 4);
  const tasks = new Uint32Array(api.memory.buffer, pointers.tasks, manifest.tasks * 2), classified = new Uint32Array(api.memory.buffer, cp, manifest.tasks);
  const reference = new Uint32Array(manifest.tasks); classifyFlat(samples, vertices, tasks, reference, manifest.positions);
  const equal = (a: ArrayBufferView, b: Uint8Array) => {
    const words = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    if (words.length !== b.length) throw new Error('Output length mismatch');
    for (let i = 0; i < words.length; i++) if (words[i] !== b[i]) throw new Error(`Output mismatch at byte ${i}`);
  };
  const measure = (a: () => void, b: () => void, check: () => void) => {
    const cold: number[] = [];
    for (const run of [a, b]) { const at = performance.now(); run(); cold.push(performance.now() - at); check(); }
    for (let i = 0; i < 4; i++) { a(); b(); }
    const ts: number[] = [], wasm: number[] = [];
    for (let i = 0; i < 4; i++) for (const arm of [0, 1, 1, 0]) {
      const at = performance.now(); (arm ? b : a)(); (arm ? wasm : ts).push(performance.now() - at); check();
    }
    return { coldTsMs: cold[0], coldWasmMs: cold[1], ts, wasm };
  };
  const intersections = measure(() => intersectFlat(data, output, manifest.intersections), () => api.intersections(pointers.intersections, ip, manifest.intersections), () => equal(output, new Uint8Array(inputs.expected)));
  const classification = measure(() => classifyFlat(samples, vertices, tasks, classified, manifest.positions), () => api.classify(pointers.samples, pointers.vertices, pointers.tasks, cp, manifest.positions, manifest.tasks), () => equal(classified, new Uint8Array(reference.buffer)));
  return { instantiateMs, copyMs, memoryBytes: api.memory.buffer.byteLength, intersections, classification, identity: true };
}

export async function gpuProbe() {
  const gpu = (navigator as unknown as { gpu: any }).gpu, adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { unavailable: 'No WebGPU adapter' };
  const timestamp = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamp ? ['timestamp-query'] : [] });
  const errors: string[] = []; device.addEventListener('uncapturederror', (e: any) => errors.push(String(e.error)));
  const manifest: CoreProbeManifest = await (await fetch('/manifest.json')).json();
  const input: Record<string, ArrayBuffer> = {};
  for (const name of ['samples', 'vertices', 'tasks']) input[name] = await (await fetch(`/${name}.bin`)).arrayBuffer();
  const expected = new Uint32Array(manifest.tasks);
  classifyFlat(new Float32Array(input.samples), new Uint32Array(input.vertices), new Uint32Array(input.tasks), expected, manifest.positions);
  const code = await (await fetch('/classify.wgsl')).text(), buffers: any[] = [];
  const make = (size: number, usage: number) => { const b = device.createBuffer({ size, usage }); buffers.push(b); return b; };
  try {
    const compiling = performance.now(), shader = device.createShaderModule({ code });
    const info = await shader.getCompilationInfo();
    if (info.messages.some((m: any) => m.type === 'error')) throw new Error(JSON.stringify(info.messages));
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
    const compileMs = performance.now() - compiling, uploading = performance.now();
    const storage = Object.values(input).map(data => { const b = make(data.byteLength, 128 | 8); device.queue.writeBuffer(b, 0, data); return b; });
    const output = make(expected.byteLength, 128 | 4), readback = make(expected.byteLength, 1 | 8), params = make(16, 64 | 8);
    device.queue.writeBuffer(params, 0, new Uint32Array([manifest.positions, manifest.tasks, 0, 0]));
    await device.queue.onSubmittedWorkDone();
    const uploadMs = performance.now() - uploading;
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [...storage, output, params].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const query = timestamp ? device.createQuerySet({ type: 'timestamp', count: 2 }) : undefined;
    const resolved = timestamp ? make(16, 512 | 4) : undefined, stamps = timestamp ? make(16, 1 | 8) : undefined;
    const times: { totalMs: number; kernelMs?: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now(), encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass(timestamp ? { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(manifest.tasks / 128)); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, expected.byteLength);
      if (timestamp) { encoder.resolveQuerySet(query, 0, 2, resolved, 0); encoder.copyBufferToBuffer(resolved, 0, stamps, 0, 16); }
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1); if (timestamp) await stamps.mapAsync(1);
      const totalMs = performance.now() - start, result = new Uint32Array(readback.getMappedRange());
      for (let j = 0; j < expected.length; j++) if (result[j] !== expected[j]) throw new Error(`GPU classification differs at ${j}`);
      const t = timestamp ? new BigUint64Array(stamps.getMappedRange()) : undefined;
      times.push({ totalMs, kernelMs: t ? Number(t[1] - t[0]) / 1e6 : undefined });
      readback.unmap(); if (timestamp) stamps.unmap();
    }
    query?.destroy();
    if (errors.length) throw new Error(errors.join('\n'));
    return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
      compileMs, uploadMs, inputBytes: Object.values(input).reduce((n, data) => n + data.byteLength, 0), readbackBytes: expected.byteLength, times, identity: true };
  } finally { for (const buffer of buffers) buffer.destroy(); device.destroy(); }
}
