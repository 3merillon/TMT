/// <reference types="@webgpu/types" />
/** TerrainRenderHost over three.js WebGPU (plan §5.1): play.html uses it until the engine takeover
 * (W1-ENG-SCENE adds EngineTerrainHost) and structural-check until W2-TER2 deletes the lab.
 * Each page is adopted through adoptIndexedTerrainMesh; draw membership changes only in commit(). */
import type { MeshStandardNodeMaterial, Object3D, WebGPURenderer } from 'three/webgpu';
import type { Bounds } from '../core/types';
import type { PageBuffers, PageDrawHandle, PageDrawInfo, TerrainRenderHost } from '../gpu/terrain/render-host';
import type { PageHook } from '../gpu/terrain/page-hooks';
import { getResidentDevice, type ResidentMeshHandle } from './resident-render';
import { adoptIndexedTerrainMesh } from './resident-mesh';

interface HostedPage { readonly handle: PageDrawHandle; readonly resident: ResidentMeshHandle; visible: boolean }

export class ThreeTerrainHost implements TerrainRenderHost {
  readonly device: GPUDevice;
  readonly pageHooks: readonly PageHook[] = [];
  private readonly pages = new Map<number, HostedPage>();
  private nextId = 1;
  /** `parent` receives shown pages (the scene in play.html); `material` is borrowed, never disposed here. */
  constructor(private readonly renderer: WebGPURenderer, private readonly parent: Object3D, private readonly material?: MeshStandardNodeMaterial) {
    this.device = getResidentDevice(renderer);
  }

  createPage(buffers: PageBuffers, info: PageDrawInfo): PageDrawHandle {
    // adoptIndexedTerrainMesh subtracts the origin from world bounds; body bounds arrive body-local.
    const bounds: Bounds = info.bodyId === undefined ? info.bounds
      : { min: [0, 1, 2].map(a => info.bounds.min[a] + info.origin[a]) as Bounds['min'], max: [0, 1, 2].map(a => info.bounds.max[a] + info.origin[a]) as Bounds['max'] };
    const resident = adoptIndexedTerrainMesh(this.renderer, buffers.vertexCount, buffers.indexCount, buffers.position, buffers.normal, buffers.surface,
      buffers.index, buffers.indirect, bounds, info.origin, this.material);
    const id = this.nextId++, mesh = resident.mesh;
    const handle: PageDrawHandle = {
      id,
      setPose: (position, rotation) => { mesh.position.set(position[0], position[1], position[2]); mesh.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]); },
      // The buffers were handed over at createPage; three already recorded its draws, so they are
      // destroyed now, exactly as resident-mesh did before the seam. Disposing also removes the mesh.
      dispose: () => { if (!this.pages.delete(id)) return; resident.dispose(); },
    };
    this.pages.set(id, { handle, resident, visible: false });
    return handle;
  }

  commit(change: { show: readonly PageDrawHandle[]; hide: readonly PageDrawHandle[] }): void {
    // Validate everything before touching the scene so a rejected commit publishes nothing.
    const page = (handle: PageDrawHandle) => {
      const hosted = this.pages.get(handle.id);
      if (!hosted || hosted.handle !== handle) throw new Error(`Terrain page ${handle.id} is disposed or belongs to another host`);
      return hosted;
    };
    const hide = change.hide.map(page), show = change.show.map(page);
    if (new Set([...hide, ...show]).size !== hide.length + show.length) throw new Error('A terrain commit lists a page twice');
    if (hide.some(p => !p.visible)) throw new Error('A terrain commit hides a page that is not visible');
    if (show.some(p => p.visible)) throw new Error('A terrain commit shows a page that is already visible');
    for (const p of hide) { p.resident.mesh.removeFromParent(); p.visible = false; }
    for (const p of show) { this.parent.add(p.resident.mesh); p.visible = true; }
  }
}
