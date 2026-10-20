import { makeModule } from '../../wgsl/module';
import type { Vec3 } from '../../contracts';

/** Convex forward cone clipped to the physical light sphere and opaque scene depth. */
export const volumeLocalQuadratureWgsl = makeModule('volume-local-quadrature',/* wgsl */ `
fn volume_light_interval(o:vec3f,rd:vec3f,axis:vec3f,range:f32,outer:f32,spot:bool,bounds:vec2f)->vec2f{
  let b=dot(o,rd);let perpendicular=o-rd*b;let disc=range*range-dot(perpendicular,perpendicular);
  if(disc<=0.0){return vec2f(0.0);}
  let root=sqrt(disc);var lo=max(bounds.x,-b-root);var hi=min(bounds.y,-b+root);
  if(hi<=lo || !spot || outer<=0.0){return vec2f(lo,hi);}
  let h=dot(o,axis);let v=dot(rd,axis);
  if(abs(v)<0.000001){if(h<0.0){return vec2f(0.0);}}
  else if(v>0.0){lo=max(lo,-h/v);}else{hi=min(hi,-h/v);}
  if(hi<=lo){return vec2f(0.0);}
  let c2=outer*outer;let a=v*v-c2;let q=h*v-c2*b;let c=h*h-c2*dot(o,o);
  if(abs(a)<0.000001){
    if(abs(q)<0.000001){if(c<0.0){return vec2f(0.0);}}
    else if(q>0.0){lo=max(lo,-c/(2.0*q));}else{hi=min(hi,-c/(2.0*q));}
  }else{
    let d=q*q-a*c;
    if(d<0.0){if(a<0.0){return vec2f(0.0);}}
    else{
      let roots=vec2f(-q-sqrt(d),-q+sqrt(d))/a;let r0=min(roots.x,roots.y);let r1=max(roots.x,roots.y);
      if(a<0.0){lo=max(lo,r0);hi=min(hi,r1);}
      else if(lo<r0){hi=min(hi,r0);}else{lo=max(lo,r1);}
    }
  }
  return vec2f(lo,hi);
}
// Equiangular samples concentrate near the source. A finite perpendicular scale
// matches the attenuation clamp and remains stable for an eye/ray on the light axis.
fn volume_light_sample(o:vec3f,rd:vec3f,span:vec2f,i:u32,n:u32)->vec2f{
  let center=-dot(o,rd);let d=max(length(o+rd*center),0.3);
  let angles=atan((span-vec2f(center))/d);let da=(angles.y-angles.x)/f32(n);
  let a=angles.x+(f32(i)+0.5)*da;let t=tan(a);
  return vec2f(center+d*t,d*(1.0+t*t)*da);
}
`);

/** Numerical oracle used to check the geometric edge cases and integration convergence. */
export function volumeLightInterval(o: Vec3, rd: Vec3, axis: Vec3, range: number, outer: number, spot: boolean, bounds: readonly [number, number]): [number, number] {
  const dot = (a: Vec3, b: Vec3) => a.reduce((s, v, i) => s + v * b[i], 0);
  const b = dot(o, rd), perp = o.map((v, i) => v - rd[i] * b) as Vec3, disc = range * range - dot(perp, perp);
  if (disc <= 0) return [0, 0];
  const root = Math.sqrt(disc); let lo = Math.max(bounds[0], -b - root), hi = Math.min(bounds[1], -b + root);
  if (hi <= lo || !spot || outer <= 0) return [lo, hi];
  const h = dot(o, axis), v = dot(rd, axis);
  if (Math.abs(v) < 1e-6) { if (h < 0) return [0, 0]; } else if (v > 0) lo = Math.max(lo, -h / v); else hi = Math.min(hi, -h / v);
  if (hi <= lo) return [0, 0];
  const c2 = outer * outer, a = v * v - c2, q = h * v - c2 * b, c = h * h - c2 * dot(o, o);
  if (Math.abs(a) < 1e-6) { if (Math.abs(q) < 1e-6) { if (c < 0) return [0, 0]; } else if (q > 0) lo = Math.max(lo, -c / (2 * q)); else hi = Math.min(hi, -c / (2 * q)); }
  else { const d = q * q - a * c; if (d < 0) { if (a < 0) return [0, 0]; } else { const roots = [(-q - Math.sqrt(d)) / a, (-q + Math.sqrt(d)) / a].sort((x, y) => x - y); if (a < 0) { lo = Math.max(lo, roots[0]); hi = Math.min(hi, roots[1]); } else if (lo < roots[0]) hi = Math.min(hi, roots[0]); else lo = Math.max(lo, roots[1]); } }
  return [lo, hi];
}
export function volumeLightSamples(o: Vec3, rd: Vec3, span: readonly [number, number], count: number): [number, number][] {
  const center = -o.reduce((s, v, i) => s + v * rd[i], 0), d = Math.max(Math.hypot(...o.map((v, i) => v + rd[i] * center)), .3);
  const start = Math.atan((span[0] - center) / d), da = (Math.atan((span[1] - center) / d) - start) / count;
  return Array.from({ length: count }, (_, i) => { const t = Math.tan(start + (i + .5) * da); return [center + d * t, d * (1 + t * t) * da]; });
}
