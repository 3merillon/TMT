import { makeModule } from '../../wgsl/module';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { atmosphereBindingsWgsl, atmosphereFnWgsl } from '../atmosphere/integrate.wgsl';
import { cloudDensityWgsl } from './density.wgsl';
import { cloudMathWgsl } from './math.wgsl';
import { CLOUD_FIELD_REGIONS, cloudFieldBindingWgsl, cloudQuatWgsl } from './field';
import { cloudLocalLightingWgsl } from './local-lighting.wgsl';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';

export const cloudRaymarchWgsl = makeModule('cloud-raymarch', /* wgsl */ `
@group(1) @binding(0) var<uniform> cp: CloudParams;
@group(1) @binding(1) var noise: texture_3d<f32>;
@group(1) @binding(2) var ns: sampler;
@group(1) @binding(3) var scene_depth: texture_depth_2d;
@group(1) @binding(4) var cloud_out: texture_storage_2d<rgba16float,write>;
@group(1) @binding(5) var meta_out: texture_storage_2d<rgba16float,write>;
// The liquid surface's depth (or the scene's again without liquids): a ray ends at the water, so the clouds composited
// after the water are only those in front of it; the water itself hides (and refracts) what lies behind it.
@group(1) @binding(19) var water_depth: texture_depth_2d;
fn cloud_phase(mu:f32,g:f32)->f32{
  return (1.0-g*g)/(12.5663706*pow(max(0.01,1.0+g*g-2.0*g*mu),1.5));
}
// Unrelated rays keep their original shell and sample spacing. live: the segment [0, depth] crosses a damaged region
// of the persistent field (field.ts); on any other segment no sample is displaced.
struct CloudRayFlow { padding:f32, live:bool }
fn cloud_ray_flow(ro:vec3f,rd:vec3f,depth:f32)->CloudRayFlow{
  var flow=CloudRayFlow(0.0,false);
  if(!CLOUD_FLOW){return flow;}
  for(var i=0u;i<min(${CLOUD_FIELD_REGIONS}u,u32(cp.field.z));i++){
    let r=cp.regions[i];let interval=cloud_sphere(ro-r.xyz,rd,r.w);
    if(interval.y>0.0 && interval.x<depth){flow.live=true;}
  }
  flow.padding=select(0.0,cp.field.y,flow.live);
  return flow;
}
fn cloud_sun(p:vec3f)->f32{
  let ground=atmo_terrain_lit(p,cp.sun.xyz,1.0);
  if(ground<0.001){return 0.0;}
  let flow=cloud_ray_flow(p,cp.sun.xyz,12.0);let padding=flow.padding;
  let top=cloud_sphere(p,cp.sun.xyz,cp.shell.z+padding);
  let original=cloud_sphere(p,cp.sun.xyz,cp.shell.z);
  let end=min(max(top.y,0.0),12.0);
  let scale=select(1.0,clamp(end/max(min(original.y,12.0),cp.shell.z-cp.shell.y),1.0,1.4),padding>0.0);
  let n=u32(ceil(cp.quality.y*scale));let step=end/f32(n);
  var tau=0.0;
  for(var j=0u;j<n;j++){
    tau+=cloud_density_live(noise,ns,cp,p+cp.sun.xyz*((f32(j)+0.5)*step),false,flow.live).x*step;
  }
  return exp(-tau)*ground;
}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
  let dims=textureDimensions(cloud_out); if(any(id.xy>=dims)){return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(dims);
  let ndc=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0);
  let near=frame.inv_view_proj*vec4f(ndc,1.0,1.0);
  let rd=normalize(near.xyz/near.w-frame.eye_pos);
  let ro=frame.eye_pos;
  let depth=max(textureLoad(scene_depth,vec2i(id.xy),0),textureLoad(water_depth,vec2i(id.xy),0));
  var sceneT=60000.0;
  if(depth>0.0){
    let wp=frame.inv_view_proj*vec4f(ndc,depth,1.0);
    sceneT=distance(ro,wp.xyz/wp.w);
  }
  let flow=cloud_ray_flow(ro,rd,sceneT);let padding=flow.padding;let bounds=vec2f(max(0.0,cp.shell.y-padding),cp.shell.z+padding);
  let outer=cloud_sphere(ro,rd,bounds.y);let inner=cloud_sphere(ro,rd,bounds.x);
  let begin=max(outer.x,0.0); var end=min(outer.y,sceneT);
  // Actual rendered geometry is authoritative, including excavations through the datum.
  var bands=array<vec2f,2>(vec2f(begin,end),vec2f(0.0));
  var count=1u;
  if(inner.y>begin && inner.x<end){
    bands[0]=vec2f(begin,min(end,inner.x)); bands[1]=vec2f(max(begin,inner.y),end); count=2u;
  }
  let total=max(0.0,bands[0].y-bands[0].x)+max(0.0,bands[1].y-bands[1].x);
  let baseOuter=cloud_sphere(ro,rd,cp.shell.z);let baseInner=cloud_sphere(ro,rd,cp.shell.y);
  let baseBegin=max(baseOuter.x,0.0);let baseEnd=min(baseOuter.y,sceneT);
  let baseLength=max(0.0,baseEnd-baseBegin)-max(0.0,min(baseEnd,baseInner.y)-max(baseBegin,baseInner.x));
  let reference=select(cp.shell.z-cp.shell.y,baseLength,baseLength>0.001);
  let budget=cp.quality.x*select(1.0,clamp(total/reference,1.0,1.4),padding>0.0);
  var punctualSelection:CloudLocalSelection;
  if(total>0.0001 && cp.shock_control.y>0.5){punctualSelection=cloud_local_select(ro,rd,bands);}
  var trans=1.0; var radiance=vec3f(0.0); var moment=0.0; var first=60000.0; var last=0.0; var localTau=0.0;
  let jitter=fract(52.9829189*fract(dot(vec2f(id.xy),vec2f(0.06711056,0.00583715))+f32(frame_index()%32u)*0.61803399));
  let mu=dot(rd,cp.sun.xyz);
  let phase=min(0.9,cloud_phase(mu,0.65)*0.8+cloud_phase(mu,-0.2)*0.2);
  if(cp.control.x>0.5 && total>0.0001){
    for(var band=0u;band<count;band++){
      let a=bands[band].x; let b=bands[band].y; if(b<=a){continue;}
      let steps=max(2u,u32(ceil(budget*(b-a)/total)));
      let ds=(b-a)/f32(steps);
      for(var i=0u;i<steps;i++){
        let t=a+(f32(i)+jitter)*ds; let p=ro+rd*t;
        let sample=cloud_density_live(noise,ns,cp,p,true,flow.live);let physical=sample.x;
        let density=physical;
        if(density<=0.001){continue;}
        let protect=cloud_play_visibility(cp,p,sample.y); let tau=density*ds; let local=tau*protect;
        let softened=CLOUD_LOCAL_TAU*exp(-localTau/CLOUD_LOCAL_TAU)*(1.0-exp(-local/CLOUD_LOCAL_TAU));
        localTau+=local; let effective=tau*(1.0-protect)+softened;
        if(effective<0.00001){continue;}
        if(first>50000.0){first=a+f32(i)*ds;} last=min(b,a+f32(i+1u)*ds);
        let dt=exp(-effective); let weight=trans*(1.0-dt);
        let sunVis=cloud_sun(p);
        let day=smoothstep(-0.25,0.16,dot(normalize(p),cp.sun.xyz));
        let powder=1.0-exp(-physical*1.8);
        var direct=vec3f(0.0);
        if(sunVis>0.0){direct=cp.sun.w*atmo_sun_color(p)*sunVis*(phase+0.045*powder);}
        let ambient=mix(vec3f(0.014,0.019,0.032),vec3f(0.3,0.37,0.48),day);
        let multi=atmo_multiscatter(length(p)-atmo.rayleigh.w,dot(normalize(p),cp.sun.xyz))*cp.sun.w*0.4;
        var punctual=vec3f(0.0);
        if(t>punctualSelection.span.x-0.05 && t<punctualSelection.span.y+0.05){punctual=cloud_local_radiance(punctualSelection,p,rd,noise,ns,cp);}
        radiance+=weight*(direct+ambient+multi+punctual)*cp.tint.rgb;
        moment+=weight*t; trans*=dt;
        if(trans<0.015){break;}
      }
      if(trans<0.015){break;}
    }
  }
  let opacity=1.0-trans;
  let centroid=select(max(begin,0.0),moment/max(opacity,0.00001),opacity>0.00001);
  if(opacity>0.0001 && atmo_valid()){
    let air=atmo_integrate(ro,rd,centroid,4u,0.5);
    radiance=radiance*air.T+air.L*opacity;
  }
  textureStore(cloud_out,vec2i(id.xy),vec4f(clamp(radiance,vec3f(0.0),vec3f(128.0)),opacity));
  textureStore(meta_out,vec2i(id.xy),vec4f(min(centroid,60000.0),sceneT,min(first,60000.0),last));
}
`, [frameWgsl, cloudDensityWgsl, cloudFieldBindingWgsl(1,18), cloudLocalLightingWgsl, atmosphereFnWgsl, atmosphereBindingsWgsl(1,{params:6,transmittance:7,multiscatter:8,sampler:9},true),sdfWgsl,sdfBindingsWgsl(1,{volume:10,params:11,sampler:12})]);

