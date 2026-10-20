//! Incremental independent fine-graph oracle. No cached connectivity is consulted.
use crate::core::*;
use crate::storage::{append,key_hash,Ids,IndexTable,Map,Span};
use crate::world::{Graph,World};

struct Portal { source:u32,sorted:Span,region:u32,face:u32,paired:bool }
#[derive(Default)]
pub(crate) struct AuditWork {
    graph:Graph,table:IndexTable,portals:Vec<Portal>,ids:Vec<u32>,edges:Map<(u32,u32),(u32,i32)>,
    brick:usize,region:usize,cursor:usize,phase:u8,
}
fn root(parents:&mut [u32],mut i:u32)->u32 { while parents[i as usize]!=i { parents[i as usize]=parents[parents[i as usize] as usize];i=parents[i as usize]; }i }
impl World {
    pub fn audit_step(&mut self)->Outcome<bool> {
        if self.transaction.is_some() { return Err("Cannot audit a pending transaction".into()); }
        let mut work=self.auditing.take().unwrap_or_default();
        let result=self.advance_audit(&mut work);
        if matches!(result,Ok(false)) { self.auditing=Some(work); }result
    }
    fn advance_audit(&self,w:&mut AuditWork)->Outcome<bool> {
        if w.phase==0 {
            let mut remaining=256;
            while w.brick<self.pages.len() && remaining>0 {
                if let Some(page)=&self.pages[w.brick] {
                    while w.region<page.regions.len() && remaining>0 {
                        let region=&page.regions[w.region];let index=w.graph.roots.len() as u32;
                        w.graph.regions.push((w.brick as u32,w.region as u32));w.graph.roots.push(index);
                        for &face in &self.core.region_links[region.faces.range()] {
                            let source=self.core.faces[face as usize].source;let v=self.core.ids(face);
                            if !self.core.area_positive(v) { return Err("Zero-area fine-graph portal".into()); }
                            let mut sorted=Ids::from(v);sorted.slice_mut().sort_unstable();let sorted=sorted.slice();let hash=key_hash(&[source],sorted);
                            if let Some(id)=w.table.find(hash,|id| { let p=&w.portals[id as usize];p.source==source && w.ids[p.sorted.range()]==*sorted }) {
                                let p=&mut w.portals[id as usize];if p.paired { return Err("Non-manifold fine-graph portal".into()); }p.paired=true;
                                let a=root(&mut w.graph.roots,p.region);let b=root(&mut w.graph.roots,index);w.graph.roots[a.max(b) as usize]=a.min(b);
                            } else { let id=w.portals.len() as u32;w.portals.push(Portal { source,sorted:append(&mut w.ids,sorted),region:index,face,paired:false });w.table.insert(hash,id); }
                        }
                        w.region+=1;remaining-=1;
                    }
                    if w.region<page.regions.len() { break; }
                }
                w.brick+=1;w.region=0;
            }
            if w.brick==self.pages.len() { w.phase=1;w.graph.anchored.resize(w.graph.roots.len(),false); }return Ok(false);
        }
        if w.phase==1 {
            let end=(w.cursor+2048).min(w.graph.roots.len());
            for i in w.cursor..end { let r=root(&mut w.graph.roots,i as u32);w.graph.roots[i]=r;let (b,l)=w.graph.regions[i];
                if self.core.sources[self.pages[b as usize].as_ref().unwrap().regions[l as usize].source as usize].anchor.is_some() { w.graph.anchored[r as usize]=true; }
            }
            w.cursor=end;if end==w.graph.roots.len() { w.phase=2;w.cursor=0; }return Ok(false);
        }
        if w.phase==2 {
            let end=(w.cursor+1024).min(w.portals.len());
            for p in &w.portals[w.cursor..end] { if p.paired {continue;}w.graph.boundary.push((p.region,p.face));let v=self.core.ids(p.face);
                for i in 0..v.len() { let a=v[i];let b=v[(i+1)%v.len()];let e=w.edges.entry((a.min(b),a.max(b))).or_default();e.0+=1;e.1+=if a<b {1}else{-1}; }
            }
            w.cursor=end;if end==w.portals.len() {w.phase=3;}return Ok(false);
        }
        if w.phase==3 {
            if w.graph.roots.iter().any(|&r|!w.graph.anchored[r as usize]) {return Err("Unanchored static fine-graph component".into());}
            if w.edges.values().any(|e|e.0!=2||e.1!=0) {return Err("Fine-graph boundary is not closed and oriented".into());}
            let mut actual=self.graph.boundary.clone();w.graph.boundary.sort_unstable();actual.sort_unstable();
            if w.graph.boundary!=actual {return Err("Cached boundary differs from fine graph".into());}
            w.phase=4;w.cursor=0;return Ok(false);
        }
        if w.cursor<self.bodies.len() {
            let body=&self.bodies[w.cursor];let graph=self.local_graph(&body.regions)?;let mut expected=graph.boundary;let mut actual=body.boundary.clone();expected.sort_unstable();actual.sort_unstable();
            if expected!=actual || graph.roots.iter().any(|&r|r!=0) {return Err("Retained body differs from fine graph".into());}
            w.cursor+=1;return Ok(false);
        }Ok(true)
    }
}
