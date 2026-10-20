/** Every common WGSL single source (registered in the engine's WgslLibrary at start-up). */
import type { WgslModule } from '../../contracts';
import { brdfWgsl } from './brdf.wgsl';
import { gbufferFlagWgsl, materialClassWgsl, mathWgsl } from './constants.wgsl';
import { depthWgsl } from './depth.wgsl';
import { frameStructWgsl, frameWgsl } from './frame.wgsl';
import { gbufferWgsl } from './gbuffer.wgsl';
import { packingWgsl } from './packing.wgsl';
import { radialWgsl } from './radial.wgsl';
import { shadowViewWgsl } from './shadow-view.wgsl';

export { brdfWgsl, depthWgsl, frameStructWgsl, frameWgsl, gbufferFlagWgsl, gbufferWgsl, materialClassWgsl, mathWgsl, packingWgsl, radialWgsl, shadowViewWgsl };

export const COMMON_WGSL: readonly WgslModule[] = [
  mathWgsl, materialClassWgsl, gbufferFlagWgsl, frameStructWgsl, frameWgsl, depthWgsl, packingWgsl, gbufferWgsl, brdfWgsl, radialWgsl, shadowViewWgsl,
];
