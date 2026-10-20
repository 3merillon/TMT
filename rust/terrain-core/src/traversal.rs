//! Immutable resident query snapshots. Traversal order, tolerances and overflow
//! accounting follow the historical terrain query contract, independently of Rapier.
use crate::core::Outcome;
use std::{collections::HashMap, rc::Rc};
type V = [f64; 3];
fn sub(a: V, b: V) -> V { [a[0]-b[0],a[1]-b[1],a[2]-b[2]] }
fn add(a: V, b: V) -> V { [a[0]+b[0],a[1]+b[1],a[2]+b[2]] }
fn scale(a: V, k: f64) -> V { [a[0]*k,a[1]*k,a[2]*k] }
fn dot(a: V, b: V) -> f64 { a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
fn cross(a: V, b: V) -> V { [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]] }
fn length(v: V) -> f64 { let m=v[0].abs().max(v[1].abs()).max(v[2].abs());if m==0. {0.} else {let u=scale(v,1./m);dot(u,u).sqrt()*m} }
fn vec(d:&[f64],at:usize)->V {[d[at],d[at+1],d[at+2]]}
fn number(out:&mut Vec<u8>,n:f64) {out.extend_from_slice(&n.to_le_bytes());}
fn write(out:&mut Vec<u8>,v:V) {for n in v {number(out,n);}}
struct Read<'a> { bytes:&'a [u8],at:usize }
impl Read<'_> {
    fn take<const N:usize>(&mut self)->Outcome<[u8;N]> {let end=self.at.checked_add(N).ok_or("Query packet overflow")?;let b=self.bytes.get(self.at..end).ok_or("Truncated query packet")?;self.at=end;Ok(b.try_into().unwrap())}
    fn u32(&mut self)->Outcome<u32>{Ok(u32::from_le_bytes(self.take()?))}
}
struct Chunk {positions:Vec<f32>,indices:Vec<u32>,materials:Vec<u16>,boxes:Vec<[f64;6]>,skip:Vec<usize>,leaf:Vec<[i32;2]>,faces:Vec<usize>}
impl Chunk {
    fn read(bytes:&[u8])->Outcome<Self> {
        let mut r=Read{bytes,at:0};let nv=r.u32()? as usize;let ni=r.u32()? as usize;let nf=r.u32()? as usize;let nn=r.u32()? as usize;
        let expected=((16+nv*12+ni*4+nf*2+7)/8)*8+nn*60+nf*4;
        if ni!=nf*3||expected!=bytes.len(){return Err("Invalid query packet layout".into());}
        let mut positions=Vec::with_capacity(nv*3);for _ in 0..nv*3{positions.push(f32::from_le_bytes(r.take()?));}
        let mut indices=Vec::with_capacity(ni);for _ in 0..ni{let id=r.u32()?;if id as usize>=nv{return Err("Invalid query vertex".into());}indices.push(id);}
        let mut materials=Vec::with_capacity(nf);for _ in 0..nf{materials.push(u16::from_le_bytes(r.take()?));}r.at=(r.at+7)/8*8;
        let mut boxes=Vec::with_capacity(nn);for _ in 0..nn{let mut b=[0.;6];for x in &mut b{*x=f64::from_le_bytes(r.take()?);}boxes.push(b);}
        let mut skip=Vec::with_capacity(nn);for i in 0..nn{let s=r.u32()? as usize;if s<=i||s>nn{return Err("Invalid query skip".into());}skip.push(s);}
        let mut leaf=Vec::with_capacity(nn);for _ in 0..nn{let a=r.u32()? as i32;let b=r.u32()? as i32;if a>=0&&(b<a||b as usize>nf){return Err("Invalid query leaf".into());}leaf.push([a,b]);}
        let mut faces=Vec::with_capacity(nf);for _ in 0..nf{let id=r.u32()? as usize;if id>=nf{return Err("Invalid query face".into());}faces.push(id);}
        if positions.iter().any(|x|!x.is_finite())||boxes.iter().flatten().any(|x|!x.is_finite()){return Err("Non-finite query geometry".into());}
        Ok(Self{positions,indices,materials,boxes,skip,leaf,faces})
    }
    fn triangle(&self,f:usize)->[V;3] {let p=|i:usize|{let k=self.indices[f*3+i] as usize*3;[self.positions[k] as f64,self.positions[k+1] as f64,self.positions[k+2] as f64]};[p(0),p(1),p(2)]}
}
struct Node {bounds:[f64;6],skip:usize,chunk:Option<usize>,count:usize}
struct Scene {chunks:Vec<Rc<Chunk>>,top:Vec<Node>}
impl Scene {
    fn new(chunks:Vec<Rc<Chunk>>)->Self {let mut s=Self{chunks,top:Vec::new()};if !s.chunks.is_empty(){s.build(0,s.chunks.len());}s}
    fn build(&mut self,from:usize,to:usize)->usize {
        let n=self.top.len();self.top.push(Node{bounds:[0.;6],skip:0,chunk:None,count:to-from});
        if to-from==1{self.top[n].bounds=self.chunks[from].boxes[0];self.top[n].chunk=Some(from);}
        else{let mid=(from+to)/2;let a=self.build(from,mid);let b=self.build(mid,to);for k in 0..3{self.top[n].bounds[k]=self.top[a].bounds[k].min(self.top[b].bounds[k]);self.top[n].bounds[k+3]=self.top[a].bounds[k+3].max(self.top[b].bounds[k+3]);}}
        self.top[n].skip=self.top.len();n
    }
    fn ray(&self,mut r:Ray,mode:u32,out:&mut Vec<u8>) {
        let mut best=None;let mut node=0;
        while node<self.top.len(){let top=&self.top[node];let Some(ci)=top.chunk else{node=if r.box_hit(&top.bounds){node+1}else{top.skip};continue;};node+=1;
            let c=&self.chunks[ci];let mut n=0;while n<c.skip.len(){if !r.box_hit(&c.boxes[n]){n=c.skip[n];continue;}let [first,end]=c.leaf[n];if first<0{n+=1;continue;}
                for k in first..end{let f=c.faces[k as usize];let tri=c.triangle(f);let hit=if mode==2{sphere_triangle(&r,tri)}else{ray_triangle(&r,tri)};
                    if let Some(distance)=hit{if mode==1{number(out,1.);return;}r.far=distance.max(0.);best=Some((ci,f));}
                }n=c.skip[n];
            }
        }
        if mode==1{number(out,0.);return;}let Some((ci,f))=best else{return;};number(out,r.far);if mode==2{return;}
        let [a,b,c]=self.chunks[ci].triangle(f);let normal=cross(sub(b,a),sub(c,a));write(out,add(r.origin,scale(r.direction,r.far)));write(out,scale(normal,1./length(normal)));number(out,self.chunks[ci].materials[f] as f64);
    }
    fn collect(&self,d:&[f64],out:&mut Vec<u8>)->Outcome<()> {
        if d.len()!=7||d.iter().any(|x|!x.is_finite())||d[6].fract()!=0.||d[6]<1.||d[6]>2048.||(0..3).any(|a|d[a]>d[a+3]){return Err("Invalid bounded terrain triangle query.".into());}
        let b=[d[0]-1e-7,d[1]-1e-7,d[2]-1e-7,d[3]+1e-7,d[4]+1e-7,d[5]+1e-7];let limit=d[6] as usize;let mut visited=0;let mut count=0;let mut node=0;number(out,0.);
        let overflow=|out:&mut Vec<u8>|{out[..8].copy_from_slice(&1f64.to_le_bytes());};
        while node<self.top.len(){let top=&self.top[node];let Some(ci)=top.chunk else{if overlaps(&top.bounds,&b){node+=1;}else{visited+=top.count;if visited>8192{overflow(out);return Ok(());}node=top.skip;}continue;};node+=1;
            let c=&self.chunks[ci];let mut n=0;while n<c.skip.len(){visited+=1;if visited>8192{overflow(out);return Ok(());}if !overlaps(&c.boxes[n],&b){n=c.skip[n];continue;}let [first,end]=c.leaf[n];if first<0{n+=1;continue;}
                for k in first..end{let f=c.faces[k as usize];let [a,z,t]=c.triangle(f);if (0..3).any(|j|a[j].min(z[j]).min(t[j])>b[j+3]||a[j].max(z[j]).max(t[j])<b[j]){continue;}
                    if count>=limit{overflow(out);return Ok(());}let normal=cross(sub(z,a),sub(t,a));let len=length(normal);if len<=1e-12{continue;}write(out,a);write(out,z);write(out,t);write(out,scale(normal,1./len));number(out,c.materials[f] as f64);count+=1;
                }n=c.skip[n];
            }
        }Ok(())
    }
}
fn overlaps(a:&[f64;6],b:&[f64;6])->bool {(0..3).all(|i|a[i]<=b[i+3]&&a[i+3]>=b[i])}
struct Ray {origin:V,direction:V,far:f64,radius:f64}
impl Ray {
    fn read(d:&[f64],sweep:bool)->Option<Self>{if d.len()!=if sweep{8}else{7}||d.iter().any(|x|!x.is_finite())||d[6]<0.||sweep&&d[7]<=0.{return None;}let v=vec(d,3);let n=length(v);if n<1e-15{return None;}Some(Self{origin:vec(d,0),direction:[v[0]/n,v[1]/n,v[2]/n],far:d[6],radius:if sweep{d[7]}else{0.}})}
    fn box_hit(&self,b:&[f64;6])->bool {let mut near=0f64;let mut far=self.far;for i in 0..3{let o=self.origin[i];let d=self.direction[i];if d.abs()<1e-15{if o<b[i]-self.radius-1e-7||o>b[i+3]+self.radius+1e-7{return false;}}else{let mut lo=(b[i]-self.radius-o)/d;let mut hi=(b[i+3]+self.radius-o)/d;if lo>hi{std::mem::swap(&mut lo,&mut hi);}near=near.max(lo);far=far.min(hi);if near>far+1e-7{return false;}}}true}
}
fn ray_triangle(r:&Ray,[a,b,c]:[V;3])->Option<f64>{let e1=sub(b,a);let e2=sub(c,a);let p=cross(r.direction,e2);let det=dot(e1,p);if det.abs()<1e-12{return None;}let inv=1./det;let t=sub(r.origin,a);let u=dot(t,p)*inv;if u< -1e-8||u>1.+1e-8{return None;}let q=cross(t,e1);let v=dot(r.direction,q)*inv;if v< -1e-8||u+v>1.+1e-8{return None;}let distance=dot(e2,q)*inv;if distance< -1e-7||distance>r.far||length(cross(e1,e2))==0.{None}else{Some(distance)}}
fn first_root(a:f64,b:f64,c:f64)->Option<f64>{if a<1e-16{return None;}let d=b*b-a*c;if d<0.{return None;}let t=(-b-d.sqrt())/a;if t>=0.{Some(t)}else{None}}
fn sphere_triangle(r:&Ray,[a,b,c]:[V;3])->Option<f64>{
    let ab=sub(b,a);let ac=sub(c,a);let ap=sub(r.origin,a);let d1=dot(ab,ap);let d2=dot(ac,ap);
    let closest=if d1<=0.&&d2<=0.{a}else{let bp=sub(r.origin,b);let d3=dot(ab,bp);let d4=dot(ac,bp);let vc=d1*d4-d3*d2;
        if d3>=0.&&d4<=d3{b}else if vc<=0.&&d1>=0.&&d3<=0.{add(a,scale(ab,d1/(d1-d3)))}else{let cp=sub(r.origin,c);let d5=dot(ab,cp);let d6=dot(ac,cp);let vb=d5*d2-d1*d6;let va=d3*d6-d5*d4;
            if d6>=0.&&d5<=d6{c}else if vb<=0.&&d2>=0.&&d6<=0.{add(a,scale(ac,d2/(d2-d6)))}else if va<=0.&&d4-d3>=0.&&d5-d6>=0.{add(b,scale(sub(c,b),(d4-d3)/((d4-d3)+(d5-d6))))}else{let den=1./(va+vb+vc);add(add(a,scale(ab,vb*den)),scale(ac,vc*den))}
        }};
    let delta=sub(closest,r.origin);if dot(delta,delta)<=r.radius*r.radius{return Some(0.);}let mut best=r.far;let mut hit=false;
    let n=cross(sub(c,b),sub(a,b));let squared=dot(n,n);let n=if squared>0.{scale(n,1./squared.sqrt())}else{[0.;3]};let distance=dot(ap,n);let rate=dot(r.direction,n);
    if rate.abs()>1e-12{for side in [-1.,1.]{let t=(side*r.radius-distance)/rate;if t<0.||t>best{continue;}let p=add(add(r.origin,scale(r.direction,t)),scale(n,-side*r.radius));let v=sub(p,a);
        let d00=dot(ac,ac);let d01=dot(ac,ab);let d02=dot(ac,v);let d11=dot(ab,ab);let d12=dot(ab,v);let den=d00*d11-d01*d01;if den==0.{continue;}let inv=1./den;let u=(d11*d02-d01*d12)*inv;let v=(d00*d12-d01*d02)*inv;let w=1.-u-v;if w>=0.&&v>=0.&&w+v<=1.&&t<=best{best=t;hit=true;}
    }}
    for (k,j) in [(a,b),(b,c),(c,a)]{let offset=sub(r.origin,k);let reach=dot(offset,offset)-r.radius*r.radius;if let Some(t)=first_root(1.,dot(offset,r.direction),reach){if t<=best{best=t;hit=true;}}
        let edge=sub(j,k);let len=dot(edge,edge).sqrt();if len<1e-12{continue;}let edge=scale(edge,1./len);let along=dot(offset,edge);let speed=dot(r.direction,edge);let s=add(offset,scale(edge,-along));let w=add(r.direction,scale(edge,-speed));
        if let Some(t)=first_root(dot(w,w),dot(s,w),dot(s,s)-r.radius*r.radius){if along+t*speed>=0.&&along+t*speed<=len&&t<=best{best=t;hit=true;}}
    }if hit{Some(best)}else{None}
}
#[derive(Default)]
pub struct Queries {next:u32,chunks:HashMap<u32,Rc<Chunk>>,scenes:HashMap<u32,Rc<Scene>>,worlds:HashMap<u32,QueryWorld>}
impl Queries {
    pub fn require(&self,kind:u32,id:u32)->Outcome<()> {match kind {
        0=>Ok(()),1=>if self.scenes.contains_key(&id){Ok(())}else{Err("Unknown query snapshot".into())},
        2=>if self.worlds.contains_key(&id){Ok(())}else{Err("Unknown composed query snapshot".into())},
        _=>Err("Unknown query kind".into()),
    }}
    /// Shared ballistic query entry. Static aim traces retain the same inside probe
    /// as their host adapter; live shots use the composed, pose-fenced snapshot.
    pub fn flight_query(&mut self,kind:u32,id:u32,op:u32,d:&[f64],range:f64,physics:Option<&crate::physics::Physics>,out:&mut Vec<u8>)->Outcome<()> {
        match kind {
            0=>{out.clear();Ok(())},
            1=>{if op==4{let scene=self.scenes.get(&id).ok_or("Unknown query snapshot")?;let solid=QueryWorld::solid_scene(scene,vec(d,0),range,out);out.clear();number(out,solid as u8 as f64);Ok(())}else{self.run(id,op,d,out)}},
            2=>self.world_run(id,op,d,physics.ok_or("Engine physics is absent")?,out),
            _=>Err("Unknown flight query kind".into()),
        }
    }
    fn id(&mut self)->Outcome<u32>{self.next=self.next.checked_add(1).ok_or("Query ID space exhausted")?;Ok(self.next)}
    pub fn retain(&mut self,bytes:&[u8])->Outcome<u32>{let chunk=Chunk::read(bytes)?;if chunk.boxes.is_empty(){return Err("Empty native query chunk".into());}let id=self.id()?;self.chunks.insert(id,Rc::new(chunk));Ok(id)}
    pub fn scene(&mut self,ids:&[f64])->Outcome<u32>{let mut chunks=Vec::with_capacity(ids.len());for &id in ids{if !id.is_finite()||id.fract()!=0.{return Err("Invalid query ID".into());}chunks.push(self.chunks.get(&(id as u32)).ok_or("Unknown query chunk")?.clone());}let id=self.id()?;self.scenes.insert(id,Rc::new(Scene::new(chunks)));Ok(id)}
    pub fn release(&mut self,id:u32,kind:u32){match kind{2=>{self.worlds.remove(&id);},1=>{self.scenes.remove(&id);},_=>{self.chunks.remove(&id);}}}
    pub fn run(&self,id:u32,op:u32,d:&[f64],out:&mut Vec<u8>)->Outcome<()>{out.clear();let scene=self.scenes.get(&id).ok_or("Unknown query snapshot")?;match op{0..=2=>{if let Some(ray)=Ray::read(d,op==2){scene.ray(ray,op,out);}else if op==1{number(out,0.);}Ok(())},3=>scene.collect(d,out),_=>Err("Unknown query operation".into())}}
    pub fn world(&mut self,d:&[f64],physics:&crate::physics::Physics)->Outcome<u32>{
        if d.len()<2||d.len()%2!=0||d.iter().any(|x|!x.is_finite())||d[1]<=0.{return Err("Invalid composed query descriptor".into());}
        let scene=|id:f64|->Outcome<Rc<Scene>>{if id.fract()!=0.{return Err("Invalid query scene ID".into());}Ok(self.scenes.get(&(id as u32)).ok_or("Unknown query snapshot")?.clone())};
        let fixed=scene(d[0])?;let mut bodies=Vec::new();
        for pair in d[2..].chunks_exact(2){if pair[1]<0.||pair[1]>u32::MAX as f64||pair[1].fract()!=0.{return Err("Invalid physics query body".into());}let body=pair[1] as u32;physics.body_pose(body)?;bodies.push(QueryBody::new(scene(pair[0])?,body));}
        let id=self.id()?;self.worlds.insert(id,QueryWorld{fixed,bodies,held:false,solid_range:d[1],scratch:Vec::with_capacity(8*14)});Ok(id)
    }
    pub fn world_sync(&mut self,id:u32,physics:&crate::physics::Physics)->Outcome<bool>{let world=self.worlds.get_mut(&id).ok_or("Unknown composed query snapshot")?;let changed=world.load(physics)?;world.held=true;Ok(changed)}
    pub fn world_run(&mut self,id:u32,op:u32,d:&[f64],physics:&crate::physics::Physics,out:&mut Vec<u8>)->Outcome<()>{let world=self.worlds.get_mut(&id).ok_or("Unknown composed query snapshot")?;if !world.held{world.load(physics)?;}world.run(op,d,out)}
}

