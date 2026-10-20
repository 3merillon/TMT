//! Resident ballistic flights and the shared deterministic weather timeline.
//! One step includes launch clearance and terrain CCD when a resident query is
//! supplied. Extension/entity hit policy is applied by the host after this result.
use std::collections::HashMap;
use crate::{core::Outcome, physics::Physics, traversal::Queries};
const DT: f64 = 1. / 60.;
type V = [f64; 3];
fn v(d: &[f64], i: usize) -> V { [d[i], d[i+1], d[i+2]] }
fn len(p: V) -> f64 { let m = p[0].abs().max(p[1].abs()).max(p[2].abs()); if m == 0. { 0. } else { let a = [p[0]/m, p[1]/m, p[2]/m]; (a[0]*a[0]+a[1]*a[1]+a[2]*a[2]).sqrt()*m } }
fn normal(p: V) -> V { let n = len(p); if n > 1e-10 { let s = 1./n; [p[0]*s,p[1]*s,p[2]*s] } else { [0.,1.,0.] } }
fn valid(d: &[f64], size: usize) -> Outcome<()> { if d.len() != size || d.iter().any(|n| !n.is_finite()) { Err("Invalid flight descriptor".into()) } else { Ok(()) } }
fn integer(x: f64) -> bool { x >= 0. && x <= 9007199254740991. && x.fract() == 0. }
fn write(out: &mut Vec<u8>, d: &[f64]) { out.clear(); for n in d { out.extend_from_slice(&n.to_le_bytes()); } }
fn word(d: &[u8], i: usize) -> f64 { f64::from_le_bytes(d[i*8..i*8+8].try_into().unwrap()) }
fn js_i32(x: f64) -> i32 { x.trunc().rem_euclid(4294967296.) as u32 as i32 }
fn hash(i: f64, seed: u32) -> f64 {
    let mut h = js_i32(i).wrapping_mul(374761393).wrapping_add((seed as i32).wrapping_mul(0x9e3779b1u32 as i32));
    h = (h ^ (h >> 13)).wrapping_mul(1274126177); h ^= h >> 16;
    ((h as u32) & 0x7fffffff) as f64 / 0x3fffffff as f64 - 1.
}
fn smooth(t: f64, seed: u32) -> f64 { let i = t.floor(); let f = t-i; let u = f*f*(3.-2.*f); hash(i,seed)*(1.-u)+hash(i+1.,seed)*u }
fn fbm(t: f64, seed: u32) -> f64 { smooth(t,seed)*0.6+smooth(t*2.7,seed^0x5b5b)*0.28+smooth(t*6.1,seed^0xa7a7)*0.12 }
#[derive(Clone, Copy)]
struct Weather { seed: u32, mean: f64, gust: f64, period: f64 }
impl Weather {
    fn sample(&self, tick: f64) -> [f64; 7] {
        let base = tick*DT/self.period;
        let bars = (self.mean+self.gust*fbm(base*1.7+41.3,self.seed^0x71bd)).clamp(0.,5.);
        let heading = (hash(0x5eed as f64,self.seed)+1.)*std::f64::consts::PI+0.6*fbm(base/6.+7.9,self.seed^0xd1a0);
        [tick,bars*0.24,bars,heading,heading.cos(),0.,-heading.sin()]
    }
}
#[derive(Clone, Copy)]
pub(crate) struct Flight { pub p: V, pub velocity: V, pub age: f64, pub launch: f64, barrel: f64, factor: f64 }
struct Environment { gravity: f64, radius: f64, max_age: f64, weather: Option<Weather>, next: u32, flights: HashMap<u32, Flight>, scratch: Vec<u8> }
#[derive(Default)]
pub struct Flights { next: u32, environments: HashMap<u32, Environment> }
impl Flights {
    pub(crate) fn canonical_environment(&self,id:u32,w:&mut crate::canonical::Writer)->Outcome<()>{
        let e=self.environments.get(&id).ok_or("Unknown flight environment")?;
        w.words(&[e.gravity,e.radius,e.max_age]);w.option(&e.weather,|w,e|{w.integer(e.seed as u64);w.words(&[e.mean,e.gust,e.period]);});Ok(())
    }
    pub fn create(&mut self, d: &[f64]) -> Outcome<u32> {
        valid(d,9)?;
        if d[0] != 1. || d[1] < 0. || d[2] <= 0. || d[3] < 0. || !integer(d[4]) || d[4] > u32::MAX as f64
            || (d[5] != 0. && d[5] != 1.) || d[6] < 0. || d[7] < 0. || d[8] <= 0. { return Err("Invalid flight environment".into()); }
        let weather = if d[5] == 0. { None } else { Some(Weather { seed: d[4] as u32, mean: d[6], gust: d[7], period: d[8] }) };
        self.next = self.next.checked_add(1).ok_or("Flight environments exhausted")?;
        self.environments.insert(self.next, Environment { gravity:d[1],radius:d[2],max_age:d[3],weather,next:0,flights:HashMap::new(),scratch:Vec::new() }); Ok(self.next)
    }
    pub(crate) fn require(&self,id:u32)->Outcome<()> {if self.environments.contains_key(&id){Ok(())}else{Err("Unknown flight environment".into())}}
    pub(crate) fn live(&mut self,context:u32,f:Flight,d:&[f64],queries:&mut Queries,physics:Option<&Physics>,out:&mut Vec<u8>)->Outcome<Flight> {self.environments.get_mut(&context).ok_or("Unknown flight environment")?.advance(f,d,queries,physics,out)}
    pub fn remove(&mut self, id: u32) { self.environments.remove(&id); }
    pub fn command(&mut self, context: u32, op: u32, id: u32, d: &[f64], queries: &mut Queries, physics: Option<&Physics>, out: &mut Vec<u8>) -> Outcome<()> {
        let e = self.environments.get_mut(&context).ok_or("Unknown flight environment")?;
        match op {
            0 => { valid(d,1)?; if !integer(d[0]) { return Err("Invalid wind tick".into()); } if let Some(w) = e.weather { write(out,&w.sample(d[0])); } else { out.clear(); } }
            1 => {
                valid(d,10)?;
                if d[6] < 0. || !integer(d[7]) || d[8] < 0. || d[9] < 0. { return Err("Invalid flight admission".into()); }
                e.next = e.next.checked_add(1).ok_or("Flight handles exhausted")?;
                e.flights.insert(e.next,Flight { p:v(d,0),velocity:v(d,3),age:d[6],launch:d[7],barrel:d[8],factor:d[9] }); write(out,&[e.next as f64]);
            }
            2 => { let f=*e.flights.get(&id).ok_or("Unknown resident flight")?;let next=e.advance(f,d,queries,physics,out)?;e.flights.insert(id,next); },
            3 => { valid(d,0)?; e.flights.remove(&id); out.clear(); }
            4 => { valid(d,0)?; let f = e.flights.get(&id).ok_or("Unknown resident flight")?; write(out,&[f.p[0],f.p[1],f.p[2],f.velocity[0],f.velocity[1],f.velocity[2],f.age]); }
            5 => { valid(d,0)?; write(out,&[e.flights.len() as f64]); }
            _ => return Err("Unknown flight command".into()),
        }
        Ok(())
    }
}

