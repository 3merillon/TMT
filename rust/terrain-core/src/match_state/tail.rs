//! Engine v20 tick-tail support: the transient resume point of a tail that is
//! waiting on a host service, and the match facts the tail sequencer reads.
//! A tail never outlives its tick; it is not part of the canonical image.
use super::Matches;
use super::armament::{len, v};

pub(crate) struct Tail { pub stage: u8, pub params: Vec<f64> }
pub(crate) struct TailInfo { pub drive: bool, pub phase: u8, pub tick: f64, pub active: usize, pub units: usize, pub aim_expired: bool }
impl Matches {
    pub(crate) fn tail_info(&self, id: u32) -> Result<TailInfo, String> {
        let m = self.states.get(&id).ok_or("Unknown resident match")?;
        Ok(TailInfo { drive: m.drive, phase: m.phase, tick: m.tick, active: m.active, units: m.units.len(),
            aim_expired: m.aim_seconds >= 0. && m.phase == 0 && m.phase_time >= m.aim_seconds - 1e-9 })
    }
    /// The host's fall rule on the bound chassis pose: below a quarter radius
    /// (JS Math.hypot arithmetic) and still alive.
    pub(crate) fn fallen(&self, id: u32, unit: usize, radius: f64, combats: &crate::combat::Combats) -> Result<bool, String> {
        let m = self.states.get(&id).ok_or("Unknown resident match")?;
        let p = v(&m.motion.as_ref().ok_or("Resident motion is absent")?.units.get(unit).ok_or("Invalid match unit")?.cur, 0);
        Ok(len(p) < radius * 0.25 && self.unit_alive(id, unit, combats)?)
    }
    pub(crate) fn combat_of(&self, id: u32) -> Result<u32, String> { self.states.get(&id).ok_or("Unknown resident match")?.combat.ok_or_else(|| "Resident combat is absent".into()) }
    pub(crate) fn set_tail(&mut self, id: u32, tail: Option<Tail>) -> Result<(), String> { self.states.get_mut(&id).ok_or("Unknown resident match")?.tail = tail; Ok(()) }
    /// The bound chassis pose (position, rotation x y z w) of a unit.
    pub(crate) fn unit_pose(&self, id: u32, unit: usize) -> Result<[f64; 7], String> {
        let m = self.states.get(&id).ok_or("Unknown resident match")?;
        Ok(m.motion.as_ref().ok_or("Resident motion is absent")?.units.get(unit).ok_or("Invalid match unit")?.cur[..7].try_into().unwrap())
    }
    /// The last tread profile per unit and its key (engine v21; presentation, never hashed).
    pub(crate) fn tread_cache(&mut self, id: u32) -> Result<&mut Vec<(Vec<u64>, Vec<f64>)>, String> { Ok(&mut self.states.get_mut(&id).ok_or("Unknown resident match")?.treads) }
    pub(crate) fn take_tail(&mut self, id: u32) -> Result<Option<Tail>, String> { Ok(self.states.get_mut(&id).ok_or("Unknown resident match")?.tail.take()) }
}
