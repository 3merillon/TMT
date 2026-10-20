// Ported from Pinionfall src/audio/world-gust-cpu.ts (MIT, same owner)
/**
 * CPU world gust field: episodic gust fronts drifting along the wind over the sphere, sampled at the listener and at
 * two "ears" so the wind synth's swells sweep across the stereo field. Constants are rescaled to TMT units:
 * cells 0.11 / 0.08 per u, drift 1.3 / 0.3 u/s. The field uses a u32 wraparound hash, mirrored by Math.imul below.
 */

export const WORLD_GUST_CELL_ALONG = 0.11;
export const WORLD_GUST_CELL_CROSS = 0.08;
export const WORLD_GUST_DRIFT_ALONG = 1.3;
export const WORLD_GUST_DRIFT_CROSS = 0.3;

function wgHash(x: number, y: number): number {
  // Math.imul does ToInt32 on both arguments, which matches WGSL's u32 multiply with wraparound.
  const qx = (Math.floor(x) + 32768) >>> 0;
  const qy = (Math.floor(y) + 32768) >>> 0;
  let h = (Math.imul(qx, 1597334677) ^ Math.imul(qy, 3812015801)) >>> 0;
  h = Math.imul(h, 2654435769) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function wgNoise(px: number, py: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = wgHash(ix, iy) * (1 - fx) + wgHash(ix + 1, iy) * fx;
  const b = wgHash(ix, iy + 1) * (1 - fx) + wgHash(ix + 1, iy + 1) * fx;
  return a * (1 - fy) + b * fy;
}

function wgFbm(px: number, py: number): number {
  return wgNoise(px, py) * 0.6 + wgNoise(px * 2.1 + 5.3, py * 2.1 + 1.7) * 0.4;
}

/** The gust field in [0, 1] at a world position, for a world wind direction (projected onto the local tangent plane)
 * at time `t` (s). 0 where the wind is radial or absent. */
export function sampleWorldGust(worldX: number, worldY: number, worldZ: number, windX: number, windY: number, windZ: number, t: number): number {
  const r = Math.hypot(worldX, worldY, worldZ);
  let upX = 0, upY = 1, upZ = 0;
  if (r > 1e-4) { upX = worldX / r; upY = worldY / r; upZ = worldZ / r; }
  const dotWU = windX * upX + windY * upY + windZ * upZ;
  const wtX = windX - upX * dotWU, wtY = windY - upY * dotWU, wtZ = windZ - upZ * dotWU;
  const wlen = Math.hypot(wtX, wtY, wtZ);
  if (wlen < 1e-3) return 0;
  const wnX = wtX / wlen, wnY = wtY / wlen, wnZ = wtZ / wlen;
  const wpX = upY * wnZ - upZ * wnY, wpY = upZ * wnX - upX * wnZ, wpZ = upX * wnY - upY * wnX;
  const along = worldX * wnX + worldY * wnY + worldZ * wnZ;
  const across = worldX * wpX + worldY * wpY + worldZ * wpZ;
  return wgFbm(along * WORLD_GUST_CELL_ALONG - t * WORLD_GUST_DRIFT_ALONG, across * WORLD_GUST_CELL_CROSS + t * WORLD_GUST_DRIFT_CROSS);
}

/** Pinionfall's episodic gate: readings below 0.35 collapse to 0, the rest smoothstep to [0, 1] (real lulls). */
export function gateWorldGust(raw: number): number {
  const lifted = (raw - 0.35) / 0.65;
  return lifted > 0 ? Math.min(1, lifted * lifted * (3 - 2 * lifted)) : 0;
}
