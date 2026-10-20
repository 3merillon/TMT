//! Authoritative input journal and replay boundary scheduler. Presentation and
//! extension calls remain in the host; the cursor, drive, target and expected
//! hash never read back JavaScript output mirrors. Rows use the existing v2
//! command vocabulary; the JSON envelope remains a platform transport.
use super::{Match,finite,flag,integer,output};
const NAMES:[&str;7]=["aim","fire","munition","scan","endMove","drive","hold"];
#[derive(Clone,Copy,PartialEq)]
struct Command {tick:f64,tank:usize,kind:usize,args:[f64;3]}
impl Command {
    fn read(d:&[f64],n:usize)->Result<Self,String> {
        finite(d,6)?;
        if !integer(d[0])||!integer(d[1])||d[1]>=n as f64||!integer(d[2])||d[2]>6. {return Err("Invalid replay command".into());}
        let kind=d[2] as usize;
        if (kind==2&&(!integer(d[3])||d[3]>3.))
            ||(kind!=0&&d[5]!=0.)||(kind!=0&&kind!=5&&d[4]!=0.)||(kind!=0&&kind!=2&&kind!=5&&d[3]!=0.) {return Err("Invalid replay command payload".into());}
        Ok(Self{tick:d[0],tank:d[1] as usize,kind,args:[d[3],d[4],d[5]]})
    }
    fn append(&self,w:&mut Vec<f64>){w.extend([self.tick,self.tank as f64,self.kind as f64,self.args[0],self.args[1],self.args[2]]);}
}
#[derive(Clone,Copy)]
enum Pending {Boundary(f64),Command(usize,usize),Step(f64)}
struct Replay {commands:Vec<Command>,cursor:usize,target:f64,hash:[u32;2],drive:[f64;2],applied:f64,boundary:Option<f64>,pending:Option<Pending>}
pub(super) struct Journal {commands:Vec<Command>,human:Vec<bool>,drive:[f64;2],replay:Option<Replay>}
impl Journal {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){
        w.words(&self.drive);w.list(&self.human,|w,v|w.flag(*v));
        w.list(&self.commands,|w,c|{w.words(&[c.tick,c.tank as f64,c.kind as f64]);w.words(&c.args);});
    }
}
impl Replay {
    fn words(&self)->Vec<f64> {
        match self.pending {
            Some(Pending::Boundary(_))=>vec![1.],
            Some(Pending::Command(i,_))=>{let c=self.commands[i];vec![2.,i as f64,c.tank as f64,c.kind as f64,c.args[0],c.args[1],c.args[2]]},
            Some(Pending::Step(_))=>vec![3.,self.drive[0],self.drive[1]],
            None=>vec![0.],
        }
    }
    fn next(&mut self,tick:f64,logged:usize)->Result<Vec<f64>,String> {
        if let Some(p)=self.pending {
            let expected=match p{Pending::Boundary(t)|Pending::Step(t)=>t,Pending::Command(i,_)=>self.commands[i].tick};
            if expected!=tick {return Err("Replay advanced outside its boundary".into());}return Ok(self.words());
        }
        if self.applied!=tick {
            if self.boundary!=Some(tick) {self.pending=Some(Pending::Boundary(tick));return Ok(self.words());}
            while self.cursor<self.commands.len() {
                let c=self.commands[self.cursor];if c.tick<tick{return Err("Replay skipped a command boundary".into());}if c.tick>tick{break;}
                if c.kind==5{self.drive=[c.args[0],c.args[1]];self.cursor+=1;}
                else{self.pending=Some(Pending::Command(self.cursor,logged));return Ok(self.words());}
            }
            self.applied=tick;self.boundary=None;
        }
        if tick<self.target {self.pending=Some(Pending::Step(tick));}
        Ok(self.words())
    }
    fn ack(&mut self,d:&[f64],tick:f64,finished:bool,logged:&[Command])->Result<bool,String> {
        finite(d,2)?;if !flag(d[1]){return Err("Invalid replay response".into());}
        match self.pending.ok_or("No replay request pending")? {
            Pending::Boundary(t)=>{if d[0]!=1.||tick!=t{return Err("Invalid replay boundary response".into());}if d[1]==0.{return Ok(true);}self.boundary=Some(t);},
            Pending::Command(i,before)=>{if d[0]!=2.||tick!=self.commands[i].tick{return Err("Invalid replay command response".into());}
                if d[1]==0.{return Err(format!("Replay diverged: command {} ({}) was refused at tick {}",i,NAMES[self.commands[i].kind],tick));}
                if logged.len()!=before+1||logged[before]!=self.commands[i]{return Err("Replay command was not admitted by the resident match".into());}self.cursor+=1;},
            Pending::Step(t)=>{if d[0]!=3.||d[1]!=1.||tick<t||tick>t+1.{return Err("Invalid replay tick response".into());}
                if tick==t {if finished{return Err(format!("Replay diverged: the match finished at tick {}, before the checkpoint tick {}",tick,self.target));}
                    self.pending=None;return Ok(true);}
            },
        }
        self.pending=None;Ok(false)
    }
}
impl Match {
    /// The action's own successful transaction appends the original input, before
    /// publishing mirrors or notifying the host. Brain/internal actions omit it.
    pub(super) fn record_action(&mut self,kind:u8,tank:usize,d:&[f64]) {
        if let Some(j)=&mut self.journal {
            let kind=match kind{0=>0,1=>1,2=>2,3=>3,4=>6,5=>4,_=>return};
            let args=match kind{0=>[d[0],d[1],d[2]],2=>[d[0],0.,0.],_=>[0.;3]};
            j.commands.push(Command{tick:self.tick,tank,kind,args});
        }
    }
    pub(super) fn journal_command(&mut self,op:u32,d:&[f64],out:&mut Vec<u8>)->Result<(),String> {
        let n=self.units.len();
        if op==27 {
            finite(d,1+n)?;if d[0]!=1.||d[1..].iter().any(|&x|!flag(x))||self.journal.is_some()||self.tick!=0.||self.observations.is_none(){return Err("Invalid journal admission".into());}
            self.journal=Some(Journal{commands:Vec::new(),human:d[1..].iter().map(|&v|v==1.).collect(),drive:[0.;2],replay:None});output(out,&[]);return Ok(());
        }
        if !matches!(op,31|35|36)&&self.observations.as_ref().is_some_and(|o|o.busy()){return Err("Observation query is pending".into());}
        let j=self.journal.as_mut().ok_or("Resident journal is absent")?;
        match op {
            30=>{
                finite(d,2)?;let drive=[d[0].clamp(-1.,1.),d[1].clamp(-1.,1.)];
                let movable=self.drive||(self.phase==1&&self.move_time>0.&&self.arsenal.as_ref().unwrap().units[self.active].movement>0.);
                if movable&&j.human[self.active]&&drive!=j.drive {j.commands.push(Command{tick:self.tick,tank:self.active,kind:5,args:[drive[0],drive[1],0.]});j.drive=drive;}
                output(out,&[]);
            },
            31=>{
                finite(d,2)?;if !integer(d[0])||d[0]>j.commands.len() as f64||!integer(d[1])||d[1]<1.||d[1]>4096.{return Err("Invalid journal read".into());}
                let start=d[0] as usize;let end=(start+d[1] as usize).min(j.commands.len());let mut w=vec![j.commands.len() as f64];
                for c in &j.commands[start..end]{c.append(&mut w);}output(out,&w);
            },
            32=>{
                if d.len()<4{return Err("Invalid replay admission".into());}finite(d,d.len())?;
                if self.tick!=0.||!j.commands.is_empty()||j.replay.is_some()||!integer(d[0])||!integer(d[1])||d[1]!=((d.len()-4)/6) as f64||(d.len()-4)%6!=0
                    ||d[2..4].iter().any(|&x|!integer(x)||x>u32::MAX as f64){return Err("Invalid replay admission".into());}
                let mut commands=Vec::with_capacity(d[1] as usize);let mut last=0.;
                for row in d[4..].chunks_exact(6){let c=Command::read(row,n)?;if c.tick<last||c.tick>d[0]{return Err("Replay commands are out of order".into());}last=c.tick;commands.push(c);}
                j.replay=Some(Replay{commands,cursor:0,target:d[0],hash:[d[2] as u32,d[3] as u32],drive:[0.;2],applied:-1.,boundary:None,pending:None});output(out,&[]);
            },
            33=>{finite(d,0)?;let r=j.replay.as_mut().ok_or("Resident replay is absent")?;output(out,&r.next(self.tick,j.commands.len())?);},
            34=>{let r=j.replay.as_mut().ok_or("Resident replay is absent")?;let stalled=r.ack(d,self.tick,self.phase==3,&j.commands)?;output(out,&[stalled as u8 as f64]);},
            35=>{finite(d,0)?;let r=j.replay.as_ref().ok_or("Resident replay is absent")?;output(out,&[(self.tick>=r.target&&r.applied==r.target) as u8 as f64]);},
            36=>{finite(d,2)?;if d.iter().any(|&x|!integer(x)||x>u32::MAX as f64){return Err("Invalid replay hash".into());}
                let r=j.replay.as_ref().ok_or("Resident replay is absent")?;output(out,&[([d[0] as u32,d[1] as u32]==r.hash) as u8 as f64]);},
            _=>return Err("Unknown journal operation".into()),
        }
        Ok(())
    }
}
