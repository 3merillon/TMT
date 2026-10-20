//! Engine physics ABI v1. One native Rapier world in the terrain WASM instance.
//! The browser adapter only transports descriptors, commands and flat snapshots.
use crate::core::Outcome;
use rapier3d::prelude::*;
use rapier3d::parry::query::ShapeCastOptions;
use std::sync::Mutex;
use std::collections::HashMap;
use crate::vehicle::{self, Control, Drive, Force};

pub struct Physics {
    pub world:PhysicsWorld,
    bodies:Vec<Option<RigidBodyHandle>>,colliders:Vec<Option<ColliderHandle>>,
    shapes:Vec<Option<SharedShape>>,free_shapes:Vec<usize>,events:Events,
    drives:HashMap<u32,Drive>,forces:Vec<Force>,torques:Vec<(RigidBodyHandle,Vector)>,
}
#[derive(Default)]
struct Events(Mutex<Vec<CollisionEvent>>);
impl EventHandler for Events {
    fn handle_collision_event(&self,_:&RigidBodySet,_:&ColliderSet,event:CollisionEvent,_:Option<&ContactPair>) { self.0.lock().unwrap().push(event); }
    fn handle_contact_force_event(&self,_:f32,_:&RigidBodySet,_:&ColliderSet,_:&ContactPair,_:f32) {}
}
fn v(d:&[f64],i:usize)->Vector { Vector::new(d[i] as f32,d[i+1] as f32,d[i+2] as f32) }
fn q(d:&[f64],i:usize)->Rotation { Rotation::from_xyzw(d[i] as f32,d[i+1] as f32,d[i+2] as f32,d[i+3] as f32).normalize() }
fn pose(d:&[f64],i:usize)->Pose { Pose::from_parts(v(d,i),q(d,i+3)) }
fn mass(d:&[f64],i:usize)->MassProperties { MassProperties::with_principal_inertia_frame(v(d,i+1),d[i] as f32,v(d,i+4),q(d,i+7)) }
fn args(d:&[f64],n:usize)->Outcome<()> { if d.len()!=n || d.iter().any(|v|!v.is_finite()) {Err("Invalid native physics command".into())} else {Ok(())} }
fn kind(n:u32)->Outcome<RigidBodyType> { match n {0=>Ok(RigidBodyType::Dynamic),1=>Ok(RigidBodyType::Fixed),2=>Ok(RigidBodyType::KinematicPositionBased),3=>Ok(RigidBodyType::KinematicVelocityBased),_=>Err("Invalid body type".into())} }
pub(crate) fn groups(n:u32)->InteractionGroups { InteractionGroups::new(Group::from_bits_truncate(n>>16),Group::from_bits_truncate(n&65535),InteractionTestMode::And) }
fn number(out:&mut Vec<u8>,n:f64) { out.extend_from_slice(&n.to_le_bytes()); }
fn vector(out:&mut Vec<u8>,p:Vector) { for v in [p.x,p.y,p.z] {number(out,v as f64);} }
fn rotation(out:&mut Vec<u8>,p:Rotation) { for v in [p.x,p.y,p.z,p.w] {number(out,v as f64);} }

