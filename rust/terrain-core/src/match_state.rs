//! Resident match lifecycle, ABI 1. Physics, projectiles and extension callbacks run
//! between begin_tick and after_motion. Terrain publication gates both begin_tick
//! and settle in the host; waiting wall time is explicitly discarded, never replayed.
use std::collections::HashMap;
mod armament;
use armament::Arsenal;
mod observations;
use observations::Observations;
mod journal;
use journal::Journal;
mod motion;
use motion::Motion;
mod bot_inputs;
use bot_inputs::BotInputs;
mod shots;
use shots::Shots;
mod canonical;
use canonical::Canonical;
mod meter;
use meter::Meter;
mod tail;
pub(crate) use tail::Tail;

const DT: f64 = 1. / 60.;
#[derive(Default)]
pub struct Matches { next: u32, states: HashMap<u32, Match> }
struct Unit { team: f64, player: bool, ready: f64 }
struct Anchor { tank: usize, position: [f64; 3], elapsed: f64, idle: f64 }
struct Match {
    drive: bool, move_seconds: f64, aim_seconds: f64, max_turns: f64, sudden_turn: f64, max_charge: f64,
    units: Vec<Unit>, tick: f64, phase: u8, active: usize, turn: f64, phase_time: f64,
    accumulator: f64, frame_ticks: u8, move_time: f64, winner: f64, team: f64, sudden: bool,
    anchor: Option<Anchor>, combat: Option<u32>, rng: Option<u32>, arsenal: Option<Arsenal>, observations: Option<Observations>, journal: Option<Journal>, motion: Option<Motion>, bot_inputs: Option<BotInputs>, shots: Option<Shots>, canonical:Option<Canonical>, meter:Option<Meter>, tail:Option<Tail>, treads:Vec<(Vec<u64>, Vec<f64>)>,
}
fn finite(v: &[f64], size: usize) -> Result<(), String> {
    if v.len() != size || v.iter().any(|v| !v.is_finite()) { Err("Invalid match descriptor".into()) } else { Ok(()) }
}
fn flag(v: f64) -> bool { v == 0. || v == 1. }
fn integer(v: f64) -> bool { v >= 0. && v <= 9007199254740991. && v.fract() == 0. }
fn output(out: &mut Vec<u8>, words: &[f64]) { out.clear(); for x in words { out.extend_from_slice(&x.to_le_bytes()); } }
impl Matches {
    pub fn create(&mut self, v: &[f64]) -> Result<u32, String> {
        if v.len() < 8 { return Err("Invalid match descriptor".into()); }
        let n = v[7] as usize;
        if n == 0 || n > 64 || v[7] != n as f64 { return Err("Invalid match unit count".into()); }
        finite(v, 8 + n * 3)?;
        if v[0] != 1. || !flag(v[1]) || v[2] < 0. || v[3] < -1. || v[4] < -1. || v[5] < -1. || v[6] < 0.
            { return Err("Invalid match rules".into()); }
        let mut units = Vec::with_capacity(n);
        let mut alive = Vec::with_capacity(n);
        for r in v[8..].chunks_exact(3) {
            if !integer(r[0]) || !flag(r[1]) || !flag(r[2]) { return Err("Invalid match unit".into()); }
            units.push(Unit { team: r[0], player: r[1] == 1., ready: 0. }); alive.push(r[2] == 1.);
        }
        let mut m = Match { drive: v[1] == 1., move_seconds: v[2], aim_seconds: v[3], max_turns: v[4], sudden_turn: v[5], max_charge: v[6], units,
            tick: 0., phase: 0, active: 0, turn: 1., phase_time: 0., accumulator: 0., frame_ticks: 0, move_time: 0., winner: -1., team: -1., sudden: false, anchor: None, combat: None, rng: None, arsenal: None, observations: None, journal: None, motion: None, bot_inputs: None, shots: None, canonical:None, meter:None, tail:None, treads:Vec::new() };
        m.active = m.next_actor(|id| alive[id]).unwrap_or(0);
        self.next = self.next.checked_add(1).ok_or("Match handles exhausted")?;
        self.states.insert(self.next, m); Ok(self.next)
    }
    pub fn remove(&mut self, id: u32) { self.states.remove(&id); }
    pub fn require_random(&self, id: u32) -> Result<(), String> {
        if self.states.get(&id).and_then(|m|m.rng).is_none() { Err("Unknown resident match random stream".into()) } else { Ok(()) }
    }
    pub fn random(&mut self, id: u32) -> Result<f64, String> {
        if self.states.get(&id).is_some_and(|m|m.observations.as_ref().is_some_and(|o|o.busy())) {return Err("Observation query is pending".into());}
        let rng=self.states.get_mut(&id).and_then(|m|m.rng.as_mut()).ok_or("Unknown resident match random stream")?;
        *rng=rng.wrapping_mul(1664525).wrapping_add(1013904223); Ok(*rng as f64/4294967296.)
    }
    pub fn command(&mut self, id: u32, op: u32, v: &[f64], combats: &mut crate::combat::Combats, queries: &mut crate::traversal::Queries, physics: Option<&mut crate::physics::Physics>, flights:&mut crate::flight::Flights, out: &mut Vec<u8>) -> Result<(), String> {
        if op==8 { finite(v,0)?; output(out,&[self.random(id)?]); return Ok(()); }
        let m = self.states.get_mut(&id).ok_or("Unknown resident match")?;
        if op>=62 {return m.meter_command(op,v,out);}
        if op>=48 {return m.shot_command(op,v,combats,queries,physics.as_deref(),flights,out);}
        if op>=46 {return m.bot_input_command(op,v,out);}
        if op>=37 {return m.motion_command(op,v,combats,queries,physics,out);}
        if op>=27 {return m.journal_command(op,v,out);}
        if op>=16 {return m.observation_command(op,v,combats,queries,physics.as_deref(),out);}
        if op!=0 && m.observations.as_ref().is_some_and(|o|o.busy()) {return Err("Observation query is pending".into());}
        if op>=9 {return m.armament_command(op,v,combats,out);}
        let (mut event, mut previous, mut charge, mut zero) = (0., -1., 0., false);
        match op {
            0 => { finite(v, 0)?; }
            // Start a presentation frame. Like the original clock, NaN/Infinity or
            // negative dt contributes no time. Each frame can run at most 8 ticks.
            1 => {
                if v.len() != 2 || !flag(v[1]) { return Err("Invalid match frame".into()); }
                m.frame_ticks = 0;
                if v[1] == 1. || m.phase == 3 { m.accumulator = 0.; }
                else if v[0].is_finite() && v[0] > 0. { m.accumulator += v[0].min(DT * 8.); }
            }
            2 => {
                finite(v, 0)?;
                if !m.can_tick() { return Err("Match tick is not ready".into()); }
                if m.tick >= 9007199254740991. { return Err("Match tick overflow".into()); }
                if let Some(motion)=&mut m.motion {motion.begin_tick();}
                if let Some(meter)=&mut m.meter {meter.begin_tick();}
                m.accumulator = (m.accumulator - DT).max(0.); m.frame_ticks += 1;
                m.tick += 1.; m.phase_time += DT;
            }
            // Accepted actions: fire, hold, endMove, reposition. Command validation,
            // ammo, recoil and shot creation still belong to the host in this ABI.
            3 => {
                if m.arsenal.is_some(){return Err("Resident actions require admission".into());}
                finite(v, 2)?; let action = v[0] as u32;
                if v[0] != action as f64 || action > 3 || v[1] != m.active as f64 || m.phase == 3
                    || (action != 0 && m.drive) || (action == 2 && m.phase != 1)
                    || (action != 2 && !m.drive && m.phase != 0) { return Err("Invalid match action".into()); }
                if action != 2 { m.phase = 1; m.phase_time = 0.; }
                m.move_time = if action == 0 || action == 3 { m.move_seconds } else { 0. };
                if action == 0 || action == 3 { m.anchor = None; }
                zero = action == 1 || action == 2;
            }
            // Active chassis movement after physics and onTick extensions. The
            // caller supplies only observations, never the resident timers/anchor.
            4 => {
                let resident;
                let v=if let Some(motion)=&m.motion {finite(v,4)?;let u=&motion.units[m.active];resident=[v[0],v[1],v[2],v[3],u.before[0],u.before[1],u.before[2],u.cur[0],u.cur[1],u.cur[2]];&resident[..]}else{v};
                finite(v, 10)?;
                if !flag(v[0]) || !flag(v[1]) { return Err("Invalid match motion".into()); }
                if m.phase == 1 {
                    m.move_time = (m.move_time - DT).max(0.);
                    if !m.drive && v[0] == 1. && v[1] == 1. && m.move_time > 0. {
                        if m.anchor.as_ref().map_or(true, |a| a.tank != m.active) {
                            m.anchor = Some(Anchor { tank: m.active, position: [v[4], v[5], v[6]], elapsed: 0., idle: 0. });
                        }
                        let a = m.anchor.as_mut().unwrap(); a.elapsed += DT;
                        a.idle = if v[2].abs() < 0.01 && v[3].abs() < 0.01 { a.idle + DT } else { 0. };
                        let d = [a.position[0] - v[7], a.position[1] - v[8], a.position[2] - v[9]];
                        if (d[0]*d[0] + d[1]*d[1] + d[2]*d[2]).sqrt() >= 0.2 {
                            a.position = [v[7], v[8], v[9]]; a.elapsed = 0.;
                        }
                        if a.elapsed >= 8. || a.idle >= 0.5 { m.move_time = 0.; }
                    }
                    zero = m.move_time == 0.;
                }
            }
            // Settle only after every pending terrain edit has committed. Bound
            // combat owns health/charge; v4/v5 retain their original input ABI.
            5 => {
                let shot_count;
                let v=if let Some(s)=&m.shots {shot_count=[vec![s.count()],v.to_vec()].concat();&shot_count[..]}else{v};
                let mut resident_rows = Vec::new();
                let v = if let Some(id) = m.combat {
                    let stride=if m.arsenal.is_some(){1}else{2};finite(v, 1 + m.units.len() * stride)?;
                    if !integer(v[0]) || v[1..].chunks_exact(stride).any(|r| r[stride-1] <= 0.) { return Err("Invalid match settle".into()); }
                    let c = combats.get(id)?;
                    resident_rows.push(v[0]);
                    for (i,((u, row), munit)) in c.units.iter().zip(v[1..].chunks_exact(stride)).zip(m.units.iter_mut()).enumerate() {
                        let fuel=m.arsenal.as_ref().map_or(row[0],|a|a.units[i].movement);
                        resident_rows.extend_from_slice(&[u.health, u.charge, fuel, row[stride-1]]); munit.team = u.team;
                    }
                    &resident_rows[..]
                } else { v };
                finite(v, 1 + m.units.len() * 4)?;
                if !integer(v[0]) || v[1..].chunks_exact(4).any(|r| r[3] <= 0.) { return Err("Invalid match settle".into()); }
                if m.phase != 3 {
                    if m.drive { if v[0] == 0. { m.phase = 0; } }
                    else {
                        let rows = &v[1..];
                        let living: Vec<usize> = (0..m.units.len()).filter(|i| rows[i*4] > 0.).collect();
                        let mut teams: Vec<(f64, f64)> = Vec::new();
                        for &id in &living {
                            let team = m.units[id].team;
                            if let Some(t) = teams.iter_mut().find(|t| t.0 == team) { t.1 += rows[id*4]; }
                            else { teams.push((team, rows[id*4])); }
                        }
                        if teams.len() < 2 { m.finish(teams.first().map_or(-1., |t| t.0), &living); event = 2.; }
                        else {
                            if m.phase == 0 && rows[m.active*4] <= 0. { m.phase = 1; m.move_time = 0.; }
                            if m.phase == 1 && v[0] == 0. && !(m.move_time > 0. && rows[m.active*4+2] > 0.) {
                                if m.max_turns >= 0. && m.turn >= m.max_turns {
                                    teams.sort_by(|a,b| b.1.total_cmp(&a.1).then(a.0.total_cmp(&b.0)));
                                    m.finish(if teams[0].1 == teams[1].1 { -1. } else { teams[0].0 }, &living); event = 2.;
                                } else {
                                    previous = m.active as f64; charge = m.max_charge.min(rows[m.active*4+1] + 1.);
                                    if let Some(id) = m.combat { combats.get_mut(id)?.units[m.active].charge = charge; }
                                    m.units[m.active].ready += 100. * rows[m.active*4+3];
                                    m.active = m.next_actor(|id| rows[id*4] > 0.).unwrap(); m.turn += 1.;
                                    if m.sudden_turn >= 0. && m.turn >= m.sudden_turn { m.sudden = true; }
                                    m.phase = 0; m.phase_time = 0.; event = 1.;
                                }
                            }
                        }
                    }
                }
            }
            6 => {
                finite(v, 1)?;
                if !integer(v[0]) || v[0] > u32::MAX as f64 || m.combat.is_some() { return Err("Invalid match combat binding".into()); }
                let c = combats.get(v[0] as u32)?;
                if c.units.len() != m.units.len() || c.sandbox != m.drive || c.units.iter().zip(&m.units).any(|(a,b)|a.team!=b.team) { return Err("Mismatched match combat".into()); }
                m.combat = Some(v[0] as u32);
            }
            7 => {
                finite(v,1)?;
                if !integer(v[0]) || v[0]>u32::MAX as f64 || m.rng.is_some() || m.tick!=0. { return Err("Invalid match random admission".into()); }
                m.rng=Some(v[0] as u32);
            }
            _ => return Err("Unknown match command".into()),
        }
        if zero {if let Some(a)=&mut m.arsenal {a.units[m.active].movement=0.;}}
        if event==1. {if let Some(o)=&mut m.observations {o.turn(m.active,m.tick);}}
        if event>=1. {if let Some(s)=&mut m.shots {s.retire();}}
        output(out, &m.snapshot(event,previous,charge,zero)); Ok(())
    }
}
impl Match {
    fn snapshot(&self,event:f64,previous:f64,charge:f64,zero:bool)->Vec<f64> {
        let mut words=vec![self.tick,self.tick*DT,self.phase as f64,self.active as f64,self.turn,self.phase_time,self.accumulator,self.move_time,self.winner,self.team,self.sudden as u8 as f64,
            (self.aim_seconds>=0.&&self.phase==0&&self.phase_time>=self.aim_seconds-1e-9) as u8 as f64,self.can_tick() as u8 as f64,event,previous,charge,zero as u8 as f64];
        words.extend(self.units.iter().map(|u|u.ready));if let Some(a)=&self.arsenal {a.append(&mut words);}words
    }
    fn can_tick(&self) -> bool { self.phase != 3 && self.frame_ticks < 8 && self.accumulator + 1e-10 >= DT }
    fn next_actor(&self, alive: impl Fn(usize) -> bool) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (id, u) in self.units.iter().enumerate() {
            if !alive(id) { continue; }
            if best.map_or(true, |b| { let b = &self.units[b]; u.ready < b.ready || (u.ready == b.ready && u.player && !b.player) }) { best = Some(id); }
        }
        best
    }
    fn finish(&mut self, team: f64, living: &[usize]) {
        self.phase = 3; self.team = team;
        self.winner = living.iter().find(|&&id| self.units[id].team == team).map_or(-1., |&id| id as f64);
    }
}
