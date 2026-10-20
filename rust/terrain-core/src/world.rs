//! Resident numeric coordinator. Worker packets enter WASM directly: no JS regions, Maps,
//! recipe strings or face arrays are materialized between compilation and connectivity.
use crate::core::*;
use crate::storage::{append, key_hash, Ids, IndexTable, Map, Span};
use crate::body::Body;

#[derive(Default)]
pub struct Graph {
    pub regions: Vec<(u32,u32)>, pub roots: Vec<u32>, pub anchored: Vec<bool>,
    pub boundary: Vec<(u32,u32)>, pub portals: u32, pub components: u32,
    pub edges: u32, pub unpaired: u32, pub orientation_errors: u32,
}
#[derive(Default)]
pub(crate) struct LocalGraph { pub roots: Vec<u32>, pub boundary: Vec<(u32,u32)>, portals: u32 }
pub(crate) struct Transaction { pub revision: u32, mark: ImportMark, pub pages: Vec<Option<Page>>, locals: Vec<Option<LocalGraph>>, pub graph: Option<Graph>, pub bodies: Vec<Body>, pub removed_bodies: Vec<u32>, pub masks: Vec<Mask>, pub body_sequence: u32, pub body_removed: f64 }
#[derive(Default)]
struct GeometryArena { faces: Vec<Face>, vertices: Vec<u32>, links: Vec<u32>, signs: Vec<i32> }
pub struct World { pub core: Core, pub pages: Vec<Option<Page>>, pub graph: Graph, pub revision: u32, locals: Vec<Option<LocalGraph>>, pub(crate) transaction: Option<Transaction>, recycled: GeometryArena, pub bodies: Vec<Body>, pub masks: Vec<Mask>, mask_index: Map<u32,Vec<usize>>, body_sequence: u32, connecting: Option<ConnectWork>, pub(crate) auditing:Option<crate::audit::AuditWork> }
struct Portal { source: u32, sorted: Span, region: u32, face: u32, paired: bool }
#[derive(Default)]
struct ConnectWork { graph: Graph, table: IndexTable, portals: Vec<Portal>, ids: Vec<u32>, edges: Map<(u32,u32),(u32,i32)>, brick: usize, cursor: usize, phase: u8 }
struct Input<'a> { words: &'a [u8], values: &'a [u8], word: usize, value: usize }
impl<'a> Input<'a> {
    fn new(bytes: &'a [u8]) -> Outcome<Self> {
        let header = bytes.get(..16).ok_or("Truncated numeric packet")?;
        let u = |i| u32::from_le_bytes(header[i..i+4].try_into().unwrap()) as usize;
        if u(0) != 0x32544d54 || u(4) != 0 { return Err("Coordinator requires the numeric terrain ABI".into()); }
        let word_bytes = u(8).checked_mul(4).ok_or("Packet size overflow")?;
        let end_words = 16usize.checked_add(word_bytes).ok_or("Packet size overflow")?;
        let start_values = end_words.checked_add(7).ok_or("Packet size overflow")? & !7;
        let end_values = start_values.checked_add(u(12).checked_mul(8).ok_or("Packet size overflow")?).ok_or("Packet size overflow")?;
        if bytes.len() != end_values { return Err("Invalid numeric packet length".into()); }
        Ok(Self { words:&bytes[16..end_words],values:&bytes[start_values..],word:0,value:0 })
    }
    fn word(&mut self) -> Outcome<u32> { let end = self.word+4; let bytes = self.words.get(self.word..end).ok_or("Missing topology word")?; self.word = end; Ok(u32::from_le_bytes(bytes.try_into().unwrap())) }
    fn value(&mut self) -> Outcome<f64> { let end = self.value+8; let bytes = self.values.get(self.value..end).ok_or("Missing predicate word")?; self.value = end; let v = f64::from_le_bytes(bytes.try_into().unwrap()); if !v.is_finite() { return Err("Non-finite packet value".into()); } Ok(v) }
    fn list(&mut self) -> Outcome<Ids> { let n = self.word()?; let mut result = Ids::default(); for _ in 0..n { result.push(self.word()?); } Ok(result) }
    fn finish(&self) -> Outcome<()> { if self.word == self.words.len() && self.value == self.values.len() { Ok(()) } else { Err("Trailing topology words".into()) } }
}
impl World {
    pub fn new(core: Core) -> Self { let n=core.bricks.len(); Self { core,pages:empty(n),locals:empty(n),graph:Graph::default(),revision:0,transaction:None,recycled:GeometryArena::default(),bodies:Vec::new(),masks:Vec::new(),mask_index:Map::default(),body_sequence:0,connecting:None,auditing:None } }
    pub fn begin(&mut self, revision: u32, fields: &[u8]) -> Outcome<()> {
        if self.transaction.is_some() { return Err("Resident transaction already active".into()); }
        if revision <= self.revision { return Err("Stale resident transaction".into()); }
        self.auditing=None;
        let mark=self.core.import_mark(); let n=self.pages.len();
        self.transaction=Some(Transaction { revision,mark,pages:empty(n),locals:empty(n),graph:None,bodies:Vec::new(),removed_bodies:Vec::new(),masks:Vec::new(),body_sequence:self.body_sequence,body_removed:0. });
        if let Err(error)=crate::wire::append_fields(&mut self.core,fields) { self.abort(); return Err(error); } Ok(())
    }
    pub fn abort(&mut self) { self.connecting=None;if let Some(tx)=self.transaction.take() { self.core.abort_import(tx.mark); } }
    pub fn commit(&mut self) -> Outcome<()> {
        if self.transaction.as_ref().and_then(|tx|tx.graph.as_ref()).is_none() { return Err("Resident transaction is not prepared".into()); }
        let tx=self.transaction.take().unwrap();
        self.bodies.retain(|b|!tx.removed_bodies.contains(&b.id)); self.bodies.extend(tx.bodies);
        for mask in tx.masks { self.mask_index.entry(mask.tet).or_default().push(self.masks.len());self.masks.push(mask); }
        self.body_sequence=tx.body_sequence;
        for (i,page) in tx.pages.into_iter().enumerate() { if let Some(page)=page { self.pages[i]=Some(page); } }
        for (i,local) in tx.locals.into_iter().enumerate() { if let Some(local)=local { self.locals[i]=Some(local); } }
        self.graph=tx.graph.unwrap(); self.revision=tx.revision; Ok(())
    }
    pub(crate) fn page(&self, brick: usize) -> Option<&Page> { self.transaction.as_ref().and_then(|tx|tx.pages[brick].as_ref()).or(self.pages[brick].as_ref()) }
    pub(crate) fn page_view(&self, brick: usize, preview: bool) -> Option<&Page> { if preview { self.page(brick) } else { self.pages[brick].as_ref() } }
    pub(crate) fn graph_view(&self, preview: bool) -> Outcome<&Graph> { if preview { self.transaction.as_ref().and_then(|tx|tx.graph.as_ref()).ok_or("Resident transaction is not prepared".into()) } else { Ok(&self.graph) } }
    pub(crate) fn changed(&self, brick: u32) -> bool { self.transaction.as_ref().map_or(false,|tx|tx.pages[brick as usize].is_some()) }
    /// Reclaim obsolete page topology between transactions. Vertex ids stay stable for GPU
    /// position buffers and retained bodies; full recipe collection must include body roots.
    pub fn compact_pages(&mut self) -> Outcome<()> {
        self.auditing=None;
        if self.transaction.is_some() { return Err("Cannot compact during a resident transaction".into()); }
        let mut arena=std::mem::take(&mut self.recycled);arena.faces.clear();arena.vertices.clear();arena.links.clear();arena.signs.clear();
        let mut remap=vec![NONE;self.core.faces.len()];
        for region in self.pages.iter_mut().flatten().flat_map(|p|&mut p.regions).chain(self.bodies.iter_mut().flat_map(|b|&mut b.regions)) {
                let old_physical=region.faces;let old_source=region.source_faces;
                for span in [&mut region.faces,&mut region.source_faces] {
                    let start=arena.links.len() as u32;
                    for &id in &self.core.region_links[span.range()] {
                        let mut mapped=remap[id as usize];
                        if mapped==NONE { let old=self.core.faces[id as usize];mapped=arena.faces.len() as u32;arena.faces.push(Face { source:old.source,vertices:append(&mut arena.vertices,&self.core.face_vertices[old.vertices.range()]) });remap[id as usize]=mapped; }
                        arena.links.push(mapped);
                    }
                    *span=Span { start,len:span.len };
                }
                if old_source.start==old_physical.start && old_source.len==old_physical.len { arena.links.truncate(region.source_faces.start as usize);region.source_faces=region.faces; }
                region.constraints=append(&mut arena.signs,&self.core.region_signs[region.constraints.range()]);
        }
        for body in &mut self.bodies { for (_,face) in &mut body.boundary { *face=remap[*face as usize]; } }
        for local in self.locals.iter_mut().flatten() { for (_,face) in &mut local.boundary { *face=remap[*face as usize]; } }
        for (_,face) in &mut self.graph.boundary { *face=remap[*face as usize]; }
        std::mem::swap(&mut self.core.faces,&mut arena.faces);std::mem::swap(&mut self.core.face_vertices,&mut arena.vertices);std::mem::swap(&mut self.core.region_links,&mut arena.links);std::mem::swap(&mut self.core.region_signs,&mut arena.signs);
        arena.faces.clear();arena.vertices.clear();arena.links.clear();arena.signs.clear();self.recycled=arena;Ok(())
    }
    fn source(&mut self, kind: u32, key: [u32;3]) -> Outcome<u32> {
        match kind {
            0=>Ok(self.core.fields.get(key[0] as usize).ok_or("Unknown field source")?.source),
            1=>{ if key.iter().any(|&v|v as usize >= self.core.base_count) { return Err("Invalid lattice face source".into()); }
                if let Some(&source) = self.core.lattice_sources.get(&key) { return Ok(source); }
                let source = self.core.name(format!("face:{},{},{}",key[0],key[1],key[2])); self.core.lattice_sources.insert(key,source); Ok(source)
            },
            _=>Err("Unknown face source kind".into()),
        }
    }
    fn face(&mut self, vertices: &[u32], source: u32) -> u32 {
        // Worker packets already intern their faces. Opposite portal incidences have opposite
        // winding, so globally interning oriented faces adds a large table with almost no reuse.
        // Portal identity is established from source + sorted physical vertices in connect().
        let id = self.core.faces.len() as u32; self.core.faces.push(Face { vertices:append(&mut self.core.face_vertices,vertices),source }); id
    }
    pub fn ingest(&mut self, bytes: &[u8]) -> Outcome<()> {
        let tx=self.transaction.as_ref().ok_or("No resident transaction")?;
        if tx.graph.is_some() || self.connecting.is_some() { return Err("Resident transaction is already preparing connectivity".into()); }
        let result=self.ingest_inner(bytes); if result.is_err() { self.abort(); } result
    }
    fn ingest_inner(&mut self, bytes: &[u8]) -> Outcome<()> {
        let mut r = Input::new(bytes)?; let mut faces = Vec::new(); let mut face_vertices = Vec::new();
        let count = r.word()?;
        for _ in 0..count { let kind = r.word()?; let key = [r.word()?,r.word()?,r.word()?]; let source = self.source(kind,key)?; let ids = r.list()?; if ids.slice().len() < 3 { return Err("Invalid packet face".into()); } faces.push(Face { source,vertices:append(&mut face_vertices,ids.slice()) }); }
        let mut remap: Vec<u32> = (0..self.core.base_count as u32).collect(); let count = r.word()?;
        for _ in 0..count {
            let id = r.word()? as usize; let field = r.word()?; let local_edge = [r.word()?,r.word()?]; let count = r.word()?;
            if count == 0 || count > 4 || field as usize >= self.core.fields.len() || id < self.core.base_count { return Err("Invalid packet recipe".into()); }
            let position = [r.value()?,r.value()?,r.value()?]; let operands = [r.value()?,r.value()?]; let mut support = [0;4]; let mut weights = [0.;4];
            for i in 0..count as usize { support[i] = r.word()?; if support[i] as usize >= self.core.base_count { return Err("Invalid source support".into()); } weights[i] = r.value()?; }
            let planes = r.list()?; if planes.slice().iter().any(|&p|p as usize >= self.core.fields.len()) { return Err("Invalid source plane".into()); }
            let edge = [mapped(&remap,local_edge[0])?,mapped(&remap,local_edge[1])?];
            let vertex = Vertex { support,sorted:support,weights,count,edge,operands,field,planes:Span::default(),live_key:true };
            let global = self.core.import_vertex(vertex,planes.slice(),position)?;
            if id >= remap.len() { remap.resize(id+1,NONE); } if remap[id] != NONE { return Err("Repeated local recipe id".into()); } remap[id] = global;
        }
        let mut global_faces = Vec::with_capacity(faces.len());
        for face in faces { let mut ids = Ids::default(); for &local in &face_vertices[face.vertices.range()] { ids.push(mapped(&remap,local)?); } global_faces.push(self.face(ids.slice(),face.source)); }
        let mut physical_cache = vec![NONE;global_faces.len()];
        let count = r.word()?;
        for _ in 0..count {
            let brick = r.word()?; if brick as usize >= self.pages.len() { return Err("Unknown packet brick".into()); }
            let revision = r.word()?; let region_count = r.word()?; let removed_volume = r.value()?; let tet_count = r.word()?;
            let tets = if tet_count == NONE { None } else { let mut tets = Vec::new(); for _ in 0..tet_count { let local = r.word()?; if local as usize >= self.core.bricks[brick as usize].tets.len() { return Err("Invalid local tet".into()); } tets.push(local); } Some(tets) };
            let removed_count = r.word()?; let mut removed = Vec::new(); for _ in 0..removed_count { removed.push(r.value()?); }
            let mut regions = Vec::with_capacity(region_count as usize);
            for _ in 0..region_count {
                let tet = r.word()?; let source = r.word()?;
                if self.core.tets.get(tet as usize).map(|t|t.brick) != Some(brick) || source as usize >= self.core.sources.len() { return Err("Invalid packet region".into()); }
                let volume = r.value()?; if volume <= 0. { return Err("Invalid packet region volume".into()); }
                let constraints = r.list()?; let constraints: Vec<i32> = constraints.slice().iter().map(|&v|v as i32).collect();
                if constraints.iter().any(|&v|v == 0 || v.unsigned_abs() as usize > self.core.fields.len()) { return Err("Invalid region sign".into()); }
                let original = r.list()?; let mut source_faces = Ids::default(); for &id in original.slice() { source_faces.push(*global_faces.get(id as usize).ok_or("Invalid source face")?); }
                let physical = r.list()?;
                let mut mapped_faces = Ids::default();
                for &local in physical.slice() {
                    let face = *global_faces.get(local as usize).ok_or("Invalid physical face")?;
                    let cached = physical_cache[local as usize];
                    let mapped = if cached != NONE { cached } else {
                        let source = self.core.faces[face as usize].source; let original = Ids::from(self.core.ids(face)); let mut ids = Ids::default();
                        for &id in original.slice() { ids.push(self.core.physical_id(id)); }
                        let mapped = if ids.slice() == original.slice() { face } else { self.face(ids.slice(),source) }; physical_cache[local as usize] = mapped; mapped
                    };
                    mapped_faces.push(mapped);
                }
                let physical = append(&mut self.core.region_links,mapped_faces.slice());
                let source_faces = if source_faces.slice() == mapped_faces.slice() { physical } else { append(&mut self.core.region_links,source_faces.slice()) };
                regions.push(Region { tet,source,volume,faces:physical,source_faces,constraints:append(&mut self.core.region_signs,&constraints) });
            }
            let page = Page { brick,revision,tets,regions,removed,removed_volume }; self.replace_page(page)?;
        }
        r.finish()
    }
    fn replace_page(&mut self, mut page: Page) -> Outcome<()> {
        let brick = page.brick as usize; let n = self.core.bricks[brick].tets.len();
        let tx=self.transaction.as_ref().unwrap();
        if page.revision != tx.revision { return Err("Worker packet revision mismatch".into()); }
        if tx.pages[brick].is_some() { return Err("Duplicate resident page in transaction".into()); }
        for region in &page.regions {
            let signs=&self.core.region_signs[region.constraints.range()];
            if self.mask_index.get(&region.tet).into_iter().flatten().any(|&i|self.masks[i].constraints.iter().all(|s|signs.contains(s))) {
                return Err("Worker packet violates retained body ownership".into());
            }
        }
        if let Some(locals) = page.tets.take() {
            let old = self.pages[brick].as_ref().ok_or("Partial packet has no resident page")?;
            if page.removed.len() != locals.len() || old.removed.len() != n { return Err("Invalid partial removal cache".into()); }
            let mut dirty = vec![false;n]; for &local in &locals { if dirty[local as usize] { return Err("Duplicate partial tet".into()); } dirty[local as usize] = true; }
            if page.regions.iter().any(|r|!dirty[self.core.tets[r.tet as usize].local as usize]) { return Err("Partial packet includes an unrequested tet".into()); }
            let mut removed = old.removed.clone(); for (i,&local) in locals.iter().enumerate() { removed[local as usize] = page.removed[i]; }
            let mut merged: Vec<Region> = old.regions.iter().filter(|r|!dirty[self.core.tets[r.tet as usize].local as usize]).cloned().collect();
            merged.extend(page.regions); merged.sort_by_key(|r|self.core.tets[r.tet as usize].local);
            page.regions = merged; page.removed = removed; page.removed_volume = page.removed.iter().sum();
        } else if page.removed.len() != n { return Err("Invalid full removal cache".into()); }
        self.transaction.as_mut().unwrap().pages[brick] = Some(page); Ok(())
    }
    pub fn connect(&mut self) -> Outcome<()> {
        let tx=self.transaction.as_ref().ok_or("No resident transaction")?;
        if tx.graph.is_some() { return Err("Resident transaction is already prepared".into()); }
        let result=self.connect_inner(); if result.is_err() { self.abort(); } result
    }
    pub(crate) fn local_graph(&self, regions: &[Region]) -> Outcome<LocalGraph> {
        let mut graph=LocalGraph { roots:(0..regions.len() as u32).collect(),..LocalGraph::default() };
        let mut table=IndexTable::default(); let mut portals: Vec<Portal>=Vec::new(); let mut ids=Vec::new();
        for (index,region) in regions.iter().enumerate() {
            for &face in &self.core.region_links[region.faces.range()] {
                let f=self.core.faces[face as usize]; let vertices=self.core.ids(face);
                if !self.core.area_positive(vertices) { return Err("Zero-area resident portal".into()); }
                let mut sorted=Ids::from(vertices); sorted.slice_mut().sort_unstable(); let sorted=sorted.slice(); let hash=key_hash(&[f.source],sorted);
                if let Some(id)=table.find(hash,|id| { let p=&portals[id as usize]; p.source==f.source && ids[p.sorted.range()]==*sorted }) {
                    let portal=&mut portals[id as usize]; if portal.paired { return Err("Non-manifold resident portal".into()); } portal.paired=true; graph.portals+=1;
                    let a=root(&mut graph.roots,portal.region); let b=root(&mut graph.roots,index as u32); graph.roots[a.max(b) as usize]=a.min(b);
                } else { let id=portals.len() as u32; portals.push(Portal { source:f.source,sorted:append(&mut ids,sorted),region:index as u32,face,paired:false }); table.insert(hash,id); }
            }
        }
        for i in 0..graph.roots.len() { graph.roots[i]=root(&mut graph.roots,i as u32); }
        graph.boundary=portals.into_iter().filter(|p|!p.paired).map(|p|(p.region,p.face)).collect(); Ok(graph)
    }
    pub(crate) fn connect_inner(&mut self) -> Outcome<()> {
        while !self.connect_step()? {}Ok(())
    }
    /// One bounded connectivity segment. No accepted graph changes until commit.
    pub fn connect_step(&mut self) -> Outcome<bool> {
        if self.transaction.is_none() { return Err("No resident transaction".into()); }
        if self.transaction.as_ref().unwrap().graph.is_some() { return Ok(true); }
        let mut work=self.connecting.take().unwrap_or_default();
        match self.advance_connect(&mut work) {
            Ok(true)=>{ self.transaction.as_mut().unwrap().graph=Some(work.graph);Ok(true) },
            Ok(false)=>{ self.connecting=Some(work);Ok(false) },
            Err(error)=>{ self.abort();Err(error) }
        }
    }
    fn advance_connect(&mut self, work: &mut ConnectWork) -> Outcome<bool> {
        let ConnectWork { graph,table,portals,ids,edges,brick,cursor,phase }=work;
        if *phase==0 && *brick<self.pages.len() {
            let current=*brick;*brick+=1;let brick=current;
            if let Some(page)=self.transaction.as_ref().unwrap().pages[brick].as_ref() {
                let local=self.local_graph(&page.regions)?; self.transaction.as_mut().unwrap().locals[brick]=Some(local);
            }
            let Some(page)=self.page(brick) else { return Ok(false); };
            let local=self.transaction.as_ref().unwrap().locals[brick].as_ref().or(self.locals[brick].as_ref()).ok_or("Missing local connectivity")?;
            let offset=graph.regions.len() as u32; graph.portals+=local.portals;
            for region in 0..page.regions.len() { graph.regions.push((brick as u32,region as u32)); graph.roots.push(offset+local.roots[region]); }
            for &(region,face) in &local.boundary {
                let f = self.core.faces[face as usize]; let vertices = self.core.ids(face);
                let mut sorted=Ids::from(vertices); sorted.slice_mut().sort_unstable(); let sorted=sorted.slice(); let hash=key_hash(&[f.source],sorted);
                if let Some(id) = table.find(hash,|id| { let p = &portals[id as usize]; p.source == f.source && ids[p.sorted.range()] == *sorted }) {
                    let portal = &mut portals[id as usize]; if portal.paired { return Err("Non-manifold resident portal".into()); } portal.paired = true; graph.portals += 1;
                    let a = root(&mut graph.roots,portal.region); let b = root(&mut graph.roots,offset+region); graph.roots[a.max(b) as usize] = a.min(b);
                } else { let id = portals.len() as u32; portals.push(Portal { source:f.source,sorted:append(ids,sorted),region:offset+region,face,paired:false }); table.insert(hash,id); }
            }
            return Ok(false);
        }
        if *phase==0 { graph.anchored.resize(graph.regions.len(),false);*phase=1; }
        if *phase==1 {
            let end=(*cursor+2048).min(graph.regions.len());
            for i in *cursor..end { let parent = root(&mut graph.roots,i as u32); graph.roots[i] = parent; if parent == i as u32 { graph.components += 1; }
                let (brick,index) = graph.regions[i]; let region = &self.page(brick as usize).unwrap().regions[index as usize];
                if self.core.sources[region.source as usize].anchor.is_some() { graph.anchored[parent as usize] = true; }
            }
            *cursor=end;if end==graph.regions.len() { *phase=2;*cursor=0; }return Ok(false);
        }
        if *phase==2 {
            let end=(*cursor+1024).min(portals.len());
            for portal in &portals[*cursor..end] { if portal.paired { continue; } graph.boundary.push((portal.region,portal.face)); let vertices = self.core.ids(portal.face);
                for i in 0..vertices.len() { let a = vertices[i]; let b = vertices[(i+1)%vertices.len()]; let entry = edges.entry((a.min(b),a.max(b))).or_default(); entry.0 += 1; entry.1 += if a < b { 1 } else { -1 }; }
            }
            *cursor=end;if end==portals.len() { *phase=3; }return Ok(false);
        }
        graph.edges = edges.len() as u32; graph.unpaired = edges.values().filter(|e|e.0 != 2).count() as u32; graph.orientation_errors = edges.values().filter(|e|e.1 != 0).count() as u32;
        if graph.unpaired != 0 || graph.orientation_errors != 0 { return Err(format!("Resident boundary has {} unpaired edges and {} orientation errors",graph.unpaired,graph.orientation_errors)); }
        Ok(true)
    }
    pub fn gpu_recipes(&self, from: usize, output: &mut Vec<u8>) -> Outcome<()> {
        if from > self.core.vertices.len() { return Err("Invalid GPU recipe cursor".into()); } output.clear();
        for id in from..self.core.vertices.len() { let v = self.core.vertices[id]; let mut words = [0u32;16];
            if id < self.core.base_count { for a in 0..3 { words[8+a] = (self.core.positions[id][a] as f32).to_bits(); } }
            else { words[0] = v.edge[0]; words[1] = v.edge[1]; words[2] = 1; words[3] = 2;
                for j in 0..4 { words[4+j] = if j < v.count as usize { v.support[j] } else { v.support[0] }; if j < v.count as usize { words[12+j] = (v.weights[j] as f32).to_bits(); } }
                words[8] = (v.operands[0] as f32).to_bits(); words[9] = (v.operands[1] as f32).to_bits();
            }
            for word in words { output.extend_from_slice(&word.to_le_bytes()); }
        }
        Ok(())
    }
}
fn empty<T>(n: usize) -> Vec<Option<T>> { (0..n).map(|_|None).collect() }
fn mapped(remap: &[u32], id: u32) -> Outcome<u32> { match remap.get(id as usize) { Some(&global) if global != NONE=>Ok(global),_=>Err("Missing packet recipe ancestor".into()) } }
fn root(parents: &mut [u32], mut id: u32) -> u32 { while parents[id as usize] != id { parents[id as usize] = parents[parents[id as usize] as usize]; id = parents[id as usize]; } id }
