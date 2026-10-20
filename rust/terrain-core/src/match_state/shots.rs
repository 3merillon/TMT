//! Match-owned live shots. Preview flights retain their independent environment
//! API; live identity, metadata, integration state and retirement stay here.
use super::{Match,finite,flag,integer,output};
use super::armament::{v,len};
use crate::{flight::{Flight,Flights},combat::Combats,traversal::Queries,physics::Physics};

// Row: id, owner, ammo (-1 = default), position3, velocity3, age,
// launch-present, launch-tick, origin-present, origin3, peak-present, peak.
#[derive(Clone)]
struct Shot {row:[f64;18]}
impl Shot {
    fn read(d:&[f64],n:usize)->Result<Self,String>{
        finite(d,18)?;
        if d[0]< -1.||d[0]>9007199254740991.||d[0].fract()!=0.||!integer(d[1])||d[1]>=n as f64||d[2]< -1.||d[2]>3.||d[2].fract()!=0.||d[9]<0.
            ||!flag(d[10])||!integer(d[11])||!flag(d[12])||!flag(d[16]){return Err("Invalid live shot".into());}
        Ok(Self{row:d.try_into().unwrap()})
    }
    fn flight(&self,kits:&[[f64;5]])->Flight {let r=&self.row;let kit=kits[r[1] as usize];Flight::new(v(r,3),v(r,6),r[9],if r[10]==1.{r[11]}else{0.},kit[0],kit[1+r[2].max(0.) as usize])}
}
// A callback may edit display metadata without resetting a same-ID integrator.
// Preserve that distinction, including an already-advanced flight if it throws.
struct Pending {shot:Shot,before:Flight,next:Flight,words:Vec<f64>}
pub(super) struct Shots {context:u32,kits:Vec<[f64;5]>,records:Vec<Shot>,active:Option<(f64,Flight)>,pending:Option<Pending>}
fn words(d:&[u8])->Vec<f64>{d.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect()}
impl Shots {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer,flights:&Flights)->Result<(),String>{
        let mut env=crate::canonical::Writer::default();flights.canonical_environment(self.context,&mut env)?;
        w.section(9,|w|w.bytes.extend(env.bytes));
        w.section(10,|w|{w.list(&self.kits,|w,k|w.words(k));w.list(&self.records,|w,s|w.words(&s.row));
            w.option(&self.active,|w,(id,f)|{w.number(*id);f.canonical(w);});
            w.option(&self.pending,|w,p|{w.words(&p.shot.row);p.before.canonical(w);p.next.canonical(w);w.words(&p.words);});});Ok(())
    }
    pub fn count(&self)->f64 {self.records.len() as f64}
    pub(super) fn kit(&self,unit:usize)->[f64;5] {self.kits[unit]}
    pub(super) fn context(&self)->u32 {self.context}
    pub fn retire(&mut self){self.records.clear();self.active=None;self.pending=None;}
    pub fn launch(&mut self,id:f64,owner:usize,p:&[f64]) {
        self.records=vec![Shot{row:[id,owner as f64,p[9],p[0],p[1],p[2],p[6],p[7],p[8],0.,1.,p[10],1.,p[0],p[1],p[2],1.,p[11]]}];
    }
    fn snapshot(&self)->Vec<f64>{let mut w=vec![self.count()];for s in &self.records{w.extend(s.row);}w}
    fn flight(&self)->Result<Flight,String>{let s=self.records.first().ok_or("No live shot")?;Ok(self.active.filter(|a|a.0==s.row[0]).map_or_else(||s.flight(&self.kits),|a|a.1))}
}
impl Match {
    // 48 admission; 49 output; 50 begin segment; 51 finish after ordered hooks;
    // 52 retire; 53 kit; 54/55 explicit list/pending edits; 56 abort hook;
    // 57 physical output; 58 atomic masked edits of existing display records.
    pub(super) fn shot_command(&mut self,op:u32,d:&[f64],combats:&mut Combats,queries:&mut Queries,physics:Option<&Physics>,flights:&mut Flights,out:&mut Vec<u8>)->Result<(),String>{
        if !matches!(op,49|57)&&self.observations.as_ref().is_some_and(|o|o.busy()){return Err("Observation query is pending".into());}
        let n=self.units.len();
        if op==48 {
            finite(d,2+5*n)?;if d[0]!=1.||!integer(d[1])||d[1]>u32::MAX as f64||d[2..].iter().any(|&v|v<0.)||self.shots.is_some()||self.bot_inputs.is_none()||self.tick!=0.{return Err("Invalid live shot admission".into());}
            flights.require(d[1] as u32)?;
            self.shots=Some(Shots{context:d[1] as u32,kits:d[2..].chunks_exact(5).map(|r|r.try_into().unwrap()).collect(),records:Vec::new(),active:None,pending:None});output(out,&[]);return Ok(());
        }
        let s=self.shots.as_mut().ok_or("Resident live shots are absent")?;
        match op {
            49=>{finite(d,0)?;output(out,&s.snapshot());},
            50=>{
                if d.len()!=3&&d.len()!=11{return Err("Invalid live shot step".into());}finite(d,d.len())?;
                if s.pending.is_some(){return Err("Live shot step is pending".into());}
                let shot=s.records.first().ok_or("No live shot")?.clone();let before=s.flight()?;
                let next=if d.len()==11 {
                    if d[0]!=0.||d[1]!=0.||d[2]!=1.||before.age!=0.||d[3]<0.{return Err("Invalid analytic launch guard".into());}flights.require(s.context)?;
                    let mut w=before.p.to_vec();w.extend(before.velocity);w.extend([before.age,0.,0.,0.,1.,0.,0.]);w.extend(&d[3..]);output(out,&w);before
                }else{flights.live(s.context,before,d,queries,physics,out)?};
                s.active=Some((shot.row[0],next));s.pending=Some(Pending{shot,before,next,words:words(out)});
            },
            51=>{
                if !d.is_empty(){finite(d,8)?;if d[0]<0.{return Err("Invalid shot hit".into());}}
                let p=s.pending.as_ref().ok_or("No live shot step is pending")?;
                let mut hit=if p.words.len()==21{p.words[13..].to_vec()}else{Vec::new()};
                if !d.is_empty()&&(hit.is_empty()||d[0]<hit[0]){hit=d.to_vec();}
                let mut victim=-1.;let stepped=p.words[7];let expired=p.words[8];
                if stepped==1. {
                    let mut r=p.before.p.to_vec();r.extend(&p.words[9..12]);r.extend([p.words[12],p.before.age,p.shot.row[1],1.,0.,0.,0.,0.,1.,(!hit.is_empty()) as u8 as f64]);
                    r.extend(if hit.is_empty(){vec![0.;8]}else{hit});for u in &self.motion.as_ref().unwrap().units{r.extend(&u.cur[..3]);}
                    combats.command(self.combat.unwrap(),7,&r,queries,physics,out)?;let resolved=words(out);victim=resolved[0];hit=if resolved.len()==10{resolved[2..].to_vec()}else{Vec::new()};
                }
                // Finish output: victim, stepped, expired, hit-present, hit8,
                // pre-step display row18, then count + current display rows.
                let p=s.pending.take().unwrap();let mut result=vec![victim,stepped,expired,(!hit.is_empty()) as u8 as f64];result.extend(if hit.is_empty(){vec![0.;8]}else{hit.clone()});result.extend(p.shot.row);
                if !hit.is_empty(){s.active=None;}
                else if expired==1.{s.retire();}
                else {let mut row=p.shot.row;row[3..6].copy_from_slice(&p.next.p);row[6..9].copy_from_slice(&p.next.velocity);row[9]=p.next.age;
                    let peak=len(p.next.p)-self.arsenal.as_ref().unwrap().bot_weapon(row[1] as usize)[2];row[17]=if row[16]==1.{row[17].max(peak)}else{peak};row[16]=1.;s.records=vec![Shot{row}];}
                result.extend(s.snapshot());output(out,&result);
            },
            52=>{finite(d,0)?;s.retire();output(out,&s.snapshot());},
            53=>{finite(d,6)?;if !integer(d[0])||d[0]>=n as f64||d[1..].iter().any(|&v|v<0.)||self.phase!=0||self.arsenal.as_ref().unwrap().kit_locked(){return Err("Invalid live shot kit update".into());}s.kits[d[0] as usize].copy_from_slice(&d[1..]);output(out,&[]);},
            54=>{
                if d.is_empty()||!integer(d[0])||d[0]>4096.{return Err("Invalid live shot edit".into());}finite(d,1+18*d[0] as usize)?;
                let records=d[1..].chunks_exact(18).map(|r|Shot::read(r,n)).collect::<Result<Vec<_>,_>>()?;s.records=records;output(out,&[]);
            },
            55=>{let shot=Shot::read(d,n)?;s.pending.as_mut().ok_or("No live shot step is pending")?.shot=shot;output(out,&[]);},
            56=>{finite(d,0)?;s.pending=None;output(out,&[]);},
            57=>{finite(d,0)?;let f=s.flight()?;let mut w=f.p.to_vec();w.extend(f.velocity);w.push(f.age);output(out,&w);},
            58=>{
                if d.is_empty()||!integer(d[0])||d[0]>s.count(){return Err("Invalid live shot field edits".into());}finite(d,d.len())?;
                let mut records=s.records.clone();let mut at=1;let mut seen=Vec::new();
                for _ in 0..d[0] as usize {if at+2>d.len(){return Err("Invalid live shot field edits".into());}let id=d[at];let mask=d[at+1];at+=2;
                    if !integer(id)||id>=records.len() as f64||seen.contains(&(id as usize))||!integer(mask)||mask<1.||mask>262143.{return Err("Invalid live shot field mask".into());}seen.push(id as usize);
                    let mut row=records[id as usize].row;for i in 0..18 {if (mask as u32)&(1<<i)!=0 {if at==d.len(){return Err("Invalid live shot field edits".into());}row[i]=d[at];at+=1;}}
                    records[id as usize]=Shot::read(&row,n)?;
                }
                if at!=d.len(){return Err("Invalid live shot field edits".into());}s.records=records;output(out,&[]);
            },
            _=>return Err("Unknown live shot operation".into()),
        }Ok(())
    }
}
