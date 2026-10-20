use crate::storage::{append, key_hash, Ids, IndexTable, Map, Span};
use num_bigint::Sign;
use num_rational::BigRational;
use num_traits::{One, ToPrimitive, Zero};

pub const NONE: u32 = u32::MAX;
pub type Point = [f64; 3];
pub type Outcome<T> = Result<T, String>;
pub fn f(v: f64) -> f64 { (v as f32) as f64 }
fn sub(a: Point, b: Point) -> Point { [a[0]-b[0], a[1]-b[1], a[2]-b[2]] }
fn cross(a: Point, b: Point) -> Point { [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]] }
fn dot(a: Point, b: Point) -> f64 { a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }

#[derive(Clone, Copy, Default)]
pub struct Bounds { pub min: Point, pub max: Point }
impl Bounds {
    pub fn overlaps(self, b: Self) -> bool { (0..3).all(|i| self.min[i] <= b.max[i] && self.max[i] >= b.min[i]) }
    fn intersects(self, b: Self) -> bool { (0..3).all(|i| self.min[i] < b.max[i] && self.max[i] > b.min[i]) }
}
pub struct SampleWords { pub values: Vec<f32>, pub blocks: Vec<u32> }
impl std::ops::Index<usize> for SampleWords {
    type Output = f32;
    fn index(&self, index: usize) -> &f32 {
        if self.blocks.is_empty() { return &self.values[index]; }
        let block = self.blocks[index >> 6]; if block == NONE { &1. } else { &self.values[block as usize*64+(index&63)] }
    }
}
#[derive(Clone, Copy, Default)]
pub struct Surface { pub kind: u32, pub center: Point }
/// `materials` is a bitmask of source material ids (bit `1<<id`) that a material-dependent cutter (rust-engine-v22)
/// removes and recuts; 0 means every material, the only form older engines send.
pub struct Field { pub source: u32, pub support: Option<Bounds>, pub surface: Surface, pub samples: SampleWords, pub is_static: bool, pub cut: bool, pub materials: u32, pub vertex_mark: usize }
impl Field { pub fn removes(&self, material: u32) -> bool { self.materials == 0 || (material < 32 && self.materials & (1 << material) != 0) } }
pub struct Source { pub name: String, pub anchor: Option<String>, pub material: u32, pub bounds: Bounds, pub fields: Vec<u32> }
pub struct Tet { pub name: String, pub vertices: [u32;4], pub brick: u32, pub local: u32, pub faces: Option<[u32;4]> }
pub struct Brick { pub name: String, pub bounds: Bounds, pub tets: Vec<u32>, pub fields: Vec<u32> }

#[derive(Clone, Copy)]
pub struct Vertex {
    pub support: [u32;4], pub sorted: [u32;4], pub weights: [f64;4], pub count: u32,
    pub edge: [u32;2], pub operands: [f64;2], pub field: u32, pub planes: Span, pub live_key: bool,
}
impl Vertex {
    fn base(id: u32) -> Self { Self { support: [id,0,0,0], sorted: [id,0,0,0], weights: [1.,0.,0.,0.], count: 1, edge: [NONE;2], operands: [0.;2], field: NONE, planes: Span::default(), live_key: false } }
    fn weight(self, key: u32) -> f64 { for i in 0..self.count as usize { if self.support[i] == key { return self.weights[i]; } } 0. }
}
#[derive(Clone, Copy)]
pub struct Face { pub vertices: Span, pub source: u32 }
#[derive(Clone, Copy)]
struct Cell { faces: Span, signs: Span }
struct Trace { source: u32, ids: Span, faces: Span, reversed: Option<Span>, valid: bool }
#[derive(Clone)]
pub struct Mask { pub tet: u32, pub constraints: Vec<i32> }
#[derive(Clone)]
pub struct Region { pub tet: u32, pub source: u32, pub volume: f64, pub faces: Span, pub source_faces: Span, pub constraints: Span }
#[derive(Clone)]
pub struct Page { pub brick: u32, pub revision: u32, pub tets: Option<Vec<u32>>, pub regions: Vec<Region>, pub removed: Vec<f64>, pub removed_volume: f64 }
pub struct Request { pub brick: u32, pub tets: Option<Vec<u32>> }
#[derive(Clone, Copy)]
pub struct ImportMark { vertices: usize, planes: usize, faces: usize, face_vertices: usize, links: usize, signs: usize, names: usize, fields: usize }

#[derive(Default)]
pub struct Core {
    pub canonical_construction: bool,
    pub base_count: usize, pub positions: Vec<Point>, pub vertices: Vec<Vertex>, pub planes: Vec<u32>,
    pub fields: Vec<Field>, pub sources: Vec<Source>, pub tets: Vec<Tet>, pub bricks: Vec<Brick>,
    pub names: Vec<String>, pub faces: Vec<Face>, pub face_vertices: Vec<u32>,
    pub region_links: Vec<u32>, pub region_signs: Vec<i32>, pub fallback_count: u32,
    name_ids: Map<String,u32>, pub lattice_sources: Map<[u32;3],u32>, canonical: IndexTable,
    pub surfaces: Map<u32,Surface>,
    aliases: Map<(u32,u32,u32),u32>, values: Map<(u32,u32),f64>, exact: Map<u32,Vec<(u32,BigRational)>>,
    physical: Map<[u32;3],u32>, physical_ids: Vec<u32>,
    traces: Vec<Trace>, trace_table: IndexTable, trace_links: Vec<u32>, trace_ids: Vec<u32>, traces_by_tet: Map<u32,Vec<u32>>,
    candidates: Map<u32,Vec<u32>>, marks: Vec<u32>, mark: u32, value_scratch: Vec<f64>, cap: Vec<u32>, link_mark: Vec<u32>, link_to: Vec<u32>,
    scratch_links: Vec<u32>, scratch_signs: Vec<i32>, signs: Vec<i8>, slots: Vec<i32>,
    cells: Vec<Cell>, next_cells: Vec<Cell>,
}

