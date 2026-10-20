//! Resident default-bot controller. The host services bounded trace requests;
//! candidate order, scoring, search progress, decisions and steering live here.
use std::collections::HashMap;
use crate::{core::Outcome, match_state::Matches, combat::Combats, bot_trace::{self, Trace}, flight::Flights, traversal::Queries, physics::Physics};
type V = [f64; 3];
fn v(d: &[f64], i: usize) -> V { [d[i],d[i+1],d[i+2]] }
fn sub(a: V,b: V) -> V { [a[0]-b[0],a[1]-b[1],a[2]-b[2]] }
fn dot(a: V,b: V) -> f64 { a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
fn len(a: V) -> f64 {
    let m=a[0].abs().max(a[1].abs()).max(a[2].abs()); if m==0. { return 0.; }
    let x=(a[0]/m)*(a[0]/m); let y=(a[1]/m)*(a[1]/m); let z=(a[2]/m)*(a[2]/m);
    (x+y+(z-((x+y)-x-y))).sqrt()*m
}
fn rotate(a: V,q: &[f64]) -> V {
    let [x,y,z,w]=[q[0],q[1],q[2],q[3]];
    let tx=2.*(y*a[2]-z*a[1]); let ty=2.*(z*a[0]-x*a[2]); let tz=2.*(x*a[1]-y*a[0]);
    [a[0]+w*tx+y*tz-z*ty,a[1]+w*ty+z*tx-x*tz,a[2]+w*tz+x*ty-y*tx]
}
fn distance_to_segment(point: V,a: V,b: V) -> f64 {
    let d=sub(b,a); let t=(dot(sub(point,a),d)/dot(d,d).max(1e-10)).clamp(0.,1.);
    len([point[0]-(a[0]+d[0]*t),point[1]-(a[1]+d[1]*t),point[2]-(a[2]+d[2]*t)])
}
fn integer(x: f64) -> bool { x>=0.&&x<=9007199254740991.&&x.fract()==0. }
fn flag(x: f64) -> bool { x==0.||x==1. }
fn valid(d: &[f64],n: usize) -> Outcome<()> { if d.len()!=n||d.iter().any(|x|!x.is_finite()) { Err("Invalid AI descriptor".into()) } else { Ok(()) } }
fn write(out: &mut Vec<u8>,d: &[f64]) { out.clear(); for n in d { out.extend_from_slice(&n.to_le_bytes()); } }
struct Search { target: V,yaw: f64,cursor: usize,closest: f64,best_score: f64,best: usize }
struct Legacy { owner: u32,unit:Option<usize>,search: Option<Search>,heading: f64,self_heading: f64,remaining: usize,trace: Option<Trace> }
#[derive(Default)]
pub struct Brains { next: u32,states: HashMap<u32,Legacy> }
impl Brains {
    pub(crate) fn canonical(&self,owner:u32,w:&mut crate::canonical::Writer){
        let mut brains:Vec<_>=self.states.iter().filter(|(_,b)|b.owner==owner).collect();brains.sort_by_key(|(id,b)|(b.unit,**id));
        w.list(&brains,|w,(_,b)|{w.option(&b.unit,|w,u|w.integer(*u as u64));w.words(&[b.heading,b.self_heading]);w.integer(b.remaining as u64);
            w.option(&b.search,|w,s|{w.words(&s.target);w.words(&[s.yaw,s.closest,s.best_score]);w.integer(s.cursor as u64);w.integer(s.best as u64);});});
    }
    pub(crate) fn canonical_traces(&self,owner:u32,w:&mut crate::canonical::Writer){
        let mut brains:Vec<_>=self.states.iter().filter(|(_,b)|b.owner==owner).collect();brains.sort_by_key(|(id,b)|(b.unit,**id));
        w.list(&brains,|w,(_,b)|w.option(&b.trace,|w,t|t.canonical(w)));
    }
    /// v16 resident step of a bound controller: one decision step whose trace
    /// batches run inside the engine on the composed query lease.
    pub fn resident(&mut self,id:u32,d:&[f64],matches:&mut Matches,combats:&Combats,flights:&mut Flights,queries:&mut Queries,physics:Option<&Physics>,out:&mut Vec<u8>) -> Outcome<()> {
        let b=self.states.get_mut(&id).ok_or("Unknown resident AI")?;matches.require_random(b.owner)?;
        let unit=b.unit.ok_or("Resident execution requires a bound AI")?;valid(d,3)?;let lease=bot_trace::lease(d)?;matches.meter_remaining(b.owner)?;
        let o=matches.bot_observation(b.owner,unit,None,combats)?;let mut words=b.start(&o,matches)?;
        while words[0]==3. {
            let cursor=words[2];
            if b.trace.as_ref().map_or(true,|t|t.id!=cursor){b.trace=Some(Trace::new(matches,b.owner,unit,[words[3],words[4],words[5]],None,cursor)?);}
            let mut batch=vec![cursor,0.];let mut count=0.;
            while count<words[6] {
                let Some(s)=b.trace.as_mut().unwrap().step(matches,b.owner,flights,queries,physics,&lease)? else {break};
                batch.extend(s.from);batch.extend(s.to);batch.extend([s.hit as u8 as f64,s.expired as u8 as f64]);count+=1.;
                if s.hit||s.expired {b.trace=None;break;}
            }
            batch[1]=count;words=b.accept(&batch,matches)?;
        }
        words.push(matches.bot_ammo(b.owner,unit)?);write(out,&words);Ok(())
    }
    pub fn create(&mut self,d: &[f64],matches: &Matches) -> Outcome<u32> {
        let linked=d.first()==Some(&2.);valid(d,if linked{3}else{2})?; if (!linked&&d[0]!=1.)||!integer(d[1])||d[1]>u32::MAX as f64 { return Err("Invalid AI owner".into()); }
        matches.require_random(d[1] as u32)?;
        let unit=if linked{Some(matches.require_unit(d[1] as u32,d[2])?)}else{None};
        self.next=self.next.checked_add(1).ok_or("AI handles exhausted")?;
        self.states.insert(self.next,Legacy { owner:d[1] as u32,unit,search:None,heading:0.,self_heading:0.,remaining:0,trace:None }); Ok(self.next)
    }
    pub fn remove(&mut self,id: u32) { self.states.remove(&id); }
    pub(crate) fn require_bound(&self,id:u32,owner:u32,unit:usize)->Outcome<()> {match self.states.get(&id) {Some(b) if b.owner==owner&&b.unit==Some(unit)=>Ok(()),_=>Err("Controller is not bound to the active unit".into())}}
    pub fn remove_match(&mut self,owner: u32) { self.states.retain(|_,b|b.owner!=owner); }
    pub fn command(&mut self,id: u32,op: u32,d: &[f64],matches: &mut Matches,combats:&Combats,out: &mut Vec<u8>) -> Outcome<()> {
        let b=self.states.get_mut(&id).ok_or("Unknown resident AI")?;
        matches.require_random(b.owner)?;
        let ammo=b.unit.map(|unit|matches.bot_ammo(b.owner,unit)).transpose()?;
        let resident;
        let d=if let Some(unit)=b.unit {match op {
            1=>{valid(d,0)?;resident=matches.bot_observation(b.owner,unit,None,combats)?;&resident},
            3=>{valid(d,0)?;resident=matches.bot_drive(b.owner,unit,false)?;&resident},_=>d,
        }}else{d};
        let mut words=match op {
            0 => { valid(d,0)?; b.search=None; b.remaining=0; b.trace=None; vec![0.,b.heading] },
            1 => b.start(d,matches)?,
            2 => b.accept(d,matches)?,
            3 => {
                valid(d,1)?; let error=b.heading-d[0];
                vec![0.85,-(error.sin().atan2(error.cos())*1.8).clamp(-1.,1.),b.heading]
            },
            _ => return Err("Unknown AI command".into()),
        };
        if let Some(ammo)=ammo{words.push(ammo);}write(out,&words); Ok(())
    }
}
impl Legacy {
    fn candidate(&self,cursor: usize) -> [f64;3] {
        [self.search.as_ref().unwrap().yaw,[0.2,0.4,0.6,0.8,1.,1.2][cursor/3],[0.22,0.5,0.78][cursor%3]]
    }
    fn request(&self) -> Vec<f64> {
        let s=self.search.as_ref().unwrap(); let c=self.candidate(s.cursor);
        vec![3.,self.heading,s.cursor as f64,c[0],c[1],c[2],self.remaining as f64]
    }
    fn pick_heading(&mut self,matches: &mut Matches) -> Outcome<()> {
        let sign=if matches.random(self.owner)?>0.5 {1.} else {-1.};
        self.heading=self.self_heading+sign*(0.8+matches.random(self.owner)?*0.8); Ok(())
    }
    // [phaseTime,charge,radarCost,team,heading,position3,rotation4,count], then
    // observation-only rows [tank,team,visible,observedAt,position3]. No world access.
    fn start(&mut self,d: &[f64],matches: &mut Matches) -> Outcome<Vec<f64>> {
        if d.len()<13||!integer(d[12])||d[12]>128. { return Err("Invalid AI contacts".into()); }
        valid(d,13+d[12] as usize*7)?;
        if d[0]<0.||d[1]<0.||d[2]<0.||!integer(d[3])||d[13..].chunks_exact(7).any(|r|!integer(r[0])||!integer(r[1])||!flag(r[2])) { return Err("Invalid AI observation".into()); }
        if d[0]<0.5 { return Ok(vec![0.,self.heading]); }
        self.self_heading=d[4];
        if self.search.is_none() {
            let mut contacts: Vec<&[f64]>=d[13..].chunks_exact(7).filter(|r|r[1]!=d[3]).collect();
            contacts.sort_by(|a,b|a[0].total_cmp(&b[0]));
            let mut best: Option<&[f64]>=None; let mut nearest=f64::INFINITY;
            for c in contacts {
                let distance=len(sub(v(c,4),v(d,5)));
                if best.map_or(true,|old|(c[2]==1.&&old[2]==0.)||(c[2]==old[2]&&if c[2]==1. {distance<nearest} else {c[3]>old[3]})) { best=Some(c); nearest=distance; }
            }
            if best.map_or(true,|c|c[2]==0.)&&d[1]>=d[2] { return Ok(vec![1.,self.heading]); }
            if let Some(contact)=best {
                let delta=sub(v(contact,4),v(d,5));
                let yaw=dot(delta,rotate([1.,0.,0.],&d[8..12])).atan2(dot(delta,rotate([0.,0.,1.],&d[8..12])));
                self.search=Some(Search { target:v(contact,4),yaw,cursor:0,closest:f64::INFINITY,best_score:f64::INFINITY,best:0 });
            } else {
                let yaw=matches.random(self.owner)?*std::f64::consts::PI*2.;
                let pitch=0.65+matches.random(self.owner)?*0.4;
                let power=0.4+matches.random(self.owner)?*0.3;
                self.pick_heading(matches)?; return Ok(vec![2.,self.heading,yaw,pitch,power]);
            }
        }
        self.remaining=32;
        if self.search.as_ref().unwrap().cursor==18 { return self.fire(matches); }
        Ok(self.request())
    }
    // [candidate,count], then [from3,to3,hit,expired] from one trace only. At most
    // the requested remaining work. Empty/incomplete batches indicate budget yield.
    fn accept(&mut self,d: &[f64],matches: &mut Matches) -> Outcome<Vec<f64>> {
        if d.len()<2||!integer(d[1])||d[1]>32. { return Err("Invalid AI trace batch".into()); }
        valid(d,2+d[1] as usize*8)?;
        let s=self.search.as_mut().ok_or("AI has no search")?; let count=d[1] as usize;
        if d[0]!=s.cursor as f64||s.cursor>=18||self.remaining==0||count>self.remaining { return Err("Stale AI trace batch".into()); }
        for (i,r) in d[2..].chunks_exact(8).enumerate() {
            if !flag(r[6])||!flag(r[7])||(i+1<count&&(r[6]==1.||r[7]==1.)) { return Err("Invalid AI trace termination".into()); }
        }
        let mut finished=false;
        for r in d[2..].chunks_exact(8) {
            s.closest=s.closest.min(distance_to_segment(s.target,v(r,0),v(r,3)));
            finished=r[6]==1.||r[7]==1.;
            if finished {
                let score=s.closest+if r[7]==1. {1.} else {0.};
                if score<s.best_score { s.best_score=score; s.best=s.cursor; }
                s.cursor+=1; s.closest=f64::INFINITY;
            }
        }
        self.remaining-=count;
        if s.cursor==18 { return self.fire(matches); }
        if !finished { self.remaining=0; }
        if self.remaining>0 { Ok(self.request()) } else { Ok(vec![0.,self.heading]) }
    }
    fn fire(&mut self,matches: &mut Matches) -> Outcome<Vec<f64>> {
        let c=self.candidate(self.search.as_ref().unwrap().best);
        self.pick_heading(matches)?; self.remaining=0; Ok(vec![2.,self.heading,c[0],c[1],c[2]])
    }
}
