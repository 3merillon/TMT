use super::*;
use crate::canonical::Writer;
impl Params {
    pub(super) fn canonical(&self,w:&mut Writer){
        w.integer(self.profile as u64);w.words(&[self.reaction,self.bracket,self.min_pitch,self.max_pitch,self.forget,self.scan]);w.words(&self.sigma);w.words(&self.relocate);
        w.integer(self.candidates as u64);w.integer(self.refine as u64);w.flag(self.random_relocate);
    }
}
impl Observation {
    fn canonical(&self,w:&mut Writer){
        w.words(&[self.tick,self.time,self.budget,self.team,self.charge,self.radar,self.yaw,self.pitch,self.radius,self.fuel,self.speed,self.gravity,self.blast,self.damage]);w.words(&self.p);w.words(&self.q);
        w.option(&self.impact,|w,(t,p)|{w.number(*t);w.words(p);});w.option(&self.sound,|w,&(a,b)|w.words(&[a,b]));
        w.list(&self.contacts,|w,c|{w.words(&[c.tank,c.team,c.at,c.uncertainty]);w.flag(c.visible);w.words(&c.p);});
    }
}
impl Belief {pub(super) fn canonical(&self,w:&mut Writer){w.words(&[self.tank,self.at]);w.flag(self.visible);w.words(&self.center);w.list(&self.hypotheses,|w,(p,k)|{w.words(p);w.number(*k);});}}
impl Aim {pub(super) fn canonical(&self,w:&mut Writer){w.words(&[self.yaw,self.pitch,self.power]);}}
impl Personality {
    fn canonical(&self,w:&mut Writer){
        w.option(&self.unit,|w,u|w.integer(*u as u64));self.params.canonical(w);w.integer(self.random.state as u64);w.option(&self.random.spare,|w,x|w.number(*x));w.integer(self.turns);
        w.option(&self.bracket,|w,b|{w.words(&[b.tank,b.range,b.lateral,b.seen]);w.words(&b.reference);w.integer(b.shots as u64);w.option(&b.last,|w,(a,b)|{w.words(a);w.words(b);});});
        w.option(&self.pursuit,|w,p|p.canonical(w));w.integer(self.stage as u64);w.option(&self.observation,|w,o|o.canonical(w));
        w.option(&self.target,|w,t|t.canonical(w));w.option(&self.aim_point,|w,p|w.words(p));w.option(&self.search,|w,s|s.canonical(w));w.option(&self.final_aim,|w,a|a.canonical(w));
        w.option(&self.check,|w,c|{w.integer(c.attempts as u64);c.best.canonical(w);w.integer(c.trace);w.number(c.launch);});
        w.option(&self.relocation,|w,r|r.canonical(w));w.flag(self.scanned);
        w.option(&self.pending,|w,p|match *p {
            Pending::Heard(p,v)=>{w.integer(0);w.integer(p as u64);w.words(&v);},Pending::Aim(v)=>{w.integer(1);w.words(&v);},
            Pending::Pitch(p,v)=>{w.integer(2);w.integer(p as u64);w.number(v);},Pending::Surface=>w.integer(3),Pending::Ray=>w.integer(4),Pending::Trace(b)=>{w.integer(5);w.flag(b);},
        });w.integer(self.serial);w.integer(self.trace_serial);w.integer(self.active_trace);
    }
}
impl Profiles {
    pub(crate) fn canonical(&self,owner:u32,w:&mut Writer){
        let mut brains:Vec<_>=self.states.iter().filter(|(_,b)|b.owner==owner).collect();brains.sort_by_key(|(id,b)|(b.unit,**id));
        w.list(&brains,|w,(_,b)|b.canonical(w));
    }
    pub(crate) fn canonical_traces(&self,owner:u32,w:&mut Writer){
        let mut brains:Vec<_>=self.states.iter().filter(|(_,b)|b.owner==owner).collect();brains.sort_by_key(|(id,b)|(b.unit,**id));
        w.list(&brains,|w,(_,b)|w.option(&b.trace,|w,t|t.canonical(w)));
    }
}
