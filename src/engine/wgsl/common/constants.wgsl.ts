/** Engine-wide WGSL constants generated from TS (N3): material classes, GB3 flag bits, maths. */
import { GBUFFER_FLAG, MATERIAL_CLASS } from '../../contracts';
import { makeModule, tsConstCode } from '../module';

const classConsts = Object.fromEntries(Object.entries(MATERIAL_CLASS).map(([k, v]) => [`CLASS_${k}`, v]));
const flagConsts = Object.fromEntries(Object.entries(GBUFFER_FLAG).map(([k, v]) => [`GB_FLAG_${k}`, v]));

export const materialClassWgsl = makeModule('material-class', tsConstCode(classConsts));
export const gbufferFlagWgsl = makeModule('gbuffer-flags', tsConstCode(flagConsts));
export const mathWgsl = makeModule('math', tsConstCode({
  PI: { value: Math.PI, type: 'f32' },
  TAU: { value: Math.PI * 2, type: 'f32' },
  INV_PI: { value: 1 / Math.PI, type: 'f32' },
}));
