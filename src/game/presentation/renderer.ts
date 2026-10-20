/** Renderer warm-up boundary. The shell and input can mount before GPU passes and their shaders load. */
export { Engine } from '../../engine/engine';
export { RENDER_MODULES } from '../../engine/modules';
export { createSceneModules } from '../../engine/scene';
export { LIGHTING_DEBUG_VIEWS } from '../../engine/passes/lighting/debug-views';
export { TerrainDebris } from './debris';
export { createProjectileTrails } from './projectile-trails';