export const cloudTemporalWgsl = makeModule('cloud-temporal', /* wgsl */ `
@group(1) @binding(0) var<uniform> cp: CloudParams;
@group(1) @binding(1) var current: texture_2d<f32>;
@group(1) @binding(2) var cloud_meta: texture_2d<f32>;
@group(1) @binding(3) var history: texture_2d<f32>;
@group(1) @binding(4) var previous_meta: texture_2d<f32>;
@group(1) @binding(5) var resolved: texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) id:vec3u){
  let dim=textureDimensions(resolved); if(any(id.xy>=dim)){return;}
  let px=vec2i(id.xy); let uv=(vec2f(id.xy)+0.5)/vec2f(dim);
  let cur=textureLoad(current,px,0); let m=textureLoad(cloud_meta,px,0);
  let near=frame.inv_view_proj*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,1.0,1.0);
  let ray=normalize(near.xyz/near.w-frame.eye_pos);
  let point=frame.eye_pos+ray*m.x;
  // Reproject moving weather in world space, not background raster velocity: the same cloud, turned back by the
  // wind's last step.
  let old=cloud_qrot(cp.wind_prev,cloud_qunrot(cp.wind,point));
  let clip=frame.prev_view_proj*vec4f(old,1.0);
  let oldNdc=clip.xy/clip.w+frame.prev_jitter;
  let prev=vec2f(oldNdc.x*0.5+0.5,0.5-oldNdc.y*0.5);
  var output=cur;
  if(cp.control.z<0.5 && cur.a>0.0001 && clip.w>0.0 && all(prev>vec2f(0.0)) && all(prev<vec2f(1.0))){
    let pos=prev*vec2f(dim)-0.5;let base=vec2i(floor(pos));let f=fract(pos);
    var h=vec4f(0.0);var valid=true;
    // Validate every history tap before filtering. A sky/terrain edge may never
    // interpolate background metadata into permission to reuse hidden cloud.
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){
      let at=clamp(base+vec2i(x,y),vec2i(0),vec2i(dim)-1);
      let oldMeta=textureLoad(previous_meta,at,0);let c=textureLoad(history,at,0);
      let foreground=max(m.w,oldMeta.w)<min(m.y,oldMeta.y)-0.1;
      let depthOK=(abs(m.y-oldMeta.y)<max(0.8,m.y*0.035) || foreground) && oldMeta.w<=m.y+0.02;
      let cloudOK=abs(cur.a-c.a)<0.28 && abs(m.z-oldMeta.z)<max(1.0,m.z*0.08) && abs(m.w-oldMeta.w)<max(1.0,m.w*0.08);
      valid=valid && depthOK && cloudOK;
      h+=c*mix(1.0-f.x,f.x,f32(x))*mix(1.0-f.y,f.y,f32(y));
    }}
    if(valid){
      var lo=vec4f(1e5); var hi=vec4f(-1e5);
      for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
        let c=textureLoad(current,clamp(px+vec2i(x,y),vec2i(0),vec2i(dim)-1),0);
        lo=min(lo,c); hi=max(hi,c);
      }}
      let clipped=clamp(h,lo,hi);
      let rejection=clamp(abs(h.a-cur.a)*3.0,0.0,1.0);
      output=mix(clipped,cur,max(select(0.22,0.7,cp.shock_control.x>0.0),rejection));
    }
  }
  textureStore(resolved,px,output);
}
`, [frameWgsl, cloudMathWgsl, cloudQuatWgsl]);

/** Full-resolution premultiplied cloud color, already clipped to this geometry pixel. */
export const cloudCompositeWgsl = makeModule('cloud-composite', /* wgsl */ `
@group(1) @binding(0) var color: texture_2d<f32>;
struct CloudVertex { @builtin(position) position: vec4f }
@vertex fn vs(@builtin(vertex_index) i:u32)->CloudVertex{
  var o:CloudVertex; let p=vec2f(f32((i<<1u)&2u),f32(i&2u));
  o.position=vec4f(p*2.0-1.0,0.0,1.0); return o;
}
@fragment fn fs(v:CloudVertex)->@location(0) vec4f{
  return textureLoad(color,vec2i(v.position.xy),0);
}
`);
