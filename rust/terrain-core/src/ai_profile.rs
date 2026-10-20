//! Personality controllers retain all decision state in the engine. The host
//! services observation-only trace/query/kit requests and never scores a plan.
use std::collections::HashMap;
use crate::{core::Outcome, match_state::Matches, combat::Combats, bot_trace::{self, Trace}, flight::Flights, traversal::Queries, physics::Physics};
mod belief;
mod search;
mod relocation;
mod canonical;
use belief::Belief;
use search::{Aim, Search};
use relocation::{Pursuit, Relocation};
type V = [f64; 3];
fn v(d:&[f64],i:usize)->V { [d[i],d[i+1],d[i+2]] }
fn add(a:V,b:V)->V { [a[0]+b[0],a[1]+b[1],a[2]+b[2]] }
fn sub(a:V,b:V)->V { [a[0]-b[0],a[1]-b[1],a[2]-b[2]] }
fn mul(a:V,s:f64)->V { [a[0]*s,a[1]*s,a[2]*s] }
fn dot(a:V,b:V)->f64 { a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
fn cross(a:V,b:V)->V { [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]] }
fn len(a:V)->f64 {
    let m=a[0].abs().max(a[1].abs()).max(a[2].abs());if m==0. {return 0.;}
    let x=(a[0]/m)*(a[0]/m);let y=(a[1]/m)*(a[1]/m);let z=(a[2]/m)*(a[2]/m);
    (x+y+(z-((x+y)-x-y))).sqrt()*m
}
fn norm(a:V)->V { let n=len(a);if n>1e-10 {mul(a,1./n)} else {[0.,1.,0.]} }
fn tangent(a:V,up:V)->V { sub(a,mul(up,dot(a,up))) }
fn wrap(a:f64)->f64 { a.sin().atan2(a.cos()) }
fn rotate(a:V,q:[f64;4])->V {
    let [x,y,z,w]=q;let tx=2.*(y*a[2]-z*a[1]);let ty=2.*(z*a[0]-x*a[2]);let tz=2.*(x*a[1]-y*a[0]);
    [a[0]+w*tx+y*tz-z*ty,a[1]+w*ty+z*tx-x*tz,a[2]+w*tz+x*ty-y*tx]
}
fn frame(up:V)->(V,V) {
    let up=norm(up);let reference=if up[2].abs()<0.96 {[0.,0.,1.]} else {[1.,0.,0.]};
    let base=norm(tangent(reference,up));let right=norm(cross(up,base));
    let forward=add(mul(base,1.),mul(right,0.));(norm(cross(up,forward)),forward)
}
fn bearing(position:V,rotation:[f64;4],point:V)->f64 {
    let d=sub(point,position);dot(d,rotate([1.,0.,0.],rotation)).atan2(dot(d,rotate([0.,0.,1.],rotation)))
}
fn integer(x:f64)->bool { x>=0.&&x<=9007199254740991.&&x.fract()==0. }
fn flag(x:f64)->bool { x==0.||x==1. }
fn valid(d:&[f64],n:usize)->Outcome<()> {if d.len()!=n||d.iter().any(|x|!x.is_finite()){Err("Invalid personality descriptor".into())}else{Ok(())}}
fn write(out:&mut Vec<u8>,d:&[f64]) {out.clear();for n in d {out.extend_from_slice(&n.to_le_bytes());}}
#[derive(Clone)]
struct Params { profile:u8,reaction:f64,sigma:[f64;3],bracket:f64,candidates:usize,refine:usize,min_pitch:f64,max_pitch:f64,
    relocate:[f64;4],random_relocate:bool,forget:f64,scan:f64 }
