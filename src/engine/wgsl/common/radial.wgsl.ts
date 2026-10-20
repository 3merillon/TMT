/** Planet-local frame (plan §4.4): the planet centre is the origin, so "up" at p is normalize(p). */
import { makeModule } from '../module';

export const radialWgsl = makeModule('radial', /* wgsl */ `
fn radial_up(p: vec3f) -> vec3f { return p / max(length(p), 1e-6); }
fn radial_altitude(p: vec3f, radius: f32) -> f32 { return length(p) - radius; }
`);

export function radialUp(p: readonly number[]): [number, number, number] {
  const l = Math.max(Math.hypot(p[0], p[1], p[2]), 1e-6);
  return [p[0] / l, p[1] / l, p[2] / l];
}
