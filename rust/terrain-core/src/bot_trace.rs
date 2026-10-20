//! Engine v16 resident bot traces. A controller's trace request runs on the
//! match's live flight environment and composed query lease, charged against
//! the match-owned query meter, with the host trace's step/cost/termination order.
use crate::{core::Outcome, flight::{Flight, Flights}, match_state::Matches, physics::Physics, traversal::Queries};
type V = [f64; 3];
pub(crate) struct Step { pub from: V, pub to: V, pub hit: bool, pub expired: bool }
pub(crate) struct Trace { pub id: f64, flight: Flight, context: u32, pub done: bool, pub impact: Option<V> }
/// [kind, id, range] of a composed (kind 2) query lease whose ray/surface
/// results are the world's own. Scene leases cannot answer surface queries.
pub(crate) fn lease(d: &[f64]) -> Outcome<[f64; 3]> {
    if d.len() < 3 || d[0] != 2. || !(d[1] >= 0. && d[1] <= u32::MAX as f64 && d[1].fract() == 0.) || !(d[2] > 0. && d[2].is_finite()) { return Err("Invalid resident bot query lease".into()); }
    Ok([d[0], d[1], d[2]])
}
fn words(d: &[u8]) -> Vec<f64> { d.chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect() }
/// Ray (op 0) or surface (op 5) on the lease: None for a miss, else the decoded hit words.
pub(crate) fn query(queries: &mut Queries, lease: &[f64; 3], op: u32, args: &[f64], physics: Option<&Physics>) -> Outcome<Option<Vec<f64>>> {
    let mut out = Vec::new(); queries.flight_query(lease[0] as u32, lease[1] as u32, op, args, lease[2], physics, &mut out)?;
    Ok(if out.is_empty() { None } else { Some(words(&out)) })
}
impl Trace {
    pub fn new(matches: &Matches, owner: u32, unit: usize, aim: [f64; 3], launch: Option<f64>, id: f64) -> Outcome<Self> {
        let (flight, context) = matches.bot_trace_flight(owner, unit, aim, launch)?;
        Ok(Self { id, flight, context, done: false, impact: None })
    }
    /// None when the trace is finished or the meter refuses the step's cost.
    pub fn step(&mut self, matches: &mut Matches, owner: u32, flights: &mut Flights, queries: &mut Queries, physics: Option<&Physics>, lease: &[f64; 3]) -> Outcome<Option<Step>> {
        if self.done { return Ok(None); }
        if !matches.meter_charge(owner, if self.flight.age == 0. { 2. } else { 1. }, false)? { return Ok(None); }
        let from = self.flight.p; let mut out = Vec::new();
        self.flight = flights.live(self.context, self.flight, lease, queries, physics, &mut out)?;
        let w = words(&out);
        if w.len() == 21 { let p = [w[14], w[15], w[16]]; self.done = true; self.impact = Some(p); return Ok(Some(Step { from, to: p, hit: true, expired: false })); }
        // An unstepped launch-guard result never expires the flight.
        let expired = w[7] == 1. && w[8] == 1.; if expired { self.done = true; }
        Ok(Some(Step { from, to: self.flight.p, hit: false, expired }))
    }
    pub fn canonical(&self, w: &mut crate::canonical::Writer) {
        w.number(self.id); self.flight.canonical(w); w.integer(self.context as u64); w.flag(self.done); w.option(&self.impact, |w, p| w.words(p));
    }
}
