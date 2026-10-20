//! Authoritative combat state. ABI 1 batches entity observations at a hit/impact;
//! health, charge, ammunition and spent armor never round-trip as step inputs.
use std::collections::HashMap;
use crate::{core::Outcome, physics::Physics, traversal::Queries};
type V = [f64; 3];
fn v(d:&[f64],i:usize)->V {[d[i],d[i+1],d[i+2]]}
fn sub(a:V,b:V)->V {[a[0]-b[0],a[1]-b[1],a[2]-b[2]]}
fn dot(a:V,b:V)->f64 {a[0]*b[0]+a[1]*b[1]+a[2]*b[2]}
// Preserve the host's three-argument hypot compensation and operation order.
// https://github.com/v8/v8/blob/main/src/builtins/math.tq (FastMathHypot)
fn length(a:V)->f64 {let m=a[0].abs().max(a[1].abs()).max(a[2].abs());if m==0.{0.}else{let b=[a[0]/m,a[1]/m,a[2]/m];let x=b[0]*b[0];let y=b[1]*b[1];let correction=((x+y)-x)-y;(x+y+(b[2]*b[2]-correction)).sqrt()*m}}
fn horizontal(x:f64,z:f64)->f64 {let m=x.abs().max(z.abs());if m==0.{0.}else{let a=x/m;let b=z/m;(a*a+b*b).sqrt()*m}}
fn normal(a:V)->V {let n=length(a);if n>1e-10{let s=1./n;[a[0]*s,a[1]*s,a[2]*s]}else{[0.,1.,0.]}}
fn integer(x:f64)->bool {x>=0.&&x<=9007199254740991.&&x.fract()==0.}
fn flag(x:f64)->bool {x==0.||x==1.}
fn valid(d:&[f64],n:usize)->Outcome<()> {if d.len()!=n||d.iter().any(|x|!x.is_finite()){Err("Invalid combat descriptor".into())}else{Ok(())}}
fn write(out:&mut Vec<u8>,d:&[f64]) {out.clear();for n in d{out.extend_from_slice(&n.to_le_bytes());}}
fn index(x:f64,n:usize)->Outcome<usize>{if !integer(x)||x>=n as f64{Err("Unknown combat unit".into())}else{Ok(x as usize)}}
#[derive(Clone)]
pub struct Unit {pub team:f64,pub health:f64,pub charge:f64,reactive:u8,ammo:[f64;4],mass:f64,mitigation:f64,equipped:bool}
impl Unit {
    fn read(d:&[f64])->Outcome<Self>{
        valid(d,11)?;
        if !integer(d[0])||d[1]<0.||d[2]<0.||!integer(d[3])||d[3]>15.||d[4..8].iter().any(|&a|a != -1.&&!integer(a))||d[8]<=0.||d[9]<0.||!flag(d[10]){return Err("Invalid combat unit".into());}
        Ok(Self{team:d[0],health:d[1],charge:d[2],reactive:d[3] as u8,ammo:[d[4],d[5],d[6],d[7]],mass:d[8],mitigation:d[9],equipped:d[10]==1.})
    }
}
pub struct Combat {pub units:Vec<Unit>,pub sandbox:bool,friendly:bool,radius:f64,nuke:f64,blast_reduction:f64,rail_reduction:f64,radar:f64,scratch:Vec<u8>}
impl Combat {
    pub(crate) fn canonical(&self,w:&mut crate::canonical::Writer){
        w.flag(self.sandbox);w.flag(self.friendly);w.words(&[self.radius,self.nuke,self.blast_reduction,self.rail_reduction,self.radar]);
        w.list(&self.units,|w,u|{w.words(&[u.team,u.health,u.charge,u.reactive as f64,u.mass,u.mitigation]);w.words(&u.ammo);w.flag(u.equipped);});
    }
}
#[derive(Default)]
pub struct Combats {next:u32,states:HashMap<u32,Combat>}
impl Combats {
    pub fn get(&self,id:u32)->Outcome<&Combat>{self.states.get(&id).ok_or("Unknown resident combat".into())}
    pub fn get_mut(&mut self,id:u32)->Outcome<&mut Combat>{self.states.get_mut(&id).ok_or("Unknown resident combat".into())}
    pub fn create(&mut self,d:&[f64])->Outcome<u32>{
        if d.len()<9||!integer(d[8])||d[8]<1.||d[8]>64.{return Err("Invalid combat unit count".into());}valid(d,9+d[8] as usize*11)?;
        if d[0]!=1.||!flag(d[1])||!flag(d[2])||d[3]<=0.||d[4]<0.||!(0. ..=1.).contains(&d[5])||!(0. ..=1.).contains(&d[6])||d[7]<0.{return Err("Invalid combat rules".into());}
        let units=d[9..].chunks_exact(11).map(Unit::read).collect::<Outcome<Vec<_>>>()?;
        self.next=self.next.checked_add(1).ok_or("Combat handles exhausted")?;
        self.states.insert(self.next,Combat{units,sandbox:d[1]==1.,friendly:d[2]==1.,radius:d[3],nuke:d[4],blast_reduction:d[5],rail_reduction:d[6],radar:d[7],scratch:Vec::new()});Ok(self.next)
    }
    pub fn remove(&mut self,id:u32){self.states.remove(&id);}
    pub fn command(&mut self,id:u32,op:u32,d:&[f64],queries:&mut Queries,physics:Option<&Physics>,out:&mut Vec<u8>)->Outcome<()>{
        let c=self.get_mut(id)?;let mut result=Vec::new();
        match op {
            0=>{valid(d,0)?;},
            1|2=>{
                valid(d,if op==1{2}else{1})?;let id=index(d[0],c.units.len())?;
                if op==1&&d[1]<=0.{return Err("Invalid combat damage".into());}
                let u=&mut c.units[id];let before=u.health;
                if !c.sandbox&&before>0.{u.health=if op==2{0.}else{(before-d[1]).max(0.)};}
                result.push((before>0.&&u.health==0.) as u8 as f64);
            }
            // Kit edits retain ammunition/armor state; resetHealth=-1 preserves hp.
            3=>{
                if d.is_empty()||!integer(d[0])||d[0]>64.{return Err("Invalid combat kit batch".into());}valid(d,1+d[0] as usize*5)?;
                let mut ids=Vec::new();for r in d[1..].chunks_exact(5){let id=index(r[0],c.units.len())?;if ids.contains(&id)||r[1]<=0.||r[2]<0.||!flag(r[3])||(r[4]<0.&&r[4]!= -1.){return Err("Invalid combat kit".into());}ids.push(id);}
                for (r,id) in d[1..].chunks_exact(5).zip(ids){let u=&mut c.units[id];u.mass=r[1];u.mitigation=r[2];u.equipped=r[3]==1.;if r[4]>=0.{u.health=r[4];}}
            }
            4|5=>{
                valid(d,if op==4{2}else{1})?;let id=index(d[0],c.units.len())?;let u=&mut c.units[id];
                let accepted=if op==4{let ammo=index(d[1],4)?;let ok=c.sandbox||(u.health>0.&&u.ammo[ammo]!=0.&&(ammo!=3||u.charge>=c.nuke));if ok&&!c.sandbox{if u.ammo[ammo]>=0.{u.ammo[ammo]-=1.;}if ammo==3{u.charge-=c.nuke;}}ok}
                    else{let ok=u.charge>=c.radar&&(c.sandbox||u.health>0.);if ok{u.charge-=c.radar;}ok};result.push(accepted as u8 as f64);
            }
            6=>{result=c.impact(d,queries,physics)?;},
            7=>{let r=c.resolve(d)?;write(out,&r);return Ok(());},
            // Explicit state admission for checkpoint restoration/tooling. Never
            // used to import host snapshots in an ordinary tick or impact.
            8=>{valid(d,12)?;let id=index(d[0],c.units.len())?;let u=Unit::read(&d[1..])?;c.units[id]=u;},
            _=>return Err("Unknown combat command".into()),
        }
        result.push(c.units.len() as f64);
        for u in &c.units {result.extend_from_slice(&[u.team,u.health,u.charge,u.reactive as f64,u.ammo[0],u.ammo[1],u.ammo[2],u.ammo[3]]);}
        write(out,&result);Ok(())
    }
}
impl Combat {
    pub(crate) fn radar_cost(&self)->f64 {self.radar}
    pub fn available(&self,id:usize,ammo:usize)->bool {self.sandbox||self.units[id].ammo[ammo]!=0.}
    pub fn can_spend(&self,id:usize,ammo:usize)->bool {self.sandbox||(self.units[id].health>0.&&self.available(id,ammo)&&(ammo!=3||self.units[id].charge>=self.nuke))}
    pub fn spend(&mut self,id:usize,ammo:usize){if !self.sandbox {let u=&mut self.units[id];if u.ammo[ammo]>=0.{u.ammo[ammo]-=1.;}if ammo==3{u.charge-=self.nuke;}}}
    pub fn can_scan(&self,id:usize)->bool {self.units[id].charge>=self.radar&&(self.sandbox||self.units[id].health>0.)}
    pub fn scan(&mut self,id:usize){self.units[id].charge-=self.radar;}
    fn armor(&self,u:&Unit,position:V,q:&[f64],point:V,direct:bool,rail:bool,nuclear:bool)->(usize,u8,f64){
        let p=sub(point,position);let [x,y,z,w]=[-q[0],-q[1],-q[2],q[3]];
        let tx=2.*(y*p[2]-z*p[1]);let ty=2.*(z*p[0]-x*p[2]);let tz=2.*(x*p[1]-y*p[0]);
        let p=[p[0]+w*tx+y*tz-z*ty,p[1]+w*ty+z*tx-x*tz,p[2]+w*tz+x*ty-y*tx];
        let section=if p[1]>horizontal(p[0],p[2])*0.8{4}else if p[2].abs()>=p[0].abs(){if p[2]>=0.{0}else{3}}else if p[0]>=0.{1}else{2};
        let directional=match section{0=>1.5,3=>0.45,4=>0.3,_=>1.};let mitigation=(u.mitigation*if direct{directional}else{1.}).min(0.55);
        let mut spent=0;let mut reduction=0.;
        if direct&&section!=4&&p[1]>=-0.15&&p[1]<=0.3&&!nuclear&&u.equipped{let bit=1<<section;if u.reactive&bit==0{spent=bit;reduction=if rail{self.rail_reduction}else{self.blast_reduction};}}
        (section,spent,(1.-mitigation)*(1.-reduction))
    }
    fn impact(&mut self,d:&[f64],queries:&mut Queries,physics:Option<&Physics>)->Outcome<Vec<f64>>{
        valid(d,15+self.units.len()*11)?;let owner=index(d[0],self.units.len())?;
        if d[1]!=-1.{index(d[1],self.units.len())?;}
        if d[2]<0.||d[3]<0.||!flag(d[4])||!flag(d[5])||!integer(d[12])||d[12]>2.||!integer(d[13])||d[13]>u32::MAX as f64||d[14]<=0.{return Err("Invalid combat impact".into());}
        if d[15..].chunks_exact(11).any(|r|!flag(r[10])){return Err("Invalid combat obstruction".into());}
        let point=v(d,6);let n=v(d,9);let start=[point[0]+n[0]*0.08,point[1]+n[1]*0.08,point[2]+n[2]*0.08];
        let mut next=self.units.clone();let mut result=vec![0.];
        for (id,r) in d[15..].chunks_exact(11).enumerate(){
            let u=&self.units[id];let position=v(r,0);let direct=d[1]==id as f64;
            let mut exposure=if direct{1.}else{(1.-length(sub(point,position))/(d[2]*1.65+self.radius)).clamp(0.,1.)};if exposure<=0.{continue;}
            let mut blocked=r[10]!=0.;
            if d[12]!=0.{let delta=sub(position,start);let dir=normal(delta);let reach=(length(delta)-self.radius).max(0.);
                queries.flight_query(d[12] as u32,d[13] as u32,1,&[start[0],start[1],start[2],dir[0],dir[1],dir[2],reach],d[14],physics,&mut self.scratch)?;
                blocked=f64::from_le_bytes(self.scratch[..8].try_into().unwrap())!=0.;}
            if blocked&&!direct{exposure*=0.35;}
            let spared=!self.friendly&&u.team==self.units[owner].team&&id!=owner;let can_damage=!self.sandbox&&!spared&&u.health>0.;
            let (section,spent,multiplier)=self.armor(u,position,&r[3..7],point,direct,d[4]==1.,d[5]==1.);
            let target=&mut next[id];if can_damage{target.health=(u.health-(d[3]*exposure*multiplier).round().max(1.)).max(0.);target.reactive=(u.reactive|spent)&15;}
            let dir=normal(sub(position,point));let force=exposure*25./u.mass;let vel=v(r,7);
            result[0]+=1.;result.extend_from_slice(&[id as f64,u.health-target.health,exposure,direct as u8 as f64,(u.health>0.&&target.health==0.) as u8 as f64,section as f64,if can_damage{spent as f64}else{0.},vel[0]+dir[0]*force,vel[1]+dir[1]*force,vel[2]+dir[2]*force]);
        }
        self.units=next;Ok(result)
    }
    fn resolve(&self,d:&[f64])->Outcome<Vec<f64>>{
        valid(d,24+self.units.len()*3)?;let owner=index(d[8],self.units.len())?;
        if d[6]<0.||d[7]<0.||!flag(d[9])||!flag(d[10])||d[14]<=0.||!flag(d[15]){return Err("Invalid combat segment".into());}
        let from=v(d,0);let dir=v(d,3);let mut hit=if d[15]==1.{Some(d[16..24].to_vec())}else{None};let mut selected=false;let mut victim=-1.;
        let replace=|center:V,radius:f64,hit:&mut Option<Vec<f64>>|->bool{let o=sub(from,center);let b=dot(o,dir);let c=dot(o,o)-radius*radius;let at=if c<=0.{Some(0.)}else{let disc=b*b-c;if disc<0.{None}else{let t=-b-disc.sqrt();if t>=0.&&t<=d[6]{Some(t)}else{None}}};
            if let Some(at)=at{if hit.as_ref().map_or(true,|h|at<h[0]){let p=[from[0]+dir[0]*at,from[1]+dir[1]*at,from[2]+dir[2]*at];let n=normal(sub(p,center));*hit=Some(vec![at,p[0],p[1],p[2],n[0],n[1],n[2],0.]);return true;}}false};
        if d[10]==1.{selected=replace(v(d,11),d[14],&mut hit);}
        if d[9]==1.{for (id,u) in self.units.iter().enumerate(){if u.health<=0.||(id==owner&&d[7]<0.3){continue;}if replace(v(d,24+id*3),self.radius,&mut hit){victim=id as f64;}}}
        let mut out=vec![victim,selected as u8 as f64];if let Some(h)=hit{out.extend(h);}Ok(out)
    }
}
