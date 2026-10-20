/// <reference types="@webgpu/types" />
import { BufferAttribute, BufferGeometry, DoubleSide, IndirectStorageBufferAttribute, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshStandardNodeMaterial, Sphere, Vector3, type WebGPURenderer } from 'three/webgpu';
import { getResidentDevice, type ResidentMeshHandle } from './resident-render';
import type { Bounds, Vec3 } from '../core/types';

/** Separate indexed adapter; the qualified lab's non-indexed bridge is unchanged.
 * Three 0.180.0 backend.get(attribute).buffer is the sole version-pinned seam. */
export function adoptIndexedTerrainMesh(renderer: WebGPURenderer, vertexCount: number, indexCount: number,
  position: GPUBuffer, normal: GPUBuffer, surface: GPUBuffer, index: GPUBuffer, indirect: GPUBuffer, bounds: Bounds, origin: Vec3, sharedMaterial?: MeshStandardNodeMaterial): ResidentMeshHandle {
  getResidentDevice(renderer); // Checks revision, initialized native backend, and API shape.
  const backend = renderer.backend as unknown as { get(a: BufferAttribute | InterleavedBuffer): { buffer?: GPUBuffer }; has(a: BufferAttribute | InterleavedBuffer): boolean; delete(a: BufferAttribute | InterleavedBuffer): void };
  const geometry = new BufferGeometry(), attributes: (BufferAttribute | InterleavedBuffer)[] = [], buffers = [position, normal, surface, index, indirect];
  const specs = [['position', vertexCount, 3], ['normal', vertexCount, 3], ['surface', vertexCount, 8], ['index', indexCount, 1], ['indirect', 1, 5]] as const;
  let material: MeshStandardNodeMaterial | undefined;
  try {
    for (let i = 0; i < specs.length; i++) {
      const [name, count, size] = specs[i];
      const attribute = name === 'surface' ? new InterleavedBuffer(new Float32Array(8), 8) : name === 'indirect' ? new IndirectStorageBufferAttribute(new Uint32Array(5), 5) : new BufferAttribute(name === 'index' ? new Uint32Array(1) : new Float32Array(size), size);
      Object.defineProperty(attribute, 'count', { value: count }); Object.defineProperty(attribute, 'needsUpdate', { get: () => false, set: (v: boolean) => { if (v) throw new Error('Resident terrain cannot upload CPU attributes'); } });
      attributes.push(attribute); backend.get(attribute).buffer = buffers[i];
      if (name === 'surface') {
        // One packed GPU output keeps the emitter within the eight-storage-buffer
        // WebGPU baseline: material (1), analytic source (4), diagnostic color (3).
        const data = attribute as InterleavedBuffer;
        geometry.setAttribute('terrainMaterial', new InterleavedBufferAttribute(data, 1, 0));
        geometry.setAttribute('terrainSource', new InterleavedBufferAttribute(data, 4, 1));
        geometry.setAttribute('color', new InterleavedBufferAttribute(data, 3, 5));
      } else if (name === 'index') geometry.setIndex(attribute as BufferAttribute); else if (name === 'indirect') geometry.setIndirect(attribute as IndirectStorageBufferAttribute); else geometry.setAttribute(name, attribute as BufferAttribute);
    }
    geometry.setDrawRange(0, indexCount);
    // CPU arrays describe formats only. Three also needs bounds for render sorting
    // when frustum culling is disabled; it must not scan those one-item arrays.
    const center = new Vector3(...bounds.min).add(new Vector3(...bounds.max)).multiplyScalar(.5);
    const radius = center.distanceTo(new Vector3(...bounds.max));
    geometry.boundingSphere = new Sphere(center.sub(new Vector3(...origin)), radius);
    material = sharedMaterial ?? new MeshStandardNodeMaterial({ vertexColors: true, roughness: .85, metalness: .03, side: DoubleSide });
    const mesh = new Mesh(geometry, material); mesh.frustumCulled = false; mesh.userData.terrainOrigin = new Vector3(...origin);
    let disposed = false; const originalDispose = geometry.dispose.bind(geometry);
    mesh.onBeforeRender = () => {
      if (disposed || geometry.index !== attributes[3] || geometry.indirect !== attributes[4]) throw new Error('Resident indexed mesh metadata changed');
      attributes.forEach((a, i) => { if (a.version || backend.get(a).buffer !== buffers[i]) throw new Error('Resident indexed buffer ownership changed'); });
    };
    const dispose = () => { if (disposed) return; disposed = true; mesh.removeFromParent(); originalDispose(); attributes.forEach((a, i) => { buffers[i].destroy(); if (backend.has(a)) backend.delete(a); }); if (!sharedMaterial) material!.dispose(); };
    geometry.dispose = dispose; return { mesh, geometry, material, setSmooth: () => {}, dispose };
  } catch (error) { attributes.forEach(a => backend.delete(a)); if (!sharedMaterial) material?.dispose(); throw error; }
}
