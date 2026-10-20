import { makeModule } from '../../wgsl/module';
import { HULL_WAKE } from './hull-wake';

export const hullWakeWgsl=makeModule('water-hull-wake',/* wgsl */ `
fn water_hull_flux(previous: f32, along: f32, depth: f32, edge: f32, open: f32, contact: f32, dt: f32, max_speed: f32) -> f32 {
  let driven_flux = clamp(along, 0.0, ${HULL_WAKE.maximumSpeed}.0) * depth * edge * ${HULL_WAKE.transfer} * open;
  let blend = (1.0 - exp(-dt * ${HULL_WAKE.response}.0)) * clamp(contact, 0.0, 1.0);
  return min(max_speed * depth * edge * open, max(0.0, mix(previous, driven_flux, blend)));
}
`);
