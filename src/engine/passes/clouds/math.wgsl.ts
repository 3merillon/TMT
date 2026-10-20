import { makeModule } from '../../wgsl/module';
import { CLOUD_PARAMS } from './params';

export const cloudMathWgsl = makeModule('cloud-math', /* wgsl */ `
fn cloud_sphere(ro:vec3f,rd:vec3f,r:f32)->vec2f{
  let b=dot(ro,rd);let q=ro-rd*b;let disc=r*r-dot(q,q);
  if(disc<0.0){return vec2f(1e5,-1e5);}let root=sqrt(disc);return vec2f(-b-root,-b+root);
}
fn cloud_rotate(p:vec3f,axis:vec3f,angle:f32)->vec3f{
  let c=cos(angle);let s=sin(angle);return p*c+cross(axis,p)*s+axis*dot(axis,p)*(1.0-c);
}
// View, sun and receiver shadow lookups use the same conservative advected shell.
fn cloud_bounds(cp:CloudParams)->vec2f{return vec2f(max(0.0,cp.shell.y-cp.shock_control.z),cp.shell.z+cp.shock_control.z);}
`,[CLOUD_PARAMS.module]);
