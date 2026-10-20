use crate::core::{Core, Page, NONE};
use crate::storage::{key_hash, IndexTable, Map};

#[derive(Default)]
pub struct Packet { pub strings: Vec<String>, pub words: Vec<i32>, pub values: Vec<f64>, indices: Map<String,u32>, flat: bool }
impl Packet {
    fn text(&mut self, text: &str) -> i32 {
        if let Some(&index) = self.indices.get(text) { return index as i32; }
        let id = self.strings.len() as u32; self.strings.push(text.into()); self.indices.insert(text.into(),id); id as i32
    }
    fn list(&mut self, values: &[u32]) { self.words.push(values.len() as i32); self.words.extend(values.iter().map(|&v|v as i32)); }
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.clear(); put_u32(out,if self.flat { 0x32544d54 } else { 0x31544d54 }); put_u32(out,self.strings.len() as u32); put_u32(out,self.words.len() as u32); put_u32(out,self.values.len() as u32);
        for text in &self.strings { put_u32(out,text.len() as u32); out.extend_from_slice(text.as_bytes()); }
        while out.len()%4 != 0 { out.push(0); }
        for &v in &self.words { out.extend_from_slice(&v.to_le_bytes()); }
        while out.len()%8 != 0 { out.push(0); }
        for &v in &self.values { out.extend_from_slice(&v.to_le_bytes()); }
    }
}
/// Numeric worker/coordinator ABI. Names, formatted recipe keys and region ids never enter
/// this path. The compatibility packet above is only needed by the TS qualification bridge.
pub fn pack_flat(core: &Core, pages: &[Page]) -> Packet {
    let mut packet = Packet { flat:true,..Packet::default() }; let mut table = IndexTable::default(); let mut faces: Vec<u32> = Vec::new(); let mut face_map: Map<u32,u32> = Map::default();
    let mut sources = vec![[NONE;4];core.names.len()];
    for (i,field) in core.fields.iter().enumerate().rev() { sources[field.source as usize] = [0,i as u32,0,0]; }
    for (&triangle,&source) in &core.lattice_sources { sources[source as usize] = [1,triangle[0],triangle[1],triangle[2]]; }
    for page in pages { for region in &page.regions { for span in [region.faces,region.source_faces] { for &id in &core.region_links[span.range()] {
        if face_map.contains_key(&id) { continue; }
        let face = core.faces[id as usize]; let v = &core.face_vertices[face.vertices.range()]; let hash = key_hash(&[face.source],v);
        let known = table.find(hash,|other| { let f = core.faces[faces[other as usize] as usize]; f.source == face.source && core.face_vertices[f.vertices.range()] == *v });
        let local = known.unwrap_or_else(|| { let index = faces.len() as u32; faces.push(id); table.insert(hash,index); packet.words.extend(sources[face.source as usize].iter().map(|&v|v as i32)); packet.list(v); index });
        face_map.insert(id,local);
    } } } }
    packet.words.insert(0,faces.len() as i32);
    let mut live = vec![false;core.vertices.len()]; let mut stack = Vec::new();
    for &face in &faces { for &id in &core.face_vertices[core.faces[face as usize].vertices.range()] { stack.push(id); } }
    while let Some(id) = stack.pop() { if (id as usize) < core.base_count || live[id as usize] { continue; } live[id as usize] = true; stack.extend_from_slice(&core.vertices[id as usize].edge); }
    packet.words.push(live.iter().filter(|&&v|v).count() as i32);
    for (id,_) in live.iter().enumerate().filter(|(_,live)|**live) {
        let v = core.vertices[id]; let n = v.count as usize;
        packet.words.extend_from_slice(&[id as i32,v.field as i32,v.edge[0] as i32,v.edge[1] as i32,v.count as i32]);
        packet.values.extend_from_slice(&core.positions[id]); packet.values.extend_from_slice(&v.operands);
        for i in 0..n { packet.words.push(v.support[i] as i32); packet.values.push(v.weights[i]); }
        packet.list(&core.planes[v.planes.range()]);
    }
    packet.words.push(pages.len() as i32);
    for page in pages {
        packet.words.extend_from_slice(&[page.brick as i32,page.revision as i32,page.regions.len() as i32]); packet.values.push(page.removed_volume);
        if let Some(tets) = &page.tets { packet.list(tets); } else { packet.words.push(-1); }
        packet.words.push(page.removed.len() as i32); packet.values.extend_from_slice(&page.removed);
        for region in &page.regions {
            let constraints = &core.region_signs[region.constraints.range()]; packet.words.extend_from_slice(&[region.tet as i32,region.source as i32]); packet.values.push(region.volume);
            packet.words.push(constraints.len() as i32); packet.words.extend_from_slice(constraints);
            for span in [region.source_faces,region.faces] { packet.words.push(span.len as i32); for face in &core.region_links[span.range()] { packet.words.push(face_map[face] as i32); } }
        }
    }
    packet
}
fn put_u32(out: &mut Vec<u8>, v: u32) { out.extend_from_slice(&v.to_le_bytes()); }
pub fn pack(core: &Core, pages: &[Page]) -> Packet {
    let mut packet = Packet::default(); let mut table = IndexTable::default(); let mut faces: Vec<u32> = Vec::new();
    let mut face_map: Map<u32,u32> = Map::default();
    for page in pages { for region in &page.regions { for span in [region.faces,region.source_faces] { for &id in &core.region_links[span.range()] {
        if face_map.contains_key(&id) { continue; }
        let face = core.faces[id as usize]; let v = &core.face_vertices[face.vertices.range()]; let source = packet.text(&core.names[face.source as usize]);
        let hash = key_hash(&[face.source],v);
        let known = table.find(hash,|other| { let f = core.faces[faces[other as usize] as usize]; f.source == face.source && core.face_vertices[f.vertices.range()] == *v });
        let local = known.unwrap_or_else(|| { let index = faces.len() as u32; faces.push(id); table.insert(hash,index); packet.words.push(source); packet.list(v); index });
        face_map.insert(id,local);
    } } } }
    packet.words.insert(0,faces.len() as i32);
    let mut live = vec![false;core.vertices.len()]; let mut stack = Vec::new();
    for &face in &faces { for &id in &core.face_vertices[core.faces[face as usize].vertices.range()] { stack.push(id); } }
    while let Some(id) = stack.pop() { if (id as usize) < core.base_count || live[id as usize] { continue; } live[id as usize] = true; let v = core.vertices[id as usize]; stack.extend_from_slice(&v.edge); }
    packet.words.push(live.iter().filter(|&&v|v).count() as i32);
    for (id,_) in live.iter().enumerate().filter(|(_,live)|**live) {
        let v = core.vertices[id]; let n = v.count as usize; let planes = &core.planes[v.planes.range()];
        let key = format!("source:{}/{}",v.sorted[..n].iter().map(u32::to_string).collect::<Vec<_>>().join(","),planes.iter().map(u32::to_string).collect::<Vec<_>>().join(","));
        let text = packet.text(&key); packet.words.extend_from_slice(&[id as i32,text,1,if v.field == NONE { -1 } else { v.field as i32 },v.edge[0] as i32,v.edge[1] as i32,v.count as i32]);
        packet.values.extend_from_slice(&core.positions[id]); packet.values.extend_from_slice(&v.operands);
        for i in 0..n { packet.words.push(v.support[i] as i32); packet.values.push(v.weights[i]); }
        packet.list(&v.support[..n]); packet.values.extend(v.weights[..n].iter().map(|&v|v as f32 as f64)); packet.list(planes);
    }
    packet.words.push(pages.len() as i32);
    for page in pages {
        let brick = packet.text(&core.bricks[page.brick as usize].name); packet.words.extend_from_slice(&[brick,page.revision as i32,page.regions.len() as i32]); packet.values.push(page.removed_volume);
        if let Some(tets) = &page.tets { packet.list(tets); } else { packet.words.push(-1); }
        packet.words.push(page.removed.len() as i32); packet.values.extend_from_slice(&page.removed);
        for region in &page.regions {
            let source = &core.sources[region.source as usize]; let tet = &core.tets[region.tet as usize]; let constraints = &core.region_signs[region.constraints.range()];
            let id = packet.text(&format!("{}:{}",tet.name,constraints.iter().map(i32::to_string).collect::<Vec<_>>().join(".")));
            let tet = packet.text(&tet.name); let text = packet.text(&source.name); let anchor = source.anchor.as_ref().map_or(-1,|s|packet.text(s));
            packet.words.extend_from_slice(&[id,tet,source.material as i32,text,anchor]); packet.values.push(region.volume);
            packet.words.push(constraints.len() as i32); packet.words.extend_from_slice(constraints);
            for span in [region.source_faces,region.faces] { packet.words.push(span.len as i32); for face in &core.region_links[span.range()] { packet.words.push(face_map[face] as i32); } }
        }
    }
    packet
}