struct Random {state:u32,spare:Option<f64>}
impl Random {
    fn next(&mut self)->f64 {
        self.state=self.state.wrapping_add(0x6d2b79f5);let mut t=self.state;
        t=(t^(t>>15)).wrapping_mul(t|1);t^=t.wrapping_add((t^(t>>7)).wrapping_mul(t|61));
        (t^(t>>14)) as f64/4294967296.
    }
    fn gaussian(&mut self)->f64 {
        if let Some(x)=self.spare.take(){return x;}
        let u=self.next().max(1e-12);let v=self.next();let radius=(-2.*u.ln()).sqrt();let angle=2.*std::f64::consts::PI*v;
        self.spare=Some(radius*angle.sin());radius*angle.cos()
    }
}
#[derive(Clone)]
struct Contact {tank:f64,team:f64,visible:bool,at:f64,uncertainty:f64,p:V}
#[derive(Clone)]
struct Observation {tick:f64,time:f64,budget:f64,team:f64,charge:f64,radar:f64,p:V,q:[f64;4],yaw:f64,pitch:f64,
    radius:f64,fuel:f64,speed:f64,gravity:f64,blast:f64,damage:f64,impact:Option<(f64,V)>,sound:Option<(f64,f64)>,contacts:Vec<Contact>}
