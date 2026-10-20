//! Standing-water drag; arithmetic mirrors game/rules/projectile-water.ts.
use crate::core::Outcome;
type V = [f64; 3];
const DRAG: f64 = 1.2;
pub(crate) struct Water { n: usize, levels: Vec<f64>, max_level: f64 }
impl Water {
    /// Additive flight command 6: [version=1, n, 6*n*n water levels]. Zero is dry.
    pub fn read(d: &[f64]) -> Outcome<Self> {
        if d.len()<2 || d[0]!=1. || !d[1].is_finite() || d[1]<1. || d[1]>128. || d[1].fract()!=0. { return Err("Invalid projectile water grid".into()); }
        let n=d[1] as usize;
        if d.len()!=2+6*n*n || d[2..].iter().any(|&v| !v.is_finite() || v<0. || v>=100.) { return Err("Invalid projectile water levels".into()); }
        Ok(Self { n, levels:d[2..].to_vec(), max_level:d[2..].iter().copied().fold(0.,f64::max) })
    }
    fn level(&self,p:V)->f64 {
        let [x,y,z]=p; let [ax,ay,az]=[x.abs(),y.abs(),z.abs()];
        let (face,u,v)=if ax>=ay && ax>=az { if x>0. {(0,-z/x,y/x)} else {(1,z/-x,y/-x)} }
            else if ay>=az { if y>0. {(2,x/y,-z/y)} else {(3,x/-y,z/-y)} }
            else if z>0. {(4,x/z,y/z)} else {(5,-x/-z,y/-z)};
        let coord=|a:f64| (((a.atan()/std::f64::consts::FRAC_PI_4+1.)*0.5*self.n as f64).floor().max(0.) as usize).min(self.n-1);
        self.levels[(face*self.n+coord(v))*self.n+coord(u)]
    }
    pub fn contains(&self,p:V)->bool { super::flight::len(p)<self.level(p) }
    pub fn canonical(&self,w:&mut crate::canonical::Writer){w.number(self.n as f64);w.words(&self.levels);}
    pub fn advance(&self,p:V,velocity:V,dt:f64)->Option<(V,V)> {
        let mut speed=super::flight::len(velocity); if speed<1e-10{return None;}
        let direction=velocity.map(|v|v/speed);let distance=speed*dt;
        let dot=|a:V,b:V|a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
        let point=|s:f64|[p[0]+direction[0]*s,p[1]+direction[1]*s,p[2]+direction[2]*s];
        let nearest=(-dot(p,direction)).clamp(0.,distance);
        if super::flight::len(point(nearest))>=self.max_level{return None;}
        let steps=((distance/0.05).ceil() as usize).clamp(1,128);let h=dt/steps as f64;
        let mut travelled=0.;let mut wet=false;
        for _ in 0..steps {
            let start=point(travelled);let midpoint=point(travelled+speed*h*0.5);let level=self.level(midpoint);
            let b=dot(start,direction);let discriminant=b*b-(start[0]*start[0]+start[1]*start[1]+start[2]*start[2]-level*level);
            if level<=0. || discriminant<=0. {travelled+=speed*h;continue;}
            let root=discriminant.sqrt();let entry=(-b-root).max(0.);let exit=-b+root;
            if exit<=0. || entry>=speed*h {travelled+=speed*h;continue;}
            let remaining=h-entry/speed;
            let water_time=remaining.min((DRAG*(exit-entry).min(speed*remaining)).exp_m1()/(DRAG*speed));
            travelled+=entry+(DRAG*speed*water_time).ln_1p()/DRAG;
            speed/=1.+DRAG*speed*water_time;travelled+=speed*(remaining-water_time);wet=true;
        }
        if wet {Some((point(travelled),direction.map(|v|v*speed)))} else {None}
    }
}