impl Environment {
    fn advance(&mut self,mut f:Flight,d:&[f64],queries:&mut Queries,physics:Option<&Physics>,out:&mut Vec<u8>)->Outcome<Flight> {
                valid(d,3)?;
                if !integer(d[0]) || d[0] > 2. || !integer(d[1]) || d[1] > u32::MAX as f64 || d[2] <= 0. { return Err("Invalid flight query".into()); }
                let old = f.p; let mut stepped = true;
                let query = |op, args: &[f64], q: &mut Queries, scratch: &mut Vec<u8>| q.flight_query(d[0] as u32,d[1] as u32,op,args,d[2],physics,scratch);
                self.scratch.clear();
                if f.age == 0. && d[0] != 0. {
                    let u = normal(f.velocity); let b = [old[0]-u[0]*f.barrel,old[1]-u[1]*f.barrel,old[2]-u[2]*f.barrel];
                    query(0,&[b[0],b[1],b[2],u[0],u[1],u[2],f.barrel],queries,&mut self.scratch)?;
                    if !self.scratch.is_empty() { stepped = false; }
                    else {
                        query(4,&old,queries,&mut self.scratch)?;
                        let solid = word(&self.scratch,0) != 0.; self.scratch.clear();
                        if solid { let n = normal(old); write(&mut self.scratch,&[0.,old[0],old[1],old[2],n[0],n[1],n[2],0.]); stepped = false; }
                    }
                }
                let mut expired = false; let mut direction = [0.,1.,0.]; let mut extent = 0.;
                if stepped {
                    let n = normal(old); let g = -self.gravity*DT;
                    for i in 0..3 { f.velocity[i] += n[i]*g; }
                    if let Some(w) = self.weather {
                        if f.factor != 0. {
                            let tick = f.launch+1.+(f.age/DT).round(); if !integer(tick) { return Err("Invalid wind tick".into()); }
                            let wind = w.sample(tick); let length = len(old);
                            if wind[1] != 0. && length > 1e-9 {
                                let [x,y,z] = [old[0]/length,old[1]/length,old[2]/length]; let a = v(&wind,4); let s = wind[1]; let k = f.factor*DT;
                                let force = [(a[1]*z-a[2]*y)*s,(a[2]*x-a[0]*z)*s,(a[0]*y-a[1]*x)*s];
                                for i in 0..3 { f.velocity[i] += force[i]*k; }
                            }
                        }
                    }
                    for i in 0..3 { f.p[i] = old[i]+f.velocity[i]*DT; } f.age += DT;
                    let delta = [f.p[0]-old[0],f.p[1]-old[1],f.p[2]-old[2]]; direction = normal(delta); extent = len(delta);
                    query(0,&[old[0],old[1],old[2],direction[0],direction[1],direction[2],extent],queries,&mut self.scratch)?;
                    expired = f.age+1e-9 >= self.max_age || len(f.p) > self.radius*5.;
                }
                // A missing/stale query or bad descriptor never advances the flight.
                write(out,&[f.p[0],f.p[1],f.p[2],f.velocity[0],f.velocity[1],f.velocity[2],f.age,stepped as u8 as f64,expired as u8 as f64,direction[0],direction[1],direction[2],extent]); out.extend_from_slice(&self.scratch);
        Ok(f)
    }
}

impl Flight {
    pub(crate) fn new(p:V,velocity:V,age:f64,launch:f64,barrel:f64,factor:f64)->Self {Self{p,velocity,age,launch,barrel,factor}}
    pub(crate) fn canonical(&self,w:&mut crate::canonical::Writer){w.words(&self.p);w.words(&self.velocity);w.words(&[self.age,self.launch,self.barrel,self.factor]);}
}
