/**
 * The W1-ENG-SCENE engine modules (terrain host + material, Surface Memory Cube, overlays, debug lines). The game facade
 * passes them after RENDER_MODULES: `Engine.create({ modules: [...RENDER_MODULES, ...scene.factories] })`.
 */
import type { RenderModule } from '../contracts';
import { debugLinesModule, type DebugLinesModule } from './debug-lines';
import { overlaysModule, type OverlaysModule } from './overlays';
import { surfaceMemoryModule, type SurfaceMemoryModule } from './surface-memory';
import { terrainModule, type TerrainModule, type TerrainModuleOptions } from './terrain-host';
import './facets';

export { EngineTerrainHost, TERRAIN_OBJECT_ID, terrainModule, type TerrainModule } from './terrain-host';
export { surfaceMemoryModule, SMC_CHANNELS, type SmcChannel, type SmcStamp, type SurfaceMemoryFacet } from './surface-memory';
export { overlaysModule, DEFAULT_RIBBON, type OverlayFacet, type OverlayRing, type RibbonStyle } from './overlays';
export { debugLinesModule, type DebugLinesFacet } from './debug-lines';
export { PendingCutSet, type PendingCutEntry } from './pending-cuts';
export { cullAndSort, extractFrustumPlanes, HORIZON_OCCLUDER_RADIUS } from './culling';

export interface SceneModules {
  readonly terrain: TerrainModule;
  readonly surfaceMemory: SurfaceMemoryModule;
  readonly overlays: OverlaysModule;
  readonly debugLines: DebugLinesModule;
  /** Factories for EngineOptions.modules, in install order. */
  readonly factories: (() => RenderModule)[];
}

export function createSceneModules(options: { terrain?: TerrainModuleOptions; smcSize?: number } = {}): SceneModules {
  const terrain = terrainModule(options.terrain);
  const surfaceMemory = surfaceMemoryModule({ size: options.smcSize });
  const overlays = overlaysModule();
  const debugLines = debugLinesModule();
  return { terrain, surfaceMemory, overlays, debugLines, factories: [() => surfaceMemory, () => terrain, () => overlays, () => debugLines] };
}
