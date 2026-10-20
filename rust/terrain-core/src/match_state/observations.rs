//! Match-owned knowledge. Native scenes are traversed without returning to JS;
//! analytic worlds service the identical ordered request stream. A refresh/scan
//! publishes only after every query succeeds, including its RNG and charge spend.
use super::{Match,finite,flag,integer,output,DT};
use super::armament::{Arsenal,v,q,add,sub,mul,len,norm,rotate,wrap};
use crate::{combat::{Combat,Combats},traversal::Queries,physics::Physics};
type V=[f64;3];
fn dot(a:V,b:V)->f64 {a[0]*b[0]+a[1]*b[1]+a[2]*b[2]}
fn cross(a:V,b:V)->V {[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]}
fn index(x:f64,n:usize)->Result<usize,String> {if integer(x)&&x<(n as f64){Ok(x as usize)}else{Err("Invalid observer".into())}}
#[derive(Clone,Copy)]
struct Pose {p:V,q:[f64;4]}
fn poses(d:&[f64],n:usize)->Result<Vec<Pose>,String> {finite(d,n*7)?;Ok(d.chunks_exact(7).map(|r|Pose{p:v(r,0),q:q(r,3)}).collect())}
struct Kit {sensor:V,hull:V,half:V,turret:V,top:f64,ring:V}
impl Kit {
    fn read(d:&[f64])->Result<Self,String> {finite(d,16)?;if d[6..9].iter().any(|x|*x<0.)||d[12]<0.{return Err("Invalid sight kit".into());}
        Ok(Self{sensor:v(d,0),hull:v(d,3),half:v(d,6),turret:v(d,9),top:d[12],ring:v(d,13)})}
    fn points(&self,pose:Pose,yaw:f64,target:V,end:[V;2])->Vec<V> {
        let mut local=Vec::with_capacity(14);
        for sx in [-1.,1.] {for sy in [-1.,1.] {for sz in [-1.,1.] {
            local.push([self.hull[0]+sx*(self.half[0]-0.05).max(0.),self.hull[1]+sy*(self.half[1]-0.05).max(0.),self.hull[2]+sz*(self.half[2]-0.05).max(0.)]);
        }}}
        local.extend([self.hull,target]);let c=yaw.cos();let s=yaw.sin();
        for p in [self.turret,[self.turret[0],self.turret[1]+(self.top-0.05).max(0.),self.turret[2]]] {
            local.push([self.ring[0]+p[0]*c+p[2]*s,self.ring[1]+p[1],self.ring[2]-p[0]*s+p[2]*c]);
        }
        let mut points:Vec<V>=local.into_iter().map(|p|add(pose.p,rotate(p,pose.q))).collect();points.extend(end);points
    }
}
#[derive(Clone,Copy)]
struct Contact {position:V,time:f64,scan:bool,visible:bool,turns:f64}
#[derive(Clone,Copy)]
enum Request {Ray([f64;7]),Surface(V)}
impl Request {fn words(self)->Vec<f64>{match self {Self::Ray(r)=>{let mut w=vec![1.];w.extend(r);w},Self::Surface(p)=>{let mut w=vec![2.];w.extend(p);w}}}}
struct Job {
    scan:Option<usize>, record:bool, poses:Vec<Pose>, teams:Vec<f64>, alive:Vec<bool>, groups:Vec<Vec<usize>>,
    sensors:Vec<V>, points:Vec<Vec<V>>, contacts:Vec<Option<Contact>>, rng:u32,
    group:usize,target:usize,sensor:usize,point:usize,request:Option<Request>,
}
pub(super) struct Observations {
    kits:Vec<Kit>,radius:f64,lift:f64,target:V,fog:bool,seed:u64,
    contacts:Vec<Option<Contact>>,primary:Vec<Option<usize>>,
    // Counts at the current tick replace the old unbounded turn-start lists.
    // Each contact owns the number of subsequent starts, including ties at its tick.
    starts:Vec<(f64,f64)>,heard:Vec<Vec<(f64,f64)>>,impacts:Vec<Vec<(f64,V)>>,job:Option<Job>,
}
impl Observations {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){
        w.words(&[self.radius,self.lift]);w.words(&self.target);w.flag(self.fog);w.integer(self.seed);w.words(&self.snapshot());
        w.list(&self.kits,|w,k|{w.words(&k.sensor);w.words(&k.hull);w.words(&k.half);w.words(&k.turret);w.number(k.top);w.words(&k.ring);});
        w.list(&self.starts,|w,&(tick,count)|w.words(&[tick,count]));
        w.list(&self.heard,|w,row|w.list(row,|w,&(bearing,tick)|w.words(&[bearing,tick])));
        w.list(&self.impacts,|w,row|w.list(row,|w,(tick,p)|{w.number(*tick);w.words(p);}));
    }
    pub(super) fn last_impact(&self,id:usize)->Option<(f64,V)>{self.impacts[id].last().copied()}
    pub(super) fn last_sound(&self,id:usize)->Option<(f64,f64)>{self.heard[id].last().copied()}
    // Shared private-knowledge filter. Rows: tank, team, visible, time, uncertainty, p3.
    pub(super) fn contact_words(&self,id:usize,positions:&[V],c:&Combat,a:&Arsenal,tick:f64)->Vec<[f64;8]> {
        let n=self.kits.len();let mut rows=Vec::new();
        for target in 0..n {if target==id||c.units[target].health<=0.{continue;}let team=c.units[target].team;
            if !self.fog||team==c.units[id].team {let p=positions[target];rows.push([target as f64,team,1.,tick*DT,0.,p[0],p[1],p[2]]);}
            else if let Some(k)=self.contacts[id*n+target] {rows.push([target as f64,team,k.visible as u8 as f64,k.time,(a.fuel(target)*k.turns).min(20.),k.position[0],k.position[1],k.position[2]]);}
        }rows
    }
    pub(super) fn busy(&self)->bool {self.job.is_some()}
    pub(super) fn turn(&mut self,id:usize,tick:f64) {
        let a=&mut self.starts[id];if a.0==tick {a.1+=1.;}else{*a=(tick,1.);}
        let n=self.kits.len();for row in 0..n {if let Some(c)=&mut self.contacts[row*n+id] {if tick*DT>=c.time-1e-9 {c.turns+=1.;}}}
    }
    fn contact(&self,p:V,tick:f64,scan:bool,id:usize)->Contact {
        let a=self.starts[id];Contact{position:p,time:tick*DT,scan,visible:!scan,turns:if a.0*DT>=tick*DT-1e-9{a.1}else{0.}}
    }
    fn points(&self,id:usize,p:Pose,a:&Arsenal)->Vec<V> {self.kits[id].points(p,a.yaw(id),self.target,a.sight_endpoints(id,p.p,p.q))}
    fn start(&self,scan:Option<usize>,poses:Vec<Pose>,c:&Combat,a:&Arsenal,rng:u32)->Job {
        let mut groups:Vec<Vec<usize>>=Vec::new();for (id,u) in c.units.iter().enumerate() {
            if let Some(g)=groups.iter_mut().find(|g|c.units[g[0]].team==u.team){g.push(id);}else{groups.push(vec![id]);}
        }
        Job {scan,record:false,sensors:poses.iter().enumerate().map(|(i,p)|add(p.p,rotate(self.kits[i].sensor,p.q))).collect(),
            points:poses.iter().enumerate().map(|(i,p)|self.points(i,*p,a)).collect(),poses,
            teams:c.units.iter().map(|u|u.team).collect(),alive:c.units.iter().map(|u|u.health>0.).collect(),groups,
            contacts:self.contacts.clone(),rng,group:0,target:0,sensor:0,point:0,request:None}
    }
    fn visible(&self,j:&mut Job,visible:bool,tick:f64) {
        let n=self.kits.len();for &id in &j.groups[j.group] {
            let c=&mut j.contacts[id*n+j.target];if visible {*c=Some(self.contact(j.poses[j.target].p,tick,false,j.target));}else if let Some(c)=c{c.visible=false;}
        }
        j.target+=1;j.sensor=0;j.point=0;
    }
    fn answer(&self,j:&mut Job,d:&[f64],tick:f64)->Result<(),String> {
        match j.request.ok_or("No observation query pending")? {
            Request::Ray(_)=>{finite(d,1)?;if !flag(d[0]) {return Err("Invalid sight answer".into());}if d[0]==0.{self.visible(j,true,tick);}},
            Request::Surface(up)=>{if !d.is_empty(){finite(d,3)?;}let p=add(if d.is_empty(){mul(up,self.radius)}else{v(d,0)},mul(up,self.lift));
                j.contacts[j.scan.unwrap()*self.kits.len()+j.target]=Some(self.contact(p,tick,true,j.target));j.target+=1;},
        }
        j.request=None;Ok(())
    }
    fn next(&self,j:&mut Job,tick:f64)->Option<Request> {
        if j.request.is_some(){return j.request;}
        let n=self.kits.len();
        if let Some(id)=j.scan {
            while j.target<n {
                if j.teams[j.target]==j.teams[id]||!j.alive[j.target] {j.target+=1;continue;}
                // frame(normalize(position), 0), retaining both normalizations.
                let up=norm(norm(j.poses[j.target].p));let reference=if up[2].abs()<0.96{[0.,0.,1.]}else{[1.,0.,0.]};
                let base=norm(sub(reference,mul(up,dot(reference,up))));let right=norm(cross(up,base));
                let forward=add(mul(base,1.),mul(right,0.));let right=norm(cross(up,forward));
                j.rng=j.rng.wrapping_mul(1664525).wrapping_add(1013904223);let angle=j.rng as f64/4294967296.*std::f64::consts::PI*2.;
                let offset=add(mul(right,angle.cos()*1.15),mul(forward,angle.sin()*1.15));
                j.request=Some(Request::Surface(norm(add(j.poses[j.target].p,offset))));return j.request;
            }
        } else {
            while j.group<j.groups.len() {
                if j.target==n {j.group+=1;j.target=0;j.sensor=0;j.point=0;continue;}
                let members=&j.groups[j.group];
                if j.teams[j.target]==j.teams[members[0]] {j.target+=1;continue;}
                if !j.alive[j.target]||!members.iter().any(|&id|j.alive[id]) {self.visible(j,false,tick);continue;}
                if !self.fog {self.visible(j,true,tick);continue;}
                while j.sensor<members.len() {
                    let id=members[j.sensor];if !j.alive[id] {j.sensor+=1;j.point=0;continue;}
                    if j.point==j.points[j.target].len() {j.sensor+=1;j.point=0;continue;}
                    let origin=j.sensors[id];let delta=sub(j.points[j.target][j.point],origin);j.point+=1;let extent=len(delta);
                    if extent>=self.radius*1.65 {continue;}
                    let direction=norm(delta);j.request=Some(Request::Ray([origin[0],origin[1],origin[2],direction[0],direction[1],direction[2],(extent-0.12).max(0.)]));return j.request;
                }
                self.visible(j,false,tick);
            }
        }
        None
    }
    fn primary(&mut self,poses:&[Pose],only:Option<usize>) {
        let n=self.kits.len();for id in 0..n {if only.is_some_and(|i|i!=id){continue;}let mut best=None;let mut best_distance=f64::INFINITY;
            for target in 0..n {if let Some(c)=self.contacts[id*n+target] {
                let distance=len(sub(c.position,poses[id].p));let replace=best.map_or(true,|b:usize|{let b=self.contacts[id*n+b].unwrap();
                    (c.visible&&!b.visible)||(c.visible==b.visible&&if c.visible{distance<best_distance}else{c.time>b.time})});
                if replace {best=Some(target);best_distance=distance;}
            }}self.primary[id]=best;
        }
    }
    fn snapshot(&self)->Vec<f64> {
        let mut w=Vec::with_capacity(self.contacts.len()*8+self.kits.len());
        for c in &self.contacts {if let Some(c)=c {w.extend([1.,c.position[0],c.position[1],c.position[2],c.time,c.scan as u8 as f64,c.visible as u8 as f64,c.turns]);}else{w.extend([0.;8]);}}
        w.extend(self.primary.iter().map(|x|x.map_or(-1.,|i|i as f64)));w
    }
}
impl Match {
    pub(super) fn observation_command(&mut self,op:u32,d:&[f64],combats:&mut Combats,queries:&mut Queries,physics:Option<&Physics>,out:&mut Vec<u8>)->Result<(),String> {
        let n=self.units.len();let combat=self.combat.ok_or("Observations require combat")?;
        let a=self.arsenal.as_ref().ok_or("Observations require armament")?;
        if op==16 {
            finite(d,8+n*16)?;if self.observations.is_some()||self.tick!=0.||d[0]!=1.||d[1]<=0.||!flag(d[2])||!integer(d[3])||d[4]<0. {return Err("Invalid observation admission".into());}
            let kits=d[8..].chunks_exact(16).map(Kit::read).collect::<Result<Vec<_>,_>>()?;
            let mut o=Observations{kits,radius:d[1],fog:d[2]==1.,seed:d[3] as u64,lift:d[4],target:v(d,5),contacts:vec![None;n*n],primary:vec![None;n],starts:vec![(-1.,0.);n],heard:vec![Vec::new();n],impacts:vec![Vec::new();n],job:None};
            o.turn(self.active,0.);self.observations=Some(o);output(out,&[]);return Ok(());
        }
        if self.observations.is_none(){return Err("Resident observations are absent".into());}
        if self.observations.as_ref().unwrap().busy()&&!matches!(op,18|24|26) {return Err("Observation query is pending".into());}
        let mut resident=Vec::new();
        let d=if let Some(m)=&self.motion {
            let size=match op {17=>Some(3),19|22=>Some(1),20=>Some(2),25=>Some(6),_=>None};
            if let Some(size)=size {finite(d,size)?;resident.extend(d);
                if op==22 {let id=index(d[0],n)?;resident.extend(&m.units[id].cur[..7]);}else{resident.extend(m.poses());}
                &resident
            }else{d}
        }else{d};
        // 17 sight refresh / 25 atomic radar scan. A native query lease is consumed
        // entirely in this call; only analytic hosts use 18 to resume a request.
        if op==17||op==25 {
            let record=op==25&&self.journal.is_some();let start=if op==25{if record{6}else{5}}else{3};finite(d,start+7*n)?;
            if record&&!flag(d[5]){return Err("Invalid scan origin".into());}
            if !integer(d[0])||d[0]>2.||!integer(d[1])||d[1]>u32::MAX as f64||d[2]<=0. {return Err("Invalid observation query lease".into());}
            queries.require(d[0] as u32,d[1] as u32)?;
            let poses=poses(&d[start..],n)?;let c=combats.get(combat)?;
            let scan=if op==25 {if !flag(d[4]){return Err("Invalid scan serial flag".into());}
                let id=match index(d[3],n){Ok(i)=>i,Err(_)=>{output(out,&[0.,0.]);return Ok(());}};
                if !self.allowed_aim(id,d[4]==1.,c)||!c.can_scan(id) {output(out,&[0.,0.]);return Ok(());}Some(id)
            }else{None};
            let rng=self.rng.ok_or("Observations require match random stream")?;
            let o=self.observations.as_mut().unwrap();let mut j=o.start(scan,poses,c,a,rng);
            j.record=record&&d[5]==1.;
            let mut scratch=Vec::new();
            while let Some(request)=o.next(&mut j,self.tick) {
                if d[0]==0. {output(out,&request.words());o.job=Some(j);return Ok(());}
                let (op,args)=match request {Request::Ray(r)=>(1,r.to_vec()),Request::Surface(up)=>{
                    if d[0]==2.{(5,up.to_vec())}else{let distance=d[2]/4.*3f64.sqrt()+1.;let length=len(up);
                        (0,vec![up[0]*distance/length,up[1]*distance/length,up[2]*distance/length,-up[0],-up[1],-up[2],2.*distance])}
                }};
                queries.flight_query(d[0] as u32,d[1] as u32,op,&args,d[2],physics,&mut scratch)?;
                let words:Vec<f64>=scratch.chunks_exact(8).map(|b|f64::from_le_bytes(b.try_into().unwrap())).collect();
                o.answer(&mut j,if matches!(request,Request::Surface(_)) {if words.is_empty(){&[]}else{&words[1..4]}}else{&words},self.tick)?;
            }
            self.publish_observations(j,combats)?;output(out,&[0.,1.]);return Ok(());
        }
        let o=self.observations.as_mut().unwrap();
        match op {
            18=>{
                // Invalid answers leave the pending request intact for correction.
                let mut j=o.job.take().ok_or("No observation query pending")?;
                if let Err(e)=o.answer(&mut j,d,self.tick){o.job=Some(j);return Err(e);}
                if let Some(r)=o.next(&mut j,self.tick){output(out,&r.words());o.job=Some(j);return Ok(());}
                self.publish_observations(j,combats)?;output(out,&[0.,1.]);return Ok(());
            },
            19=>{
                finite(d,1+7*n)?;let id=index(d[0],n)?;let poses=poses(&d[1..],n)?;let c=combats.get(combat)?;let mut records=Vec::new();
                for r in o.contact_words(id,&poses.iter().map(|p|p.p).collect::<Vec<_>>(),c,a,self.tick) {records.extend([r[2],r[0],r[1],r[5],r[6],r[7],r[3],r[4]]);}
                let mut w=vec![(records.len()/8) as f64];w.extend(records);w.push(o.heard[id].len() as f64);for &(bearing,tick) in &o.heard[id]{w.extend([bearing,tick]);}
                w.push(o.impacts[id].len() as f64);for &(tick,p) in &o.impacts[id]{w.push(tick);w.extend(p);}output(out,&w);return Ok(());
            },
            20=>{
                finite(d,2+7*n)?;let shooter=index(d[0],n)?;if !integer(d[1]){return Err("Invalid heard shot".into());}let poses=poses(&d[2..],n)?;let c=combats.get(combat)?;
                for id in 0..n {if c.units[id].team==c.units[shooter].team||c.units[id].health<=0.||len(sub(poses[id].p,poses[shooter].p))>40.||o.contacts[id*n+shooter].is_some_and(|c|c.visible){continue;}
                    let delta=sub(poses[shooter].p,poses[id].p);let bearing=dot(delta,rotate([1.,0.,0.],poses[id].q)).atan2(dot(delta,rotate([0.,0.,1.],poses[id].q)));
                    let mut hash=0x811c9dc5u32;for part in [o.seed,d[1] as u64,id as u64] {for b in part.to_string().bytes(){hash=(hash^(b as u32)).wrapping_mul(0x01000193);}}
                    let noise=(hash as f64/4294967296.*2.-1.)*(15.*std::f64::consts::PI/180.);let h=&mut o.heard[id];h.push((wrap(bearing+noise),self.tick));if h.len()>4{h.remove(0);}
                }
            },
            21=>{finite(d,4)?;let id=index(d[0],n)?;let h=&mut o.impacts[id];h.push((self.tick,v(d,1)));if h.len()>4{h.remove(0);}},
            22=>{finite(d,8)?;let id=index(d[0],n)?;let points=o.points(id,Pose{p:v(d,1),q:q(d,4)},a);output(out,&points.into_iter().flatten().collect::<Vec<_>>());return Ok(());},
            23=>{finite(d,17)?;let id=index(d[0],n)?;let kit=Kit::read(&d[1..])?;o.kits[id]=kit;},
            24=>{finite(d,0)?;o.job=None;},
            26=>{finite(d,0)?;output(out,&o.snapshot());return Ok(());},
            _=>return Err("Unknown observation operation".into()),
        }
        output(out,&[]);Ok(())
    }
    fn publish_observations(&mut self,j:Job,combats:&mut Combats)->Result<(),String> {
        if let Some(id)=j.scan {combats.get_mut(self.combat.unwrap())?.scan(id);self.rng=Some(j.rng);if j.record{self.record_action(3,id,&[]);}}
        let o=self.observations.as_mut().unwrap();o.contacts=j.contacts;o.primary(&j.poses,j.scan);Ok(())
    }
}
