use super::*;
pub(super) enum Work {Yield,Surface(V),Ray(V,V,f64),Done}
struct Endpoint {distance:f64,point:Option<V>,normal_dot:f64,threat:usize,covered:usize}
pub(super) struct Relocation {position:V,params:Params,threats:Vec<V>,reach:f64,bearings:Vec<(f64,f64)>,cursor:usize,pending:Option<Endpoint>,best:f64,pub target:Option<V>}
impl Relocation {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){
        w.words(&self.position);self.params.canonical(w);w.list(&self.threats,|w,p|w.words(p));w.words(&[self.reach,self.best]);
        w.list(&self.bearings,|w,&(a,b)|w.words(&[a,b]));w.integer(self.cursor as u64);w.option(&self.target,|w,p|w.words(p));
        w.option(&self.pending,|w,e|{w.words(&[e.distance,e.normal_dot]);w.option(&e.point,|w,p|w.words(p));w.integer(e.threat as u64);w.integer(e.covered as u64);});
    }
    pub fn new(o:&Observation,params:&Params,threats:Vec<V>,random:&mut Random,reach:f64)->Self {
        let drive=(o.fuel*0.85).max(0.5);let offset=random.next()*2.*std::f64::consts::PI/12.;let mut bearings=Vec::new();
        for i in 0..12 {bearings.push((offset+i as f64*2.*std::f64::consts::PI/12.,drive.min(params.relocate[0]+(params.relocate[1]-params.relocate[0])*random.next())));}
        if params.random_relocate {bearings.truncate(1);}
        Self {position:o.p,params:params.clone(),threats,reach,bearings,cursor:0,pending:None,best:f64::NEG_INFINITY,target:None}
    }
    pub fn next(&mut self,budget:f64,radius:f64)->Work {
        loop {
            if self.pending.is_none(){
                if self.cursor>=self.bearings.len(){return Work::Done;}if budget<1. {return Work::Yield;}
                let (bearing,distance)=self.bearings[self.cursor];let up=norm(self.position);let (right,forward)=frame(up);let angle=distance/len(self.position);
                let heading=add(mul(forward,bearing.cos()),mul(right,bearing.sin()));let direction=norm(add(mul(up,angle.cos()),mul(heading,angle.sin())));
                self.pending=Some(Endpoint {distance,point:None,normal_dot:0.,threat:0,covered:0});self.cursor+=1;return Work::Surface(direction);
            }
            let e=self.pending.as_mut().unwrap();
            if e.point.is_some()&&!self.params.random_relocate&&e.threat<self.threats.len(){
                if budget<1. {return Work::Yield;}let threat=self.threats[e.threat];e.threat+=1;let point=e.point.unwrap();
                let from=add(threat,mul(norm(threat),0.8));let to=add(point,mul(norm(point),0.8));return Work::Ray(from,norm(sub(to,from)),(len(sub(from,to))-0.2).max(0.));
            }
            let e=self.pending.take().unwrap();let Some(point)=e.point else{continue;};
            let slope=e.normal_dot.clamp(-1.,1.).acos();let height=len(point)-radius;let covered=if self.threats.is_empty(){0.}else{e.covered as f64/self.threats.len() as f64};
            let hole=(len(self.position)-radius-height-0.35).max(0.);let nearest=self.threats.iter().fold(f64::INFINITY,|best,&threat|best.min(len(sub(threat,point))));
            let out=if nearest.is_finite(){(nearest-self.reach).max(0.)}else{0.};
            let score=if slope>25.*std::f64::consts::PI/180. {f64::NEG_INFINITY}else{self.params.relocate[2]*covered+self.params.relocate[3]*height-1.5*hole-0.6*out-0.02*(e.distance-(self.params.relocate[0]+self.params.relocate[1])/2.).abs()};
            if score.is_finite()&&score>self.best {self.best=score;self.target=Some(add(point,mul(norm(point),0.55)));}
        }
    }
    pub fn surface(&mut self,point:Option<V>,normal:V){let e=self.pending.as_mut().unwrap();e.point=point;e.normal_dot=point.map_or(0.,|p|dot(normal,norm(p)));}
    pub fn ray(&mut self,hit:bool){if hit {self.pending.as_mut().unwrap().covered+=1;}}
}
pub(super) struct Pursuit {target:V,anchor:Option<(V,f64)>,reverse_until:f64}
impl Pursuit {
    pub(super) fn canonical(&self,w:&mut crate::canonical::Writer){w.words(&self.target);w.option(&self.anchor,|w,(p,t)|{w.words(p);w.number(*t);});w.number(self.reverse_until);}
    pub fn new(target:V)->Self {Self {target,anchor:None,reverse_until:-1.}}
    pub fn drive(&mut self,position:V,heading:f64,tick:f64)->(f64,f64) {
        let up=norm(position);let (right,forward)=frame(up);let delta=tangent(sub(self.target,position),up);let range=len(delta);
        if range<0.6 {return (0.,0.);}if tick<self.reverse_until {return (-0.8,0.);}
        let desired=dot(delta,right).atan2(dot(delta,forward));let error=wrap(desired-heading);
        let throttle=if error.abs()>0.8 {0.}else{(range/1.5).clamp(0.35,1.)};let steer=-(error*1.8).clamp(-1.,1.);
        if throttle==0. {self.anchor=None;}else if let Some((p,t))=self.anchor {
            if tick-t>=45. {if len(sub(p,position))<0.1 {self.anchor=None;self.reverse_until=tick+30.;return (-0.8,0.);}self.anchor=Some((position,tick));}
        }else{self.anchor=Some((position,tick));}(throttle,steer)
    }
}
