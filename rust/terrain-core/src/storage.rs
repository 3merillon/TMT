use std::hash::{BuildHasherDefault, Hasher};
pub type Map<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<NumericHash>>;

#[derive(Default)]
pub struct NumericHash(u64);
impl Hasher for NumericHash {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for chunk in &mut chunks { self.write_u64(u64::from_le_bytes(chunk.try_into().unwrap())); }
        let rest = chunks.remainder(); if !rest.is_empty() { let mut tail = [0;8]; tail[..rest.len()].copy_from_slice(rest); self.write_u64(u64::from_le_bytes(tail)); }
        self.write_usize(bytes.len());
    }
    fn write_u32(&mut self, v: u32) { self.write_u64(v as u64); }
    fn write_usize(&mut self, v: usize) { self.write_u64(v as u64); }
    fn write_u64(&mut self, v: u64) { self.0 = (self.0.rotate_left(5)^v).wrapping_mul(0x517cc1b727220a95); }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Span { pub start: u32, pub len: u32 }
impl Span {
    pub fn range(self) -> std::ops::Range<usize> { self.start as usize..(self.start + self.len) as usize }
}
pub fn append<T: Copy>(arena: &mut Vec<T>, values: &[T]) -> Span {
    let span = Span { start: arena.len() as u32, len: values.len() as u32 };
    arena.extend_from_slice(values); span
}

/// Most polygons have 3..8 vertices. No allocator call for ordinary clipping lists.
#[derive(Clone)]
pub struct Ids { local: [u32; 32], spill: Vec<u32>, len: usize }
impl Default for Ids { fn default() -> Self { Self { local: [0; 32], spill: Vec::new(), len: 0 } } }
impl Ids {
    pub fn from(values: &[u32]) -> Self { let mut v = Self::default(); for &id in values { v.push(id); } v }
    pub fn push(&mut self, id: u32) {
        if self.len < 32 { self.local[self.len] = id; }
        else { if self.len == 32 { self.spill.extend_from_slice(&self.local); } self.spill.push(id); }
        self.len += 1;
    }
    pub fn slice(&self) -> &[u32] { if self.len <= 32 { &self.local[..self.len] } else { &self.spill } }
    pub fn slice_mut(&mut self) -> &mut [u32] { if self.len <= 32 { &mut self.local[..self.len] } else { &mut self.spill } }
    pub fn unique(&mut self) {
        let old = self.clone(); self.len = 0; self.spill.clear();
        for &id in old.slice() { if !self.slice().contains(&id) { self.push(id); } }
    }
}

/// Full-key equality is checked by the owner. Slots contain arena indices, never allocated key objects.
#[derive(Default)]
pub struct IndexTable { slots: Vec<u32>, hashes: Vec<u64>, count: usize }
impl IndexTable {
    pub fn find(&self, hash: u64, same: impl Fn(u32) -> bool) -> Option<u32> {
        if self.slots.is_empty() { return None; }
        let mut at = hash as usize & (self.slots.len() - 1);
        loop {
            let value = self.slots[at];
            if value == 0 { return None; }
            if self.hashes[at] == hash && same(value - 1) { return Some(value - 1); }
            at = (at + 1) & (self.slots.len() - 1);
        }
    }
    pub fn insert(&mut self, hash: u64, id: u32) {
        if self.slots.is_empty() || (self.count + 1) * 10 >= self.slots.len() * 7 {
            let size = (self.slots.len() * 2).max(1024);
            let old = std::mem::replace(&mut self.slots, vec![0; size]);
            let hashes = std::mem::replace(&mut self.hashes, vec![0; size]); self.count = 0;
            for (at, value) in old.into_iter().enumerate() { if value != 0 { self.insert(hashes[at], value - 1); } }
        }
        let mut at = hash as usize & (self.slots.len() - 1);
        while self.slots[at] != 0 { at = (at + 1) & (self.slots.len() - 1); }
        self.slots[at] = id + 1; self.hashes[at] = hash; self.count += 1;
    }
    pub fn clear(&mut self) { self.slots.fill(0); self.count = 0; }
}
pub fn key_hash(first: &[u32], second: &[u32]) -> u64 {
    let mut h = 0x9e3779b97f4a7c15u64;
    for &x in first.iter().chain(std::iter::once(&(first.len() as u32))).chain(second) {
        h ^= x as u64; h = h.wrapping_mul(0x100000001b3); h ^= h >> 29;
    }
    h ^ (second.len() as u64).wrapping_mul(0x85ebca6b)
}
