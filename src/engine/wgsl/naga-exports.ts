/**
 * Every full linked engine shader plus each common module linked standalone, for `tests/wgsl-naga.test.ts` (W0-TOOLS).
 * Pure: importable in Node (no GPU globals).
 */
import { imageStatsShader } from '../debug/image-stats';
import { gbufferViewShader } from '../debug/gbuffer-views';
import { mipGenShader } from '../gpu/mip-gen';
import { partMeshDepthShader, partMeshGbufferShader } from '../passes/gbuffer/mesh.pass';
import { lightingShader } from '../passes/lighting/lighting';
import { compositeShaderLinked, presentShaderLinked } from '../passes/post/composite';
import { pendingCutsWgsl } from '../frame/pending-cuts';
import { lightsWgsl } from '../scene/lights';
import { partBasicWgsl } from '../materials/part-basic.wgsl';
import { workshopMipWgsl } from '../materials/workshop-textures';
import { workshopReflectionDecodeWgsl } from '../materials/workshop-reflection';
import { fullscreenWgsl } from '../gpu/fullscreen';
import { focusRingShader } from '../sandbox/focus-ring';
import { COMMON_WGSL } from './common';
import { liquidBedWgsl, liquidCacheWgsl, liquidCompositeWgsl, liquidDepthWgsl } from '../passes/fluids/fluids.wgsl';
import { waterProbeWgsl, waterStepWgsl, waterSurfaceWgsl, waterTilesWgsl } from '../passes/fluids/water.wgsl';
import { sprayDrawWgsl, sprayStepWgsl } from '../passes/fluids/spray.wgsl';
import {
  gasAdvectWgsl, gasClearRWgsl, gasClearRgbaWgsl, gasCurlWgsl, gasDivergenceWgsl, gasObsBandWgsl, gasObsDensityWgsl, gasPressureWgsl, gasProjectWgsl,
  gasRaymarchWgsl,
} from '../passes/fluids/gas.wgsl';
import { buildLightingShader } from '../passes/lighting/lighting.wgsl';
import { link, makeModule } from './module';
import { grassCullShader, grassDrawShader, grassEmitShader, grassPlaceShader, grassShadowShader } from '../passes/vegetation/grass';
import { shockwavesWgsl } from '../passes/shockwaves/shockwaves.wgsl';
import { cloudShaders } from '../passes/clouds/clouds';
import { cloudFieldUpdateWgsl } from '../passes/clouds/field';
import { volumeShaders } from '../passes/volumetrics/volumetrics.wgsl';
import { opticsSourceWgsl } from '../passes/post/optics';
import { tsrShaders } from '../passes/post/tsr.wgsl';
import { gasEmissionWgsl } from '../passes/fluids/gas-emission.wgsl';
import { gasFlowAdvectWgsl, gasFlowClearWgsl } from '../passes/fluids/gas-flow.wgsl';
import { sunClassShaders } from '../passes/atmosphere/sun-class';
import { aoShader } from '../passes/ao/sdf-ao';
import { dofShader } from '../passes/post/dof';

export function nagaModules(): { name: string; code: string }[] {
  const out: { name: string; code: string }[] = [];
  for (const [name, shader] of Object.entries(cloudShaders())) out.push({ name: `shader:clouds-${name}`, code: shader.code });
  out.push({ name: 'shader:clouds-field', code: link(cloudFieldUpdateWgsl).code });
  for (const [name, shader] of Object.entries(volumeShaders())) out.push({ name: `shader:volumetrics-${name}`, code: shader.code });
  out.push({ name: 'shader:optics-source', code: link(opticsSourceWgsl).code });
  for (const [name, shader] of Object.entries(tsrShaders())) out.push({ name: `shader:tsr-${name}`, code: shader.code });
  for (const m of [grassDrawShader, grassPlaceShader, grassShadowShader, grassCullShader, grassEmitShader]) out.push({ name: m.name, code: link(m).code });
  for (const m of [...COMMON_WGSL, lightsWgsl, partBasicWgsl, pendingCutsWgsl, fullscreenWgsl]) out.push({ name: `module:${m.name}`, code: link(m).code });
  out.push({ name: 'shader:part-mesh-gbuffer', code: partMeshGbufferShader().code });
  out.push({ name: 'shader:workshop-texture-mip', code: link(workshopMipWgsl).code });
  out.push({ name: 'shader:workshop-reflection-decode', code: link(workshopReflectionDecodeWgsl).code });
  out.push({ name: 'shader:part-mesh-depth', code: partMeshDepthShader().code });
  out.push({ name: 'shader:lighting-v0', code: lightingShader().code });
  for (const options of [{ ao: false, gi: false, casters: false }, { ao: false, gi: false, casters: true }, { ao: true, gi: false, casters: true }]) {
    out.push({ name: `shader:lighting-cap-${Number(options.ao)}${Number(options.gi)}${Number(options.casters)}`, code: link(buildLightingShader(options)).code });
  }
  out.push({ name: 'shader:composite-v0', code: compositeShaderLinked().code });
  out.push({ name: 'shader:depth-of-field', code: dofShader().code });
  out.push({ name: 'shader:present', code: presentShaderLinked().code });
  out.push({ name: 'shader:gbuffer-views', code: gbufferViewShader().code });
  out.push({ name: 'shader:image-stats', code: imageStatsShader().code });
  for (const f of ['rgba8unorm', 'rgba16float'] as const) for (const d of ['2d', '2d-array'] as const) out.push({ name: `shader:mip-gen:${f}:${d}`, code: mipGenShader(f, d).code });
  out.push({ name: 'shader:sandbox-focus-ring', code: focusRingShader().code });
  out.push({ name: 'shader:shockwaves', code: link(shockwavesWgsl).code });
  // Planet-wide liquids: the level map, the water step and surface, and the composite (a second
  // entry point of lighting).
  for (const m of [liquidBedWgsl, liquidCacheWgsl, liquidDepthWgsl, waterStepWgsl, waterSurfaceWgsl, waterTilesWgsl, waterProbeWgsl, sprayStepWgsl, sprayDrawWgsl,
    gasCurlWgsl, gasAdvectWgsl, gasDivergenceWgsl, gasPressureWgsl, gasProjectWgsl, gasClearRgbaWgsl, gasClearRWgsl, gasObsDensityWgsl, gasObsBandWgsl,
    gasRaymarchWgsl, gasEmissionWgsl, gasFlowAdvectWgsl, gasFlowClearWgsl]) out.push({ name: `shader:${m.name}`, code: link(m).code });
  out.push({ name: 'shader:liquid-composite', code: link(makeModule('liquid-composite-check', '', [buildLightingShader({ ao: true, gi: true, casters: true }), liquidCompositeWgsl])).code });
  // Exact sun classes: their kernels and the lighting variant (with its liquid composite entry point) that reads them.
  for (const [name, shader] of Object.entries(sunClassShaders())) out.push({ name: `shader:sun-class-${name}`, code: shader.code });
  out.push({ name: 'shader:lighting-sun-class', code: link(buildLightingShader({ ao: true, gi: true, casters: true, sunClass: true })).code });
  out.push({ name: 'shader:liquid-composite-sun-class', code: link(makeModule('liquid-composite-sun-class-check', '', [buildLightingShader({ ao: true, gi: true, casters: true, sunClass: true }), liquidCompositeWgsl])).code });
  for (const format of ['r8unorm', 'rgba8unorm'] as const) out.push({ name: `shader:sdf-ao:${format}`, code: link(aoShader(format)).code });
  return out;
}
