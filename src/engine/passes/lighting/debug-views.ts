/** Lighting inspection controls shared by the shell and GPU pass, without shader imports. */
export type LightingDebugView = 'none' | 'shadow' | 'direct' | 'ambient' | 'ao' | 'gi' | 'fog' | 'sdf-sun'
  | 'gi-sky' | 'gi-bounce' | 'mist' | 'veil' | 'moon' | 'local' | 'sdf';
export const VIEW_INDEX: Record<LightingDebugView, number> = {
  none: 0, shadow: 1, direct: 2, ambient: 3, ao: 4, gi: 5, fog: 6, 'sdf-sun': 7,
  'gi-sky': 8, 'gi-bounce': 9, mist: 10, veil: 11, moon: 12, local: 13, sdf: 14,
};
export const LIGHTING_DEBUG_VIEWS = Object.keys(VIEW_INDEX) as LightingDebugView[];
/** What each view shows (the ?dev panel's tooltips). Term views are scaled so 1.0 reads as white. */
export const LIGHTING_DEBUG_VIEW_INFO: Readonly<Record<LightingDebugView, string>> = {
  none: 'The final image.',
  shadow: 'Sun visibility: the soft SDF trace (world) times the tank bricks, the contact shadow and the back-face gate.',
  direct: 'All direct light: sun, moon and punctual lights, with their shadows.',
  ambient: 'Ambient light (sky, GI, night floor) times AO, plus environment specular.',
  ao: 'SDF ambient occlusion times the material AO (ambient light only).',
  gi: 'GI probes: sky visibility in grey plus the bounce in colour.',
  'gi-sky': 'GI probe sky visibility alone (how much sky each point sees).',
  'gi-bounce': 'GI probe bounce light alone.',
  fog: 'Fog-of-war hidden fraction on surfaces: black seen, white hidden.',
  mist: 'Volumetric war-fog opacity along each camera ray.',
  veil: 'The veil colour hidden surfaces take, on every veiled surface.',
  'sdf-sun': 'The raw planet-SDF sun trace from the unlifted surface point (no tanks, no terminator fix).',
  moon: 'Moon light: back-face gate times the soft SDF moon shadow (world and tanks).',
  local: 'Punctual lights (shells, flashes, impacts) with their SDF shadows (world and tanks).',
  sdf: 'SDF distance at the rendered surface: black = the SDF matches, grey = outside it, red = inside it (2 voxels = full).',
};
