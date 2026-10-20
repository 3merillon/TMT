/** Shared rendered flame response: cold smoke and steam produce no emission. */
import { makeModule } from '../../wgsl/module';
export const gasEmissionProfileWgsl = makeModule('gas-emission-profile', /* wgsl */ `
fn gas_flame_heat(temperature:f32,erosion:f32,fade:f32,steam:f32)->f32{
  let heat=1.0-exp(-temperature*1.5);
  return max(0.0,(heat-erosion)/max(1.0-erosion,0.05))*fade*(1.0-steam);
}
fn gas_flame_ramp(heat:f32)->vec3f{
  return mix(mix(vec3f(0.9,0.06,0.0),vec3f(3.2,0.75,0.06),smoothstep(0.05,0.45,heat)),
             vec3f(6.0,2.6,0.45),smoothstep(0.45,0.9,heat));
}
`);
