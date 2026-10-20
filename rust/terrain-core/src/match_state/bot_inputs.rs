//! Direct private bot observations assembled from the match's existing owners.
//! Only immutable munition envelopes and gravity need separate admission.
use super::{Match,Matches,finite,integer,output};
use super::armament::v;
use crate::combat::Combats;

pub(super) struct BotInputs {gravity:f64,blast:Vec<[f64;8]>}
impl BotInputs {pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){w.number(self.gravity);w.list(&self.blast,|w,b|w.words(b));}}
impl Match {
    pub(super) fn bot_input_command(&mut self,op:u32,d:&[f64],out:&mut Vec<u8>)->Result<(),String> {
        if self.observations.as_ref().is_some_and(|o|o.busy()){return Err("Observation query is pending".into());}
        match op {
            46=>{finite(d,2+8*self.units.len())?;
                if d[0]!=1.||d[1..].iter().any(|&v|v<0.)||self.bot_inputs.is_some()||self.motion.is_none()||self.tick!=0.{return Err("Invalid bot input admission".into());}
                self.bot_inputs=Some(BotInputs{gravity:d[1],blast:d[2..].chunks_exact(8).map(|r|r.try_into().unwrap()).collect()});},
            47=>{finite(d,9)?;if !integer(d[0])||d[0]>=self.units.len() as f64||d[1..].iter().any(|&v|v<0.){return Err("Invalid bot kit update".into());}
                if self.phase!=0||self.arsenal.as_ref().is_some_and(|a|a.kit_locked()){return Err("Bot kit is locked".into());}
                self.bot_inputs.as_mut().ok_or("Resident bot inputs are absent")?.blast[d[0] as usize].copy_from_slice(&d[1..]);},
            _=>return Err("Unknown bot input operation".into()),
        }output(out,&[]);Ok(())
    }
}
impl Matches {
    pub fn require_unit(&self,id:u32,unit:f64)->Result<usize,String>{
        let m=self.states.get(&id).ok_or("Unknown resident match")?;
        if !integer(unit)||unit>=m.units.len() as f64 {Err("Invalid bot unit".into())}else{Ok(unit as usize)}
    }
    pub(super) fn bot_match(&self,id:u32,unit:usize)->Result<&Match,String>{
        let m=self.states.get(&id).ok_or("Unknown resident match")?;
        if unit>=m.units.len()||m.motion.is_none()||m.bot_inputs.is_none(){return Err("Resident bot inputs are absent".into());}
        if m.observations.as_ref().unwrap().busy(){return Err("Observation query is pending".into());}Ok(m)
    }
    pub fn bot_ammo(&self,id:u32,unit:usize)->Result<f64,String>{Ok(self.bot_match(id,unit)?.arsenal.as_ref().unwrap().selected(unit) as f64)}
    pub fn bot_drive(&self,id:u32,unit:usize,profile:bool)->Result<Vec<f64>,String>{
        let m=self.bot_match(id,unit)?;let u=&m.motion.as_ref().unwrap().units[unit];
        Ok(if profile{vec![m.tick,u.cur[0],u.cur[1],u.cur[2],u.cur[10]]}else{vec![u.cur[10]]})
    }
    pub fn bot_begin(&self,id:u32,unit:usize)->Result<Vec<f64>,String>{
        let m=self.bot_match(id,unit)?;let impact=m.observations.as_ref().unwrap().last_impact(unit);
        let mut w=vec![impact.is_some() as u8 as f64,impact.map_or(0.,|i|i.0)];w.extend(impact.map_or([0.;3],|i|i.1));Ok(w)
    }
    pub fn bot_observation(&self,id:u32,unit:usize,budget:Option<f64>,combats:&Combats)->Result<Vec<f64>,String>{
        let m=self.bot_match(id,unit)?;let motion=m.motion.as_ref().unwrap();let u=&motion.units[unit];let c=combats.get(m.combat.unwrap())?;
        let a=m.arsenal.as_ref().unwrap();let o=m.observations.as_ref().unwrap();let inputs=m.bot_inputs.as_ref().unwrap();
        let positions=motion.units.iter().map(|u|v(&u.cur,0)).collect::<Vec<_>>();let mut contacts=o.contact_words(unit,&positions,c,a,m.tick);
        // Detached observations group visible contacts first, retaining ID order.
        contacts.sort_by(|a,b|b[2].total_cmp(&a[2]));
        if let Some(budget)=budget {
            if !integer(budget){return Err("Invalid native bot budget".into());}
            let weapon=a.bot_weapon(unit);let blast=&inputs.blast[unit];let ammo=a.selected(unit);let impact=o.last_impact(unit);let sound=o.last_sound(unit);
            let mut w=vec![m.tick,m.phase_time,budget,c.units[unit].team,c.units[unit].charge,c.radar_cost()];w.extend(&u.cur[..7]);w.push(u.cur[10]);w.extend(weapon);
            w.extend([inputs.gravity,blast[ammo*2],blast[ammo*2+1],impact.is_some() as u8 as f64,impact.map_or(0.,|i|i.0)]);w.extend(impact.map_or([0.;3],|i|i.1));
            w.extend([sound.is_some() as u8 as f64,sound.map_or(0.,|s|s.0),sound.map_or(0.,|s|s.1),contacts.len() as f64]);for r in contacts {w.extend(r);}Ok(w)
        }else{
            let mut w=vec![m.phase_time,c.units[unit].charge,c.radar_cost(),c.units[unit].team,u.cur[10]];w.extend(&u.cur[..7]);w.push(contacts.len() as f64);
            for r in contacts {w.extend([r[0],r[1],r[2],r[3],r[5],r[6],r[7]]);}Ok(w)
        }
    }
}
