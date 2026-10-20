//! Shared match/chassis state. Body poses and pending recoil/blast velocity stay
//! resident; only explicit tool/extension edits cross back into the component.
use super::{Match,finite,integer,output};
use super::armament::{v,q,rotate,norm,add,sub,mul};
use crate::{combat::Combats,traversal::Queries,physics::Physics};
type V=[f64;3];
fn dot(a:V,b:V)->f64 {a[0]*b[0]+a[1]*b[1]+a[2]*b[2]}
fn cross(a:V,b:V)->V {[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]}
fn index(x:f64,n:usize)->Result<usize,String>{if integer(x)&&x<n as f64{Ok(x as usize)}else{Err("Invalid motion unit".into())}}
pub(super) struct Unit {
    // position3, rotation4, velocity3, heading, yawVelocity, recoil, trackPhase, phases2.
    pub cur:[f64;16],pub before:[f64;7],base:V,body:Option<u32>,
}
pub(super) struct Motion {pub units:Vec<Unit>}
impl Motion {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){w.list(&self.units,|w,u|{w.words(&u.cur);w.words(&u.before);w.words(&u.base);});}
    pub(super) fn canonical_physics(&self,w:&mut crate::canonical::Writer,p:Option<&Physics>)->Result<(),String>{
        // Unit order is stable; allocation handles and unrelated bodies are not
        // part of a match checksum. Solver warm-start internals are not a restore image.
        let mut rows=Vec::new();for u in &self.units{let mut row=crate::canonical::Writer::default();row.flag(u.body.is_some());
            if let Some(id)=u.body{p.ok_or("Engine physics is absent")?.canonical_body(id,&mut row)?;}rows.push(row.bytes);}
        w.section(11,|w|w.list(&rows,|w,row|{w.integer(row.len() as u64);w.bytes.extend(row);}));Ok(())
    }
    pub fn begin_tick(&mut self){for u in &mut self.units {u.before.copy_from_slice(&u.cur[..7]);}}
    fn snapshot(&self)->Vec<f64>{self.units.iter().flat_map(|u|u.cur).collect()}
    pub fn poses(&self)->Vec<f64>{self.units.iter().flat_map(|u|u.cur[..7].iter().copied()).collect()}
    fn bodies(&self)->Result<Vec<u32>,String>{self.units.iter().map(|u|u.body.ok_or("Match chassis is not bound".into())).collect()}
    fn after_step(&mut self,physics:&Physics,dt:f64)->Result<(),String>{
        // Validate/read the complete batch before publishing any output.
        let rows=self.bodies()?.into_iter().map(|id|Ok((physics.body_motion(id)?,physics.drive(id)?.speeds()))).collect::<Result<Vec<_>,String>>()?;
        for (u,(r,speeds)) in self.units.iter_mut().zip(rows) {
            u.cur[..10].copy_from_slice(&r[..10]);u.base=v(&r,7);
            let up=rotate([0.,1.,0.],q(&r,3));let forward=rotate([0.,0.,1.],q(&r,3));let upn=norm(up);
            let reference=if upn[2].abs()<0.96{[0.,0.,1.]}else{[1.,0.,0.]};
            let base=norm(sub(reference,mul(upn,dot(reference,upn))));let right=norm(cross(upn,base));
            let f=add(mul(base,1.),mul(right,0.));let right=norm(cross(upn,f));
            u.cur[10]=dot(forward,right).atan2(dot(forward,f));u.cur[11]=dot(v(&r,10),up);u.cur[12]*=(-6.*dt).exp();
            u.cur[14]+=speeds[0]*dt;u.cur[15]+=speeds[1]*dt;u.cur[13]=(u.cur[14]+u.cur[15])*0.5;
        }Ok(())
    }
}
impl Match {
    pub(super) fn motion_command(&mut self,op:u32,d:&[f64],combats:&mut Combats,queries:&mut Queries,physics:Option<&mut Physics>,out:&mut Vec<u8>)->Result<(),String>{
        let n=self.units.len();
        if op!=42&&self.observations.as_ref().is_some_and(|o|o.busy()){return Err("Observation query is pending".into());}
        if op==37 {
            finite(d,1+16*n)?;if d[0]!=1.||self.motion.is_some()||self.journal.is_none()||self.tick!=0.{return Err("Invalid match motion admission".into());}
            let units=d[1..].chunks_exact(16).map(|r|Unit{cur:r.try_into().unwrap(),before:r[..7].try_into().unwrap(),base:v(r,7),body:None}).collect();
            self.motion=Some(Motion{units});output(out,&[]);return Ok(());
        }
        let m=self.motion.as_mut().ok_or("Resident match motion is absent")?;
        match op {
            38=>{
                if d.is_empty()||!integer(d[0])||d[0]>n as f64{return Err("Invalid chassis binding".into());}finite(d,1+2*d[0] as usize)?;
                let p=physics.ok_or("Engine physics is absent")?;let mut bodies:Vec<Option<u32>>=m.units.iter().map(|u|u.body).collect();let mut seen=Vec::new();
                for row in d[1..].chunks_exact(2){let id=index(row[0],n)?;if seen.contains(&id)||!integer(row[1])||row[1]>u32::MAX as f64{return Err("Invalid chassis binding".into());}seen.push(id);
                    let body=row[1] as u32;p.body(body)?;if p.drive(body)?.control.is_none(){return Err("Native chassis control is absent".into());}bodies[id]=Some(body);
                }
                for i in 0..n {if bodies[i].is_some()&&bodies[..i].contains(&bodies[i]){return Err("Duplicate match chassis".into());}}
                for (u,body) in m.units.iter_mut().zip(bodies){if u.body!=body {u.body=body;u.base=v(&u.cur,7);}}
                output(out,&[]);
            },
            39=>{finite(d,1)?;if d[0]<=0.{return Err("Invalid motion timestep".into());}m.after_step(physics.ok_or("Engine physics is absent")?,d[0])?;output(out,&m.snapshot());},
            40=>{
                if d.len()<15{return Err("Invalid resident impact".into());}finite(d,15+if d[12]==0.{n}else{0})?;
                let mut words=d[..15].to_vec();for (id,u) in m.units.iter().enumerate(){words.extend(&u.cur[..10]);words.push(if d[12]==0.{d[15+id]}else{0.});}
                combats.command(self.combat.unwrap(),6,&words,queries,physics.as_deref(),out)?;
                let result:Vec<f64>=out.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect();
                for row in result[1..1+result[0] as usize*10].chunks_exact(10){m.units[row[0] as usize].cur[7..10].copy_from_slice(&row[7..10]);}
            },
            41=>{finite(d,24)?;let mut words=d.to_vec();for u in &m.units{words.extend(&u.cur[..3]);}combats.command(self.combat.unwrap(),7,&words,queries,physics.as_deref(),out)?;},
            42=>{finite(d,0)?;output(out,&m.snapshot());},
            43=>{finite(d,0)?;let ids=m.bodies()?;physics.ok_or("Engine physics is absent")?.command(70,0,&ids.iter().map(|&x|x as f64).collect::<Vec<_>>(),out)?;},
            44=>{
                if d.len()<5||!integer(d[4])||d[4]>n as f64{return Err("Invalid resident chassis tick".into());}finite(d,5+d[4] as usize*7)?;
                let c=combats.get(self.combat.unwrap())?;let mut words=d[..5].to_vec();let mut seen=Vec::new();
                for row in d[5..].chunks_exact(7){let id=index(row[0],n)?;if seen.contains(&id){return Err("Duplicate resident chassis tick".into());}seen.push(id);let u=&m.units[id];
                    words.push(u.body.ok_or("Match chassis is not bound")? as f64);words.extend(&row[1..4]);words.push((c.units[id].health>0.) as u8 as f64);words.extend(&row[4..7]);words.extend(sub(v(&u.cur,7),u.base));
                }
                physics.ok_or("Engine physics is absent")?.command(71,0,&words,out)?;
            },
            45=>{
                if d.is_empty()||!integer(d[0])||d[0]>n as f64{return Err("Invalid motion edit".into());}finite(d,d.len())?;let mut at=1;let mut updates=Vec::new();let mut seen=Vec::new();
                for _ in 0..d[0] as usize {
                    if at+2>d.len(){return Err("Invalid motion edit length".into());}let id=index(d[at],n)?;let mask=d[at+1];at+=2;
                    if seen.contains(&id)||!integer(mask)||mask<1.||mask>65535.{return Err("Invalid motion edit mask".into());}seen.push(id);let mask=mask as u32;let mut row=m.units[id].cur;
                    for i in 0..16 {if mask&(1<<i)!=0{if at==d.len(){return Err("Invalid motion edit length".into());}row[i]=d[at];at+=1;}}updates.push((id,row));
                }
                if at!=d.len(){return Err("Invalid motion edit length".into());}for (id,row) in updates{m.units[id].cur=row;}output(out,&m.snapshot());
            },
            _=>return Err("Unknown match motion operation".into()),
        }Ok(())
    }
}