impl Observation {
    fn read(d:&[f64])->Outcome<Self> {
        if d.len()<31||!integer(d[30])||d[30]>128.{return Err("Invalid personality contacts".into());}valid(d,31+d[30] as usize*8)?;
        if !integer(d[0])||d[1]<0.||!integer(d[2])||!integer(d[3])||d[4]<0.||d[5]<0.||d[16]<=0.||d[17]<0.||d[18]<0.||d[19]<0.||d[20]<0.||d[21]<0.||!flag(d[22])||!flag(d[27])
            ||d[31..].chunks_exact(8).any(|r|!integer(r[0])||!integer(r[1])||!flag(r[2])||r[4]<0.) {return Err("Invalid personality observation".into());}
        Ok(Self {tick:d[0],time:d[1],budget:d[2],team:d[3],charge:d[4],radar:d[5],p:v(d,6),q:[d[9],d[10],d[11],d[12]],yaw:d[14],pitch:d[15],
            radius:d[16],fuel:d[17],speed:d[18],gravity:d[19],blast:d[20],damage:d[21],impact:if d[22]==1.{Some((d[23],v(d,24)))}else{None},
            sound:if d[27]==1.{Some((d[28],d[29]))}else{None},contacts:d[31..].chunks_exact(8).map(|r|Contact{tank:r[0],team:r[1],visible:r[2]==1.,at:r[3],uncertainty:r[4],p:v(r,5)}).collect()})
    }
    fn allies(&self)->Vec<V> {self.contacts.iter().filter(|c|c.visible&&c.team==self.team).map(|c|c.p).collect()}
}
struct Bracket {tank:f64,reference:V,range:f64,lateral:f64,shots:u32,last:Option<(V,V)>,seen:f64}
#[derive(Clone,Copy,PartialEq)]
enum Stage {Target,Search,Check,RelocateInit,Relocate,Ready}
#[derive(Clone,Copy)]
enum Purpose {Target,Relocation}
#[derive(Clone,Copy)]
enum PitchPurpose {Search,Probe,Final,Retry}
#[derive(Clone,Copy)]
enum Pending {Heard(Purpose,V),Aim(V),Pitch(PitchPurpose,f64),Surface,Ray,Trace(bool)}
struct Check {attempts:u8,best:Aim,trace:u64,launch:f64}
struct Personality {
    owner:u32,unit:Option<usize>,params:Params,random:Random,turns:u64,bracket:Option<Bracket>,pursuit:Option<Pursuit>,stage:Stage,observation:Option<Observation>,
    target:Option<Belief>,aim_point:Option<V>,search:Option<Search>,final_aim:Option<Aim>,check:Option<Check>,relocation:Option<Relocation>,scanned:bool,
    pending:Option<Pending>,serial:u64,trace_serial:u64,active_trace:u64,trace:Option<Trace>,
}
#[derive(Default)]
pub struct Profiles {next:u32,states:HashMap<u32,Personality>}
impl Profiles {
    pub fn create(&mut self,d:&[f64],matches:&Matches)->Outcome<u32> {
        let linked=d.first()==Some(&2.);valid(d,if linked{21}else{20})?;
        if (!linked&&d[0]!=1.)||!integer(d[1])||d[1]>u32::MAX as f64||!integer(d[2])||d[2]>u32::MAX as f64||!integer(d[3])||d[3]>3.||d[4..9].iter().any(|&x|x<0.)||d[8]>1.
            ||!integer(d[9])||d[9]<4.||d[9]>128.||!integer(d[10])||d[10]>128.||d[12]<d[11]||d[13]<0.||d[14]<d[13]||!flag(d[17])||(d[18]<0.&&d[18]!= -1.)||(d[19]!= -1.&&(!integer(d[19])||d[19]<1.)){return Err("Invalid personality rules".into());}
        matches.require_random(d[1] as u32)?;
        let unit=if linked{Some(matches.require_unit(d[1] as u32,d[20])?)}else{None};
        let params=Params {profile:d[3] as u8,reaction:d[4],sigma:[d[5],d[6],d[7]],bracket:d[8],candidates:d[9] as usize,refine:d[10] as usize,min_pitch:d[11],max_pitch:d[12],
            relocate:[d[13],d[14],d[15],d[16]],random_relocate:d[17]==1.,forget:d[18],scan:d[19]};
        self.next=self.next.checked_add(1).ok_or("Personality handles exhausted")?;
        self.states.insert(self.next,Personality {owner:d[1] as u32,unit,params,random:Random {state:d[2] as u32,spare:None},turns:0,bracket:None,pursuit:None,stage:Stage::Target,observation:None,
            target:None,aim_point:None,search:None,final_aim:None,check:None,relocation:None,scanned:false,pending:None,serial:0,trace_serial:0,active_trace:0,trace:None});Ok(self.next)
    }
    pub fn remove(&mut self,id:u32){self.states.remove(&id);}
    pub(crate) fn require_bound(&self,id:u32,owner:u32,unit:usize)->Outcome<()> {match self.states.get(&id) {Some(b) if b.owner==owner&&b.unit==Some(unit)=>Ok(()),_=>Err("Controller is not bound to the active unit".into())}}
    /// v16 resident step of a bound controller. Surface, ray, trace and canonical
    /// elevation requests are serviced in the engine; only a custom kit's
    /// elevation callback returns to the host (mode 1 resumes with its limits).
    pub fn resident(&mut self,id:u32,d:&[f64],matches:&mut Matches,combats:&Combats,flights:&mut Flights,queries:&mut Queries,physics:Option<&Physics>,out:&mut Vec<u8>)->Outcome<()> {
        let b=self.states.get_mut(&id).ok_or("Unknown resident personality")?;matches.require_random(b.owner)?;
        let unit=b.unit.ok_or("Resident execution requires a bound personality")?;let lease=bot_trace::lease(d)?;let owner=b.owner;
        let mut words=match d.get(3) {
            Some(&m) if m==0. => {valid(d,4)?;if b.pending.is_some(){return Err("Personality request still pending".into());}
                let o=Observation::read(&matches.bot_observation(owner,unit,Some(matches.meter_remaining(owner)?),combats)?)?;b.learn(o.impact);b.observation=Some(o);b.run()},
            Some(&m) if m==1. => {valid(d,7)?;if !matches!(b.pending,Some(Pending::Pitch(..))){return Err("No elevation request pending".into());}b.respond(&[d[4],matches.meter_remaining(owner)?,d[5],d[6]])?},
            _=>return Err("Invalid resident personality step".into()),
        };
        loop {
            if b.serial>=9007199254740990||b.trace_serial>=9007199254740990 {return Err("Personality request IDs exhausted".into());}
            let reply:Vec<f64>=match words[0] as u8 {
                4=>{let Some(l)=matches.bot_pitch_limits(owner,unit,words[2])? else {break};l.to_vec()},
                5=>{matches.meter_charge(owner,1.,true)?;bot_trace::query(queries,&lease,5,&words[2..5],physics)?.map_or(vec![0.;7],|h|[&[1.][..],&h[1..7]].concat())},
                6=>{matches.meter_charge(owner,1.,true)?;vec![bot_trace::query(queries,&lease,0,&words[2..9],physics)?.is_some() as u8 as f64]},
                7=>{
                    if b.trace.as_ref().map_or(true,|t|t.id!=words[2]){b.trace=Some(Trace::new(matches,owner,unit,[words[3],words[4],words[5]],Some(words[6]),words[2])?);}
                    if words[7]==1. {vec![0.;7]}else{
                        let t=b.trace.as_mut().unwrap();let (mut steps,mut blocked)=(0.,false);
                        while !t.done&&steps<256. {if t.step(matches,owner,flights,queries,physics,&lease)?.is_none(){blocked=true;break;}steps+=1.;}
                        let i=t.impact;vec![steps,t.done as u8 as f64,i.is_some() as u8 as f64,i.map_or(0.,|p|p[0]),i.map_or(0.,|p|p[1]),i.map_or(0.,|p|p[2]),blocked as u8 as f64]
                    }
                },
                _=>break,
            };
            let mut r=vec![words[1],matches.meter_remaining(owner)?];r.extend(reply);words=b.respond(&r)?;
        }
        words.push(matches.bot_ammo(owner,unit)?);write(out,&words);Ok(())
    }
    pub fn remove_match(&mut self,owner:u32){self.states.retain(|_,b|b.owner!=owner);}
    pub fn command(&mut self,id:u32,op:u32,d:&[f64],matches:&Matches,combats:&Combats,out:&mut Vec<u8>)->Outcome<()> {
        let b=self.states.get_mut(&id).ok_or("Unknown resident personality")?;matches.require_random(b.owner)?;
        if b.serial>=9007199254740990||b.trace_serial>=9007199254740990 {return Err("Personality request IDs exhausted".into());}
        let ammo=b.unit.map(|unit|matches.bot_ammo(b.owner,unit)).transpose()?;
        let resident;
        let d=if let Some(unit)=b.unit {match op {
            0=>{valid(d,0)?;resident=matches.bot_begin(b.owner,unit)?;&resident},
            1=>{valid(d,1)?;resident=matches.bot_observation(b.owner,unit,Some(d[0]),combats)?;&resident},
            3=>{valid(d,0)?;resident=matches.bot_drive(b.owner,unit,true)?;&resident},_=>d,
        }}else{d};
        let mut words=match op {
            0=>{valid(d,5)?;if !flag(d[0]){return Err("Invalid personality impact".into());}
                b.turns+=1;b.stage=Stage::Target;b.target=None;b.aim_point=None;b.search=None;b.final_aim=None;b.check=None;b.relocation=None;b.scanned=false;b.pending=None;b.pursuit=None;b.trace=None;
                b.learn(if d[0]==1.{Some((d[1],v(d,2)))}else{None});vec![0.]},
            1=>{if b.pending.is_some(){return Err("Personality request still pending".into());}let o=Observation::read(d)?;b.learn(o.impact);b.observation=Some(o);b.run()},
            2=>b.respond(d)?,
            3=>{valid(d,5)?;if !integer(d[0]){return Err("Invalid pursuit tick".into());}let (t,s)=b.pursuit.as_mut().map_or((0.,0.),|p|p.drive(v(d,1),d[4],d[0]));vec![t,s]},
            _=>return Err("Unknown personality command".into()),
        };if let Some(ammo)=ammo{words.push(ammo);}write(out,&words);Ok(())
    }
}
impl Personality {
    fn o(&self)->&Observation {self.observation.as_ref().unwrap()}
    fn fire_tick(&self)->f64 {let o=self.o();o.tick.max(o.tick-(o.time/(1./60.)).round()+(self.params.reaction/(1./60.)-1e-9).ceil())}
    fn spread(&self)->f64 {(1.-self.params.bracket).max(0.25).powi(self.bracket.as_ref().map_or(0,|b|b.shots as i32))}
    fn disperse(&mut self,a:Aim)->Aim {
        let s=self.spread();Aim {yaw:wrap(a.yaw+self.random.gaussian()*self.params.sigma[0]*s),pitch:a.pitch+self.random.gaussian()*self.params.sigma[1]*s,power:(a.power*(1.+self.random.gaussian()*self.params.sigma[2]*s)).clamp(0.,1.)}
    }
    fn learn(&mut self,impact:Option<(f64,V)>) {
        if let (Some(b),Some((tick,p)))=(&mut self.bracket,impact){if tick<=b.seen{return;}if let Some((point,from))=b.last.take(){b.seen=tick;let up=norm(point);let along=norm(tangent(sub(point,from),up));let miss=tangent(sub(p,point),up);let k=self.params.bracket;
            b.range=b.range*(1.-k)+dot(miss,along)*k;b.lateral=b.lateral*(1.-k)+dot(miss,cross(up,along))*k;b.shots+=1;}}
    }
    fn request(&mut self,p:Pending,kind:f64,data:&[f64])->Vec<f64> {self.serial+=1;self.pending=Some(p);let mut out=vec![kind,self.serial as f64];out.extend_from_slice(data);out}
    fn pitch(&mut self,p:PitchPurpose,yaw:f64)->Vec<f64> {self.request(Pending::Pitch(p,yaw),4.,&[yaw])}
    fn trace(&mut self,a:Aim,launch:f64,id:u64,deferred:bool)->Vec<f64> {self.request(Pending::Trace(deferred),7.,&[id as f64,a.yaw,a.pitch,a.power,launch,deferred as u8 as f64])}
    fn slew(&self,a:Aim)->Vec<f64> {let o=self.o();let yaw=1.6*(1./60.);let pitch=1.1*(1./60.);vec![2.,o.yaw+wrap(a.yaw-o.yaw).clamp(-yaw,yaw),o.pitch+(a.pitch-o.pitch).clamp(-pitch,pitch),a.power]}
    fn waiting(&self)->Vec<f64> {if self.stage==Stage::Search {self.search.as_ref().and_then(|s|s.best.as_ref()).map_or(vec![0.],|b|self.slew(b.aim))}else{self.slew(self.final_aim.unwrap())}}
    fn make_beliefs(&mut self,purpose:Purpose)->Option<Vec<f64>> {
        let forgetting=matches!(purpose,Purpose::Target);let (mut all,guess)=belief::beliefs(self.o(),if forgetting{self.params.forget}else{-1.});
        if let Some(dir)=guess {if self.o().budget>0.{return Some(self.request(Pending::Heard(purpose,dir),5.,&dir));}all.push(belief::heard(self.o(),mul(dir,self.o().radius)));}
        self.accept_beliefs(purpose,all)
    }
    fn accept_beliefs(&mut self,purpose:Purpose,all:Vec<Belief>)->Option<Vec<f64>> {
        if matches!(purpose,Purpose::Relocation) {
            let o=self.o().clone();let pitch=(std::f64::consts::PI/4.).clamp(self.params.min_pitch,self.params.max_pitch);
            let reach=0.75*o.speed*o.speed*(2.*pitch).sin()/o.gravity;
            self.relocation=Some(Relocation::new(&o,&self.params,all.iter().map(|b|b.center).collect(),&mut self.random,reach));self.stage=Stage::Relocate;return None;
        }
        let target=belief::choose(self.o().p,all);let can_scan=self.o().charge>=self.o().radar&&!self.scanned;
        let scheduled=self.params.scan>=1.&&(self.turns as f64)%self.params.scan==0.;
        if can_scan&&(target.is_none()||target.as_ref().is_some_and(|t|!t.visible&&(self.params.profile!=0||scheduled))){self.scanned=true;return Some(vec![1.]);}
        let Some(target)=target else {
            let a=Aim {yaw:self.random.next()*2.*std::f64::consts::PI-std::f64::consts::PI,pitch:0.95,power:0.45+self.random.next()*0.3};self.final_aim=Some(a);return Some(self.pitch(PitchPurpose::Probe,a.yaw));
        };
        if self.bracket.as_ref().map_or(true,|b|b.tank!=target.tank||len(sub(b.reference,target.center))>1.5){self.bracket=Some(Bracket {tank:target.tank,reference:target.center,range:0.,lateral:0.,shots:0,last:None,seen:self.o().impact.map_or(-1.,|i|i.0)});}
        let b=self.bracket.as_ref().unwrap();let up=norm(target.center);let along=norm(tangent(sub(target.center,self.o().p),up));let dir=norm(sub(target.center,add(mul(along,b.range),mul(cross(up,along),b.lateral))));
        let fallback=mul(dir,len(target.center));self.target=Some(target);
        if self.o().budget>0.{Some(self.request(Pending::Aim(fallback),5.,&dir))}else{Some(self.accept_aim(fallback))}
    }
    fn accept_aim(&mut self,point:V)->Vec<f64> {self.aim_point=Some(point);let yaw=bearing(self.o().p,self.o().q,point);self.pitch(PitchPurpose::Search,yaw)}
    fn run(&mut self)->Vec<f64> {
        loop {match self.stage {
            Stage::Target=>{if let Some(r)=self.make_beliefs(Purpose::Target){return r;}},
            Stage::Search=>{
                let s=self.search.as_mut().unwrap();
                if let Some(job)=s.next(){if s.fresh {self.trace_serial+=1;self.active_trace=self.trace_serial;s.fresh=false;}let launch=s.launch;return self.trace(job.aim,launch,self.active_trace,false);}
                let chosen=s.best.as_ref().map_or(Aim {yaw:s.yaw,pitch:0.8,power:0.5},|b|b.aim);
                let a=self.disperse(chosen);self.final_aim=Some(a);self.check=Some(Check {attempts:1,best:chosen,trace:0,launch:self.fire_tick()});return self.pitch(PitchPurpose::Final,a.yaw);
            },
            Stage::Check=>{let c=self.check.as_ref().unwrap();return self.trace(self.final_aim.unwrap(),c.launch,c.trace,false);},
            Stage::RelocateInit=>{if let Some(r)=self.make_beliefs(Purpose::Relocation){return r;}},
            Stage::Relocate=>{
                let budget=self.o().budget;let radius=self.o().radius;
                match self.relocation.as_mut().unwrap().next(budget,radius){
                    relocation::Work::Yield=>return self.waiting(),
                    relocation::Work::Surface(dir)=>return self.request(Pending::Surface,5.,&dir),
                    relocation::Work::Ray(o,d,n)=>{let mut words=o.to_vec();words.extend(d);words.push(n);return self.request(Pending::Ray,6.,&words);},
                    relocation::Work::Done=>self.stage=Stage::Ready,
                }
            },
            Stage::Ready=>{
                let a=self.final_aim.unwrap();let o=self.o();
                if o.time<self.params.reaction||wrap(a.yaw-o.yaw).abs()>=0.02||(a.pitch-o.pitch).abs()>=0.02{return self.slew(a);}
                let from=o.p;if let (Some(b),Some(point))=(&mut self.bracket,self.aim_point){b.last=Some((point,from));}
                let target=self.relocation.as_ref().and_then(|r|r.target);self.pursuit=target.map(Pursuit::new);
                let mut out=vec![3.,a.yaw,a.pitch,a.power,self.aim_point.is_some() as u8 as f64];out.extend(self.aim_point.unwrap_or([0.;3]));out.push(self.target.as_ref().map_or(-1.,|t|t.tank));
                out.push(target.is_some() as u8 as f64);out.extend(target.unwrap_or([0.;3]));out.push(self.spread());return out;
            }
        }}
    }
    fn respond(&mut self,d:&[f64])->Outcome<Vec<f64>> {
        let p=self.pending.ok_or("No personality request pending")?;
        let size=match p {Pending::Pitch(..)=>4,Pending::Ray=>3,Pending::Trace(_)=>9,_=>9};valid(d,size)?;
        if d[0]!=self.serial as f64||!integer(d[1]){return Err("Stale personality response".into());}
        match p {
            Pending::Pitch(..)=>if d[3]<d[2]{return Err("Invalid elevation limits".into());},
            Pending::Ray=>if !flag(d[2]){return Err("Invalid ray response".into());},
            Pending::Trace(deferred)=>if !integer(d[2])||d[2]>1000000.||!flag(d[3])||!flag(d[4])||!flag(d[8])||(d[4]==1.&&d[3]!=1.)||(deferred&&d[2..].iter().any(|x|*x!=0.)){return Err("Invalid trace response".into());},
            _=>if !flag(d[2]){return Err("Invalid surface response".into());},
        }
        self.pending=None;self.observation.as_mut().unwrap().budget=d[1];
        let point=if d.len()>=6&&d[2]==1.{Some(v(d,3))}else{None};
        match p {
            Pending::Heard(purpose,dir)=>{let b=belief::heard(self.o(),point.unwrap_or(mul(dir,self.o().radius)));if let Some(r)=self.accept_beliefs(purpose,vec![b]){return Ok(r);}},
            Pending::Aim(fallback)=>return Ok(self.accept_aim(point.unwrap_or(fallback))),
            Pending::Pitch(purpose,yaw)=>match purpose {
                PitchPurpose::Search=>{self.search=Some(Search::new(self.o(),&self.params,self.target.as_ref().unwrap(),self.aim_point.unwrap(),yaw,d[2],d[3],self.fire_tick()));self.stage=Stage::Search;},
                PitchPurpose::Probe=>{let a=self.final_aim.as_mut().unwrap();a.pitch=a.pitch.clamp(d[2],d[3]);self.stage=Stage::RelocateInit;},
                PitchPurpose::Final|PitchPurpose::Retry=>{
                    let a=self.final_aim.as_mut().unwrap();a.pitch=a.pitch.clamp(d[2],d[3]);let a=*a;
                    if self.check.is_some(){self.trace_serial+=1;let c=self.check.as_mut().unwrap();c.trace=self.trace_serial;self.stage=Stage::Check;let launch=c.launch;let id=c.trace;return Ok(self.trace(a,launch,id,matches!(purpose,PitchPurpose::Retry)));}
                    self.stage=Stage::RelocateInit;return Ok(self.slew(a));
                }
            },
            Pending::Surface=>self.relocation.as_mut().unwrap().surface(point,if d[2]==1.{v(d,6)}else{[0.;3]}),
            Pending::Ray=>self.relocation.as_mut().unwrap().ray(d[2]==1.),
            Pending::Trace(deferred)=>{
                if deferred{return Ok(self.waiting());}
                if self.stage==Stage::Search {self.search.as_mut().unwrap().steps+=d[2] as u64;}
                if d[3]==0.{if d[8]==1.{return Ok(self.waiting());}return Ok(self.run());}
                let impact=if d[4]==1.{Some(v(d,5))}else{None};
                if self.stage==Stage::Search {self.search.as_mut().unwrap().complete(impact);}
                else {
                    let o=self.o();let danger=search::self_damage(o.p,&o.allies(),o.blast,o.damage,impact);
                    if danger>0.&&self.target.is_some(){let c=self.check.take().unwrap();let a=if c.attempts<3{self.disperse(c.best)}else{c.best};self.final_aim=Some(a);
                        if c.attempts<3{self.check=Some(Check {attempts:c.attempts+1,best:c.best,trace:0,launch:self.fire_tick()});}return Ok(self.pitch(PitchPurpose::Retry,a.yaw));}
                    self.check=None;self.stage=Stage::RelocateInit;
                }
            }
        }
        Ok(self.run())
    }
}
