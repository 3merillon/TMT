/**
 * Blue-noise tile generator (Ulichney's void-and-cluster, toroidal Gaussian energy): the rank of every pixel, so a
 * threshold at any level gives an evenly spread point set with little low-frequency energy. Deterministic (seeded LCG);
 * pure TS, generated once at install for the composite's film grain (64², < 50 ms).
 *
 * The "insert into the largest void" step doubles as Ulichney's phase 3: with a toroidal kernel the energy of the zeros
 * is a constant minus the energy of the ones, so the tightest cluster of zeros is exactly the largest void of the ones.
 */
export function blueNoise(size = 64, sigma = 1.5, seed = 7): Float32Array {
  const n = size * size;
  const radius = Math.ceil(3 * sigma);
  const kernel: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    kernel.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) });
  }
  const energy = new Float64Array(n);
  const ones = new Uint8Array(n);
  const splat = (i: number, s: number) => {
    const x = i % size, y = (i / size) | 0;
    for (const k of kernel) energy[((y + k.dy + size) % size) * size + ((x + k.dx + size) % size)] += s * k.w;
  };
  let state = seed >>> 0 || 1;
  const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const initial = Math.max(1, Math.round(n * 0.1));
  let count = 0;
  while (count < initial) {
    const i = Math.floor(rnd() * n);
    if (!ones[i]) { ones[i] = 1; splat(i, 1); count++; }
  }
  const tightest = () => { let best = -1, e = -Infinity; for (let i = 0; i < n; i++) if (ones[i] && energy[i] > e) { e = energy[i]; best = i; } return best; };
  const largestVoid = () => { let best = -1, e = Infinity; for (let i = 0; i < n; i++) if (!ones[i] && energy[i] < e) { e = energy[i]; best = i; } return best; };
  // Relax the initial pattern into a blue-noise point set.
  for (let iter = 0; iter < n; iter++) {
    const c = tightest();
    ones[c] = 0; splat(c, -1);
    const v = largestVoid();
    ones[v] = 1; splat(v, 1);
    if (v === c) break;
  }
  const rank = new Int32Array(n).fill(-1);
  const proto = ones.slice();
  const protoEnergy = energy.slice();
  // Phase 1: remove the tightest clusters of the prototype, ranks initial-1 … 0.
  for (let r = count - 1; r >= 0; r--) {
    const c = tightest();
    ones[c] = 0; splat(c, -1);
    rank[c] = r;
  }
  // Phases 2 + 3: from the prototype, fill the largest voids, ranks initial … n-1.
  ones.set(proto);
  energy.set(protoEnergy);
  for (let r = count; r < n; r++) {
    const v = largestVoid();
    ones[v] = 1; splat(v, 1);
    rank[v] = r;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rank[i] + 0.5) / n;
  return out;
}

/** Pack a [0,1) tile into rgba8 texels: r = the tile, g/b/a = the tile shifted by (size/2, 0), (0, size/2), (size/2, size/2). */
export function blueNoiseRgba8(tile: Float32Array, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size * size * 4));
  const h = size >> 1;
  const at = (x: number, y: number) => tile[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    out[o] = Math.floor(at(x, y) * 256);
    out[o + 1] = Math.floor(at(x + h, y) * 256);
    out[o + 2] = Math.floor(at(x, y + h) * 256);
    out[o + 3] = Math.floor(at(x + h, y + h) * 256);
  }
  return out;
}