impl Physics {
    pub(crate) fn canonical_body(&self,id:u32,w:&mut crate::canonical::Writer)->Outcome<()>{
        let mut row=Vec::new();self.snapshot(id,&mut row)?;w.words(&row.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>());
        let b=&self.world.bodies[self.body(id)?];w.flag(b.is_sleeping());self.drive(id)?.canonical(w);Ok(())
    }
    pub fn new()->Self {
        let mut world=PhysicsWorld::new();world.gravity=Vector::ZERO;
        world.integration_parameters.dt=1./60.;world.integration_parameters.num_solver_iterations=8;world.integration_parameters.max_ccd_substeps=4;
        Self {world,bodies:Vec::new(),colliders:Vec::new(),shapes:Vec::new(),free_shapes:Vec::new(),events:Events::default(),drives:HashMap::new(),forces:Vec::new(),torques:Vec::new()}
    }
    pub(crate) fn body(&self,id:u32)->Outcome<RigidBodyHandle> {self.bodies.get(id as usize).copied().flatten().filter(|h|self.world.bodies.contains(*h)).ok_or("Unknown native body".into())}
    pub(crate) fn drive(&self,id:u32)->Outcome<&Drive>{self.drives.get(&id).ok_or("Unknown native drive".into())}
    fn snapshot(&self,id:u32,out:&mut Vec<u8>)->Outcome<()>{
        let b=&self.world.bodies[self.body(id)?];vector(out,b.translation());rotation(out,*b.rotation());vector(out,b.linvel());vector(out,b.angvel());vector(out,b.center_of_mass());
        for n in [b.mass() as f64,u8::from(b.is_sleeping()) as f64,b.body_type() as u32 as f64,u8::from(b.is_enabled()) as f64,b.colliders().len() as f64]{number(out,n);}Ok(())
    }
    fn chassis_ids(&self,d:&[f64])->Outcome<Vec<u32>>{
        if d.len()>64{return Err("Too many native chassis".into());}let mut ids=Vec::with_capacity(d.len());
        for &v in d{let id=v as u32;if !v.is_finite()||v!=id as f64||ids.contains(&id){return Err("Invalid native chassis IDs".into());}self.body(id)?;if self.drive(id)?.control.is_none(){return Err("Native chassis control is absent".into());}ids.push(id);}Ok(ids)
    }
    pub fn body_pose(&self,id:u32)->Outcome<[f64;7]> {let b=&self.world.bodies[self.body(id)?];let p=b.translation();let q=b.rotation();Ok([p.x as f64,p.y as f64,p.z as f64,q.x as f64,q.y as f64,q.z as f64,q.w as f64])}
    pub fn body_motion(&self,id:u32)->Outcome<[f64;13]> {let b=&self.world.bodies[self.body(id)?];let p=b.translation();let q=b.rotation();let v=b.linvel();let w=b.angvel();
        Ok([p.x as f64,p.y as f64,p.z as f64,q.x as f64,q.y as f64,q.z as f64,q.w as f64,v.x as f64,v.y as f64,v.z as f64,w.x as f64,w.y as f64,w.z as f64])}
    fn collider(&self,id:u32)->Outcome<ColliderHandle> {self.colliders.get(id as usize).copied().flatten().filter(|h|self.world.colliders.contains(*h)).ok_or("Unknown native collider".into())}
    /// Commands return f64 words into the existing shared output arena. Handles are
    /// monotonic external IDs, so a retired wrapper never aliases a newer body.
    pub fn command(&mut self,op:u32,id:u32,d:&[f64],out:&mut Vec<u8>)->Outcome<()> {
        out.clear();
        match op {
            // Cook shape: kind, parameters. Mesh: kind, flags, vertex count,
            // triangle count, xyz positions, then triangle vertex indices.
            1=>{let shape=self.shape(d)?;let id=if let Some(id)=self.free_shapes.pop(){self.shapes[id]=Some(shape);id}else{let id=self.shapes.len();self.shapes.push(Some(shape));id};number(out,id as f64);},
            2=>{if let Some(slot)=self.shapes.get_mut(id as usize){if slot.take().is_some(){self.free_shapes.push(id as usize);}}},
            // Body: type, pose7, velocities6, enabled, ccd, sleep, damping2,
            // gravity scale, additional mass properties11, can_sleep.
            10=>{args(d,32)?;let mut body=RigidBodyBuilder::new(kind(d[0] as u32)?).pose(pose(d,1)).linvel(v(d,8)).angvel(v(d,11))
                .enabled(d[14]!=0.).ccd_enabled(d[15]!=0.).sleeping(d[16]!=0.).linear_damping(d[17] as f32).angular_damping(d[18] as f32)
                .gravity_scale(d[19] as f32).additional_mass_properties(mass(d,20)).can_sleep(d[31]!=0.).build();
                let id=self.bodies.len();body.user_data=id as u128;let h=self.world.insert_body(body);self.bodies.push(Some(h));number(out,id as f64);},
            11=>{let h=self.body(id)?;let colliders=self.world.bodies[h].colliders().to_vec();for c in colliders {let i=self.world.colliders[c].user_data as usize;self.colliders[i]=None;}self.world.remove_body(h);self.bodies[id as usize]=None;self.drives.remove(&id);},
            12=>self.snapshot(id,out)?,
            13=>{args(d,3)?;let b=&self.world.bodies[self.body(id)?];vector(out,b.velocity_at_point(v(d,0)));},
            14=>{let h=self.body(id)?;self.world.bodies[h].recompute_mass_properties_from_colliders(&self.world.colliders);},
            // Body mutations use a common wake flag followed by their operands.
            15..=28=>{let need=match op {15|17|18|24|25|26|27=>4,16=>5,19|20|21=>2,22|23=>1,28=>7,_=>0};args(d,need)?;
                let h=self.body(id)?;let b=&mut self.world.bodies[h];let wake=d[0]!=0.;match op {
                    15=>b.set_translation(v(d,1),wake),16=>b.set_rotation(q(d,1),wake),17=>b.set_linvel(v(d,1),wake),18=>b.set_angvel(v(d,1),wake),
                    19=>b.set_body_type(kind(d[1] as u32)?,wake),20=>b.set_enabled(d[1]!=0.),21=>b.set_angular_damping(d[1] as f32),22=>b.sleep(),23=>b.wake_up(wake),
                    24=>b.add_force(v(d,1),wake),25=>b.add_torque(v(d,1),wake),26=>b.apply_impulse(v(d,1),wake),27=>b.apply_torque_impulse(v(d,1),wake),28=>b.add_force_at_point(v(d,1),v(d,4),wake),_=>{}
                }},
            29=>{args(d,2)?;let h=self.body(id)?;let b=&mut self.world.bodies[h];if d[1]==0. {b.reset_forces(d[0]!=0.);}else{b.reset_torques(d[0]!=0.);}},
            // Collider: cooked shape ID, pose7, density, friction, restitution,
            // collision groups, solver groups, events, sensor, enabled, skin.
            30=>{args(d,17)?;let h=if id==u32::MAX{None}else{Some(self.body(id)?)};let shape=self.shapes.get_mut(d[0] as usize).and_then(Option::take).ok_or("Unknown cooked shape")?;
                self.free_shapes.push(d[0] as usize);
                let mut c=ColliderBuilder::new(shape).position(pose(d,1)).density(d[8] as f32).friction(d[9] as f32).restitution(d[10] as f32)
                    .collision_groups(groups(d[11] as u32)).solver_groups(groups(d[12] as u32)).active_events(ActiveEvents::from_bits_truncate(d[13] as u32))
                    .sensor(d[14]!=0.).enabled(d[15]!=0.).contact_skin(d[16] as f32).build();
                let id=self.colliders.len();c.user_data=id as u128;let h=self.world.insert_collider(c,h);self.colliders.push(Some(h));number(out,id as f64);},
            31=>{let c=&self.world.colliders[self.collider(id)?];number(out,c.volume() as f64);number(out,c.parent().map(|h|self.world.bodies[h].user_data as f64).unwrap_or(-1.));},
            32=>{args(d,11)?;let h=self.collider(id)?;self.world.colliders[h].set_mass_properties(mass(d,0));},
            33=>{args(d,3)?;let h=self.collider(id)?;self.world.colliders[h].set_translation_wrt_parent(v(d,0));},
            34=>{args(d,4)?;let h=self.collider(id)?;let c=&mut self.world.colliders[h];let p=c.position_wrt_parent().copied().unwrap_or(Pose::IDENTITY);c.set_position_wrt_parent(Pose::from_parts(p.translation,q(d,0)));},
            35=>{args(d,8)?;let c=&self.world.colliders[self.collider(id)?];let ray=Ray::new(v(d,0),v(d,3));number(out,c.shape().cast_ray(c.position(),&ray,d[6] as f32,d[7]!=0.).map(|v|v as f64).unwrap_or(-1.));},
            36=>{args(d,3)?;let h=self.body(id)?;self.world.bodies[h].set_next_kinematic_translation(v(d,0));},
            37=>{args(d,4)?;let h=self.body(id)?;self.world.bodies[h].set_next_kinematic_rotation(q(d,0));},
            38=>{let h=self.collider(id)?;self.world.remove_collider(h);self.colliders[id as usize]=None;},
            // A wheel ball cast: pose7, velocity3, radius, target distance,
            // maximum time, stop flag, groups, excluded body (or -1).
            40=>{args(d,16)?;let mut filter=QueryFilter::default().groups(groups(d[14] as u32));if d[15]>=0. {filter=filter.exclude_rigid_body(self.body(d[15] as u32)?);}
                let options=ShapeCastOptions {max_time_of_impact:d[12] as f32,target_distance:d[11] as f32,stop_at_penetration:d[13]!=0.,compute_impact_geometry_on_penetration:true};
                if let Some((h,hit))=self.world.cast_shape(&pose(d,0),v(d,7),&Ball::new(d[10] as f32),options,filter) {
                    number(out,self.world.colliders[h].user_data as f64);number(out,hit.time_of_impact as f64);vector(out,hit.witness1);vector(out,hit.witness2);vector(out,hit.normal1);vector(out,hit.normal2);
                }},
            41=>{let h=self.collider(id)?;for pair in self.world.contact_pairs_with(h) {let other=if pair.collider1==h {pair.collider2}else{pair.collider1};if let Some(c)=self.world.colliders.get(other){number(out,c.user_data as f64);}}},
            42=>{args(d,1)?;let a=self.collider(id)?;let b=self.collider(d[0] as u32)?;
                if let Some(pair)=self.world.contact_pair(a,b) {number(out,pair.manifolds.len() as f64);for m in &pair.manifolds {
                    vector(out,m.data.normal);number(out,m.data.solver_contacts.len() as f64);number(out,m.points.len() as f64);
                    for c in &m.data.solver_contacts {let (a,b)=m.data.solver_contact_world_points(c,&self.world.bodies);vector(out,(a+b)*0.5);}for c in &m.points {number(out,c.data.impulse as f64);number(out,c.dist as f64);}
                }}else{number(out,0.);}},
            43=>{let b=&self.world.bodies[self.body(id)?];number(out,b.linear_damping() as f64);number(out,b.angular_damping() as f64);},
            // Step with optional radial gravity and batched force/torque inputs:
            // radial, centre3, acceleration, forces count, torques count,
            // forces [body,force3,point3], torques [body,torque3].
            50|51=>{if d.len()<7 {return Err("Invalid physics step".into());}let nf=d[5] as usize;let nt=d[6] as usize;args(d,7+nf*7+nt*4)?;
                // Reject stale input before resetting forces or changing any body.
                for i in 0..nf {self.body(d[7+i*7] as u32)?;}for i in 0..nt {self.body(d[7+nf*7+i*4] as u32)?;}
                if op==51 {for i in 0..nf {let at=7+i*7;self.forces.push((self.body(d[at] as u32)?,v(d,at+1),v(d,at+4)));}for i in 0..nt {let at=7+nf*7+i*4;self.torques.push((self.body(d[at] as u32)?,v(d,at+1)));}return Ok(());}
                if self.forces.iter().any(|(h,_,_)|!self.world.bodies.contains(*h))||self.torques.iter().any(|(h,_)|!self.world.bodies.contains(*h)){return Err("Retired body in native force queue".into());}
                if d[0]!=0. {let center=v(d,1);for (_,b) in self.world.bodies.iter_mut() {if !b.is_dynamic()||b.is_sleeping(){continue;}b.reset_forces(false);b.reset_torques(false);
                    let delta=center-b.center_of_mass();let force=delta*(d[4] as f32*b.mass()/delta.length().max(1e-6));b.add_force(force,false);
                }}
                for (h,f,p) in self.forces.drain(..) {self.world.bodies[h].add_force_at_point(f,p,true);}
                for i in 0..nf {let at=7+i*7;let h=self.body(d[at] as u32)?;self.world.bodies[h].add_force_at_point(v(d,at+1),v(d,at+4),true);}
                for (h,t) in self.torques.drain(..) {self.world.bodies[h].add_torque(t,true);}
                for i in 0..nt {let at=7+nf*7+i*4;let h=self.body(d[at] as u32)?;self.world.bodies[h].add_torque(v(d,at+1),true);}
                self.world.step_with_events(&(),&self.events);
                for event in self.events.0.lock().unwrap().drain(..) {let (a,b,started)=match event {CollisionEvent::Started(a,b,_)=>(a,b,true),CollisionEvent::Stopped(a,b,_)=>(a,b,false)};
                    if let (Some(a),Some(b))=(self.world.colliders.get(a),self.world.colliders.get(b)){number(out,a.user_data as f64);number(out,b.user_data as f64);number(out,u8::from(started) as f64);}
                }},
            52=>{if d.len()>64||d.iter().any(|v|!v.is_finite()||*v!=*v as u32 as f64){return Err("Invalid body snapshot batch".into());}for &v in d{self.body(v as u32)?;}for &v in d{number(out,v);self.snapshot(v as u32,out)?;}},
            60=>{self.body(id)?;if self.drives.contains_key(&id){return Err("Native drive already exists".into());}let drive=Drive::new(d)?;self.drives.insert(id,drive);},
            61..=64=>{let mut drive=self.drives.remove(&id).ok_or("Unknown native drive")?;let result=drive.command(op,self,id,d,out);if result.is_ok(){self.forces.extend(drive.forces.drain(..));}self.drives.insert(id,drive);result?;},
            65=>{let control=Control::new(d)?;let drive=self.drives.get_mut(&id).ok_or("Unknown native drive")?;if drive.control.is_some(){return Err("Native chassis control already exists".into());}drive.control=Some(control);},
            66=>self.drives.get_mut(&id).ok_or("Unknown native drive")?.restore_control(d)?,
            70=>{let ids=self.chassis_ids(d)?;let touches=vehicle::contacts(self,&ids)?;for (id,touch) in ids.into_iter().zip(touches){self.drives.get_mut(&id).unwrap().control.as_mut().unwrap().touch=touch;}},
            // dt, planet centre3, count; rows: body, raw throttle/steer,
            // self-right, alive, traction/lateral, damping, external delta-v3.
            71=>{if d.len()<5{return Err("Invalid chassis tick".into());}let count=d[4] as usize;
                if count>64||d[4]!=count as f64||d.len()!=5+count*11||d.iter().any(|v|!v.is_finite())||d[0]<=0.{return Err("Invalid chassis tick".into());}
                let ids=self.chassis_ids(&(0..count).map(|i|d[5+i*11]).collect::<Vec<_>>())?;let center=[d[1],d[2],d[3]];number(out,count as f64);
                for (i,id) in ids.into_iter().enumerate(){let mut drive=self.drives.remove(&id).unwrap();drive.tick(self,id,&d[5+i*11..16+i*11],d[0],center,out);self.forces.extend(drive.forces.drain(..));self.torques.extend(drive.torques.drain(..));self.drives.insert(id,drive);}
            },
            _=>return Err("Unknown engine physics command".into())
        }Ok(())
    }
    fn shape(&self,d:&[f64])->Outcome<SharedShape> {
        if d.is_empty() || d.iter().any(|n|!n.is_finite()) {return Err("Invalid shape descriptor".into());}
        Ok(match d[0] as u32 {
            0=>{args(d,2)?;SharedShape::ball(d[1] as f32)},
            1=>{args(d,4)?;SharedShape::cuboid(d[1] as f32,d[2] as f32,d[3] as f32)},
            2=>{args(d,5)?;SharedShape::round_cuboid(d[1] as f32,d[2] as f32,d[3] as f32,d[4] as f32)},
            3=>{args(d,3)?;SharedShape::capsule_y(d[1] as f32,d[2] as f32)},
            4..=6=>{if d.len()<4 {return Err("Invalid mesh descriptor".into());}let nv=d[2] as usize;let nt=d[3] as usize;args(d,4+nv*3+nt*3)?;
                let vertices=(0..nv).map(|i|v(d,4+i*3)).collect::<Vec<_>>();let mut indices=Vec::with_capacity(nt);
                for i in 0..nt {let at=4+nv*3+i*3;let t=[d[at] as u32,d[at+1] as u32,d[at+2] as u32];if t.iter().any(|&v|v as usize>=nv){return Err("Invalid mesh index".into());}indices.push(t);}
                match d[0] as u32 {4=>SharedShape::trimesh_with_flags(vertices,indices,TriMeshFlags::from_bits_truncate(d[1] as u16)).map_err(|e|format!("Invalid native trimesh: {e}"))?,
                    5=>SharedShape::convex_mesh(vertices,&indices).ok_or("Native Rapier rejected convex mesh")?,_=>SharedShape::convex_hull(&vertices).ok_or("Native Rapier rejected convex hull")?}
            },_=>return Err("Unsupported native shape".into())
        })
    }
}
