//! Compact transaction publication data. The host never rebuilds regions to discover
//! changed render/query pages or to integrate the accepted volume ledger.
use crate::core::*;
use crate::world::{Graph, World};
use std::collections::BTreeMap;

impl World {
    /// Independent full fine-graph audit, bypassing every cached brick graph.
    /// Intended for idle diagnostics; admission still validates each transaction.
    pub fn audit(&self) -> Outcome<()> {
        if self.transaction.is_some() { return Err("Cannot audit a pending transaction".into()); }
        let regions:Vec<Region>=self.pages.iter().flatten().flat_map(|p|p.regions.iter().cloned()).collect();
        let fine=self.local_graph(&regions)?;let mut anchors=vec![false;regions.len()];
        for (i,r) in regions.iter().enumerate() { if self.core.sources[r.source as usize].anchor.is_some() { anchors[fine.roots[i] as usize]=true; } }
        if fine.roots.iter().any(|&r|!anchors[r as usize]) { return Err("Unanchored static component in fine-graph audit".into()); }
        let mut expected=fine.boundary.clone();let mut actual=self.graph.boundary.clone();expected.sort_unstable();actual.sort_unstable();
        if expected!=actual { return Err("Cached boundary differs from fine graph".into()); }
        let mut edges:BTreeMap<(u32,u32),(u32,i32)>=BTreeMap::new();
        for &(_,face) in &fine.boundary { let ids=self.core.ids(face);for i in 0..ids.len() {
            let a=ids[i];let b=ids[(i+1)%ids.len()];let e=edges.entry((a.min(b),a.max(b))).or_default();e.0+=1;e.1+=if a<b {1}else{-1};
        } }
        if edges.values().any(|e|e.0!=2 || e.1!=0) { return Err("Fine-graph boundary is not closed and oriented".into()); }
        for body in &self.bodies { let graph=self.local_graph(&body.regions)?;let mut expected=graph.boundary;let mut actual=body.boundary.clone();expected.sort_unstable();actual.sort_unstable();
            if expected!=actual || graph.roots.iter().any(|&r|r!=0) { return Err("Retained body differs from fine graph".into()); }
        }Ok(())
    }
    pub fn append_body_fields(&mut self, data: &[u8]) -> Outcome<()> {
        if self.transaction.is_none() { return Err("No resident transaction".into()); }
        let start=self.core.fields.len();
        let result=crate::wire::append_fields(&mut self.core,data).and_then(|()| {
            if self.core.fields[start..].iter().any(|f|f.is_static) { Err("Only body fields may be appended after begin".into()) } else { Ok(()) }
        });
        if result.is_err() { self.abort(); }result
    }
    fn triangles_by_brick(&self, graph: &Graph, preview: bool) -> Vec<Vec<[u32;5]>> {
        let mut result=vec![Vec::new();self.pages.len()];
        for &(index,face) in &graph.boundary {
            let (brick,local)=graph.regions[index as usize];let region=&self.page_view(brick as usize,preview).unwrap().regions[local as usize];
            let source=self.core.faces[face as usize].source;let material=self.core.sources[region.source as usize].material;let v=self.core.ids(face);
            for i in 1..v.len()-1 {
                let (mut a,mut b,mut c)=(v[0],v[i],v[i+1]);
                if b<a && b<c { (a,b,c)=(b,c,a); } else if c<a && c<b { (a,b,c)=(c,a,b); }
                result[brick as usize].push([a,b,c,material,source]);
            }
        }
        result
    }
    /// Publication ABI v1, f64 header: version, before, anchored, detached, removed,
    /// error, edges, unpaired, orientation errors, fields, vertices, static regions,
    /// changed count, body count, replaced count, reserved, dirty min/max xyz.
    /// Followed by changed brick IDs, new body IDs and replaced body IDs, all exact u32s.
    pub fn publication(&self, out: &mut Vec<u8>) -> Outcome<()> {
        let graph=self.graph_view(true)?;let tx=self.transaction.as_ref().unwrap();
        let before_static:f64=self.pages.iter().flatten().flat_map(|p|&p.regions).map(|r|r.volume).sum();
        let before_removed:f64=self.pages.iter().flatten().map(|p|p.removed_volume).sum();
        let mut anchored=0.;let mut after_removed=0.;
        for brick in 0..self.pages.len() { if let Some(page)=self.page(brick) { anchored+=page.regions.iter().map(|r|r.volume).sum::<f64>();after_removed+=page.removed_volume; } }
        let detached:f64=tx.bodies.iter().map(|b|b.volume).sum();
        let replaced:f64=self.bodies.iter().filter(|b|tx.removed_bodies.contains(&b.id)).map(|b|b.volume).sum();
        let before=if self.revision==0 { anchored+detached } else { before_static+replaced };
        let removed=tx.body_removed+after_removed-before_removed;let error=before-anchored-detached-removed;
        let tolerance=1e-5f64.max(before*1e-4);
        if removed < -tolerance || error.abs()>tolerance { return Err(format!("Occupied volume ledger mismatch: {error}")); }
        let old=self.triangles_by_brick(&self.graph,false);let new=self.triangles_by_brick(graph,true);
        let mut changed=Vec::new();let mut bounds=Bounds { min:[f64::INFINITY;3],max:[f64::NEG_INFINITY;3] };
        for brick in 0..self.pages.len() {
            if !self.changed(brick as u32) && old[brick]==new[brick] { continue; }
            let mut delta:BTreeMap<[u32;5],i32>=BTreeMap::new();
            for &t in &old[brick] { *delta.entry(t).or_default()-=1; }
            for &t in &new[brick] { *delta.entry(t).or_default()+=1; }
            let mut different=false;
            for (t,n) in delta { if n==0 { continue; }different=true;
                for &id in &t[..3] { for a in 0..3 { let p=self.core.positions[id as usize][a];bounds.min[a]=bounds.min[a].min(p);bounds.max[a]=bounds.max[a].max(p); } }
            }
            if different || self.changed(brick as u32) { changed.push(brick as u32); }
        }
        out.clear();
        for v in [1.,before,anchored,detached,removed,error,graph.edges as f64,graph.unpaired as f64,graph.orientation_errors as f64,self.core.fields.len() as f64,self.core.vertices.len() as f64,graph.regions.len() as f64,changed.len() as f64,tx.bodies.len() as f64,tx.removed_bodies.len() as f64,0.] { out.extend_from_slice(&v.to_le_bytes()); }
        for v in bounds.min.into_iter().chain(bounds.max) { out.extend_from_slice(&v.to_le_bytes()); }
        for id in changed.into_iter().chain(tx.bodies.iter().map(|b|b.id)).chain(tx.removed_bodies.iter().copied()) { out.extend_from_slice(&(id as f64).to_le_bytes()); }Ok(())
    }
}
