//! GPU inputs and CPU collision triangles are produced from resident numeric topology.
//! Views remain in WASM until the host submits/copies them; no JS geometry objects are needed.
use crate::core::*;
use crate::storage::Map;
use crate::world::{Graph, World};

pub struct Selection { pub brick: u32, pub component: u32, pub anchored: bool, pub preview: bool, pub origin: Point }
impl Selection {
    fn accepts(&self, graph: &Graph, index: u32) -> bool {
        let root=graph.roots[index as usize]; (self.brick==NONE || graph.regions[index as usize].0==self.brick)
            && (self.component==NONE || root==self.component) && (!self.anchored || graph.anchored[root as usize])
    }
}
fn put(out: &mut Vec<u8>, word: u32) { out.extend_from_slice(&word.to_le_bytes()); }
fn at(out: &mut [u8], word: usize, value: u32) { out[word*4..word*4+4].copy_from_slice(&value.to_le_bytes()); }
impl World {
    /// [triangle count, vertex-reference count], then 8 words/triangle and 8 words/reference.
    /// This is the existing pages.wgsl / indices.wgsl contract, including analytic normals.
    pub fn gpu_surface(&self, selection: &Selection, out: &mut Vec<u8>) -> Outcome<()> {
        let graph=self.graph_view(selection.preview)?;
        let boundary=graph.boundary.iter().filter(|&&(region,_)|selection.accepts(graph,region)).map(|&(index,face)| {
            let (brick,local)=graph.regions[index as usize];(&self.page_view(brick as usize,selection.preview).unwrap().regions[local as usize],face)
        });
        surface(&self.core,boundary,out)
    }
    pub fn body_surface(&self, id: u32, preview: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let body=self.body_view(id,preview)?;surface(&self.core,body.boundary.iter().map(|&(r,f)|(&body.regions[r as usize],f)),out)
    }
    pub fn body_query(&self, id: u32, preview: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let body=self.body_view(id,preview)?;chunk(&self.core,body.boundary.iter().map(|&(r,f)|(&body.regions[r as usize],f)),body.center,out)?;
        crate::query::append_bvh(out)
    }
    pub fn body_volumes(&self, id: u32, preview: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let body=self.body_view(id,preview)?;volumes(&self.core,body.regions.iter(),out)
    }
    /// One GPU acceptance batch: changed static pages and every newly staged body.
    pub fn transaction_volumes(&self, out: &mut Vec<u8>) -> Outcome<()> {
        let graph=self.graph_view(true)?;let tx=self.transaction.as_ref().unwrap();
        let regions=graph.regions.iter().filter(|&&(brick,_)|self.changed(brick))
            .map(|&(brick,index)|&self.page_view(brick as usize,true).unwrap().regions[index as usize])
            .chain(tx.bodies.iter().flat_map(|b|b.regions.iter()));
        volumes(&self.core,regions,out)
    }
    /// [vertex count, index count, material count, reserved], f32 xyz, u32 indices, u16 materials.
    /// Vertex order matches first triangle traversal, including body-local subtraction before f32.
    pub fn query_chunk(&self, selection: &Selection, out: &mut Vec<u8>) -> Outcome<()> {
        if selection.origin.iter().any(|v|!v.is_finite()) { return Err("Invalid query origin".into()); }
        let graph=self.graph_view(selection.preview)?;
        let boundary=graph.boundary.iter().filter(|&&(region,_)|selection.accepts(graph,region)).map(|&(index,face)| {
            let (brick,local)=graph.regions[index as usize];(&self.page_view(brick as usize,selection.preview).unwrap().regions[local as usize],face)
        });
        chunk(&self.core,boundary,selection.origin,out)
    }
    /// [region count, triangle count], 4 words/region, 4 words/triangle, f64 expected volumes.
    pub fn gpu_volumes(&self, preview: bool, changed_only: bool, out: &mut Vec<u8>) -> Outcome<()> {
        let graph=self.graph_view(preview)?;
        let regions=graph.regions.iter().filter(|&&(brick,_)|!changed_only || self.changed(brick))
            .map(|&(brick,index)|&self.page_view(brick as usize,preview).unwrap().regions[index as usize]);
        volumes(&self.core,regions,out)
    }
    pub fn component_words(&self, preview: bool, out: &mut Vec<u8>) -> Outcome<()> { let graph=self.graph_view(preview)?;out.clear();for &root in &graph.roots { put(out,root); }Ok(()) }
}
fn surface<'a>(core: &Core, boundary: impl Iterator<Item=(&'a Region,u32)>+Clone, out: &mut Vec<u8>) -> Outcome<()> {
        let mut triangles=0usize; let mut refs=0usize;
        for (_,face) in boundary.clone() { let n=core.ids(face).len(); triangles+=n-2; refs+=n; }
        out.clear();out.resize(8+(triangles+refs)*32,0);at(out,0,triangles as u32);at(out,1,refs as u32);let mut t=2;let mut v=2+triangles*8;let mut offset=0u32;
        for (region,face) in boundary {
            let source=&core.sources[region.source as usize];let face=core.faces[face as usize];let ids=&core.face_vertices[face.vertices.range()];
            let surface=core.surfaces.get(&face.source).copied().unwrap_or_default();
            for &id in ids { for word in [id,ids[0],ids[1],ids[2],source.material|(surface.kind<<16),(surface.center[0] as f32).to_bits(),(surface.center[1] as f32).to_bits(),(surface.center[2] as f32).to_bits()] { at(out,v,word);v+=1; } }
            for i in 1..ids.len()-1 { for word in [ids[0],ids[i],ids[i+1],source.material,offset,offset+i as u32,offset+i as u32+1,0] { at(out,t,word);t+=1; } }
            offset+=ids.len() as u32;
        }
        Ok(())
    }
