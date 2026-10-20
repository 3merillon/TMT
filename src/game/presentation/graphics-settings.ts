import type { EngineServices, GraphicsSettings as EngineGraphicsSettings, QualityTier } from '../../engine/contracts';
import type { GraphicsSettings } from '../meta/settings';

/** Never resize/reset terrain SDF, liquid state, blast pools or fog when a player adjusts graphics. */
export const PROTECTED_GRAPHICS_TIER: QualityTier = 'high';
export function effectTier(level: number): QualityTier {
  return (['low', 'low', 'medium', 'high', 'ultra'] as const)[Math.max(0, Math.min(4, Math.round(level)))];
}
export function engineGraphicsSettings(g: GraphicsSettings): Partial<EngineGraphicsSettings> {
  return { renderScale: g.renderScale, shadowTier: effectTier(g.shadows), cloudTier: effectTier(g.cloudQuality), hazeTier: effectTier(g.hazeQuality) };
}
/** Runs on load and every edit, including while paused. All optional GPU passes read these controls. */
export function applyGraphicsSettings(s: Pick<EngineServices, 'settings' | 'scene'>, g: GraphicsSettings): void {
  Object.assign(s.settings, engineGraphicsSettings(g));
  const grass = s.scene.get('grass'); if (grass) grass.density = g.grassDensity;
  const clouds = s.scene.get('clouds'); if (clouds) { clouds.enabled = g.cloudQuality > 0; clouds.shadows = g.shadows > 0; }
  const haze = s.scene.get('volumetrics'); if (haze) haze.enabled = g.hazeQuality > 0;
  const shadows = s.scene.get('sunShadows'); if (shadows) shadows.enabled = g.shadows > 0;
  const lighting = s.scene.get('lighting');
  if (lighting) {
    lighting.ao = g.ambientOcclusion;
    lighting.toggles.gi = g.globalIllumination;
    lighting.toggles.sunShadows = lighting.toggles.moonShadows = lighting.toggles.localShadows = g.shadows > 0;
  }
  const post = s.scene.get('post');
  if (post) {
    post.fisheye = g.fisheye; post.miniature = g.miniature;
    post.grain = g.grain * 0.125; post.bloom = g.bloom > 0; post.bloomStrength = g.bloom * 2;
    post.flare = g.lensFlare; post.godRays = g.godRays;
  }
}
