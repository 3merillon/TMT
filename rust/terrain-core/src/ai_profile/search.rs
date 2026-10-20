use super::*;
use std::collections::VecDeque;
#[derive(Clone,Copy)]
pub(super) struct Aim {pub yaw:f64,pub pitch:f64,pub power:f64}
#[derive(Clone,Copy,PartialEq)]
enum Kind {Grid,Golden,Bearing}
#[derive(Clone,Copy)]
pub(super) struct Job {pub aim:Aim,kind:Kind}
pub(super) struct Choice {pub aim:Aim,pub impact:Option<V>,pub score:f64,pub miss:f64}
#[derive(PartialEq)]
enum Phase {Grid,Golden,Bearing,BearingRun,Done}
struct Golden {a:f64,b:f64,c:f64,d:f64,fc:Option<f64>,fd:Option<f64>,pitch:f64,left:usize}
pub(super) struct Search {
    pub yaw:f64,pub launch:f64,pub best:Option<Choice>,pub fresh:bool,pub steps:u64,
    position:V,rotation:[f64;4],blast:f64,damage:f64,point:V,hypotheses:Vec<(V,f64)>,allies:Vec<V>,refine:usize,
    jobs:VecDeque<Job>,phase:Phase,relaxed:Option<(f64,f64)>,spacing:f64,golden:Option<Golden>,active:Option<Job>,
}
impl Search {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){
        w.words(&[self.yaw,self.launch,self.blast,self.damage,self.spacing]);w.flag(self.fresh);w.integer(self.steps);w.integer(self.refine as u64);w.words(&self.position);w.words(&self.rotation);w.words(&self.point);
        w.option(&self.best,|w,c|{c.aim.canonical(w);w.option(&c.impact,|w,p|w.words(p));w.words(&[c.score,c.miss]);});
        w.list(&self.hypotheses,|w,(p,k)|{w.words(p);w.number(*k);});w.list(&self.allies,|w,p|w.words(p));
        w.integer(self.jobs.len() as u64);for j in &self.jobs{j.aim.canonical(w);w.integer(j.kind as u64);}
        w.integer(match self.phase{Phase::Grid=>0,Phase::Golden=>1,Phase::Bearing=>2,Phase::BearingRun=>3,Phase::Done=>4});
        w.option(&self.relaxed,|w,&(a,b)|w.words(&[a,b]));w.option(&self.golden,|w,g|{w.words(&[g.a,g.b,g.c,g.d,g.pitch]);w.option(&g.fc,|w,v|w.number(*v));w.option(&g.fd,|w,v|w.number(*v));w.integer(g.left as u64);});
        w.option(&self.active,|w,j|{j.aim.canonical(w);w.integer(j.kind as u64);});
    }
}
fn exposure(impact:V,point:V,extent:f64)->f64 {(1.-len(sub(impact,point))/extent).clamp(0.,1.)}
pub(super) fn self_damage(position:V,allies:&[V],blast:f64,damage:f64,impact:Option<V>)->f64 {
    let Some(impact)=impact else{return 0.;};let extent=blast*1.65+0.7;let mut friendly=0.;
    for &ally in allies {friendly+=damage*exposure(impact,ally,extent);}damage*exposure(impact,position,extent)+friendly
}
impl Search {
    pub fn new(o:&Observation,p:&Params,target:&Belief,point:V,yaw:f64,min:f64,max:f64,launch:f64)->Self {
        let mut low=p.min_pitch.max(min);let mut high=p.max_pitch.min(max);if high<=low {low=min;high=max;}
        let powers=((p.candidates as f64/2.).sqrt().round() as usize).max(2);let pitches=p.candidates.div_ceil(powers).max(2);let spacing=(1.-0.12)/(powers-1) as f64;
        let mut jobs=VecDeque::new();for i in 0..pitches {for j in 0..powers {jobs.push_back(Job {aim:Aim {yaw,pitch:low+(high-low)*i as f64/(pitches-1) as f64,power:0.12+spacing*j as f64},kind:Kind::Grid});}}
        Self {yaw,launch,best:None,fresh:false,steps:0,position:o.p,rotation:o.q,blast:o.blast,damage:o.damage,point,hypotheses:target.hypotheses.clone(),allies:o.allies(),refine:p.refine,jobs,phase:Phase::Grid,
            relaxed:if low>min+1e-6||high<max-1e-6 {Some((min,max))}else{None},spacing,golden:None,active:None}
    }
    pub fn next(&mut self)->Option<Job> {
        if let Some(job)=self.active {return Some(job);}
        let ratio=(5_f64.sqrt()-1.)/2.;
        let job=loop {match self.phase {
            Phase::Done=>return None,
            Phase::Grid=>{
                if let Some(job)=self.jobs.pop_front(){break job;}
                if self.relaxed.is_some()&&self.best.as_ref().map_or(true,|b|b.impact.is_none()||b.miss>2.5){
                    let (low,high)=self.relaxed.take().unwrap();let powers=((1.-0.12)/self.spacing).round() as usize+1;
                    for i in 0..6 {for j in 0..powers {self.jobs.push_back(Job {aim:Aim {yaw:self.yaw,pitch:low+(high-low)*(i as f64+0.5)/6.,power:0.12+self.spacing*j as f64},kind:Kind::Grid});}}continue;
                }
                if self.refine>0&&self.best.as_ref().is_some_and(|b|b.impact.is_some()) {
                    let best=self.best.as_ref().unwrap();let a=(best.aim.power-self.spacing).clamp(0.,1.);let b=(best.aim.power+self.spacing).clamp(0.,1.);
                    self.golden=Some(Golden {a,b,c:b-ratio*(b-a),d:a+ratio*(b-a),fc:None,fd:None,pitch:best.aim.pitch,left:self.refine});self.phase=Phase::Golden;
                }else{self.phase=Phase::Done;}
            },
            Phase::Golden=>{
                let g=self.golden.as_mut().unwrap();
                if g.fc.is_none(){break Job {aim:Aim {yaw:self.yaw,pitch:g.pitch,power:g.c},kind:Kind::Golden};}
                if g.fd.is_none(){break Job {aim:Aim {yaw:self.yaw,pitch:g.pitch,power:g.d},kind:Kind::Golden};}
                g.left-=1;if g.left==0 {self.phase=Phase::Bearing;continue;}
                if g.fc.unwrap()>=g.fd.unwrap(){g.b=g.d;g.d=g.c;g.fd=g.fc;g.c=g.b-ratio*(g.b-g.a);g.fc=None;}
                else{g.a=g.c;g.c=g.d;g.fc=g.fd;g.d=g.a+ratio*(g.b-g.a);g.fd=None;}
            },
            Phase::Bearing=>{
                let Some(best)=&self.best else{self.phase=Phase::Done;continue;};
                let correction=best.impact.map_or(0.,|impact|bearing(self.position,self.rotation,self.point)-bearing(self.position,self.rotation,impact));
                if correction.abs()<2e-4 {self.phase=Phase::Done;continue;}
                self.phase=Phase::BearingRun;break Job {aim:Aim {yaw:best.aim.yaw+correction,..best.aim},kind:Kind::Bearing};
            },
            Phase::BearingRun=>unreachable!("Bearing trace must be active"),
        }};
        self.active=Some(job);self.fresh=true;Some(job)
    }
    pub fn complete(&mut self,impact:Option<V>) {
        let job=self.active.take().unwrap();let (score,miss)=if let Some(p)=impact {
            let extent=self.blast*1.65+0.7;let mut expected=0.;for &(point,weight) in &self.hypotheses {expected+=weight*self.damage*exposure(p,point,extent);}
            let damage=self.damage*exposure(p,self.position,extent);let mut allies=0.;for &ally in &self.allies {allies+=self.damage*exposure(p,ally,extent);}
            let miss=len(sub(p,self.point));(expected-1.5*damage-1.2*allies-2.*miss,miss)
        }else{(-1e6,f64::INFINITY)};
        if self.best.as_ref().map_or(true,|b|score>b.score){self.best=Some(Choice {aim:job.aim,impact,score,miss});}
        if job.kind==Kind::Golden {let g=self.golden.as_mut().unwrap();if g.fc.is_none(){g.fc=Some(score);}else{g.fd=Some(score);}}
        if job.kind==Kind::Bearing {self.phase=Phase::Done;}
    }
}
