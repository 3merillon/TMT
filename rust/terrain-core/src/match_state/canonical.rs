use super::*;
use crate::{canonical::{Writer,text},combat::Combats,flight::Flights,physics::Physics};
pub(super) struct Canonical {setup:Vec<u16>}
impl Matches {
    pub fn canonical_command(&mut self,id:u32,op:u32,d:&[f64],combats:&Combats,flights:&Flights,physics:Option<&Physics>,brains:&crate::ai::Brains,profiles:&crate::ai_profile::Profiles,out:&mut Vec<u8>)->Result<(),String>{
        let m=self.states.get_mut(&id).ok_or("Unknown resident match")?;
        if m.observations.as_ref().is_some_and(|o|o.busy()){return Err("Observation query is pending".into());}
        if op==59 {
            if d.first()!=Some(&1.)||m.tick!=0.||m.canonical.is_some()||m.combat.is_none()||m.arsenal.is_none()||m.motion.is_none()||m.observations.is_none()||m.journal.is_none()||m.bot_inputs.is_none()||m.shots.is_none(){return Err("Invalid canonical admission".into());}
            let setup=text(&d[1..])?;m.canonical=Some(Canonical{setup});output(out,&[]);return Ok(());
        }
        if op!=60&&op!=61{return Err("Unknown canonical operation".into());}
        let c=m.canonical.as_ref().ok_or("Resident canonical state is absent")?;let extensions=text(d)?;
        // Admission requires every owner; never trap the shared engine instance if one is absent.
        let absent="Canonical state requires every resident owner";
        let (arsenal,motion,observations,journal,bot_inputs,shots)=(m.arsenal.as_ref().ok_or(absent)?,m.motion.as_ref().ok_or(absent)?,m.observations.as_ref().ok_or(absent)?,m.journal.as_ref().ok_or(absent)?,m.bot_inputs.as_ref().ok_or(absent)?,m.shots.as_ref().ok_or(absent)?);
        let mut w=Writer::default();w.bytes.extend(b"TMT-ENGINE-STATE\0");w.integer(1);
        w.section(1,|w|w.text(&c.setup));
        w.section(2,|w|{
            // Wall-clock accumulator/frame admission and replay cursor are not
            // fixed-tick state. Including them would make cadence define hashes.
            w.flag(m.drive);w.words(&[m.move_seconds,m.aim_seconds,m.max_turns,m.sudden_turn,m.max_charge,m.tick,m.phase as f64,m.active as f64,m.turn,m.phase_time,m.move_time,m.winner,m.team]);w.flag(m.sudden);
            w.list(&m.units,|w,u|{w.words(&[u.team,u.ready]);w.flag(u.player);});
            w.option(&m.rng,|w,r|w.integer(*r as u64));
            w.option(&m.anchor,|w,a|{w.integer(a.tank as u64);w.words(&a.position);w.words(&[a.elapsed,a.idle]);});
        });
        let combat=combats.get(m.combat.ok_or("Canonical state requires combat")?)?;
        w.section(3,|w|combat.canonical(w));
        w.section(4,|w|arsenal.canonical(w));
        w.section(5,|w|motion.canonical(w));
        w.section(6,|w|observations.canonical(w));
        w.section(7,|w|journal.canonical(w));
        w.section(8,|w|bot_inputs.canonical(w));
        shots.canonical(&mut w,flights)?;
        motion.canonical_physics(&mut w,physics)?;
        w.section(13,|w|brains.canonical(id,w));w.section(14,|w|profiles.canonical(id,w));
        // v16 only: older engines' images stay byte-identical.
        if let Some(meter)=&m.meter {w.section(15,|w|{meter.canonical(w);brains.canonical_traces(id,w);profiles.canonical_traces(id,w);});}
        w.section(12,|w|w.text(&extensions));
        let hash=w.hash();if op==60 {output(out,&[hash[0] as f64,hash[1] as f64,m.tick,w.bytes.len() as f64]);}
        else {out.clear();for b in w.bytes{out.extend((b as f64).to_le_bytes());}}Ok(())
    }
}
