/// <reference types="@webgpu/types" />
import { BufferAttribute, BufferGeometry, DoubleSide, IndirectStorageBufferAttribute, Mesh, MeshStandardNodeMaterial,
  REVISION, Sphere, StaticDrawUsage, Vector3, type WebGPURenderer } from 'three/webgpu';
import type { Bounds, FieldDefinition } from '../core/types';
import { sourceNormalNode } from './normal-material';

const adoptedBuffers = new WeakSet<GPUBuffer>();

/** This deliberately isolated bridge targets the installed three@0.180.0 internals. */
interface ResidentBackend {
  isWebGPUBackend: true;
  device: GPUDevice;
  get(attribute: BufferAttribute): { buffer?: GPUBuffer };
  has(attribute: BufferAttribute): boolean;
  delete(attribute: BufferAttribute): unknown;
  createAttribute(attribute: BufferAttribute): void;
  createIndirectStorageAttribute(attribute: BufferAttribute): void;
}
function residentBackend(renderer: WebGPURenderer): ResidentBackend {
  const backend = renderer.backend as unknown as ResidentBackend;
  if (REVISION !== '180' || !renderer._initialized || backend.isWebGPUBackend !== true || !backend.device ||
    typeof backend.get !== 'function' || typeof backend.has !== 'function' || typeof backend.delete !== 'function' ||
    typeof backend.createAttribute !== 'function' || typeof backend.createIndirectStorageAttribute !== 'function') {
    throw new Error('Resident geometry requires the initialized native WebGPU backend of pinned three@0.180.0; this renderer bridge must be reviewed before upgrading Three.');
  }
  return backend;
}

/** Construct compute producers with this exact device before adopting their buffers. */
export function getResidentDevice(renderer: WebGPURenderer): GPUDevice { return residentBackend(renderer).device; }

export interface ResidentMeshBuffers {
  readonly device: GPUDevice;
  readonly vertexCapacity: number;
  /** Tightly packed f32 xyz attributes: 12 bytes per vertex, not storage vec3's 16-byte stride. */
  readonly position: GPUBuffer;
  readonly normal: GPUBuffer;
  readonly color: GPUBuffer;
  readonly normalSource: GPUBuffer;
  readonly normalOrientation: GPUBuffer;
  /** Four u32 words written by the GPU: vertexCount, instanceCount, firstVertex, firstInstance. */
  readonly indirect: GPUBuffer;
}
export interface ResidentMeshOptions {
  readonly bounds: Bounds;
  /** Must match the producer's normalSource indices exactly. */
  readonly definitions: readonly FieldDefinition[];
  readonly smooth?: boolean;
  readonly roughness?: number;
  readonly metalness?: number;
}
export interface ResidentMeshHandle {
  readonly mesh: Mesh<BufferGeometry, MeshStandardNodeMaterial>;
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  /** Changes only the shader; resident geometry and indirect arguments are retained. */
  setSmooth(enabled: boolean): void;
  /** Idempotent, including when called before the first draw. Dispose before the renderer. */
  dispose(): void;
}

/** Transfer exclusive ownership of all six producer buffers on successful return.
 * The producer must relinquish destruction/reassignment; until return it retains ownership.
 * Compute writes for this mesh remain allowed until the handle is disposed.
 * GPU computation and renderer draw submissions must share this device/queue.
 */
