/** One-time native WebGPU terrain bake. No image transfer, CPU pixel buffers or per-frame work. */
import {
  HalfFloatType, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping,
} from 'three';
import { StorageArrayTexture, type WebGPURenderer } from 'three/webgpu';
import { instanceIndex, storageTexture, texture, wgslFn } from 'three/tsl';
import { PROCEDURAL_TERRAIN_BAKE_WGSL, PROCEDURAL_TERRAIN_NORMAL_WGSL } from './procedural-material-wgsl';

export const PROCEDURAL_TERRAIN_SIZE = 512;
export const PROCEDURAL_TERRAIN_LAYERS = 6;
export const PROCEDURAL_TERRAIN_MIP_LEVELS = 10;
export const PROCEDURAL_TERRAIN_TILE_WIDTHS = [2.5, 2.0, 2.5, 3.0, 3.0, 2.5] as const;
export const PROCEDURAL_TERRAIN_HEIGHT_AMPLITUDES = [0.042, 0.032, 0.012, 0.025, 0.018, 0.048] as const;
// Two RGBA8 arrays including all mip levels; shared by every terrain draw.
export const PROCEDURAL_TERRAIN_RESIDENT_BYTES = 8 * PROCEDURAL_TERRAIN_LAYERS * (4 ** PROCEDURAL_TERRAIN_MIP_LEVELS - 1) / 3;

function makeArray(name: string, mips: boolean): StorageArrayTexture {
  const result = new StorageArrayTexture(PROCEDURAL_TERRAIN_SIZE, PROCEDURAL_TERRAIN_SIZE, PROCEDURAL_TERRAIN_LAYERS);
  result.name = name;
  // Color values in the shader are already in Three's linear working space.
  result.colorSpace = NoColorSpace;
  result.wrapS = result.wrapT = RepeatWrapping;
  result.magFilter = LinearFilter;
  result.minFilter = mips ? LinearMipmapLinearFilter : LinearFilter;
  result.generateMipmaps = mips;
  result.anisotropy = mips ? 2 : 1;
  result.flipY = false;
  return result;
}

/** Exposed for offline compilation tests and GPU diagnostics using the actual compute graphs. */
export function createProceduralTerrainBakeGraph() {
  const albedo = makeArray('Procedural terrain linear albedo', true);
  const surface = makeArray('Procedural terrain normal roughness height', true);
  const relief = makeArray('Temporary terrain half-float relief', false);
  relief.type = HalfFloatType;
  const count = PROCEDURAL_TERRAIN_SIZE ** 2 * PROCEDURAL_TERRAIN_LAYERS;
  const bake = wgslFn(PROCEDURAL_TERRAIN_BAKE_WGSL)({
    albedo_out: storageTexture(albedo).toWriteOnly(),
    relief_out: storageTexture(relief).toWriteOnly(), index: instanceIndex,
  }).compute(count, [64]);
  const normals = wgslFn(PROCEDURAL_TERRAIN_NORMAL_WGSL)({
    relief: texture(relief), surface_out: storageTexture(surface).toWriteOnly(), index: instanceIndex,
  }).compute(count, [64]);
  return { albedo, surface, relief, bake, normals };
}

export interface ProceduralTerrainTextures {
  albedo: StorageArrayTexture;
  surface: StorageArrayTexture;
  /** Includes shader compilation, all compute/mip passes, and waiting for GPU completion. */
  bakeMilliseconds: number;
  residentBytes: number;
  dispose(): void;
}

export async function createProceduralTerrainTextures(renderer: WebGPURenderer): Promise<ProceduralTerrainTextures> {
  const started = performance.now();
  // Three r180's public renderer has no mip generation operation for compute outputs.
  // This narrow backend adapter uses its existing per-layer GPU render-pass mip builder.
  // Merely setting generateMipmaps allocates levels but leaves compute-output mips empty.
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean;
    device?: GPUDevice;
    generateMipmaps(map: StorageArrayTexture): void;
  };
  if (!backend.isWebGPUBackend) throw new Error('Procedural terrain requires native WebGPU.');
  const graph = createProceduralTerrainBakeGraph();
  const { albedo, surface, relief, bake, normals } = graph;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    albedo.dispose();
    surface.dispose();
  };
  try {
    // Separate submissions prevent a read/write alias of the relief texture within one pass.
    await renderer.computeAsync(bake);
    await renderer.computeAsync(normals);
    // Each pass reads only the previous mip and writes a disjoint mip subresource.
    // Linear-space albedo, normal XY, roughness and height all receive a filtered chain.
    // Averaged normal XY naturally flattens high-frequency relief at a distance.
    backend.generateMipmaps(albedo);
    backend.generateMipmaps(surface);
    await backend.device!.queue.onSubmittedWorkDone();
    return { albedo, surface, bakeMilliseconds: performance.now() - started,
      residentBytes: PROCEDURAL_TERRAIN_RESIDENT_BYTES, dispose };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    relief.dispose();
    bake.dispose();
    normals.dispose();
  }
}
