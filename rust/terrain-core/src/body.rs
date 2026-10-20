//! Resident structural ownership. Body topology uses the same recipe/face arenas as
//! terrain; publication and rollback share the world's existing transaction.
use crate::core::*;
use crate::storage::Map;
use crate::world::World;

pub struct Body {
    pub id: u32, pub revision: u32, pub regions: Vec<Region>, pub boundary: Vec<(u32,u32)>,
    pub center: Point, pub volume: f64,
}

impl World {
    pub fn body_view(&self, id: u32, preview: bool) -> Outcome<&Body> {
        if preview {
            let tx=self.transaction.as_ref().ok_or("No resident transaction")?;
            if let Some(body)=tx.bodies.iter().find(|b|b.id==id) { return Ok(body); }
            if tx.removed_bodies.contains(&id) { return Err("Body was replaced in this transaction".into()); }
        }
        self.bodies.iter().find(|b|b.id==id).ok_or("Unknown resident body".into())
    }
    fn make_body(&mut self, regions: Vec<Region>) -> Outcome<Body> {
        let graph=self.local_graph(&regions)?;
        if graph.roots.iter().any(|&r|r!=0) { return Err("Disconnected structural body".into()); }
        // Audit separately from volumes: positive cells alone don't prove a closed shell.
        let mut edges:Map<(u32,u32),(u32,i32)>=Map::default();
        for &(_,face) in &graph.boundary {
            let ids=self.core.ids(face);
            for i in 0..ids.len() { let a=ids[i];let b=ids[(i+1)%ids.len()];let e=edges.entry((a.min(b),a.max(b))).or_default();e.0+=1;e.1+=if a<b {1}else{-1}; }
        }
        if edges.values().any(|e|e.0!=2 || e.1!=0) { return Err("Recut body boundary did not close".into()); }
        let mut seen=Map::default();let mut center=[0.;3];let mut volume=0.;
        for region in &regions {
            volume+=region.volume;
            for &face in &self.core.region_links[region.faces.range()] {
                for &id in self.core.ids(face) { if seen.insert(id,()).is_none() { for a in 0..3 { center[a]+=self.core.positions[id as usize][a]; } } }
            }
        }
        if seen.is_empty() || !(volume>0.) { return Err("Empty structural body".into()); }
        for x in &mut center { *x/=seen.len() as f64; }
        let tx=self.transaction.as_mut().unwrap();
        tx.body_sequence=tx.body_sequence.checked_add(1).ok_or("Body ID capacity exceeded")?;
        Ok(Body { id:tx.body_sequence,revision:tx.revision,regions,boundary:graph.boundary,center,volume })
    }
    /// Transfer every unanchored component, including clean remote bricks, to retained
    /// bodies. Static ownership masks live as long as the world, even after a body is cut away.
    pub fn detach(&mut self) -> Outcome<()> {
        let result=self.detach_inner();if result.is_err() { self.abort(); }result
    }
    fn detach_inner(&mut self) -> Outcome<()> {
        let graph=self.graph_view(true)?;
        let mut groups:std::collections::BTreeMap<u32,Vec<Region>>=std::collections::BTreeMap::new();
        let mut removed:Map<u32,Vec<usize>>=Map::default();
        for (index,&(brick,local)) in graph.regions.iter().enumerate() {
            let root=graph.roots[index];if graph.anchored[root as usize] { continue; }
            groups.entry(root).or_default().push(self.page(brick as usize).unwrap().regions[local as usize].clone());
            removed.entry(brick).or_default().push(local as usize);
        }
        if groups.is_empty() { return Ok(()); }
        for regions in groups.into_values() {
            let body=self.make_body(regions)?;let tx=self.transaction.as_mut().unwrap();
            for r in &body.regions { tx.masks.push(Mask { tet:r.tet,constraints:self.core.region_signs[r.constraints.range()].to_vec() }); }
            tx.bodies.push(body);
        }
        for (brick,locals) in removed {
            let mut page=self.page(brick as usize).unwrap().clone();let mut index=0;
            page.regions.retain(|_| { let keep=locals.binary_search(&index).is_err();index+=1;keep });
            let tx=self.transaction.as_mut().unwrap();page.revision=tx.revision;tx.pages[brick as usize]=Some(page);
        }
        self.transaction.as_mut().unwrap().graph=None;self.connect_inner()
    }
    /// Field samples are prepared in the immutable source frame by the current host.
    /// The host must fence its request-time physics pose before committing the stage.
    pub fn recut_body(&mut self, id: u32, field: u32) -> Outcome<()> {
        let result=self.recut_inner(id,field);if result.is_err() { self.abort(); }result
    }
    fn recut_inner(&mut self, id: u32, field: u32) -> Outcome<()> {
        self.graph_view(true)?;
        let body=self.body_view(id,true)?;let regions=body.regions.clone();let before=body.volume;
        let mark=self.core.import_mark();let (survivors,removed)=self.core.clip_regions(&regions,field)?;
        if removed==0. { self.core.abort_import(mark);return Ok(()); }
        let graph=self.local_graph(&survivors)?;
        let mut groups:std::collections::BTreeMap<u32,Vec<Region>>=std::collections::BTreeMap::new();
        for (index,r) in survivors.into_iter().enumerate() { groups.entry(graph.roots[index]).or_default().push(r); }
        let mut children=Vec::new();let mut after=0.;
        for regions in groups.into_values() { let body=self.make_body(regions)?;after+=body.volume;children.push(body); }
        if (before-after-removed).abs()>1e-5f64.max(before*1e-4) { return Err("Recut body volume ledger failed".into()); }
        let tx=self.transaction.as_mut().unwrap();
        if let Some(index)=tx.bodies.iter().position(|b|b.id==id) { tx.bodies.remove(index); }
        else { tx.removed_bodies.push(id); }
        tx.bodies.extend(children);tx.body_removed+=removed;Ok(())
    }
    /// Numeric mask packet is directly appendable to the compiler command (no tet strings).
    pub fn mask_words(&self, preview: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let staged=if preview { &self.transaction.as_ref().ok_or("No resident transaction")?.masks[..] } else { &[] };
        out.clear();put(out,(self.masks.len()+staged.len()) as u32);
        for mask in self.masks.iter().chain(staged) { put(out,mask.tet);put(out,mask.constraints.len() as u32);for &sign in &mask.constraints { put(out,sign as u32); } }Ok(())
    }
    /// Body ABI v1: f64 header [version, count, independently removed volume, reserved],
    /// then [id, region count, volume, center xyz] per body. IDs remain exact u32 values.
    pub fn body_words(&self, preview: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let tx=if preview { Some(self.transaction.as_ref().ok_or("No resident transaction")?) } else { None };
        let bodies=self.bodies.iter().filter(|b|tx.map_or(true,|t|!t.removed_bodies.contains(&b.id)))
            .chain(tx.into_iter().flat_map(|t|&t.bodies));
        out.clear();for x in [1.,bodies.clone().count() as f64,tx.map_or(0.,|t|t.body_removed),0.] { value(out,x); }
        for b in bodies { for x in [b.id as f64,b.regions.len() as f64,b.volume,b.center[0],b.center[1],b.center[2]] { value(out,x); } }Ok(())
    }
    /// Qualification only: reconstructs a packet so the independent TS oracle can inspect
    /// retained source faces. Runtime consumers use numeric render/query/collider feeds.
    pub fn export_body(&self, id: u32, preview: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let body=self.body_view(id,preview)?;let mut pages:Vec<Page>=Vec::new();
        for r in &body.regions {
            let brick=self.core.tets[r.tet as usize].brick;
            let index=if let Some(index)=pages.iter().position(|p|p.brick==brick) { index } else { pages.push(Page { brick,revision:body.revision,tets:None,regions:Vec::new(),removed:Vec::new(),removed_volume:0. });pages.len()-1 };
            pages[index].regions.push(r.clone());
        }
        crate::packet::pack_flat(&self.core,&pages).encode(out);Ok(())
    }
}
fn put(out: &mut Vec<u8>, v: u32) { out.extend_from_slice(&v.to_le_bytes()); }
fn value(out: &mut Vec<u8>, v: f64) { out.extend_from_slice(&v.to_le_bytes()); }
