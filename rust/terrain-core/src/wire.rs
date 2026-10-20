use crate::core::*;

pub struct Reader<'a> { data: &'a [u8], at: usize }
impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self { Self { data, at: 0 } }
    fn take(&mut self, count: usize) -> Outcome<&'a [u8]> { let end = self.at.checked_add(count).ok_or("Input size overflow")?; let data = self.data.get(self.at..end).ok_or("Truncated terrain input")?; self.at = end; Ok(data) }
    pub fn u32(&mut self) -> Outcome<u32> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
    pub fn f64(&mut self) -> Outcome<f64> { let v = f64::from_le_bytes(self.take(8)?.try_into().unwrap()); if !v.is_finite() { return Err("Non-finite terrain input".into()); } Ok(v) }
    fn point(&mut self) -> Outcome<Point> { Ok([self.f64()?,self.f64()?,self.f64()?]) }
    fn bounds(&mut self) -> Outcome<Bounds> { Ok(Bounds { min: self.point()?, max: self.point()? }) }
    fn text(&mut self) -> Outcome<String> { let count = self.u32()? as usize; String::from_utf8(self.take(count)?.to_vec()).map_err(|_|"Invalid UTF-8 terrain name".into()) }
    fn ids(&mut self, limit: usize) -> Outcome<Vec<u32>> { let n = self.u32()? as usize; if n > self.data.len().saturating_sub(self.at)/4 { return Err("Truncated id list".into()); } let mut ids = Vec::with_capacity(n); for _ in 0..n { let id = self.u32()?; if id as usize >= limit { return Err("Terrain index out of range".into()); } ids.push(id); } Ok(ids) }
    fn field(&mut self, core: &mut Core) -> Outcome<Field> {
        let source = core.name(self.text()?); let flags = self.u32()?; let support = if flags&4 != 0 { Some(self.bounds()?) } else { None };
        let surface = Surface { kind:if flags&32 != 0 { 2 } else if flags&16 != 0 { 1 } else { 0 },center:if flags&32 != 0 { self.point()? } else { [0.;3] } };
        let materials = if flags&64 != 0 { let mask = self.u32()?; if mask == 0 { return Err("Empty cut material mask".into()); } mask } else { 0 };
        let mut blocks = Vec::new(); let size = if flags&8 != 0 {
            let stored = self.u32()? as usize; if stored > (core.base_count+63)/64 { return Err("Invalid sparse sample count".into()); }
            for _ in 0..(core.base_count+63)/64 { let block = self.u32()?; if block != NONE && block as usize >= stored { return Err("Invalid sparse sample index".into()); } blocks.push(block); }
            stored*64
        } else { core.base_count };
        let bytes = self.take(size.checked_mul(4).ok_or("Sample size overflow")?)?;
        let values: Vec<f32> = bytes.chunks_exact(4).map(|v|f32::from_le_bytes(v.try_into().unwrap())).collect();
        if values.iter().any(|s|!s.is_finite()) { return Err("Non-finite source sample".into()); }
        let samples = SampleWords { values,blocks };
        Ok(Field { source,support,surface,samples,is_static:flags&1 != 0,cut:flags&2 != 0,materials,vertex_mark:0 })
    }
    pub fn finish(&self) -> Outcome<()> { if self.at == self.data.len() { Ok(()) } else { Err("Trailing terrain input".into()) } }
}
pub fn initialize(data: &[u8]) -> Outcome<Core> {
    let mut r = Reader::new(data); if r.u32()? != 2 { return Err("Unsupported terrain ABI".into()); } let mut core = Core::default(); core.canonical_construction = r.u32()? != 0;
    let count = r.u32()?; for _ in 0..count { core.add_base(r.point()?); }
    let count = r.u32()?; for _ in 0..count { core.bricks.push(Brick { name:r.text()?,bounds:r.bounds()?,tets:Vec::new(),fields:Vec::new() }); }
    let count = r.u32()?; for id in 0..count {
        let name = r.text()?; let brick = r.u32()?; let local = r.u32()?; let vertices = [r.u32()?,r.u32()?,r.u32()?,r.u32()?];
        if brick as usize >= core.bricks.len() || vertices.iter().any(|&v|v as usize >= core.base_count) || local as usize != core.bricks[brick as usize].tets.len() { return Err("Invalid lattice tet".into()); }
        core.bricks[brick as usize].tets.push(id); core.tets.push(Tet { name,brick,local,vertices,faces:None });
    }
    let count = r.u32()?; for _ in 0..count { let field = r.field(&mut core)?; core.add_field(field); }
    let count = r.u32()?; for _ in 0..count { let name = r.text()?; let anchor = if r.u32()? != 0 { Some(r.text()?) } else { None }; let material = r.u32()?; let bounds = r.bounds()?; let fields = r.ids(core.fields.len())?; core.sources.push(Source { name,anchor,material,bounds,fields }); }
    r.finish()?; Ok(core)
}
pub fn compile(core: &mut Core, data: &[u8]) -> Outcome<Vec<Page>> {
    let mut r = Reader::new(data); if r.u32()? != 1 { return Err("Unsupported terrain ABI".into()); }
    let truncate = r.u32()? as usize; if truncate > core.fields.len() { return Err("Invalid field rollback".into()); } core.rollback_fields(truncate);
    let count = r.u32()?; for _ in 0..count { let field = r.field(core)?; core.add_field(field); }
    let revision = r.u32()?; let count = r.u32()?; let mut requests = Vec::new();
    for _ in 0..count { let brick = r.u32()?; if brick as usize >= core.bricks.len() { return Err("Unknown brick".into()); } let partial = r.u32()? != 0; let tets = if partial { Some(r.ids(core.bricks[brick as usize].tets.len())?) } else { None }; requests.push(Request { brick,tets }); }
    let count = r.u32()?; let mut masks = Vec::new();
    for _ in 0..count { let tet = r.u32()?; if tet as usize >= core.tets.len() { return Err("Unknown mask tet".into()); } let n = r.u32()?; let mut constraints = Vec::new();
        for _ in 0..n { let sign = r.u32()? as i32; if sign == 0 || sign.unsigned_abs() as usize > core.fields.len() { return Err("Invalid mask constraint".into()); } constraints.push(sign); } masks.push(Mask { tet,constraints });
    }
    r.finish()?; core.compile(requests,revision,masks)
}
pub fn append_fields(core: &mut Core, data: &[u8]) -> Outcome<()> {
    let mut r = Reader::new(data); if r.u32()? != 1 { return Err("Unsupported field ABI".into()); }
    if r.u32()? as usize != core.fields.len() { return Err("Resident field revision mismatch".into()); }
    let count = r.u32()?; for _ in 0..count { let field = r.field(core)?; core.add_field(field); } r.finish()
}