impl Core {
    pub fn import_mark(&self) -> ImportMark { ImportMark { vertices:self.vertices.len(),planes:self.planes.len(),faces:self.faces.len(),face_vertices:self.face_vertices.len(),links:self.region_links.len(),signs:self.region_signs.len(),names:self.names.len(),fields:self.fields.len() } }
    /// Coordinator imports append to arenas. Aborting an edit restores the published prefix;
    /// rebuilding lookup indices is deliberately confined to this exceptional path.
    pub fn abort_import(&mut self, mark: ImportMark) {
        self.vertices.truncate(mark.vertices); self.positions.truncate(mark.vertices); self.planes.truncate(mark.planes);
        self.faces.truncate(mark.faces); self.face_vertices.truncate(mark.face_vertices); self.region_links.truncate(mark.links); self.region_signs.truncate(mark.signs);
        self.fields.truncate(mark.fields); for brick in &mut self.bricks { brick.fields.retain(|&id|(id as usize)<mark.fields); }
        self.names.truncate(mark.names); self.name_ids.retain(|_,id|(*id as usize)<mark.names); self.lattice_sources.retain(|_,id|(*id as usize)<mark.names);
        self.surfaces.clear(); for field in &self.fields { self.surfaces.insert(field.source,field.surface); }
        self.canonical.clear(); for (id,v) in self.vertices.iter().enumerate() { if v.live_key { self.canonical.insert(key_hash(&v.sorted[..v.count as usize],&self.planes[v.planes.range()]),id as u32); } }
        self.physical.retain(|_,id|(*id as usize)<mark.vertices); self.physical_ids.clear();
        // Coordinator clipping populates these caches. A retry can reuse both numeric
        // field and vertex slots with different scalar words.
        self.values.clear(); self.exact.clear(); self.aliases.clear(); self.clear_traces();
        for tet in &mut self.tets { tet.faces = None; }
    }
    pub fn import_vertex(&mut self, mut vertex: Vertex, planes: &[u32], position: Point) -> Outcome<u32> {
        let n = vertex.count as usize; vertex.sorted = vertex.support; vertex.sorted[..n].sort_unstable();
        let hash = key_hash(&vertex.sorted[..n],planes);
        if let Some(id) = self.canonical.find(hash,|id| { let v = self.vertices[id as usize]; v.live_key && v.count == vertex.count && v.sorted[..n] == vertex.sorted[..n] && self.planes[v.planes.range()] == *planes }) {
            if self.positions[id as usize] != position { return Err("Worker disagrees with resident canonical source coordinates".into()); }
            return Ok(id);
        }
        let id = self.vertices.len() as u32; vertex.planes = append(&mut self.planes,planes); vertex.live_key = true;
        self.vertices.push(vertex); self.positions.push(position); self.canonical.insert(hash,id); Ok(id)
    }
    fn compare_vertices(&self, a: u32, b: u32) -> std::cmp::Ordering {
        if !self.canonical_construction { return a.cmp(&b); }
        let va = self.vertices[a as usize]; let vb = self.vertices[b as usize];
        va.sorted[..va.count as usize].cmp(&vb.sorted[..vb.count as usize]).then_with(||self.planes[va.planes.range()].cmp(&self.planes[vb.planes.range()]))
    }
    /// Solve the intersection from immutable original sample words and a sorted key, independent
    /// of which clipping edge discovered it. Pivot order is fixed; uncertain pivots use rationals.
    fn canonical_weights(&self, support: &[u32], planes: &[u32]) -> Outcome<[f64;4]> {
        let n = support.len(); let mut rows = vec![[0.;5];planes.len()+1]; rows[0][..n].fill(1.); rows[0][n] = 1.;
        for (i,&field) in planes.iter().enumerate() { for (j,&base) in support.iter().enumerate() { rows[i+1][j] = self.fields[field as usize].samples[base as usize] as f64; } }
        if rows.len() < n { return Err("Underdetermined canonical intersection".into()); }
        let original = rows.clone(); let scale = rows.iter().flat_map(|row|row[..n].iter()).fold(1f64,|a,&b|a.max(b.abs()));
        for column in 0..n {
            let pivot = (column..rows.len()).max_by(|&a,&b|rows[a][column].abs().total_cmp(&rows[b][column].abs()).then_with(||b.cmp(&a))).unwrap();
            if rows[pivot][column].abs() < 1e-12*scale { return exact_solve(&original,n); }
            rows.swap(column,pivot); let divisor = rows[column][column]; for j in column..=n { rows[column][j] /= divisor; }
            for i in 0..rows.len() { if i == column { continue; } let multiple = rows[i][column]; for j in column..=n { rows[i][j] -= multiple*rows[column][j]; } }
        }
        let mut weights = [0.;4]; for i in 0..n { weights[i] = rows[i][n]; } Ok(weights)
    }
    fn tet_bounds(&self, id: u32) -> Bounds {
        let mut result = Bounds { min: [f64::INFINITY;3], max: [f64::NEG_INFINITY;3] };
        for &v in &self.tets[id as usize].vertices { for a in 0..3 { let p = self.positions[v as usize][a]; result.min[a] = result.min[a].min(p); result.max[a] = result.max[a].max(p); } }
        result
    }
    fn candidates_for(&mut self, id: u32, bounds: Bounds) -> Ids {
        if let Some(list) = self.candidates.get(&id) { return Ids::from(list); }
        let v = self.tets[id as usize].vertices;
        let list: Vec<u32> = self.sources.iter().enumerate().filter_map(|(i,source)| {
            let possible = source.fields.iter().all(|&field| {
                let field = &self.fields[field as usize];
                field.support.map_or(true,|s|s.overlaps(bounds)) && (v.iter().any(|&id|field.samples[id as usize] < 0.) || v.iter().all(|&id|field.samples[id as usize] == 0.))
            }); possible.then_some(i as u32)
        }).collect();
        let result = Ids::from(&list); self.candidates.insert(id,list); result
    }
    fn tet_faces(&mut self, id: u32) -> [u32;4] {
        if let Some(faces) = self.tets[id as usize].faces { return faces; }
        let vertices = self.tets[id as usize].vertices; let mut faces = [0;4];
        for opposite in 0..4 {
            let mut points = [0;3]; let mut at = 0;
            for (i,&v) in vertices.iter().enumerate() { if i != opposite { points[at] = v; at += 1; } }
            let origin = self.positions[points[0] as usize];
            if dot(cross(sub(self.positions[points[1] as usize],origin),sub(self.positions[points[2] as usize],origin)),sub(self.positions[vertices[opposite] as usize],origin)) > 0. { points.reverse(); }
            let mut sorted = points; sorted.sort_unstable();
            let source = if let Some(&source) = self.lattice_sources.get(&sorted) { source } else {
                let source = self.name(format!("face:{},{},{}",sorted[0],sorted[1],sorted[2])); self.lattice_sources.insert(sorted,source); source
            };
            faces[opposite] = self.add_face(&points,source);
        }
        self.tets[id as usize].faces = Some(faces); faces
    }
    fn traced_face(&mut self, face: u32, crossing: &[u32], tet: u32) -> Outcome<Span> {
        let original = self.faces[face as usize]; let vertices = Ids::from(self.ids(face)); let v = vertices.slice(); let n = v.len();
        let start = (0..n).min_by(|&a,&b|self.compare_vertices(v[a],v[b])).unwrap(); let same = self.compare_vertices(v[(start+1)%n],v[(start+n-1)%n]).is_lt();
        let mut key = v.to_vec(); key.sort_unstable(); let hash = key_hash(&[original.source],&key);
        let known = self.trace_table.find(hash,|id| { let trace = &self.traces[id as usize]; trace.valid && trace.source == original.source && self.trace_ids[trace.ids.range()] == key });
        let trace_id = if let Some(id) = known { id } else {
            let cycle: Vec<u32> = (0..n).map(|i|v[(start+if same { i } else { n-i })%n]).collect();
            let mut polygons = vec![self.add_face(&cycle,original.source)];
            for &field in crossing {
                let mut below = false; let mut above = false;
                for &id in &cycle { if self.value(id,field)? < 0. { below = true; break; } }
                if below { for &id in &cycle { if self.value(id,field)? > 0. { above = true; break; } } }
                if !below || !above { continue; }
                let mut next = Vec::new();
                for polygon in polygons {
                    let points = Ids::from(self.ids(polygon)); let p = points.slice(); let mut values = Vec::with_capacity(p.len()); let mut below = false; let mut above = false;
                    for &id in p { let value = self.value(id,field)?; below |= value < 0.; above |= value > 0.; values.push(value); }
                    if !below || !above { next.push(polygon); continue; }
                    for sign in [-1.,1.] {
                        let mut clipped = Ids::default();
                        for i in 0..p.len() { let j = (i+1)%p.len(); let fa = values[i]; let fb = values[j];
                            if fa*sign >= 0. { clipped.push(p[i]); } if fa*fb < 0. { clipped.push(self.intersection(p[i],p[j],field)?); }
                        }
                        clipped.unique(); if clipped.slice().len() >= 3 { next.push(self.add_face(clipped.slice(),original.source)); }
                    }
                }
                polygons = next;
            }
            let id = self.traces.len() as u32;
            self.traces.push(Trace { source: original.source, ids: append(&mut self.trace_ids,&key), faces: append(&mut self.trace_links,&polygons), reversed: None, valid: true });
            self.trace_table.insert(hash,id); self.traces_by_tet.entry(tet).or_default().push(id); id
        };
        let trace = &self.traces[trace_id as usize];
        if same { return Ok(trace.faces); } if let Some(reversed) = trace.reversed { return Ok(reversed); }
        let faces = Ids::from(&self.trace_links[trace.faces.range()]); let mut reversed = Ids::default();
        for &face in faces.slice() { let source = self.faces[face as usize].source; let mut ids = self.ids(face).to_vec(); ids.reverse(); reversed.push(self.add_face(&ids,source)); }
        let span = append(&mut self.trace_links,reversed.slice()); self.traces[trace_id as usize].reversed = Some(span); Ok(span)
    }
    pub(crate) fn physical_id(&mut self, id: u32) -> u32 {
        if self.physical_ids.len() < self.vertices.len() { self.physical_ids.resize(self.vertices.len(),NONE); }
        let known = self.physical_ids[id as usize]; if known != NONE { return known; }
        let bits = self.positions[id as usize].map(|p|((p+0.) as f32).to_bits());
        let physical = *self.physical.entry(bits).or_insert(id); self.physical_ids[id as usize] = physical; physical
    }
    pub(crate) fn physical_faces(&mut self, faces: &[u32]) -> Span {
        let mut output = Ids::default(); let mut collapsed = Ids::default();
        for &face in faces {
            let original = Ids::from(self.ids(face)); let mut points = Ids::default(); let mut same = true;
            for &id in original.slice() { let physical = self.physical_id(id); points.push(physical); same &= id == physical; }
            points.unique(); let p = points.slice(); if p.len() < 3 { continue; }
            if self.area_positive(p) { output.push(if same && p.len() == original.slice().len() { face } else { self.add_face(p,self.faces[face as usize].source) }); }
            else { for &id in p { if !collapsed.slice().contains(&id) { collapsed.push(id); } } }
        }
        if collapsed.slice().is_empty() { return append(&mut self.region_links,output.slice()); }
        let mut repaired = Ids::default();
        for &face in output.slice() {
            let original = Ids::from(self.ids(face)); let v = original.slice(); let mut points = Ids::default();
            for i in 0..v.len() {
                let a = v[i]; let b = v[(i+1)%v.len()]; let p = self.positions[a as usize]; let q = self.positions[b as usize]; let d = sub(q,p); points.push(a);
                let axis = if d[0].abs() >= d[1].abs() && d[0].abs() >= d[2].abs() { 0 } else if d[1].abs() >= d[2].abs() { 1 } else { 2 };
                let mut inside = Vec::new();
                for &id in collapsed.slice() { if id == a || id == b { continue; } let r = sub(self.positions[id as usize],p); let t = r[axis]/d[axis];
                    if t > 0. && t < 1. && cross(d,r).iter().all(|&v|v == 0.) { inside.push((id,t)); }
                }
                inside.sort_by(|a,b|a.1.partial_cmp(&b.1).unwrap()); for (id,_) in inside { points.push(id); }
            }
            repaired.push(if points.slice().len() == v.len() { face } else { self.add_face(points.slice(),self.faces[face as usize].source) });
        }
        append(&mut self.region_links,repaired.slice())
    }
    fn cell_sign(&self, cell: Cell, field: u32) -> i32 {
        let slot = self.slots[field as usize]; if slot < 0 { self.signs[field as usize] as i32*(field as i32+1) } else { self.scratch_signs[cell.signs.start as usize+slot as usize] }
    }
    fn volume(&mut self, faces: &[u32]) -> f64 {
        let mut ordered;
        let faces = if self.canonical_construction {
            ordered = faces.to_vec(); ordered.sort_by(|&a,&b| {
                self.names[self.faces[a as usize].source as usize].cmp(&self.names[self.faces[b as usize].source as usize]).then_with(|| {
                    for (&a,&b) in self.ids(a).iter().zip(self.ids(b)) { let order = self.compare_vertices(a,b); if !order.is_eq() { return order; } }
                    self.ids(a).len().cmp(&self.ids(b).len())
                })
            }); ordered.as_slice()
        } else { faces };
        let stamp = self.next_mark(); let mut center = [0.;3]; let mut count = 0;
        for &face in faces { let v = Ids::from(self.ids(face)); for &id in v.slice() { if self.marks[id as usize] != stamp { self.marks[id as usize] = stamp; count += 1; for (a,sum) in center.iter_mut().enumerate() { *sum += self.positions[id as usize][a]; } } }
        }
        for value in &mut center { *value /= count as f64; }
        let mut volume = 0.;
        for &face in faces { let ids = self.ids(face); let a = sub(self.positions[ids[0] as usize],center); for i in 1..ids.len()-1 { volume += dot(a,cross(sub(self.positions[ids[i] as usize],center),sub(self.positions[ids[i+1] as usize],center)))/6.; } }
        volume
    }
    fn compile_tet(&mut self, id: u32, masks: &[&Mask], output: &mut Vec<Region>) -> Outcome<f64> {
        let bounds = self.tet_bounds(id); if !self.sources.iter().any(|s|s.bounds.intersects(bounds)) { return Ok(0.); }
        let tet = &self.tets[id as usize]; let vertices = tet.vertices; let listed = Ids::from(&self.bricks[tet.brick as usize].fields);
        self.signs.resize(self.fields.len(),1); self.signs.fill(1); self.slots.resize(self.fields.len(),-1); self.slots.fill(-1);
        let mut crossing = Ids::default(); let mut cuts = Ids::default();
        for &field in listed.slice() {
            let f = &self.fields[field as usize]; let negative = vertices.iter().any(|&id|f.samples[id as usize] < 0.); let positive = vertices.iter().any(|&id|f.samples[id as usize] > 0.);
            if !negative || !positive { self.signs[field as usize] = if positive { 1 } else { -1 }; } else { self.slots[field as usize] = crossing.slice().len() as i32; crossing.push(field); }
            if f.cut { cuts.push(field); }
        }
        let candidates = self.candidates_for(id,bounds); if candidates.slice().is_empty() { return Ok(0.); }
        let faces = self.tet_faces(id); let mut relevant = Ids::default();
        for &source in candidates.slice() { for &field in &self.sources[source as usize].fields { if !relevant.slice().contains(&field) { relevant.push(field); } } }
        for mask in masks { for &sign in &mask.constraints { let field = sign.unsigned_abs()-1; if !relevant.slice().contains(&field) { relevant.push(field); } } }
        // A material cutter removes only cells owned by its materials. Where no candidate has one, it is as irrelevant
        // as a remote source's plane and does not subdivide (face traces still use every crossing field).
        let mut active = Ids::default(); for &field in crossing.slice() { let f = &self.fields[field as usize]; if relevant.slice().contains(&field) || (f.cut && (f.materials == 0 || candidates.slice().iter().any(|&s|f.removes(self.sources[s as usize].material)))) { self.slots[field as usize] = active.slice().len() as i32; active.push(field); } }
        self.scratch_links.clear(); self.scratch_signs.clear(); self.cells.clear(); self.next_cells.clear();
        self.scratch_signs.resize(active.slice().len(),0);
        self.cells.push(Cell { faces: append(&mut self.scratch_links,&faces), signs: Span { start: 0, len: active.slice().len() as u32 } });
        for (slot,&field) in active.slice().iter().enumerate() {
            for i in 0..self.cells.len() { match self.split(self.cells[i],field,slot)? { IdsCells::One(cell)=>self.next_cells.push(cell), IdsCells::Two(cells)=>self.next_cells.extend_from_slice(&cells) } }
            std::mem::swap(&mut self.cells,&mut self.next_cells); self.next_cells.clear();
            if self.cells.len() > 2048 { return Err(format!("Tet {} exceeds 2048 arrangement cells",self.tets[id as usize].name)); }
        }
        let mut removed = 0.;
        for i in 0..self.cells.len() {
            let cell = self.cells[i]; let source = candidates.slice().iter().find(|&&s|self.sources[s as usize].fields.iter().all(|&f|self.cell_sign(cell,f) < 0)).copied(); let Some(source) = source else { continue; };
            if masks.iter().any(|mask|mask.constraints.iter().all(|&sign|self.cell_sign(cell,sign.unsigned_abs()-1) == sign)) { continue; }
            let faces = Ids::from(&self.scratch_links[cell.faces.range()]); let mut traced = Ids::default();
            for &face in faces.slice() { let parts = self.traced_face(face,crossing.slice(),id)?; for &part in &self.trace_links[parts.range()] { traced.push(part); } }
            let volume = self.volume(traced.slice()); if volume == 0. { continue; } if !(volume > 0.) { return Err(format!("Invalid occupied volume {}: {volume}",self.tets[id as usize].name)); }
            if self.sources[source as usize].anchor.is_none() && cuts.slice().iter().any(|&field|self.fields[field as usize].removes(self.sources[source as usize].material) && self.cell_sign(cell,field) < 0) { removed += volume; continue; }
            let physical = self.physical_faces(traced.slice()); let source_faces = append(&mut self.region_links,traced.slice()); let constraints = append(&mut self.region_signs,&self.scratch_signs[cell.signs.range()]);
            output.push(Region { tet: id, source, volume, faces: physical, source_faces, constraints });
        }
        Ok(removed)
    }
    pub fn compile(&mut self, requests: Vec<Request>, revision: u32, masks: Vec<Mask>) -> Outcome<Vec<Page>> {
        let mut mask_index: Map<u32,Vec<&Mask>> = Map::default(); for mask in &masks { mask_index.entry(mask.tet).or_default().push(mask); }
        let mut pages = Vec::with_capacity(requests.len());
        for request in requests {
            let all = &self.bricks[request.brick as usize].tets;
            let tets: Vec<u32> = if let Some(local) = &request.tets { local.iter().map(|&i|all[i as usize]).collect() } else { all.clone() };
            let mut page = Page { brick: request.brick, revision, tets: request.tets, regions: Vec::new(), removed: Vec::with_capacity(tets.len()), removed_volume: 0. };
            for tet in tets { let removed = self.compile_tet(tet,mask_index.get(&tet).map_or(&[],|v|v.as_slice()),&mut page.regions)?; page.removed.push(removed); page.removed_volume += removed; }
            pages.push(page);
        }
        Ok(pages)
    }
    /// Output has been copied/consumed. Retain allocations, recipes, samples and canonical identity;
    /// recycle transient polygon storage so repeated edits do not accumulate dead face arenas.
    pub fn recycle_output(&mut self) {
        self.release_caches(); self.faces.clear(); self.face_vertices.clear(); self.region_links.clear(); self.region_signs.clear();
        for tet in &mut self.tets { tet.faces = None; }
    }
    pub fn reset_construction(&mut self) -> Outcome<()> {
        if !self.canonical_construction { return Err("Construction reset requires canonical source coordinates".into()); }
        self.recycle_output(); self.vertices.truncate(self.base_count); self.positions.truncate(self.base_count); self.planes.clear();
        self.aliases.clear(); self.canonical.clear(); self.physical.clear(); self.physical_ids.clear();
        for field in &mut self.fields { field.vertex_mark = self.base_count; } Ok(())
    }
    pub fn name(&mut self, text: String) -> u32 {
        if let Some(&id) = self.name_ids.get(&text) { return id; }
        let id = self.names.len() as u32; self.names.push(text.clone()); self.name_ids.insert(text,id); id
    }
    pub fn add_base(&mut self, position: Point) { let id = self.vertices.len() as u32; self.vertices.push(Vertex::base(id)); self.positions.push(position); self.base_count += 1; }
    pub fn add_field(&mut self, mut field: Field) {
        let id = self.fields.len() as u32; field.vertex_mark = self.vertices.len();
        self.surfaces.insert(field.source,field.surface);
        if field.is_static {
            for brick in &mut self.bricks { if field.support.map_or(true, |s| s.overlaps(brick.bounds)) { brick.fields.push(id); } }
            // Invalidate traces owned by tets whose original samples can be changed by this field.
            let affected: Vec<u32> = self.traces_by_tet.keys().copied().filter(|&t| self.tets[t as usize].vertices.iter().any(|&v| field.samples[v as usize] <= 0.)).collect();
            for t in affected { if let Some(traces) = self.traces_by_tet.remove(&t) { for id in traces { self.traces[id as usize].valid = false; } } }
        }
        self.fields.push(field);
    }
    pub fn rollback_fields(&mut self, count: usize) {
        if count >= self.fields.len() { return; }
        let mark = self.fields[count].vertex_mark;
        self.fields.truncate(count);
        for brick in &mut self.bricks { brick.fields.retain(|&id| (id as usize) < count); }
        self.values.retain(|&(field,_),_| (field as usize) < count);
        for v in &mut self.vertices[mark..] { v.live_key = false; }
        self.canonical.clear();
        for (id,v) in self.vertices.iter().enumerate() { if v.live_key { self.canonical.insert(key_hash(&v.sorted[..v.count as usize], &self.planes[v.planes.range()]),id as u32); } }
        self.physical.retain(|_,id| (*id as usize) < mark); self.physical_ids.clear();
        self.aliases.clear(); self.exact.clear(); self.clear_traces();
        self.surfaces.clear(); for field in &self.fields { self.surfaces.insert(field.source,field.surface); }
    }
    fn clear_traces(&mut self) { self.traces.clear(); self.trace_table.clear(); self.trace_links.clear(); self.trace_ids.clear(); self.traces_by_tet.clear(); }
    pub fn release_caches(&mut self) { self.clear_traces(); self.values.clear(); self.exact.clear(); }
    fn reserve(&mut self) {
        let n = self.vertices.len();
        if self.marks.len() < n {
            let size = n.max(self.marks.len()*2).max(1024);
            self.marks.resize(size,0); self.value_scratch.resize(size,0.); self.cap.resize(size,0); self.link_mark.resize(size,0); self.link_to.resize(size,0);
        }
    }
    fn next_mark(&mut self) -> u32 {
        self.reserve();
        if self.mark >= 0x3fffffff { self.marks.fill(0); self.cap.fill(0); self.link_mark.fill(0); self.mark = 0; }
        self.mark += 1; self.mark
    }
    pub fn add_face(&mut self, vertices: &[u32], source: u32) -> u32 {
        let span = if self.canonical_construction {
            let start = (0..vertices.len()).min_by(|&a,&b|self.compare_vertices(vertices[a],vertices[b])).unwrap();
            let span = Span { start:self.face_vertices.len() as u32,len:vertices.len() as u32 };
            self.face_vertices.extend_from_slice(&vertices[start..]); self.face_vertices.extend_from_slice(&vertices[..start]); span
        } else { append(&mut self.face_vertices,vertices) }; let id = self.faces.len() as u32;
        self.faces.push(Face { vertices: span, source }); id
    }
    pub(crate) fn ids(&self, face: u32) -> &[u32] { &self.face_vertices[self.faces[face as usize].vertices.range()] }
    pub(crate) fn area_positive(&self, ids: &[u32]) -> bool {
        // The caller only tests area > 0. f32 coordinates have finite binary64 products, and every
        // nonzero cross product has a positive Math.hypot: no square root or temporary vectors needed.
        let origin = self.positions[ids[0] as usize];
        (1..ids.len()-1).any(|i| cross(sub(self.positions[ids[i] as usize],origin), sub(self.positions[ids[i+1] as usize],origin)).iter().any(|&v| v != 0.))
    }
    fn exact_weights(&mut self, id: u32) -> Outcome<Vec<(u32,BigRational)>> {
        if let Some(w) = self.exact.get(&id) { return Ok(w.clone()); }
        let v = self.vertices[id as usize];
        let result = if (id as usize) < self.base_count { vec![(id,BigRational::one())] } else {
            let wa = self.exact_weights(v.edge[0])?; let wb = self.exact_weights(v.edge[1])?;
            let fa = self.exact_value(v.edge[0],v.field)?; let fb = self.exact_value(v.edge[1],v.field)?;
            let denominator = &fa - &fb; if denominator.is_zero() { return Err("Zero exact intersection denominator".into()); }
            let t = fa / denominator; let mut result = Vec::new();
            for (key,_) in wa.iter().chain(&wb) {
                if result.iter().any(|(k,_)| k == key) { continue; }
                let a = wa.iter().find(|(k,_)| k == key).map(|(_,v)|v.clone()).unwrap_or_default();
                let b = wb.iter().find(|(k,_)| k == key).map(|(_,v)|v.clone()).unwrap_or_default();
                result.push((*key,a*(BigRational::one()-&t)+b*&t));
            }
            result
        };
        self.exact.insert(id,result.clone()); Ok(result)
    }
    fn exact_value(&mut self, id: u32, field: u32) -> Outcome<BigRational> {
        let weights = self.exact_weights(id)?; let samples = &self.fields[field as usize].samples;
        Ok(weights.into_iter().fold(BigRational::zero(),|sum,(key,w)| sum+w*BigRational::from_float(samples[key as usize] as f64).unwrap()))
    }
    fn value(&mut self, id: u32, field: u32) -> Outcome<f64> {
        let v = self.vertices[id as usize];
        if v.field == field || self.planes[v.planes.range()].contains(&field) { return Ok(0.); }
        if (id as usize) < self.base_count { return Ok(self.fields[field as usize].samples[id as usize] as f64); }
        if let Some(&value) = self.values.get(&(field,id)) { return Ok(value); }
        let samples = &self.fields[field as usize].samples; let mut value = 0.; let mut scale = 0.;
        for i in 0..v.count as usize { let term = v.weights[i]*samples[v.support[i] as usize] as f64; value += term; scale += term.abs(); }
        if value.abs() < 1e-12*scale.max(1.) {
            if self.value(v.edge[0],field)? == 0. && self.value(v.edge[1],field)? == 0. { value = 0.; }
            else {
                self.fallback_count += 1;
                let exact = self.exact_value(id,field)?; value = rational_number(&exact);
                if !value.is_finite() || (value == 0. && !exact.is_zero()) { return Err(format!("Unresolved exact predicate {id}/{field}")); }
            }
        }
        self.values.insert((field,id),value); Ok(value)
    }
    fn intersection(&mut self, mut a: u32, mut b: u32, field: u32) -> Outcome<u32> {
        if a > b { std::mem::swap(&mut a,&mut b); }
        if let Some(&id) = self.aliases.get(&(field,a,b)) { return Ok(id); }
        let fa = self.value(a,field)?; let fb = self.value(b,field)?; let t = fa/(fa-fb);
        let va = self.vertices[a as usize]; let vb = self.vertices[b as usize];
        let mut support = [0;4]; let mut count = 0;
        for &id in va.support[..va.count as usize].iter().chain(&vb.support[..vb.count as usize]) {
            if !support[..count].contains(&id) { if count == 4 { return Err("Non-simplex vertex support".into()); } support[count] = id; count += 1; }
        }
        let mut incident = Ids::default(); incident.push(field);
        let pa = Ids::from(&self.planes[va.planes.range()]); let pb = Ids::from(&self.planes[vb.planes.range()]);
        let mut tested = Ids::default();
        for &plane in pa.slice().iter().chain(pb.slice()) {
            if tested.slice().contains(&plane) { continue; } tested.push(plane);
            if plane != field && self.value(a,plane)? == 0. && self.value(b,plane)? == 0. { incident.push(plane); }
        }
        let mut planes = incident.slice().to_vec(); planes.sort_unstable();
        let mut sorted = support; sorted[..count].sort_unstable();
        let hash = key_hash(&sorted[..count],&planes);
        if let Some(id) = self.canonical.find(hash,|id| { let v = self.vertices[id as usize]; v.live_key && v.count as usize == count && v.sorted[..count] == sorted[..count] && self.planes[v.planes.range()] == planes }) {
            self.aliases.insert((field,a,b),id); return Ok(id);
        }
        let mut weights = [0.;4];
        if self.canonical_construction { support = sorted; weights = self.canonical_weights(&support[..count],&planes)?; }
        else { for i in 0..count { weights[i] = va.weight(support[i])*(1.-t)+vb.weight(support[i])*t; } }
        let mut position = [0.;3]; let origin = self.positions[support[0] as usize];
        for axis in 0..3 {
            let mut delta = 0.; for i in 1..count { delta = f(delta+f(f(self.positions[support[i] as usize][axis]-origin[axis])*f(weights[i]))); }
            position[axis] = f(origin[axis]+delta);
        }
        let id = self.vertices.len() as u32; let planes = append(&mut self.planes,&planes);
        self.vertices.push(Vertex { support, sorted, weights, count: count as u32, edge: [a,b], operands: [f(fa),f(fb)], field, planes, live_key: true });
        self.positions.push(position); self.canonical.insert(hash,id); self.aliases.insert((field,a,b),id); Ok(id)
    }
    /// Recut immutable source faces, never the welded render boundary. The negative
    /// volume is integrated independently, rather than inferred from before - after.
    pub fn clip_regions(&mut self, regions: &[Region], field: u32) -> Outcome<(Vec<Region>,f64)> {
        let cutter=self.fields.get(field as usize).ok_or("Unknown body field")?;
        // cut marks cutters participating in static CSG; body-only fields deliberately
        // have both flags clear in the established prepared-field wire contract.
        if cutter.is_static { return Err("Body recuts require a body-only field".into()); }
        let mut survivors=Vec::new(); let mut removed=0.;
        for region in regions {
            if !self.fields[field as usize].removes(self.sources[region.source as usize].material) { survivors.push(region.clone()); continue; }
            let faces=Ids::from(&self.region_links[region.source_faces.range()]);
            let mut negative=false; let mut positive=false;
            for &face in faces.slice() {
                let ids=Ids::from(self.ids(face));
                for &id in ids.slice() { let value=self.value(id,field)?; negative|=value<0.; positive|=value>0.; }
            }
            if !negative { survivors.push(region.clone()); continue; }
            if !positive { removed+=region.volume; continue; }
            self.scratch_links.clear(); self.scratch_signs.clear();
            let cell=Cell { faces:append(&mut self.scratch_links,faces.slice()),signs:append(&mut self.scratch_signs,&[0]) };
            let cells=match self.split(cell,field,0)? { IdsCells::One(c)=>vec![c],IdsCells::Two(c)=>c.to_vec() };
            for cell in cells {
                let faces=Ids::from(&self.scratch_links[cell.faces.range()]); let volume=self.volume(faces.slice());
                if volume==0. { continue; } if !(volume>0.) { return Err("Invalid recut occupied volume".into()); }
                if self.scratch_signs[cell.signs.start as usize]<0 { removed+=volume; }
                else {
                    let mut constraints=self.region_signs[region.constraints.range()].to_vec(); constraints.push(field as i32+1);
                    let source_faces=append(&mut self.region_links,faces.slice()); let physical=self.physical_faces(faces.slice());
                    survivors.push(Region { faces:physical,source_faces,volume,constraints:append(&mut self.region_signs,&constraints),..region.clone() });
                }
            }
        }
        Ok((survivors,removed))
    }
    fn split(&mut self, cell: Cell, field: u32, slot: usize) -> Outcome<IdsCells> {
        let seen = self.next_mark(); let mut negative = false; let mut positive = false;
        let faces = Ids::from(&self.scratch_links[cell.faces.range()]);
        for &face in faces.slice() {
            let vertices = Ids::from(self.ids(face));
            for &id in vertices.slice() {
                if self.marks[id as usize] == seen { continue; }
                self.marks[id as usize] = seen; let value = self.value(id,field)?; self.value_scratch[id as usize] = value;
                negative |= value < 0.; positive |= value > 0.;
            }
        }
        if !negative || !positive {
            self.scratch_signs[cell.signs.start as usize+slot] = if positive { field as i32+1 } else { -(field as i32+1) }; return Ok(IdsCells::One(cell));
        }
        let caps = self.next_mark(); let mut sides = [Ids::default(),Ids::default()];
        for &face in faces.slice() {
            let vertices = Ids::from(self.ids(face)); let v = vertices.slice();
            for side in 0..2 {
                let sign = if side == 0 { -1. } else { 1. }; let mut points = Ids::default();
                for i in 0..v.len() {
                    let a = v[i]; let b = v[(i+1)%v.len()]; let fa = self.value_scratch[a as usize]; let fb = self.value_scratch[b as usize];
                    if fa*sign >= 0. { points.push(a); } if fa == 0. { self.cap[a as usize] = caps; }
                    if fa*fb < 0. { let id = self.intersection(a,b,field)?; points.push(id); self.reserve(); self.cap[id as usize] = caps; }
                }
                // Canonical source identities define the clipping cycle even when f32 publication
                // collapses a microscopic face. physical_faces removes flat geometry only after
                // classification and cap construction consume the complete source topology.
                points.unique(); if points.slice().len() >= 3 && (self.canonical_construction || self.area_positive(points.slice())) { let source = self.faces[face as usize].source; let id = self.add_face(points.slice(),source); sides[side].push(id); }
            }
        }
        let linked = self.next_mark(); let mut order = Ids::default();
        for &face in sides[0].slice() {
            let vertices = Ids::from(self.ids(face)); let v = vertices.slice();
            for i in 0..v.len() { let a = v[i]; let b = v[(i+1)%v.len()];
                if self.cap[a as usize] == caps && self.cap[b as usize] == caps {
                    if self.link_mark[b as usize] != linked { self.link_mark[b as usize] = linked; order.push(b); }
                    self.link_to[b as usize] = a;
                }
            }
        }
        let mut ring = Ids::default();
        if let Some(&first) = order.slice().first() {
            let mut current = first;
            loop { ring.push(current); if self.link_mark[current as usize] != linked { break; } current = self.link_to[current as usize]; if current == first || ring.slice().len() > order.slice().len() { break; } }
        }
        let r = ring.slice();
        if r.len() < 3 || r.len() != order.slice().len() || self.link_to[*r.last().unwrap() as usize] != r[0] { return Err("Unresolved canonical cap cycle".into()); }
        let source = self.fields[field as usize].source;
        sides[0].push(self.add_face(r,source)); let mut reverse = r.to_vec(); reverse.reverse(); sides[1].push(self.add_face(&reverse,source));
        let original = self.scratch_signs[cell.signs.range()].to_vec();
        let mut result = [cell;2];
        for side in 0..2 {
            let signs = append(&mut self.scratch_signs,&original); self.scratch_signs[signs.start as usize+slot] = if side == 0 { -(field as i32+1) } else { field as i32+1 };
            result[side] = Cell { faces: append(&mut self.scratch_links,sides[side].slice()), signs };
        }
        Ok(IdsCells::Two(result))
    }
}

