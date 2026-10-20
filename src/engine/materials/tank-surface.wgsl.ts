/** Included only by the part shader. Mesh header word 9 gates the entire vehicle path. */
export const TANK_SURFACE_WGSL = /* wgsl */ `
fn tank_hash(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn tank_noise(p: vec3f) -> f32 {
  let cell = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tank_hash(cell), tank_hash(cell + vec3f(1,0,0)), u.x),
    mix(tank_hash(cell + vec3f(0,1,0)), tank_hash(cell + vec3f(1,1,0)), u.x), u.y),
    mix(mix(tank_hash(cell + vec3f(0,0,1)), tank_hash(cell + vec3f(1,0,1)), u.x),
    mix(tank_hash(cell + vec3f(0,1,1)), tank_hash(cell + vec3f(1,1,1)), u.x), u.y), u.z);
}
fn tank_float(offset: u32) -> f32 { return bitcast<f32>(mesh_data[offset]); }
struct TankRelief { mask: vec4f, normal: vec3f }
fn tank_relief(p: vec3f, gx: vec3f, gy: vec3f, dx: vec3f, dy: vec3f,
  n: vec3f, view: vec3f, footprint: f32, wear: f32) -> TankRelief {
  // A dominant rest-space projection keeps texel density fixed as joints rotate and LODs change.
  // The world tangent frame comes from derivatives, so mirrored faces and workshop scale stay correct.
  let an = abs(cross(gx,gy));
  var uv = p.xy / 0.42; var ux = gx.xy / 0.42; var uy = gy.xy / 0.42;
  if (an.x > an.y && an.x > an.z) { uv=p.zy/0.42; ux=gx.zy/0.42; uy=gy.zy/0.42; }
  else if (an.y > an.z) { uv=p.xz/0.42; ux=gx.xz/0.42; uy=gy.xz/0.42; }
  let det=ux.x*uy.y-ux.y*uy.x;
  if(abs(det)<1e-12) { return TankRelief(vec4f(1.0,0.0,0.0,0.49),n); }
  let parity=select(-1.0,1.0,det>=0.0);
  let ta=(dx*uy.y-dy*ux.y)*parity;
  let ba=(dy*ux.x-dx*uy.x)*parity;
  let tangent=normalize(ta-n*dot(n,ta));
  let bitangent=normalize(ba-n*dot(n,ba));
  let visible=1.0-smoothstep(0.0015,0.009,footprint);
  let depth=0.0025*visible*wear;
  let ray=vec2f(dot(view,tangent),dot(view,bitangent))/max(dot(view,n),0.22)*depth/0.42;
  var displaced=uv;
  if (visible>0.05 && abs(det)>1e-12) {
    // Bounded POM: find the first depth intersection, then refine it twice. Explicit gradients
    // keep the same anisotropic mip footprint throughout the ray and avoid divergence artifacts.
    var previous=0.0; var current=0.0;
    for (var i=0u;i<8u;i++) {
      let cavity=1.0-textureSampleGrad(tank_height,tank_relief_sampler,uv-ray*current,ux,uy).r;
      if(current>=cavity) { break; }
      previous=current; current+=0.125;
    }
    for(var i=0u;i<2u;i++) {
      let middle=(previous+current)*0.5;
      let cavity=1.0-textureSampleGrad(tank_height,tank_relief_sampler,uv-ray*middle,ux,uy).r;
      if(middle>=cavity) { current=middle; } else { previous=middle; }
    }
    displaced=uv-ray*((previous+current)*0.5);
  }
  let mask=textureSampleGrad(tank_height,tank_relief_sampler,displaced,ux,uy);
  let mapped=textureSampleGrad(tank_normal,tank_relief_sampler,displaced,ux,uy).xyz*2.0-1.0;
  let detail=normalize(tangent*mapped.x+bitangent*mapped.y+n*max(mapped.z,0.1));
  return TankRelief(mask,normalize(mix(n,detail,visible*wear)));
}
// Angular fractures alter the rim without impressing a Cartesian grid into the bowl.
fn tank_damage_radius(q: vec2f) -> f32 {
  let angle=atan2(q.y,q.x+0.0000001);
  let warp=1.0+0.12*sin(angle*3.0+1.1)+0.065*sin(angle*5.0-0.8)+0.035*sin(angle*11.0+0.45);
  return length(q)*warp;
}
// Positive depth into the plate: an irregular bowl with a sharp fractured rim.
fn tank_dent(q: vec2f) -> f32 {
  let r=tank_damage_radius(q);
  let bowl=max(0.0,1.0-r*r*3.3);
  return bowl*bowl;
}
fn tank_surface(input: SurfaceSample, p: vec3f, local: vec3f, local_normal: vec3f,
  lx: vec3f, ly: vec3f, dx: vec3f, dy: vec3f, view: vec3f,
  attrs: u32, footprint: f32, relief: vec4f, paint: vec4f) -> SurfaceSample {
  var s = input; let base = mesh_data[9]; let mat = part_attr_mat(attrs);
  let wear = clamp(tank_float(base + 11u), 0.0, 1.0);
  let grain_visibility = 1.0 - smoothstep(0.002, 0.016, footprint);
  let grain = tank_noise(p * 92.0) - 0.5;
  if (mat == 0u) {
    let c0 = mesh_f3(base, 0u); let c1 = mesh_f3(base + 4u, 0u); let c2 = mesh_f3(base + 8u, 0u);
    let pattern = u32(tank_float(base + 3u)); let scale = max(0.2, tank_float(base + 7u));
    let q = p * scale;
    var color = c0;
    let edge = max(0.012, footprint * scale * 1.5);
    if (pattern == 1u) {
      let v = tank_noise(q * 3.3 + tank_noise(q * 6.0) * 1.6);
      color = mix(c0, c1, smoothstep(0.42-edge, 0.42+edge, v));
      color = mix(color, c2, smoothstep(0.63-edge, 0.63+edge, v));
    } else if (pattern == 2u) {
      let tile = floor(q * 6.0); let v = tank_hash(tile);
      color = select(select(c0, c1, v > 0.42), c2, v > 0.75);
    } else if (pattern == 3u) {
      let stripe = abs(fract(q.x * 1.7 + q.z * 0.35) - 0.5);
      color = mix(c0, c1, 1.0 - smoothstep(0.09-edge, 0.09+edge, stripe));
      color = mix(color, c2, 1.0 - smoothstep(0.015-edge, 0.015+edge, abs(stripe-0.16)));
    }
    // The custom texture is premultiplied over the selected finish, before material wear and combat damage.
    color = color * (1.0 - paint.a) + paint.rgb;
    // Fine authored height/normal decals describe the painted metal surface.
    // Sheltered seams and lower faces collect grit; most upper enamel stays clean.
    let lower=1.0-smoothstep(-0.35,0.10,p.y);
    let shelter=(1.0-part_attr_ao(attrs))*0.55;
    let dirt=relief.b*(lower*0.8+shelter+0.05)*wear;
    let chip=relief.g*wear*(0.7+part_attr_edge(attrs)*0.3);
    color*=0.995+grain*grain_visibility*0.01;
    color=mix(color,vec3f(0.085,0.062,0.033),dirt);
    s.base_color=mix(color,vec3f(0.16,0.17,0.18),chip);
    s.ao*=1.0-(1.0-relief.r)*0.24*wear;
    s.metalness=chip*0.8;
    s.roughness=clamp(0.46+(relief.a-0.49)*0.45+dirt*0.25-chip*0.09,0.28,0.85);
    s.param = 0.18;
  } else if (mat == 2u) {
    // Carbon-filled rubber: matte near-black body, subtly burnished molded edges.
    let rubber_grain=tank_noise(p*670.0)-0.5;
    let fine=1.0-smoothstep(0.0008,0.004,footprint);
    s.base_color=vec3f(0.016,0.018,0.019)*(1.0+rubber_grain*fine*0.15);
    s.metalness=0.0; s.param=0.0;
    s.roughness=0.88-part_attr_edge(attrs)*0.15+rubber_grain*fine*0.055;
  } else if (mat == 6u) {
    // Thick sealed optical glass: reflective in this opaque deferred path; geometry supplies recess and rim.
    s.base_color = vec3f(0.035,0.095,0.115); s.roughness = 0.09; s.param = 0.85;
    // KIT_FLAG.headlight (4): the opaque lens carries the transmitted bulb glow.
    // Ordinary periscopes and sensor glass retain their unlit reflective surface.
    if ((part_attr_flags(attrs) & 4u) != 0u) {
      let lit=clamp(tank_float(base+12u),0.0,1.0);
      s.base_color=mix(s.base_color,vec3f(1.0,0.86,0.59),lit);
      s.emissive=6.0*lit;
    }
  } else if (mat == 5u) {
    s.base_color = vec3f(1.0,0.86,0.59);
    s.emissive = 1.8 * select(1.0,tank_float(base+12u),(part_attr_flags(attrs) & 4u) != 0u);
  } else if (mat == 1u || mat == 3u) {
    s.roughness = clamp(s.roughness + grain * grain_visibility * 0.065, 0.25,0.7);
  }
  // A slab and normal test keep strokes on their picked exterior, including thin opposing plates.
  // Dabs live in the articulated mesh frame; camouflage lives in assembled rest coordinates.
  if (mat == 0u || mat == 1u || mat == 3u) {
    let count = min(mesh_data[10], 216u);
    for (var i = 0u; i < count; i++) {
      let o = base + 16u + i * 16u;
      let damage = tank_float(o + 12u) > 0.5;
      if (mat != 0u && !damage) { continue; }
      let center = mesh_f3(o, 0u); let radius = max(0.001,tank_float(o+3u));
      let delta = local-center;
      if (dot(delta,delta) > radius*radius) { continue; }
      let normal = mesh_f3(o+4u,0u); let depth = abs(dot(delta,normal));
      if (depth > max(0.003,radius*0.12) || dot(local_normal,normal) < 0.62) { continue; }
      let soft = clamp(tank_float(o+11u),0.02,1.0);
      let alpha = (1.0-smoothstep(radius*(1.0-soft),radius,length(delta))) * tank_float(o+7u);
      if (!damage) { s.base_color = mix(s.base_color,mesh_f3(o+8u,0u),alpha); continue; }
      // This relief exists only at accepted combat contacts and follows its picked rigid joint.
      // A small decal-local raymarch creates a real depth cue without moving silhouette vertices.
      let axis=select(vec3f(0,1,0),vec3f(1,0,0),abs(normal.y)>0.85);
      let lt=normalize(cross(axis,normal)); let lb=cross(normal,lt);
      let ux=vec2f(dot(lx,lt),dot(lx,lb))/radius;
      let uy=vec2f(dot(ly,lt),dot(ly,lb))/radius;
      let determinant=ux.x*uy.y-ux.y*uy.x;
      var uv=vec2f(dot(delta,lt),dot(delta,lb))/radius;
      var cavity=tank_dent(uv);
      if(abs(determinant)>1e-12) {
        let parity=select(-1.0,1.0,determinant>=0.0);
        let t=normalize((dx*uy.y-dy*ux.y)*parity);
        let b=normalize((dy*ux.x-dx*uy.x)*parity);
        let n=input.n_shading;
        let depth_scale=min(0.024,radius*0.15)*tank_float(o+7u);
        let ray=vec2f(dot(view,t),dot(view,b))/max(dot(view,n),0.25)*depth_scale/radius;
        var low=0.0; var high=0.0;
        for(var j=0u;j<8u;j++) {
          if(high>=tank_dent(uv-ray*high)) { break; }
          low=high;high+=0.125;
        }
        for(var j=0u;j<2u;j++) {
          let middle=(low+high)*0.5;
          if(middle>=tank_dent(uv-ray*middle)) { high=middle; } else { low=middle; }
        }
        uv-=ray*(low+high)*0.5; cavity=tank_dent(uv);
        let e=max(0.008,footprint/radius);
        let gradient=vec2f(tank_dent(uv+vec2f(e,0))-tank_dent(uv-vec2f(e,0)),tank_dent(uv+vec2f(0,e))-tank_dent(uv-vec2f(0,e)))/(2.0*e);
        s.n_shading=normalize(s.n_shading+(t*gradient.x+b*gradient.y)*depth_scale/radius);
      }
      let rim=(1.0-smoothstep(0.08,0.24,abs(tank_damage_radius(uv)-0.53)))*alpha;
      // Branching radial fractures, with a bright torn edge and a dark recessed core.
      let angle=atan2(uv.y,uv.x); let radial=length(uv);
      let crackWave=abs(sin(angle*5.0+sin(radial*19.0)*.26));
      let crack=(1.0-smoothstep(.025,.10,crackWave))*smoothstep(.30,.48,radial)*(1.0-smoothstep(.72,1.0,radial))*alpha;
      s.base_color=mix(s.base_color,mesh_f3(o+8u,0u),alpha*0.55+cavity*0.4);
      s.base_color=mix(s.base_color,vec3f(0.19,0.18,0.16),rim*0.65);
      s.base_color=mix(s.base_color,vec3f(.008,.006,.005),crack*.9);
      s.ao*=1.0-crack*.65;
      s.ao*=1.0-cavity*0.45;
      s.roughness=mix(s.roughness,0.90,alpha); s.roughness=mix(s.roughness,0.48,rim);
      s.metalness=mix(s.metalness,0.8,rim);
    }
  }
  // Heat stains affect exposed metal and glass as well as the player's chosen paint.
  let damage = clamp(tank_float(base + 13u), 0.0, 1.0);
  let soot = damage * mix(0.65, 1.0, tank_noise(p * 4.0));
  s.base_color = mix(s.base_color, vec3f(0.018, 0.015, 0.012), soot);
  s.roughness = mix(s.roughness, 0.96, damage);
  s.metalness *= 1.0 - damage * 0.85;
  s.emissive *= 1.0 - damage;
  return s;
}
`;