export async function adoptResidentMesh(renderer: WebGPURenderer, buffers: ResidentMeshBuffers, options: ResidentMeshOptions): Promise<ResidentMeshHandle> {
  const backend = residentBackend(renderer), device = backend.device;
  if (buffers.device !== device) throw new Error('Resident buffers must belong to the renderer GPUDevice');
  if (!Number.isSafeInteger(buffers.vertexCapacity) || buffers.vertexCapacity < 3 || buffers.vertexCapacity > 0xffffffff) throw new Error('Invalid resident vertex capacity');
  if (options.bounds.min.length !== 3 || options.bounds.max.length !== 3 || options.bounds.min.some((v, axis) => !Number.isFinite(v) || !Number.isFinite(options.bounds.max[axis]) || options.bounds.max[axis] < v)) throw new Error('Resident mesh requires finite ordered bounds');
  const specifications = [
    ['position', buffers.position, 3], ['normal', buffers.normal, 3], ['color', buffers.color, 3],
    ['normalSource', buffers.normalSource, 1], ['normalOrientation', buffers.normalOrientation, 1],
    ['indirect', buffers.indirect, 4],
  ] as const;
  if (new Set(specifications.map(([, buffer]) => buffer)).size !== specifications.length) throw new Error('Resident attributes must use distinct exclusively owned buffers');
  if (specifications.some(([, buffer]) => adoptedBuffers.has(buffer))) throw new Error('A resident buffer has already been adopted');
  const sizes = specifications.map(([name, buffer, itemSize]) => {
    const size = name === 'indirect' ? 16 : buffers.vertexCapacity * itemSize * 4;
    const usage = GPUBufferUsage.STORAGE | (name === 'indirect' ? GPUBufferUsage.INDIRECT : GPUBufferUsage.VERTEX);
    if (buffer.size < size || (buffer.usage & usage) !== usage || buffer.mapState !== 'unmapped') throw new Error(`Invalid resident ${name} buffer size, usage, or mapping state`);
    return size;
  });
  // A GPUBuffer does not expose its device. This validation-only bind group also
  // catches buffers from a different device or buffers already destroyed by a producer.
  device.pushErrorScope('validation');
  try {
    const layout = device.createBindGroupLayout({ entries: specifications.map((_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })) });
    device.createBindGroup({ layout, entries: specifications.map(([, buffer], binding) => ({ binding, resource: { buffer, size: sizes[binding] } })) });
  } catch (error) { await device.popErrorScope(); throw error; }
  const error = await device.popErrorScope();
  if (error) throw new Error(`Resident buffer validation failed: ${error.message}`);
  if (specifications.some(([, buffer]) => adoptedBuffers.has(buffer))) throw new Error('A resident buffer was adopted concurrently');

  const geometry = new BufferGeometry();
  const attributes: BufferAttribute[] = [];
  let material: MeshStandardNodeMaterial | undefined;
  try {
    for (const [name, buffer, itemSize] of specifications) {
      // One all-zero CPU item supplies format metadata only. The external buffer
      // is installed before Three's first createAttribute call, which skips upload.
      const attribute = name === 'indirect'
        ? new IndirectStorageBufferAttribute(new Uint32Array(4), 4)
        : new BufferAttribute(new Float32Array(itemSize), itemSize);
      Object.defineProperty(attribute, 'count', { value: name === 'indirect' ? 1 : buffers.vertexCapacity, writable: false });
      Object.defineProperty(attribute, 'needsUpdate', { get: () => false, set: (value: boolean) => { if (value) throw new Error('GPU-resident attributes cannot be uploaded from CPU metadata'); } });
      attribute.setUsage(StaticDrawUsage); attribute.name = `resident ${name}`;
      attributes.push(attribute); backend.get(attribute).buffer = buffer;
      if (name === 'indirect') geometry.setIndirect(attribute as IndirectStorageBufferAttribute);
      else geometry.setAttribute(name, attribute);
    }
    geometry.setDrawRange(0, buffers.vertexCapacity);
    const center = new Vector3(...options.bounds.min).add(new Vector3(...options.bounds.max)).multiplyScalar(.5);
    const radius = center.distanceTo(new Vector3(...options.bounds.max));
    geometry.boundingSphere = new Sphere(center, radius);
    material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: options.roughness ?? .75, metalness: options.metalness ?? .08,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: DoubleSide });
    const mesh = new Mesh(geometry, material); mesh.frustumCulled = false;
    const originalDispose = geometry.dispose.bind(geometry);
    let disposed = false, smooth = options.smooth !== false;
    const smoothNode = sourceNormalNode(options.definitions);
    material.normalNode = smooth ? smoothNode : null;
    const assertLive = () => {
      if (disposed) throw new Error('Resident mesh was disposed');
      if (geometry.index !== null || geometry.indirect !== attributes[5] || material!.wireframe) throw new Error('Resident geometry does not support CPU indexing or wireframe conversion');
      specifications.forEach(([name, buffer, itemSize], i) => {
        const attribute = attributes[i];
        if (backend.get(attribute).buffer !== buffer || attribute.version !== 0 || attribute.itemSize !== itemSize || attribute.array.length !== itemSize ||
          (name !== 'indirect' && geometry.getAttribute(name) !== attribute)) throw new Error(`Resident ${name} metadata or GPU binding changed unexpectedly`);
      });
    };
    mesh.onBeforeRender = assertLive;
    const handle: ResidentMeshHandle = {
      mesh, geometry, material,
      setSmooth: enabled => {
        assertLive();
        if (enabled === smooth) return;
        smooth = enabled; material!.normalNode = smooth ? smoothNode : null; material!.needsUpdate = true;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true; mesh.removeFromParent();
        // r180's geometry listener destroys attributes used by a rendered material.
        // It omits indirect and never-rendered/unused attributes; close those gaps here.
        originalDispose();
        attributes.forEach((attribute, i) => {
          if (backend.has(attribute)) {
            specifications[i][1].destroy(); backend.delete(attribute);
          }
        });
        material!.dispose();
      },
    };
    // Generic geometry cleanup also obeys this adapter's exclusive ownership contract.
    geometry.dispose = handle.dispose;
    specifications.forEach(([, buffer]) => adoptedBuffers.add(buffer));
    return handle;
  } catch (error) {
    // Adoption did not finish: remove associations without destroying caller buffers.
    attributes.forEach(attribute => backend.delete(attribute)); material?.dispose(); throw error;
  }
}
