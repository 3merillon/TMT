//! Resident aim, ammunition selection, action admission, launch and fuel state.
//! Kit clearance tables are immutable admission data; ordinary actions never
//! import output mirrors. Bound chassis poses are read directly from the match.
use super::{Match,finite,flag,integer,output};
use crate::combat::{Combat,Combats};
type V=[f64;3];
pub(super) fn v(d:&[f64],i:usize)->V {[d[i],d[i+1],d[i+2]]}
pub(super) fn q(d:&[f64],i:usize)->[f64;4] {[d[i],d[i+1],d[i+2],d[i+3]]}
pub(super) fn add(a:V,b:V)->V {[a[0]+b[0],a[1]+b[1],a[2]+b[2]]}
pub(super) fn sub(a:V,b:V)->V {[a[0]-b[0],a[1]-b[1],a[2]-b[2]]}
pub(super) fn mul(a:V,s:f64)->V {[a[0]*s,a[1]*s,a[2]*s]}
pub(super) fn len(a:V)->f64 {let m=a[0].abs().max(a[1].abs()).max(a[2].abs());if m==0.{0.}else{let x=(a[0]/m)*(a[0]/m);let y=(a[1]/m)*(a[1]/m);let z=(a[2]/m)*(a[2]/m);(x+y+(z-((x+y)-x-y))).sqrt()*m}}
pub(super) fn norm(a:V)->V {let n=len(a);if n>1e-10{mul(a,1./n)}else{[0.,1.,0.]}}
pub(super) fn rotate(a:V,q:[f64;4])->V {let [x,y,z,w]=q;let tx=2.*(y*a[2]-z*a[1]);let ty=2.*(z*a[0]-x*a[2]);let tz=2.*(x*a[1]-y*a[0]);[a[0]+w*tx+y*tz-z*ty,a[1]+w*ty+z*tx-x*tz,a[2]+w*tz+x*ty-y*tx]}
pub(super) fn wrap(a:f64)->f64 {a.sin().atan2(a.cos())}
fn ammo(x:f64)->bool {x>=-1.&&x<=3.&&x.fract()==0.}
struct Kit {fuel:f64,recoil:f64,mass:f64,min_speed:f64,max_speed:f64,axis:V,forward:f64,barrel:f64,min:f64,max:f64,step:f64,table:Vec<f64>}
impl Kit {
    fn read(d:&[f64])->Result<(Self,usize),String>{
        if d.len()<14||!integer(d[13])||d[13]==1.||d[13]>4096.{return Err("Invalid armament kit".into());}let n=d[13] as usize;
        if d.len()<14+n||d[0]<0.||d[1]<0.||d[2]<=0.||d[3]<0.||d[4]<d[3]||d[9]<=0.||d[11]<d[10]||d[12]<=0.||d[14..14+n].iter().any(|&p|p<d[10]||p>d[11]) {return Err("Invalid armament envelope".into());}
        Ok((Self {fuel:d[0],recoil:d[1],mass:d[2],min_speed:d[3],max_speed:d[4],axis:v(d,5),forward:d[8],barrel:d[9],min:d[10],max:d[11],step:d[12],table:d[14..14+n].to_vec()},14+n))
    }
    fn pitch(&self,yaw:f64,pitch:f64)->f64 {let n=self.table.len();let u=((yaw/self.step)%(n as f64)+n as f64)%(n as f64);let i=u.floor() as usize;let f=u-i as f64;
        pitch.clamp(self.min.max(self.table[i]+(self.table[(i+1)%n]-self.table[i])*f),self.max)}
}
pub(super) struct Weapon {yaw:f64,pitch:f64,power:f64,munition:i8,pub movement:f64,kit:Kit}
impl Weapon {fn selected(&self)->usize {self.munition.max(0) as usize}}
pub(super) struct Arsenal {pub units:Vec<Weapon>,radius:f64,scale:f64,speeds:[f64;4],fired:bool,next_shot:f64}
impl Arsenal {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){
        w.words(&[self.radius,self.scale,self.next_shot]);w.words(&self.speeds);w.flag(self.fired);
        w.list(&self.units,|w,u|{w.words(&[u.yaw,u.pitch,u.power,u.munition as f64,u.movement]);let k=&u.kit;
            w.words(&[k.fuel,k.recoil,k.mass,k.min_speed,k.max_speed,k.forward,k.barrel,k.min,k.max,k.step]);w.words(&k.axis);w.words(&k.table);});
    }
    pub(super) fn bot_weapon(&self,id:usize)->[f64;5] {let u=&self.units[id];[u.yaw,u.pitch,self.radius,u.kit.fuel,self.scale*(u.kit.min_speed+(u.kit.max_speed-u.kit.min_speed))*self.speeds[u.selected()]]}
    pub(super) fn selected(&self,id:usize)->usize {self.units[id].selected()}
    pub(super) fn kit_locked(&self)->bool {self.fired}
    pub(super) fn limits(&self,id:usize,yaw:f64)->Option<[f64;2]> {let k=&self.units[id].kit;if k.table.is_empty(){return None;}let n=k.table.len();let u=((yaw/k.step)%(n as f64)+n as f64)%(n as f64);let i=u.floor() as usize;let f=u-i as f64;
        Some([k.min.max(k.table[i]+(k.table[(i+1)%n]-k.table[i])*f),k.max])}
    pub(super) fn yaw(&self,id:usize)->f64 {self.units[id].yaw}
    pub(super) fn fuel(&self,id:usize)->f64 {self.units[id].kit.fuel}
    pub(super) fn sight_endpoints(&self,id:usize,position:V,rotation:[f64;4])->[V;2] {
        let u=&self.units[id];let forward=rotate([u.yaw.sin(),0.,u.yaw.cos()],rotation);
        [add(add(position,rotate(u.kit.axis,rotation)),mul(forward,u.kit.forward)),v(&self.projectile(id,position,rotation,None,0.),0)]
    }
    pub fn append(&self,w:&mut Vec<f64>){w.extend([self.fired as u8 as f64,self.next_shot]);for u in &self.units {w.extend([u.yaw,u.pitch,u.power,u.munition as f64,u.movement]);}}
    fn read(d:&[f64],count:usize)->Result<Self,String>{
        if d.len()<8||d.iter().any(|x|!x.is_finite())||d[0]!=1.||d[1]<=0.||d[2]<=0.||d[3..7].iter().any(|x|*x<=0.)||d[7]!=count as f64{return Err("Invalid armament admission".into());}
        let mut units=Vec::new();let mut cursor=8;for _ in 0..count {
            if d.len()<cursor+5||!ammo(d[cursor+3])||d[cursor+4]<0.{return Err("Invalid armament unit".into());}
            let r=&d[cursor..];let (kit,size)=Kit::read(&r[5..])?;
            units.push(Weapon {yaw:r[0],pitch:r[1],power:r[2],munition:r[3] as i8,movement:r[4],kit});cursor+=5+size;
        }
        if cursor!=d.len(){return Err("Invalid armament length".into());}
        Ok(Self {units,radius:d[1],scale:d[2],speeds:[d[3],d[4],d[5],d[6]],fired:false,next_shot:1.})
    }
    // position, direction, velocity, munition, launch tick, peak altitude.
    pub(super) fn projectile(&self,id:usize,position:V,rotation:[f64;4],candidate:Option<[f64;4]>,tick:f64)->Vec<f64>{
        let u=&self.units[id];let (yaw,pitch,power,ammo)=candidate.map_or((u.yaw,u.pitch,u.power,u.selected()),|a|(a[0],a[1],a[2],if a[3]<0.{u.selected()}else{a[3] as usize}));
        let up=rotate([0.,1.,0.],rotation);let forward=rotate([yaw.sin(),0.,yaw.cos()],rotation);
        let direction=norm(add(mul(forward,pitch.cos()),mul(up,pitch.sin())));let pivot=add(add(position,rotate(u.kit.axis,rotation)),mul(forward,u.kit.forward));
        let position=add(pivot,mul(direction,u.kit.barrel));let speed=self.scale*(u.kit.min_speed+(u.kit.max_speed-u.kit.min_speed)*power.clamp(0.,1.).powf(1.5))*self.speeds[ammo];
        let mut out=position.to_vec();out.extend(direction);out.extend(mul(direction,speed));out.extend([ammo as f64,tick,len(position)-self.radius]);out
    }
}
impl Match {
    pub(super) fn allowed_aim(&self,id:usize,serial:bool,c:&Combat)->bool {if self.drive{id==0&&!serial&&self.phase!=3}else{self.phase==0&&self.active==id&&c.units[id].health>0.}}
    fn allowed_fire(&self,id:usize,serial:bool,projectiles:f64,pending:f64,c:&Combat)->bool {
        let a=self.arsenal.as_ref().unwrap();self.allowed_aim(id,serial,c)&&c.can_spend(id,a.units[id].selected())&&(!self.drive||(projectiles==0.&&pending==0.&&(!a.fired||self.phase_time>=0.45)))
    }
    pub(super) fn armament_command(&mut self,op:u32,d:&[f64],combats:&mut Combats,out:&mut Vec<u8>)->Result<(),String>{
        let (d,record)=if op==10&&self.journal.is_some(){
            let (&record,d)=d.split_last().ok_or("Missing action origin")?;
            if !flag(record){return Err("Invalid action origin".into());}(d,record==1.)
        }else{(d,false)};
        if op==9 {
            if self.arsenal.is_some()||self.tick!=0. {return Err("Armament already admitted".into());}
            combats.get(self.combat.ok_or("Armament requires combat")?)?;
            let a=Arsenal::read(d,self.units.len())?;self.arsenal=Some(a);output(out,&self.snapshot(0.,-1.,0.,false));return Ok(());
        }
        if self.arsenal.is_none(){return Err("Resident armament is absent".into());}
        let mut resident=Vec::new();
        let d=if let Some(m)=&self.motion {
            match op {
                10 if d.first()==Some(&1.)=>{
                    if let Some(shots)=&self.shots {finite(d,4)?;resident.extend([d[0],d[1],d[2],shots.count(),d[3]]);}else{finite(d,5)?;resident.extend(d);}
                    if integer(d[1])&&d[1]<m.units.len() as f64 {resident.extend(&m.units[d[1] as usize].cur[..10]);}else{resident.extend([0.;10]);}
                },
                12=>{finite(d,0)?;let a=self.arsenal.as_ref().unwrap();resident.push((self.drive||(self.phase==1&&self.move_time>0.&&a.units[self.active].movement>0.)) as u8 as f64);
                    for u in &m.units {resident.extend(u.before);resident.extend(&u.cur[..7]);}},
                13=>{finite(d,6)?;if !integer(d[0])||d[0]>=m.units.len() as f64{return Err("Invalid projectile request".into());}resident.extend(d);resident.extend(&m.units[d[0] as usize].cur[..7]);},
                11 if self.shots.is_some()=>{finite(d,4)?;resident.extend([d[0],d[1],d[2],self.shots.as_ref().unwrap().count(),d[3]]);},
                _=>{},
            }
            if resident.is_empty(){d}else{&resident}
        }else{d};
        let combat=self.combat.ok_or("Armament requires combat")?;
        let mut accepted=false;let mut launch=Vec::new();
        match op {
            10=>{
                if d.len()<3||!integer(d[0])||d[0]>6.||!flag(d[2]){return Err("Invalid action descriptor".into());}
                let kind=d[0] as u8;let size=match kind{0=>6,1=>15,2=>4,_=>3};
                if kind==3 && self.observations.is_some(){return Err("Resident scan requires observation admission".into());}
                if d.len()!=size&&!(kind==0&&d.len()==8) {return Err("Invalid action length".into());}
                if d.iter().all(|x|x.is_finite())&&integer(d[1])&&d[1]<(self.units.len() as f64) {
                    let id=d[1] as usize;let c=combats.get(combat)?;let serial=d[2]==1.;
                    if kind==0 {
                        let external=self.arsenal.as_ref().unwrap().units[id].kit.table.is_empty();
                        if d.len()!=if external{8}else{6}||(external&&d[7]<d[6]){return Err("Invalid action elevation limits".into());}
                    }
                    accepted=match kind {
                        0=>self.allowed_aim(id,serial,c),
                        1=>integer(d[3])&&integer(d[4])&&self.allowed_fire(id,serial,d[3],d[4],c),
                        2=>integer(d[3])&&d[3]<4.&&self.allowed_aim(id,serial,c)&&c.available(id,d[3] as usize),
                        3=>self.allowed_aim(id,serial,c)&&c.can_scan(id),
                        4|6=>!self.drive&&self.allowed_aim(id,serial,c),
                        5=>!self.drive&&id==self.active&&self.phase==1,
                        _=>false,
                    };
                    if accepted {
                        let a=self.arsenal.as_mut().unwrap();
                        if kind==1 {
                            if a.next_shot>=9007199254740991.{return Err("Shot IDs exhausted".into());}
                            let shot=a.projectile(id,v(d,5),q(d,8),None,self.tick);let u=&a.units[id];
                            let velocity=sub(v(d,12),mul(norm(v(&shot,6)),u.kit.recoil*5./u.kit.mass));
                            if let Some(shots)=&mut self.shots {shots.launch(a.next_shot,id,&shot);}
                            launch.extend([a.next_shot,id as f64]);launch.extend(shot);launch.push(u.kit.recoil);launch.extend(velocity);
                            if let Some(m)=&mut self.motion {m.units[id].cur[7..10].copy_from_slice(&velocity);m.units[id].cur[12]=u.kit.recoil;}
                            combats.get_mut(combat)?.spend(id,u.selected());a.next_shot+=1.;a.fired=true;
                        }
                        let u=&mut a.units[id];
                        match kind {
                            0=>{u.yaw=wrap(d[3]);u.pitch=if u.kit.table.is_empty(){d[4].clamp(d[6],d[7])}else{u.kit.pitch(u.yaw,d[4])};u.power=d[5].clamp(0.,1.);},
                            2=>u.munition=d[3] as i8,
                            3=>combats.get_mut(combat)?.scan(id),
                            _=>{
                                if kind!=5 {self.phase=1;self.phase_time=0.;}
                                self.move_time=if kind==1||kind==6{self.move_seconds}else{0.};u.movement=if kind==1||kind==6{u.kit.fuel}else{0.};
                                if kind==1||kind==6{self.anchor=None;}
                            }
                        }
                        if record {self.record_action(kind,id,&d[3..]);}
                    }
                }
            },
            11=>{
                finite(d,5)?;if !integer(d[0])||d[0]>3.||!flag(d[2])||!integer(d[3])||!integer(d[4]){return Err("Invalid action query".into());}
                let a=self.arsenal.as_ref().unwrap();let ok=if d[0]==3.{self.drive||(self.phase==1&&self.move_time>0.&&a.units[self.active].movement>0.)}
                    else if integer(d[1])&&d[1]<self.units.len() as f64 {let id=d[1] as usize;let c=combats.get(combat)?;match d[0] as u8 {0=>self.allowed_aim(id,d[2]==1.,c),1=>self.allowed_fire(id,d[2]==1.,d[3],d[4],c),2=>!a.fired&&self.phase==0,_=>false}}else{false};
                output(out,&[ok as u8 as f64]);return Ok(());
            },
            12=>{
                finite(d,1+self.units.len()*14)?;if !flag(d[0]){return Err("Invalid action motion".into());}
                let a=self.arsenal.as_mut().unwrap();let r=&d[1+self.active*14..];let u=&mut a.units[self.active];
                if self.phase==0||self.drive {u.yaw=hold(v(r,0),q(r,3),v(r,7),q(r,10),u.yaw);}
                if !self.drive&&d[0]==1. {u.movement=(u.movement-len(sub(v(r,0),v(r,7)))).max(0.);}
            },
            13=>{
                finite(d,13)?;if !integer(d[0])||d[0]>=self.units.len() as f64||!flag(d[1])||!ammo(d[5]){return Err("Invalid projectile request".into());}
                let shot=self.arsenal.as_ref().unwrap().projectile(d[0] as usize,v(d,6),q(d,9),if d[1]==1.{Some([d[2],d[3],d[4],d[5]])}else{None},self.tick);output(out,&shot);return Ok(());
            },
            14=>{
                finite(d,6)?;if !integer(d[0])||d[0]>=self.units.len() as f64||!ammo(d[4])||d[5]<0.{return Err("Invalid armament restore".into());}
                let u=&mut self.arsenal.as_mut().unwrap().units[d[0] as usize];u.yaw=d[1];u.pitch=d[2];u.power=d[3];u.munition=d[4] as i8;u.movement=d[5];
            },
            15=>{
                if d.is_empty()||d.iter().any(|x|!x.is_finite())||!integer(d[0])||d[0]>=self.units.len() as f64{return Err("Invalid armament kit update".into());}
                let (kit,size)=Kit::read(&d[1..])?;if size+1!=d.len(){return Err("Invalid armament kit length".into());}
                let a=self.arsenal.as_mut().unwrap();if a.fired||self.phase!=0{return Err("Armament kit is locked".into());}a.units[d[0] as usize].kit=kit;
            },
            _=>return Err("Unknown armament command".into()),
        }
        let mut words=self.snapshot(accepted as u8 as f64,-1.,0.,false);words.extend(launch);output(out,&words);Ok(())
    }
}
fn hold(before:V,bq:[f64;4],after:V,aq:[f64;4],yaw:f64)->f64 {
    let la=(before[0]*before[0]+before[1]*before[1]+before[2]*before[2]).sqrt();let lb=(after[0]*after[0]+after[1]*after[1]+after[2]*after[2]).sqrt();
    let f=mul(before,1./if la==0.{1.}else{la});let u=mul(after,1./if lb==0.{1.}else{lb});let mut aim=rotate([yaw.sin(),0.,yaw.cos()],bq);
    let mut r=f[0]*u[0]+f[1]*u[1]+f[2]*u[2]+1.;let (mut x,mut y,mut z);
    if r<1e-8 {r=0.;if f[0].abs()>f[2].abs(){x=-f[1];y=f[0];z=0.;}else{x=0.;y=-f[2];z=f[1];}}
    else{x=f[1]*u[2]-f[2]*u[1];y=f[2]*u[0]-f[0]*u[2];z=f[0]*u[1]-f[1]*u[0];}
    let mut l=(x*x+y*y+z*z+r*r).sqrt();if l==0.{x=0.;y=0.;z=0.;r=1.;}else{l=1./l;x*=l;y*=l;z*=l;r*=l;}
    aim=rotate(aim,[x,y,z,r]);aim=rotate(aim,[-aq[0],-aq[1],-aq[2],aq[3]]);aim[0].atan2(aim[2])
}
