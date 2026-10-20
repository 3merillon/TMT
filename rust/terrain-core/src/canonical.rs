//! Engine v15 canonical binary checksum format. Sections and variable arrays are
//! length framed; numbers are IEEE754 little endian with -0 normalized. This is
//! a replay comparison image, not a deserializable Rapier restore image.
#[derive(Default)]
pub(crate) struct Writer {pub bytes:Vec<u8>}
impl Writer {
    pub fn integer(&mut self,v:u64){self.bytes.extend(v.to_le_bytes());}
    pub fn flag(&mut self,v:bool){self.bytes.push(v as u8);}
    pub fn number(&mut self,v:f64){let bits=if v==0.{0}else if v.is_nan(){0x7ff8000000000000}else{v.to_bits()};self.integer(bits);}
    pub fn words(&mut self,v:&[f64]){self.integer(v.len() as u64);for &x in v{self.number(x);}}
    pub fn text(&mut self,v:&[u16]){self.integer(v.len() as u64);for &x in v{self.bytes.extend(x.to_le_bytes());}}
    pub fn option<T>(&mut self,v:&Option<T>,f:impl FnOnce(&mut Self,&T)){self.flag(v.is_some());if let Some(x)=v{f(self,x);}}
    pub fn list<T>(&mut self,v:&[T],mut f:impl FnMut(&mut Self,&T)){self.integer(v.len() as u64);for x in v{f(self,x);}}
    pub fn section(&mut self,id:u64,f:impl FnOnce(&mut Self)){self.integer(id);let at=self.bytes.len();self.integer(0);let start=self.bytes.len();f(self);let length=(self.bytes.len()-start) as u64;self.bytes[at..at+8].copy_from_slice(&length.to_le_bytes());}
    pub fn hash(&self)->[u32;2]{
        let(mut a,mut b)=(0xdeadbeefu32,0x41c6ce57u32);
        for &c in &self.bytes{a=(a^c as u32).wrapping_mul(2654435761);b=(b^c as u32).wrapping_mul(1597334677);}
        a=(a^(a>>16)).wrapping_mul(2246822507)^(b^(b>>13)).wrapping_mul(3266489909);
        b=(b^(b>>16)).wrapping_mul(2246822507)^(a^(a>>13)).wrapping_mul(3266489909);[b,a]
    }
}
pub(crate) fn text(d:&[f64])->Result<Vec<u16>,String>{
    if d.is_empty()||d[0]<0.||d[0]>1_048_576.||d[0]!=(d.len()-1) as f64||d[1..].iter().any(|&x|!x.is_finite()||x<0.||x>65535.||x.fract()!=0.){return Err("Invalid canonical text".into());}
    Ok(d[1..].iter().map(|&x|x as u16).collect())
}
