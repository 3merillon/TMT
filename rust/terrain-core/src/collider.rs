//! Structural collider descriptors, preserving the TS per-source full-box proof and
//! convex-region fallback. Shape cooking belongs to the single interacting physics world.
use crate::core::*;
use crate::storage::Map;
use crate::world::World;

#[derive(Default)]
struct Feed { meta: Vec<[u32;8]>, mass: Vec<[f64;4]>, positions: Vec<f32>, indices: Vec<u32>, regions: Vec<u32> }
impl Feed {
    fn push(&mut self, core: &Core, regions: &[Region], ids: &[u32], center: Point, full_box: Option<Bounds>) -> Outcome<()> {
        if self.meta.len()==8192 { return Err("Structural compound exceeds admitted collider capacity".into()); }
        let start=self.positions.len() as u32/3;let first_index=self.indices.len() as u32;let first_region=self.regions.len() as u32;
        let volume=ids.iter().map(|&i|regions[i as usize].volume).sum();let mut offset=[0.;3];
        if let Some(b)=full_box {
            for mask in 0..8 { for a in 0..3 { self.positions.push(((if mask&(1<<a)!=0 { b.max[a] } else { b.min[a] })-center[a]) as f32); } }
        } else {
            let points=points(core,regions,ids);let mut local=[0.;3];
            for &id in &points { for a in 0..3 { local[a]+=core.positions[id as usize][a]; } }
            for a in 0..3 { local[a]/=points.len() as f64;offset[a]=local[a]-center[a]; }
            let mut remap=Map::default();
            for (index,&id) in points.iter().enumerate() { remap.insert(id,index as u32);for a in 0..3 { self.positions.push((core.positions[id as usize][a]-local[a]) as f32); } }
            for &id in ids { for &face in &core.region_links[regions[id as usize].faces.range()] {
                let v=core.ids(face);for i in 1..v.len()-1 { for id in [v[0],v[i],v[i+1]] { self.indices.push(remap[&id]); } }
            } }
        }
        self.regions.extend_from_slice(ids);
        self.meta.push([start,self.positions.len() as u32/3-start,first_index,self.indices.len() as u32-first_index,first_region,ids.len() as u32,if full_box.is_some(){0}else{1},0]);
        self.mass.push([volume,offset[0],offset[1],offset[2]]);Ok(())
    }
}
fn points(core: &Core, regions: &[Region], ids: &[u32]) -> Vec<u32> {
    let mut seen=Map::default();let mut points=Vec::new();
    for &id in ids { for &face in &core.region_links[regions[id as usize].faces.range()] { for &v in core.ids(face) { if seen.insert(v,()).is_none() { points.push(v); } } } }points
}
impl World {
    /// Collider ABI v1: eight u32 header words [version,count,xyz count,index count,
    /// region-ref count,0,0,0], count*8 u32 descriptors, count*4 f64 (volume,offset xyz),
    /// f32 positions, u32 indices and u32 body-local region references. All spans are flat.
    pub fn body_colliders(&self, id: u32, preview: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let body=self.body_view(id,preview)?;let mut groups:Vec<Vec<u32>>=Vec::new();let mut by_source=Map::default();
        for (i,r) in body.regions.iter().enumerate() {
            let group=*by_source.entry(r.source).or_insert_with(||{groups.push(Vec::new());groups.len()-1});groups[group].push(i as u32);
        }
        let mut feed=Feed::default();
        for group in groups {
            let mut bounds=Bounds { min:[f64::INFINITY;3],max:[f64::NEG_INFINITY;3] };
            for id in points(&self.core,&body.regions,&group) { for a in 0..3 { let p=self.core.positions[id as usize][a];bounds.min[a]=bounds.min[a].min(p);bounds.max[a]=bounds.max[a].max(p); } }
            let mut box_volume=1.;for a in 0..3 { box_volume*=bounds.max[a]-bounds.min[a]; }
            let volume:f64=group.iter().map(|&i|body.regions[i as usize].volume).sum();
            if (box_volume-volume).abs()<=1e-7f64.max(volume*1e-7) { feed.push(&self.core,&body.regions,&group,body.center,Some(bounds))?; }
            else { for id in group { feed.push(&self.core,&body.regions,&[id],body.center,None)?; } }
        }
        out.clear();
        for word in [1,feed.meta.len() as u32,feed.positions.len() as u32,feed.indices.len() as u32,feed.regions.len() as u32,0,0,0] { out.extend_from_slice(&word.to_le_bytes()); }
        for meta in feed.meta { for word in meta { out.extend_from_slice(&word.to_le_bytes()); } }
        for mass in feed.mass { for value in mass { out.extend_from_slice(&value.to_le_bytes()); } }
        for value in feed.positions { out.extend_from_slice(&value.to_le_bytes()); }
        for word in feed.indices.into_iter().chain(feed.regions) { out.extend_from_slice(&word.to_le_bytes()); }Ok(())
    }
}