enum IdsCells { One(Cell), Two([Cell;2]) }
fn rational_number(q: &BigRational) -> f64 {
    if q.is_zero() { return 0.; }
    let n = q.numer().magnitude(); let d = q.denom().magnitude();
    let ns = n.bits().saturating_sub(53); let ds = d.bits().saturating_sub(53);
    let sign = if q.numer().sign() == Sign::Minus { -1. } else { 1. };
    sign*((n >> ns).to_f64().unwrap()/(d >> ds).to_f64().unwrap())*2f64.powi(ns as i32-ds as i32)
}
fn exact_solve(original: &[[f64;5]], n: usize) -> Outcome<[f64;4]> {
    let mut rows: Vec<Vec<BigRational>> = original.iter().map(|r|r[..=n].iter().map(|&v|BigRational::from_float(v).unwrap()).collect()).collect();
    for column in 0..n {
        let pivot = (column..rows.len()).find(|&i|!rows[i][column].is_zero()).ok_or("Singular canonical intersection")?;
        rows.swap(column,pivot); let divisor = rows[column][column].clone(); for j in column..=n { rows[column][j] /= &divisor; }
        for i in 0..rows.len() { if i == column { continue; } let multiple = rows[i][column].clone(); for j in column..=n { let term = &multiple*&rows[column][j]; rows[i][j] -= term; } }
    }
    let mut result = [0.;4]; for i in 0..n { result[i] = rational_number(&rows[i][n]); } Ok(result)
}
