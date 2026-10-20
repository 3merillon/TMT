//! Engine v16 match-owned bot query meter. Each fixed tick resets the spent
//! steps; metered requests refuse an overdraft, unmetered requests record it.
use super::{Match,Matches,finite,integer,output};
use super::armament::{v,q};
use crate::flight::Flight;

pub(super) struct Meter {limit:f64,used:f64,peak:f64}
impl Meter {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){w.words(&[self.limit,self.used,self.peak]);}
    pub(super) fn begin_tick(&mut self){self.used=0.;}
}
impl Match {
    pub(super) fn meter_command(&mut self,op:u32,d:&[f64],out:&mut Vec<u8>)->Result<(),String>{
        if self.observations.as_ref().is_some_and(|o|o.busy()){return Err("Observation query is pending".into());}
        match op {
            62=>{finite(d,2)?;if d[0]!=1.||!integer(d[1])||self.meter.is_some()||self.tick!=0.||self.shots.is_none(){return Err("Invalid query meter admission".into());}
                self.meter=Some(Meter{limit:d[1],used:0.,peak:0.});output(out,&[]);},
            63=>{finite(d,0)?;let m=self.meter.as_ref().ok_or("Resident query meter is absent")?;output(out,&[m.used,m.limit,m.peak]);},
            64=>{finite(d,2)?;if !(d[0]==1.||d[0]==2.)||!(d[1]==0.||d[1]==1.){return Err("Invalid query meter charge".into());}
                let ok=self.charge(d[0],d[1]==1.)?;output(out,&[ok as u8 as f64]);},
            _=>return Err("Unknown query meter operation".into()),
        }Ok(())
    }
    fn charge(&mut self,cost:f64,unmetered:bool)->Result<bool,String>{
        let m=self.meter.as_mut().ok_or("Resident query meter is absent")?;
        if !unmetered&&m.used+cost>m.limit{return Ok(false);}
        m.used+=cost;m.peak=m.peak.max(m.used);Ok(true)
    }
}
impl Matches {
    pub(crate) fn meter_charge(&mut self,id:u32,cost:f64,unmetered:bool)->Result<bool,String>{self.states.get_mut(&id).ok_or("Unknown resident match")?.charge(cost,unmetered)}
    pub(crate) fn active_unit(&self,id:u32)->Result<usize,String>{Ok(self.states.get(&id).ok_or("Unknown resident match")?.active)}
    pub(crate) fn shot_context(&self,id:u32)->Result<u32,String>{Ok(self.states.get(&id).ok_or("Unknown resident match")?.shots.as_ref().ok_or("Resident shots are absent")?.context())}
    pub(crate) fn unit_alive(&self,id:u32,unit:usize,combats:&crate::combat::Combats)->Result<bool,String>{
        let m=self.states.get(&id).ok_or("Unknown resident match")?;let c=combats.get(m.combat.ok_or("Resident combat is absent")?)?;
        Ok(c.units.get(unit).ok_or("Invalid match unit")?.health>0.)
    }
    pub(crate) fn meter_remaining(&self,id:u32)->Result<f64,String>{
        let m=self.states.get(&id).ok_or("Unknown resident match")?.meter.as_ref().ok_or("Resident query meter is absent")?;Ok((m.limit-m.used).max(0.))
    }
    /// A bot trace launches from the bound chassis pose with the unit's selected
    /// munition, like a candidate projectile; a planned launch tick is honored up
    /// to one minute ahead. Barrel/wind factors come from the live shot kits.
    pub(crate) fn bot_trace_flight(&self,id:u32,unit:usize,aim:[f64;3],launch:Option<f64>)->Result<(Flight,u32),String>{
        let m=self.bot_match(id,unit)?;let shots=m.shots.as_ref().ok_or("Resident shots are absent")?;
        let a=m.arsenal.as_ref().unwrap();let u=&m.motion.as_ref().unwrap().units[unit];let ammo=a.selected(unit);
        let w=a.projectile(unit,v(&u.cur,0),q(&u.cur,3),Some([aim[0],aim[1],aim[2],ammo as f64]),m.tick);
        let mut tick=w[10];
        if let Some(l)=launch{if l.fract()==0.&&l.abs()<=9007199254740991.&&l>m.tick{tick=l.min(m.tick+3600.);}}
        let k=shots.kit(unit);Ok((Flight::new(v(&w,0),v(&w,6),0.,tick,k[0],k[1+ammo]),shots.context()))
    }
    /// Canonical kits evaluate the elevation envelope from their admitted table;
    /// None means a custom kit whose public callback stays with the host.
    pub(crate) fn bot_pitch_limits(&self,id:u32,unit:usize,yaw:f64)->Result<Option<[f64;2]>,String>{Ok(self.bot_match(id,unit)?.arsenal.as_ref().unwrap().limits(unit,yaw))}
}
