/**
 * APPEND-ONLY RenderModule registry (plan §5.4 / §7.3). Add one line per module, tagged `// <STREAM-ID>`.
 * The engine core (G-buffer, part meshes, lights, lighting, composite, debug views, image stats) is installed by
 * Engine.create itself; this list is what the game facade and the sandbox pass as `EngineOptions.modules`.
 */
import type { RenderModule } from './contracts';
import { atmosphereModule } from './passes/atmosphere/luts'; // W1-ENG-LOOK
import { skyLightModule } from './passes/lighting/sky-light'; // W1-ENG-LOOK
import { sunShadowsModule } from './passes/shadows/sun-shadows'; // W1-ENG-LOOK
import { grassModule } from './passes/vegetation/grass';
import { cloudsModule } from './passes/clouds/clouds';
import { volumetricsModule } from './passes/volumetrics/volumetrics';

export const RENDER_MODULES: (() => RenderModule)[] = [
  /* append-only */
  () => atmosphereModule(), // W1-ENG-LOOK
  () => sunShadowsModule(), // W1-ENG-LOOK
  () => skyLightModule(), // W1-ENG-LOOK
  () => grassModule(), // W2-VEG
  () => cloudsModule(), // W3-SKY
  () => volumetricsModule(), // W3-SKY
];
