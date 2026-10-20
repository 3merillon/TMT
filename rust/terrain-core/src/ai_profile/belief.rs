use super::*;

pub(super) struct Belief { pub tank:f64,pub visible:bool,pub at:f64,pub center:V,pub hypotheses:Vec<(V,f64)> }
fn cloud(center:V,radius:f64)->Vec<(V,f64)> {
    if radius<0.25 {return vec![(center,1.)];}
    let (right,forward)=frame(norm(center));let mut points=vec![(center,0.4)];
    for i in 0..6 {let angle=i as f64*std::f64::consts::PI/3.;
        let offset=add(mul(right,angle.cos()*radius*0.6),mul(forward,angle.sin()*radius*0.6));
        points.push((mul(norm(add(center,offset)),len(center)),0.1));}
    points
}
fn centroid(h:&[(V,f64)])->V {let mut p=[0.;3];let mut total=0.;for &(point,weight) in h {for i in 0..3 {p[i]+=point[i]*weight;}total+=weight;}[p[0]/total,p[1]/total,p[2]/total]}
pub(super) fn beliefs(o:&Observation,forget:f64)->(Vec<Belief>,Option<V>) {
    let mut all=Vec::new();
    for c in &o.contacts {if c.team==o.team {continue;}
        if !c.visible&&forget>=0.&&o.fuel!=0.&&c.uncertainty>forget*o.fuel+1e-9 {continue;}
        let hypotheses=if c.visible {vec![(c.p,1.)]}else{cloud(c.p,c.uncertainty)};
        let center=if c.visible {c.p}else{centroid(&hypotheses)};
        all.push(Belief {tank:c.tank,visible:c.visible,at:c.at,center,hypotheses});
    }
    all.sort_by(|a,b|b.visible.cmp(&a.visible).then_with(||b.at.total_cmp(&a.at)).then_with(||a.tank.total_cmp(&b.tank)));
    let guess=if all.is_empty(){o.sound.map(|(bearing,_)|{
        let direction=rotate([bearing.sin(),0.,bearing.cos()],o.q);let angle=10./len(o.p);
        norm(add(mul(norm(o.p),angle.cos()),mul(norm(direction),angle.sin())))
    })}else{None};(all,guess)
}
pub(super) fn heard(o:&Observation,center:V)->Belief {let hypotheses=cloud(center,4.);Belief {tank:-1.,visible:false,at:o.sound.unwrap().1/60.,center:centroid(&hypotheses),hypotheses}}
pub(super) fn choose(position:V,mut all:Vec<Belief>)->Option<Belief> {
    let mut nearest=None;let mut range=f64::INFINITY;
    for (i,b) in all.iter().enumerate(){if b.visible {let distance=len(sub(b.center,position));if distance<range {range=distance;nearest=Some(i);}}}
    if all.is_empty(){None}else{Some(all.remove(nearest.unwrap_or(0)))}
}
