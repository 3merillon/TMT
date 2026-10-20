/** Portable flat-buffer oracle used by the Node and browser experiments. Not imported by the game. */
export function intersectFlat(input: Float64Array, output: Float64Array, count: number): void {
  const f = Math.fround;
  for (let i = 0; i < count; i++) {
    const a = i * 23, b = i * 13, n = input[a], fa = input[a + 1], fb = input[a + 2], t = fa / (fa - fb);
    for (let k = 0; k < 13; k++) output[b + k] = 0;
    for (let k = 0; k < n; k++) {
      const w = input[a + 3 + k * 5] * (1 - t) + input[a + 4 + k * 5] * t;
      output[b + k] = w; output[b + 4 + k] = f(w);
    }
    for (let axis = 0; axis < 3; axis++) {
      const origin = input[a + 5 + axis]; let delta = 0;
      for (let k = 1; k < n; k++) delta = f(delta + f(f(input[a + 5 + k * 5 + axis] - origin) * output[b + 4 + k]));
      output[b + 8 + axis] = f(origin + delta);
    }
    output[b + 11] = f(fa); output[b + 12] = f(fb);
  }
}
export function classifyFlat(samples: Float32Array, vertices: Uint32Array, tasks: Uint32Array, output: Uint32Array, positions: number): void {
  for (let i = 0; i < output.length; i++) {
    const offset = tasks[2 * i] * positions, tet = tasks[2 * i + 1] * 4;
    const a = samples[offset + vertices[tet]], b = samples[offset + vertices[tet + 1]],
      c = samples[offset + vertices[tet + 2]], d = samples[offset + vertices[tet + 3]];
    output[i] = Number(a < 0 || b < 0 || c < 0 || d < 0) | (Number(a > 0 || b > 0 || c > 0 || d > 0) << 1);
  }
}
export interface CoreProbeManifest { seed: number; kind: string; intersections: number; tasks: number; positions: number; fields: number; bytes: Record<string, number> }
export interface CoreProbeExports {
  memory: WebAssembly.Memory;
  allocate(bytes: number): number;
  release(ptr: number, bytes: number): void;
  intersections(input: number, output: number, count: number): void;
  classify(samples: number, vertices: number, tasks: number, output: number, positions: number, count: number): void;
}
