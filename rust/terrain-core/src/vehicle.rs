//! Resident wheel/belt/traction model. Kit tuning is admitted once; ticks read
//! Rapier and queue forces directly. f64 preserves host operation order up to
//! the f32 solver boundary. Engine versioning covers cross-language rounding.
use crate::{core::Outcome, physics::{Physics, groups}};
use rapier3d::{prelude::*, parry::query::ShapeCastOptions};
type V = [f64; 3];
pub type Force = (RigidBodyHandle, Vector, Vector);
fn dot(a: V,b: V)->f64 {a[0]*b[0]+a[1]*b[1]+a[2]*b[2]}
fn scale(a: V,s:f64)->V {a.map(|v|v*s)}
fn add(a:V,b:V,s:f64)->V {[a[0]+b[0]*s,a[1]+b[1]*s,a[2]+b[2]*s]}
fn sub(a:V,b:V)->V {[a[0]-b[0],a[1]-b[1],a[2]-b[2]]}
fn cross(a:V,b:V)->V {[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]}
fn tangent(a:V,n:V)->V {sub(a,scale(n,dot(a,n)))}
fn length(a:V)->f64 {let m=a.iter().fold(0f64,|m,v|m.max(v.abs()));if m==0.{0.}else{let b=scale(a,1./m);dot(b,b).sqrt()*m}}
fn normalize(a:&mut V)->f64 {let l=length(*a);if l>1e-12{for x in a{*x/=l;}}l}
fn unit(a:V)->V {let l=length(a);a.map(|x|x/if l==0.{1.}else{l})}
fn vector(a:V)->Vector {Vector::new(a[0] as f32,a[1] as f32,a[2] as f32)}
fn wide(a:Vector)->V {[a.x as f64,a.y as f64,a.z as f64]}
fn read(d:&[f64],i:usize)->V {[d[i],d[i+1],d[i+2]]}
fn rotate(q:[f64;4],a:V)->V {
    let [x,y,z,w]=q;let [vx,vy,vz]=a;let ix=w*vx+y*vz-z*vy;let iy=w*vy+z*vx-x*vz;let iz=w*vz+x*vy-y*vx;let iw=-x*vx-y*vy-z*vz;
    [ix*w+iw*-x+iy*-z-iz*-y,iy*w+iw*-y+iz*-x-ix*-z,iz*w+iw*-z+ix*-y-iy*-x]
}
fn clamp(v:f64,lo:f64,hi:f64)->f64 {v.min(hi).max(lo)}
fn guard(angle:f64,soft:f64,hard:f64)->f64 {clamp((hard-angle)/(hard-soft),0.,1.)}
fn number(out:&mut Vec<u8>,x:f64){out.extend_from_slice(&x.to_le_bytes());}
fn slew(current:f64,target:f64,rate:f64,dt:f64)->f64{let target=if target.is_finite(){clamp(target,-1.,1.)}else{0.};if target!=0.&&target!=1.&&target!= -1.{return target;}let step=rate*dt;if target>current{target.min(current+step)}else{target.max(current-step)}}
#[derive(Default,Clone,Copy)]
pub struct Touch{count:f64,total:f64,force:f64,moment:V}
pub struct Control{
    // ABI 1: version, reach, input rates2, assist inertia, righting settings9,
    // recovery settings9, initial angular damping. All are admitted once.
    tuning:[f64;24],throttle:f64,steer:f64,righting:f64,flipped:f64,damping:f64,pub touch:Touch,
}
impl Control{
    pub fn new(d:&[f64])->Outcome<Self>{
        if d.len()!=24||d[0]!=1.||d.iter().any(|x|!x.is_finite())||d[1..7].iter().any(|x|*x<=0.)||d[14]<=0.||d[17]<=0.||d[18]<=0.{return Err("Invalid native chassis tuning".into());}
        Ok(Self{tuning:d.try_into().unwrap(),throttle:0.,steer:0.,righting:-1.,flipped:0.,damping:d[23],touch:Touch::default()})
    }
    fn recovery(&mut self,f:&Frame,manual:bool)->bool{
        let t=&self.tuning;let upright=dot(f.up,f.planet_up);self.flipped=if upright<t[20]&&length(f.velocity)<t[21]{self.flipped+1.}else{0.};
        if self.righting<0.&&(self.flipped>=t[22]||(manual&&upright<t[19])){self.righting=0.;}self.righting>=0.
    }
    fn self_right(&mut self,physics:&mut Physics,body:RigidBodyHandle,f:&Frame,dt:f64){
        let t=&self.tuning;let k=self.righting;if k==0.{physics.world.bodies[body].set_linvel(vector(scale(f.planet_up,t[17])),true);}
        let mut axis=cross(f.up,f.planet_up);let s=length(axis);let c=dot(f.up,f.planet_up);let mut angle=s.atan2(c);
        if s>1e-6{axis=scale(axis,1./s);}else if c<0.{axis=f.forward;angle=std::f64::consts::PI;}else{angle=0.;}
        let rate=if k>=t[15]{t[18].min(angle/((t[16]-k+1.).max(1.)*dt))}else{0.};physics.world.bodies[body].set_angvel(vector(scale(axis,rate)),true);
        self.righting=if k+1.>=t[14]{-1.}else{k+1.};if self.righting<0.{self.flipped=0.;}
    }
    fn assist(&self,f:&Frame,drive:&Drive)->Option<V>{
        let t=&self.tuning;let airborne=drive.contacts==0;let mut reference=f.planet_up;
        if drive.contacts as f64>=t[9]{reference=drive.normal;if normalize(&mut reference)<1e-9{reference=f.planet_up;}}
        let axis=cross(f.up,reference);let s=length(axis);let angle=s.atan2(dot(f.up,reference));let excess=(angle-if airborne{0.}else{t[7]}).max(0.);
        if excess<=0.&&!airborne{return None;}let inertia=t[4];let propped=drive.front_hit!=drive.rear_hit;
        let tilt=add(f.angular,f.up,-dot(f.angular,f.up));let mut torque=scale(tilt,-t[6]*inertia*if airborne{t[10]}else if propped{t[12]}else{1.});
        if s>1e-9{torque=add(torque,axis,t[5]*inertia*excess/s);}let mut out=scale(f.forward,dot(torque,f.forward));out=add(out,f.right,dot(torque,f.right)*if propped{t[11]}else{t[8]});
        if airborne{out=scale(out,t[13]);}Some(out)
    }
}
/// Tank order, then collider insertion/contact-graph order matches the prior
/// manifold callback aggregation. Use the exact 60 Hz host timestep, not f32 dt.
pub fn contacts(physics:&Physics,ids:&[u32])->Outcome<Vec<Touch>>{
    let mut touches=vec![Touch::default();ids.len()];
    for i in 0..ids.len(){for j in i+1..ids.len(){
        let ah=physics.body(ids[i])?;let bh=physics.body(ids[j])?;let a=&physics.world.bodies[ah];let b=&physics.world.bodies[bh];
        let reach=physics.drive(ids[i])?.control.as_ref().ok_or("Native chassis control is absent")?.tuning[1]+physics.drive(ids[j])?.control.as_ref().ok_or("Native chassis control is absent")?.tuning[1];
        if length(sub(wide(a.translation()),wide(b.translation())))>reach{continue;}
        let forward=|b:&RigidBody|{let q=b.rotation();rotate([q.x as f64,q.y as f64,q.z as f64,q.w as f64],[0.,0.,1.])};let fa=forward(a);let fb=forward(b);
        for &collider in a.colliders(){for pair in physics.world.contact_pairs_with(collider){let other=if pair.collider1==collider{pair.collider2}else{pair.collider1};
            // Removal leaves narrow-phase pairs until the next step: a removed collider is not this body's.
            if physics.world.colliders.get(other).and_then(|c|c.parent())!=Some(bh){continue;}
            for m in &pair.manifolds{let n=m.data.solver_contacts.len();if n==0{continue;}let mut mean=[0.;3];let mut impulse=0.;
                for c in &m.data.solver_contacts{let (a,b)=m.data.solver_contact_world_points(c,&physics.world.bodies);mean=add(mean,wide((a+b)*0.5),1.);}
                for c in &m.points{impulse+=(c.data.impulse as f64).max(0.);}touches[i].count+=n as f64;touches[j].count+=n as f64;if impulse<=0.{continue;}
                mean=scale(mean,1./n as f64);let normal=wide(m.data.normal);let force=impulse/(1./60.);let wa=force*dot(normal,fa).abs();let wb=force*dot(normal,fb).abs();
                touches[i].total+=force;touches[i].force+=wa;touches[i].moment=add(touches[i].moment,mean,wa);touches[j].total+=force;touches[j].force+=wb;touches[j].moment=add(touches[j].moment,mean,wb);
            }
        }}
    }}Ok(touches)
}
#[derive(Default)]
struct Wheel {local:V,side:usize,hit:bool,toi:f64,load:f64,point:V,normal:V,relative:V,support:Option<RigidBodyHandle>,long:V,lat:V,along:f64,across:f64,suspension:f64}
struct Frame {position:V,rotation:[f64;4],com:V,velocity:V,angular:V,right:V,up:V,forward:V,planet_up:V}
impl Frame {fn new(physics:&Physics,id:u32,center:V)->Outcome<Self>{
    let b=&physics.world.bodies[physics.body(id)?];let q=b.rotation();let q=[q.x as f64,q.y as f64,q.z as f64,q.w as f64];let p=wide(b.translation());
    Ok(Self{position:p,rotation:q,com:wide(b.center_of_mass()),velocity:wide(b.linvel()),angular:wide(b.angvel()),right:rotate(q,[1.,0.,0.]),up:rotate(q,[0.,1.,0.]),forward:rotate(q,[0.,0.,1.]),planet_up:unit(sub(p,center))})
}}
// Descriptor ABI v1: these 36 tuning words come from vehicle/tuning.ts.
struct Tuning {
    mass:f64,radius:f64,spacing:f64,mobility:f64,turn_mobility:f64,speed:f64,long:f64,lat:f64,gravity:f64,
    above:f64,cast:f64,stiffness:f64,damping:f64,droop:f64,max_load:f64,min_up:f64,travel:f64,
    anti_roll:f64,missing:f64,height:f64,servo_long:f64,servo_lat:f64,accel:f64,brake:f64,pivot:f64,turn:f64,
    pitch_soft:f64,pitch_hard:f64,wheelie_soft:f64,wheelie_hard:f64,stall:f64,lift_soft:f64,lift_hard:f64,touch_soft:f64,touch_hard:f64,groups:u32,
}
impl Tuning {fn new(d:&[f64])->Self {Self{
    mass:d[0],radius:d[1],spacing:d[2],mobility:d[3],turn_mobility:d[4],speed:d[5],long:d[6],lat:d[7],gravity:d[8],
    above:d[9],cast:d[10],stiffness:d[11],damping:d[12],droop:d[13],max_load:d[14],min_up:d[15],travel:d[16],
    anti_roll:d[17],missing:d[18],height:d[19],servo_long:d[20],servo_lat:d[21],accel:d[22],brake:d[23],pivot:d[24],turn:d[25],
    pitch_soft:d[26],pitch_hard:d[27],wheelie_soft:d[28],wheelie_hard:d[29],stall:d[30],lift_soft:d[31],lift_hard:d[32],touch_soft:d[33],touch_hard:d[34],groups:d[35] as u32,
}}}
pub struct Drive {
    tuning:Tuning,wheels:Vec<Wheel>,front:[usize;2],rear:[usize;2],common:f64,yaw:f64,speeds:[f64;2],contact:[f64;2],ground:[f64;2],slip:[f64;2],
    contacts:usize,normal:V,front_hit:bool,rear_hit:bool,touch_force:f64,blocked:f64,touch_point:V,pub forces:Vec<Force>,
    pub control:Option<Control>,pub torques:Vec<(RigidBodyHandle,Vector)>,
}
impl Drive {
    pub(crate) fn canonical(&self,w:&mut crate::canonical::Writer){
        let t=&self.tuning;w.words(&[t.mass,t.radius,t.spacing,t.mobility,t.turn_mobility,t.speed,t.long,t.lat,t.gravity,t.above,t.cast,t.stiffness,t.damping,t.droop,t.max_load,t.min_up,t.travel,t.anti_roll,t.missing,t.height,t.servo_long,t.servo_lat,t.accel,t.brake,t.pivot,t.turn,t.pitch_soft,t.pitch_hard,t.wheelie_soft,t.wheelie_hard,t.stall,t.lift_soft,t.lift_hard,t.touch_soft,t.touch_hard,t.groups as f64]);
        w.list(&self.wheels,|w,v|{w.words(&v.local);w.integer(v.side as u64);});
        let mut row=Vec::new();self.telemetry(&mut row);w.words(&row.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>());
        w.option(&self.control,|w,c|{w.words(&c.tuning);w.words(&[c.throttle,c.steer,c.righting,c.flipped,c.damping,c.touch.count,c.touch.total,c.touch.force]);w.words(&c.touch.moment);});
    }
    pub(crate) fn speeds(&self)->[f64;2] {self.speeds}
    pub fn new(d:&[f64])->Outcome<Self>{
        if d.len()<46||d[0]!=1.||d.iter().any(|x|!x.is_finite()){return Err("Invalid native drive descriptor".into());}
        let n=d[37] as usize;if n<4||n>64||n%2!=0||d[37]!=n as f64||d.len()!=38+n*4{return Err("Invalid native drive stations".into());}
        let tuning=Tuning::new(&d[1..37]);if [tuning.mass,tuning.radius,tuning.spacing,tuning.mobility,tuning.turn_mobility,tuning.speed,tuning.droop,tuning.travel].iter().any(|x|*x<=0.){return Err("Invalid native drive tuning".into());}
        let mut wheels=Vec::with_capacity(n);for i in 0..n{let a=38+i*4;let side=usize::from(i>=n/2);if d[a]!=side as f64{return Err("Invalid native wheel ordering".into());}wheels.push(Wheel{side,local:read(d,a+1),..Wheel::default()});}
        let extreme=|from:usize,sign:f64|{let mut best=from;for i in from..from+n/2{if sign*wheels[i].local[2]>sign*wheels[best].local[2]{best=i;}}best};
        let front=[extreme(0,1.),extreme(n/2,1.)];let rear=[extreme(0,-1.),extreme(n/2,-1.)];
        Ok(Self{tuning,wheels,front,rear,common:0.,yaw:0.,speeds:[0.;2],contact:[0.;2],ground:[0.;2],slip:[0.;2],contacts:0,normal:[0.;3],front_hit:false,rear_hit:false,touch_force:0.,blocked:0.,touch_point:[0.;3],forces:Vec::with_capacity(n*6),control:None,torques:Vec::new()})
    }
    pub fn command(&mut self,op:u32,physics:&Physics,id:u32,d:&[f64],out:&mut Vec<u8>)->Outcome<()>{
        let need=match op{61|62=>14,63=>0,64=>1,_=>return Err("Unknown native drive command".into())};
        if d.len()!=need||d.iter().any(|x|!x.is_finite()){return Err("Invalid native drive command".into());}let handle=physics.body(id)?;
        match op{
            61|62=>{if d[0]<0.{return Err("Invalid drive timestep".into());}let center=read(d,5);let f=Frame::new(physics,id,center)?;if op==61{self.apply(physics,handle,&f,d,center);}else{self.belts(&f,d,None);}},
            63=>self.idle(),
            64=>self.common=d[0],_=>{}
        }
        self.telemetry(out);Ok(())
    }
    fn idle(&mut self){self.touch_force=0.;self.blocked=0.;for w in &mut self.wheels{w.hit=false;w.suspension=0.;}self.contact=[0.;2];self.contacts=0;self.normal=[0.;3];self.front_hit=false;self.rear_hit=false;}
    fn telemetry(&self,out:&mut Vec<u8>){for x in [self.common,self.yaw,self.speeds[0],self.speeds[1],self.contact[0],self.contact[1],self.ground[0],self.ground[1],self.slip[0],self.slip[1],self.contacts as f64,self.normal[0],self.normal[1],self.normal[2],u8::from(self.front_hit) as f64,u8::from(self.rear_hit) as f64]{number(out,x);}for w in &self.wheels{number(out,w.suspension);}}
    pub fn restore_control(&mut self,d:&[f64])->Outcome<()>{
        if d.len()!=5||d.iter().any(|x|!x.is_finite())||d[0].abs()>1.||d[1].abs()>1.||d[3]< -1.||d[4]<0.||d[3].fract()!=0.||d[4].fract()!=0.{return Err("Invalid native chassis state".into());}
        let c=self.control.as_mut().ok_or("Native chassis control is absent")?;c.throttle=d[0];c.steer=d[1];self.common=d[2];c.righting=d[3];c.flipped=d[4];Ok(())
    }
    pub fn tick(&mut self,physics:&mut Physics,id:u32,d:&[f64],dt:f64,center:V,out:&mut Vec<u8>){
        // Entire batch has been checked before the first mutation.
        let mut c=self.control.take().unwrap();let body=physics.body(id).unwrap();
        let delta=read(d,8);if length(delta)>1e-9{let b=&mut physics.world.bodies[body];b.set_linvel(vector(add(wide(b.linvel()),delta,1.)),true);}
        if d[7]!=c.damping{physics.world.bodies[body].set_angular_damping(d[7] as f32);c.damping=d[7];}
        c.throttle=slew(c.throttle,d[1],c.tuning[2],dt);c.steer=slew(c.steer,d[2],c.tuning[3],dt);
        let f=Frame::new(physics,id,center).unwrap();let alive=d[4]!=0.;
        if !alive{c.righting=-1.;c.flipped=0.;}
        let mut command=[dt,c.throttle,c.steer,d[5],d[6],center[0],center[1],center[2],c.touch.count,c.touch.total,c.touch.force,c.touch.moment[0],c.touch.moment[1],c.touch.moment[2]];
        if !alive{c.throttle=0.;c.steer=0.;self.common=0.;self.speeds=[0.;2];self.ground=[0.;2];self.slip=[0.;2];self.yaw=0.;self.idle();}
        else if c.recovery(&f,d[3]!=0.){command[1]=0.;command[2]=0.;self.belts(&f,&command,None);self.idle();c.self_right(physics,body,&f,dt);}
        else{self.apply(physics,body,&f,&command,center);if alive{if let Some(torque)=c.assist(&f,self){self.torques.push((body,vector(torque)));}}}
        number(out,id as f64);number(out,self.wheels.len() as f64);
        for x in [c.throttle,c.steer,c.righting,c.flipped,c.touch.count,c.touch.total,c.touch.force,c.touch.moment[0],c.touch.moment[1],c.touch.moment[2]]{number(out,x);}self.telemetry(out);self.control=Some(c);
    }
    fn belts(&mut self,f:&Frame,d:&[f64],support:Option<V>){
        let t=&self.tuning;let throttle=d[1]*(1.-d[2].abs().min(1.)*self.blocked);let amount=throttle.abs().min(1.);
        let omega=-d[2]*(t.pivot*t.mobility*(1.-amount)+t.turn*t.turn_mobility*amount);let differential=omega*t.spacing;
        let room=(t.speed-differential.abs()).max(0.);let sign=if throttle==0.{throttle}else{throttle.signum()};let wanted=(throttle.abs()*t.speed).min(room);
        let climb=clamp(dot(f.forward,f.planet_up)*sign,-1.,1.).asin();let mut limit=guard(climb,t.pitch_soft,t.pitch_hard);
        if let Some(support)=support{if sign!=0.{let rear=clamp(dot(f.forward,support)*sign,-1.,1.).asin();
            if dot(f.velocity,f.forward)*sign<t.stall*wanted{limit=limit.min(guard(rear,t.wheelie_soft,t.wheelie_hard));}
            if !(if sign>0.{self.front_hit}else{self.rear_hit}){limit=limit.min(guard(rear,t.lift_soft,t.lift_hard));}
            if d[8]>0.{limit=limit.min(guard(rear,t.touch_soft,t.touch_hard));}
        }}
        let target=sign*wanted*limit;let braking=target.abs()<self.common.abs()||target*self.common<0.;let rate=(if braking{t.brake}else{t.accel})*t.mobility*d[0];
        self.common+=clamp(target-self.common,-rate,rate);self.speeds=[self.common-differential,self.common+differential];self.yaw=omega;
    }
    fn push(forces:&mut Vec<Force>,body:RigidBodyHandle,w:&Wheel,force:V,point:V){
        forces.push((body,vector(force),vector(point)));if let Some(support)=w.support{forces.push((support,vector(scale(force,-1.)),vector(w.point)));}
    }
    fn apply(&mut self,physics:&Physics,body:RigidBodyHandle,f:&Frame,d:&[f64],center:V){
        let t=&self.tuning;let n=self.wheels.len();let half=n/2;let wheel_mass=t.mass/n as f64;let down=scale(f.up,-1.);
        for w in &mut self.wheels{
            w.hit=false;w.load=0.;w.support=None;w.suspension=0.;let origin=add(rotate(f.rotation,w.local),f.position,1.);
            let options=ShapeCastOptions{max_time_of_impact:t.cast as f32,target_distance:0.,stop_at_penetration:true,compute_impact_geometry_on_penetration:true};let filter=QueryFilter::default().groups(groups(t.groups)).exclude_rigid_body(body);
            let Some((collider,hit))=physics.world.cast_shape(&Pose::from_parts(vector(origin),Rotation::IDENTITY),vector(down),&Ball::new(t.radius as f32),options,filter) else{continue};
            w.normal=scale(wide(hit.normal2),-1.);if normalize(&mut w.normal)<1e-9||dot(w.normal,f.up)<t.min_up{continue;}
            w.hit=true;w.toi=hit.time_of_impact as f64;w.point=add(add(origin,down,w.toi),w.normal,-t.radius);
            let Some(hit_collider)=physics.world.colliders.get(collider) else{w.hit=false;continue};let parent=hit_collider.parent();let own=wide(physics.world.bodies[body].velocity_at_point(vector(w.point)));w.relative=own;
            if let Some(h)=parent{let b=&physics.world.bodies[h];if b.is_dynamic(){w.support=Some(h);}if !b.is_fixed(){w.relative=sub(own,wide(b.velocity_at_point(vector(w.point))));}}
            let compression=t.above-w.toi;let spring=if compression>=0.{t.gravity+t.stiffness*compression}else{t.gravity*(1.+compression/t.droop).max(0.)};
            w.load=wheel_mass*(spring-t.damping*dot(w.relative,w.normal));w.suspension=clamp(0.5+compression/t.travel,0.,1.);
        }
        for a in 0..half{let (left,right)=self.wheels.split_at_mut(half);let l=&mut left[a];let r=&mut right[a];if !l.hit&&!r.hit{continue;}
            let cl=if l.hit{t.above-l.toi}else{t.missing};let cr=if r.hit{t.above-r.toi}else{t.missing};let transfer=t.anti_roll*wheel_mass*(cl-cr);if l.hit{l.load+=transfer;}if r.hit{r.load-=transfer;}
        }
        let mut loads=[0.;2];let mut speeds=[0.;2];let mut counts=[0usize;2];let ceiling=t.max_load*t.mass*t.gravity;
        self.contacts=0;self.normal=[0.;3];self.front_hit=self.front.iter().any(|&i|self.wheels[i].hit);self.rear_hit=self.rear.iter().any(|&i|self.wheels[i].hit);
        for w in &mut self.wheels{if w.hit{w.load=clamp(w.load,0.,ceiling);loads[w.side]+=w.load;self.contacts+=1;self.normal=add(self.normal,w.normal,1.);}}
        self.touch_force=0.;self.blocked=0.;if d[8]>0.&&d[10]>1e-9{self.touch_force=d[10];self.touch_point=scale(read(d,11),1./d[10]);if dot(sub(self.touch_point,f.com),f.forward)*d[1]>0.{self.blocked=(d[10]/d[9]).min(1.);}}
        let mut support=self.normal;let support=if self.contacts>=3&&normalize(&mut support)>=1e-9{Some(support)}else{None};self.belts(f,d,support);
        let t=&self.tuning;let total=loads[0]+loads[1];let gravity=scale(f.planet_up,-t.gravity);let mu_long=t.long*d[3];let mu_lat=t.lat*d[4];let mut net_long=0.;
        for w in &mut self.wheels{
            w.along=0.;w.across=0.;if !w.hit{continue;}w.long=tangent(f.forward,w.normal);normalize(&mut w.long);w.lat=cross(w.normal,w.long);
            let vlong=dot(w.relative,w.long);let vlat=dot(w.relative,w.lat);let yaw_lat=self.yaw*dot(cross(f.up,sub(w.point,f.com)),w.lat);speeds[w.side]+=vlong;counts[w.side]+=1;if w.load<=0.{continue;}
            let support_gravity=if let Some(h)=w.support{let delta=sub(center,wide(physics.world.bodies[h].center_of_mass()));let l=length(delta);let l=if l==0.{1.}else{l};delta.map(|x|x/l*t.gravity)}else{[0.;3]};
            let hold=scale(tangent(sub(gravity,support_gravity),w.normal),-t.mass*w.load/total.max(1e-9));let along=dot(hold,w.long)+wheel_mass*t.servo_long*(self.speeds[w.side]-vlong);let across=dot(hold,w.lat)-wheel_mass*t.servo_lat*(vlat-yaw_lat);
            let max_long=w.load*mu_long;w.along=clamp(along,-max_long,max_long);let share=if max_long>0.{w.along/max_long}else{0.};let max_lat=w.load*mu_lat*(1.-share*share).max(0.).sqrt();w.across=clamp(across,-max_lat,max_lat);net_long+=w.along;
            Self::push(&mut self.forces,body,w,scale(w.normal,w.load),w.point);
        }
        let raise=if self.touch_force>0.{(self.touch_force/net_long.abs().max(1e-9)).min(1.)}else{0.};
        for w in &self.wheels{
            if !w.hit||w.load<=0.{continue;}let height=t.height*dot(sub(f.com,w.point),f.up);let at=add(w.point,f.up,height);
            if raise>0.{Self::push(&mut self.forces,body,w,scale(w.lat,w.across),at);let at=add(w.point,f.up,height+raise*(dot(sub(self.touch_point,w.point),f.up)-height));Self::push(&mut self.forces,body,w,scale(w.long,w.along),at);}
            else{Self::push(&mut self.forces,body,w,add(scale(w.long,w.along),w.lat,w.across),at);}
        }
        let supported=(t.mass*t.gravity).max(total);for i in 0..2{self.contact[i]=loads[i]/supported;self.ground[i]=speeds[i]/counts[i].max(1) as f64;self.slip[i]=self.speeds[i]-self.ground[i];}
    }
}