// Body transforms use the same quaternion-vector operation order as the host.
fn rotate(v:V,q:[f64;4])->V {let [x,y,z,w]=q;let [a,b,c]=v;let tx=2.*(y*c-z*b);let ty=2.*(z*a-x*c);let tz=2.*(x*b-y*a);[a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx]}
fn word(d:&[u8],i:usize)->f64{f64::from_le_bytes(d[i*8..i*8+8].try_into().unwrap())}
fn read_vector(d:&[u8],i:usize)->V{[word(d,i),word(d,i+1),word(d,i+2)]}
const SANE:f64=1e6;
const PROBE:V=[0.8192319,0.3721373,0.4361951];
struct QueryBody {scene:Rc<Scene>,body:u32,pose:[f64;7],read:bool,min:V,max:V,center:V,radius:f64,bounded:bool,near:bool,world:V,reach:f64,probe:V}
impl QueryBody {
    fn new(scene:Rc<Scene>,body:u32)->Self{let b=scene.top.first().map(|n|n.bounds).unwrap_or([0.;6]);let min=[b[0],b[1],b[2]];let max=[b[3],b[4],b[5]];let center=scale(add(min,max),0.5);let radius=length(sub(max,min))*0.5;let bounded=scene.chunks.len()<=8192&&b.iter().all(|x|x.abs()<=SANE);Self{scene,body,pose:[0.,0.,0.,0.,0.,0.,1.],read:false,min,max,center,radius,bounded,near:false,world:[0.;3],reach:0.,probe:[0.;3]}}
    fn position(&self)->V{[self.pose[0],self.pose[1],self.pose[2]]}
    fn rotation(&self)->[f64;4]{[self.pose[3],self.pose[4],self.pose[5],self.pose[6]]}
    fn inverse(&self)->[f64;4]{[-self.pose[3],-self.pose[4],-self.pose[5],self.pose[6]]}
    fn local(&self,v:V)->V{rotate(sub(v,self.position()),self.inverse())}
    fn load(&mut self,physics:&crate::physics::Physics)->Outcome<bool>{
        let p=physics.body_pose(self.body)?;let changed=!self.read||p.iter().zip(self.pose).any(|(a,b)|a.to_bits()!=b.to_bits());self.pose=p;self.read=true;
        let q=self.rotation();self.near=self.bounded&&(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]-1.).abs()<=1e-5&&self.position().iter().all(|x|x.abs()<=SANE);
        if self.near{self.world=add(self.position(),rotate(self.center,q));self.reach=self.radius*1.0001+1e-4*length(self.center)+1e-5;self.probe=rotate(scale(PROBE,1./length(PROBE)),q);}Ok(changed)
    }
    fn clear(&self,o:V,u:V,len:f64,extra:f64)->bool{if self.scene.chunks.is_empty(){return true;}let w=sub(self.world,o);let along=dot(w,u);let t=if along<0.{0.}else if along>len{len}else{along};let e=sub(w,scale(u,t));let reach=self.reach+extra;dot(e,e)>reach*reach}
    fn apart(&self,center:V,rho:f64)->bool{if self.scene.chunks.is_empty(){return true;}let p=self.local(center);let h=rho*1.0001+1e-5;(0..3).any(|i|self.min[i]>p[i]+h||self.max[i]<p[i]-h)}
}
struct QueryWorld {fixed:Rc<Scene>,bodies:Vec<QueryBody>,held:bool,solid_range:f64,scratch:Vec<u8>}
impl QueryWorld {
    fn load(&mut self,physics:&crate::physics::Physics)->Outcome<bool>{let mut changed=false;for b in &mut self.bodies{changed|=b.load(physics)?;}Ok(changed)}
    fn ray(&mut self,d:&[f64],op:u32,out:&mut Vec<u8>){
        out.clear();let Some(ray)=Ray::read(d,op==2)else{if op==1{number(out,0.);}return;};let origin=ray.origin;let direction=vec(d,3);let n=length(direction);let unit=scale(direction,1./n);let radius=ray.radius;
        let usable=n>=1e-12&&n<=SANE&&origin.iter().all(|x|x.abs()<=SANE)&&d[6]<=SANE&&(op!=2||radius<=SANE);
        self.fixed.ray(ray,op,out);if op==1&&word(out,0)!=0.{return;}
        for b in &self.bodies{let limit=if op!=1&&!out.is_empty(){word(out,0)}else{d[6]};if usable&&b.near&&b.clear(origin,unit,limit*1.0001+1e-5,if op==2{radius*1.0001}else{0.}){continue;}
            let o=b.local(origin);let v=rotate(direction,b.inverse());let args=[o[0],o[1],o[2],v[0],v[1],v[2],limit,radius];self.scratch.clear();if let Some(r)=Ray::read(&args[..if op==2{8}else{7}],op==2){b.scene.ray(r,op,&mut self.scratch);}
            if self.scratch.is_empty(){continue;}if op==1{if word(&self.scratch,0)!=0.{out.clear();number(out,1.);return;}continue;}
            out.clear();number(out,word(&self.scratch,0));if op==0{write(out,add(b.position(),rotate(read_vector(&self.scratch,1),b.rotation())));write(out,rotate(read_vector(&self.scratch,4),b.rotation()));number(out,word(&self.scratch,7));}
        }
    }
    fn solid_scene(scene:&Scene,p:V,range:f64,scratch:&mut Vec<u8>)->bool{scratch.clear();let d=[p[0],p[1],p[2],PROBE[0],PROBE[1],PROBE[2],range];if let Some(ray)=Ray::read(&d,false){scene.ray(ray,0,scratch);}!scratch.is_empty()&&(word(scratch,0)<1e-6||dot(read_vector(scratch,4),PROBE)>0.)}
    fn solid(&mut self,p:V)->bool{if Self::solid_scene(&self.fixed,p,self.solid_range,&mut self.scratch){return true;}let usable=p.iter().all(|x|x.abs()<=SANE);for b in &self.bodies{if usable&&b.near&&b.clear(p,b.probe,self.solid_range*1.0001+1e-5,1e-2){continue;}if Self::solid_scene(&b.scene,b.local(p),self.solid_range,&mut self.scratch){return true;}}false}
    fn collect(&mut self,d:&[f64],out:&mut Vec<u8>)->Outcome<()>{
        out.clear();self.fixed.collect(d,out)?;let lo=vec(d,0);let hi=vec(d,3);let center=scale(add(lo,hi),0.5);let rho=length(sub(hi,lo))*0.5;let usable=center.iter().all(|x|x.abs()<=SANE)&&rho<=SANE;
        for b in &self.bodies{if word(out,0)!=0.{return Ok(());}if usable&&b.near&&b.apart(center,rho){continue;}let mut min=[f64::INFINITY;3];let mut max=[f64::NEG_INFINITY;3];
            for mask in 0..8{let p=b.local([if mask&1!=0{hi[0]}else{lo[0]},if mask&2!=0{hi[1]}else{lo[1]},if mask&4!=0{hi[2]}else{lo[2]}]);for i in 0..3{min[i]=min[i].min(p[i]);max[i]=max[i].max(p[i]);}}
            let remaining=d[6] as usize-(out.len()/8-1)/13;let args=[min[0],min[1],min[2],max[0],max[1],max[2],remaining.max(1) as f64];self.scratch.clear();b.scene.collect(&args,&mut self.scratch)?;
            if word(&self.scratch,0)!=0.||remaining==0&&self.scratch.len()>8{out[..8].copy_from_slice(&1f64.to_le_bytes());}if remaining==0&&self.scratch.len()>8{return Ok(());}
            for row in self.scratch[8..].chunks_exact(13*8){for i in [0,3,6]{write(out,add(b.position(),rotate(read_vector(row,i),b.rotation())));}write(out,rotate(read_vector(row,9),b.rotation()));number(out,word(row,12));}
        }Ok(())
    }
    fn run(&mut self,op:u32,d:&[f64],out:&mut Vec<u8>)->Outcome<()>{out.clear();match op{0..=2=>self.ray(d,op,out),3=>return self.collect(d,out),4=>{if d.len()!=3{return Err("Invalid solid query".into());}let hit=self.solid(vec(d,0));number(out,if hit{1.}else{0.});},5=>{if d.len()!=3{return Err("Invalid surface query".into());}let v=vec(d,0);let n=length(v);if n>0.&&n.is_finite(){let distance=self.solid_range/4.*3f64.sqrt()+1.;self.ray(&[v[0]*distance/n,v[1]*distance/n,v[2]*distance/n,-v[0],-v[1],-v[2],2.*distance],0,out);}},_=>return Err("Unknown composed query operation".into())}Ok(())}
}
