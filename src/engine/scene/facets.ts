/**
 * Scene facets added by W1-ENG-SCENE (plan §5.5), by declaration merging into the open `SceneFacets` interface:
 *   'terrainHost'        EngineTerrainHost & { addPageHook(h: PageHook): () => void }   (TerrainHostFacet, extended here)
 *   'surfaceMemory'      { stamp(channel, stamps), clearSphere(center, radius), stats() }
 *   'terrainPlanetWGSL'  string: planetNormalWGSL(seed), provided by the facade (the engine never imports game code)
 *   'overlays'           trajectory ribbon + terrain-projected rings
 *   'debugLines'         world-space debug segments
 */
import type { PageHook } from '../../gpu/terrain/page-hooks';
import type { TerrainRenderHost } from '../../gpu/terrain/render-host';
import type { DebugLinesFacet } from './debug-lines';
import type { OverlayFacet } from './overlays';
import type { SurfaceMemoryFacet } from './surface-memory';
import type { TerrainTextures } from '../materials/terrain/bake';

declare module '../contracts' {
  interface TerrainHostFacet extends TerrainRenderHost {
    addPageHook(h: PageHook): () => void;
  }
  interface SceneFacets {
    surfaceMemory: SurfaceMemoryFacet;
    terrainPlanetWGSL: string;
    terrainTextures: TerrainTextures;
    overlays: OverlayFacet;
    debugLines: DebugLinesFacet;
  }
}

export {};