fn chunk<'a>(core: &Core, boundary: impl Iterator<Item=(&'a Region,u32)>, origin: Point, out: &mut Vec<u8>) -> Outcome<()> {
        let mut remap:Map<u32,u32>=Map::default();let mut positions=Vec::new();let mut indices=Vec::new();let mut materials=Vec::new();
        for (region,face) in boundary {
            let material=core.sources[region.source as usize].material as u16;
            let ids=core.ids(face);
            for i in 1..ids.len()-1 {
                for id in [ids[0],ids[i],ids[i+1]] {
                    let next=remap.len() as u32;let local=*remap.entry(id).or_insert_with(|| { for a in 0..3 { positions.push((core.positions[id as usize][a]-origin[a]) as f32); } next });indices.push(local);
                }
                materials.push(material);
            }
        }
        out.clear();put(out,remap.len() as u32);put(out,indices.len() as u32);put(out,materials.len() as u32);put(out,0);
        for value in positions { put(out,value.to_bits()); } for index in indices { put(out,index); } for material in materials { out.extend_from_slice(&material.to_le_bytes()); } Ok(())
    }
fn volumes<'a>(core: &Core, regions: impl Iterator<Item=&'a Region>+Clone, out: &mut Vec<u8>) -> Outcome<()> {
        let mut count=0usize;let mut triangles=0usize;
        for region in regions.clone() { count+=1;for &face in &core.region_links[region.faces.range()] { triangles+=core.ids(face).len()-2; } }
        out.clear();out.resize(8+count*24+triangles*16,0);at(out,0,count as u32);at(out,1,triangles as u32);let mut r=2;let mut t=2+count*4;let mut v=8+count*16+triangles*16;let mut offset=0u32;
        for region in regions {
            let start=offset;
            for &face in &core.region_links[region.faces.range()] { let ids=core.ids(face);for i in 1..ids.len()-1 { for word in [ids[0],ids[i],ids[i+1],0] { at(out,t,word);t+=1; }offset+=1; } }
            at(out,r,start);at(out,r+1,offset-start);r+=4;out[v..v+8].copy_from_slice(&region.volume.to_le_bytes());v+=8;
        }
        Ok(())
    }
