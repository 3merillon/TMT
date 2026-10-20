//! Flat median BVH construction. Sorting is stable and follows the historical query order,
//! so equal-distance hits and bounded-query overflow retain deterministic tie breaking.
use crate::core::{Outcome, NONE};

pub fn append_bvh(packet: &mut Vec<u8>) -> Outcome<()> {
    let word=|at:usize|u32::from_le_bytes(packet[at..at+4].try_into().unwrap()) as usize;
    let vertices=word(0);let index_count=word(4);let materials=word(8);
    if index_count%3!=0 || materials!=index_count/3 { return Err("Invalid query triangle count".into()); }
    let position_end=16+vertices*12;let index_end=position_end+index_count*4;
    if packet.len()!=index_end+materials*2 { return Err("Invalid query triangle packet".into()); }
    let position=|vertex:usize,axis:usize|f32::from_le_bytes(packet[16+vertex*12+axis*4..20+vertex*12+axis*4].try_into().unwrap()) as f64;
    let index=|at:usize|u32::from_le_bytes(packet[position_end+at*4..position_end+at*4+4].try_into().unwrap()) as usize;
    let count=index_count/3;let mut centers=Vec::with_capacity(count);let mut bounds=Vec::with_capacity(count);
    for face in 0..count { let mut c=[0.;3];let mut b=[0.;6];for a in 0..3 { let x=position(index(face*3),a);let y=position(index(face*3+1),a);let z=position(index(face*3+2),a);c[a]=x+y+z;b[a]=x.min(y).min(z);b[a+3]=x.max(y).max(z); }centers.push(c);bounds.push(b); }
    let mut tree=Tree { centers,bounds,boxes:Vec::new(),skip:Vec::new(),leaf:Vec::new() };let mut faces:Vec<u32>=(0..count as u32).collect();if count>0 { tree.build(&mut faces,0); }
    packet[12..16].copy_from_slice(&(tree.skip.len() as u32).to_le_bytes());while packet.len()%8!=0 { packet.push(0); }
    for b in tree.boxes { for v in b { packet.extend_from_slice(&v.to_le_bytes()); } }
    for v in tree.skip { packet.extend_from_slice(&v.to_le_bytes()); }
    for leaf in tree.leaf { for v in leaf { packet.extend_from_slice(&v.to_le_bytes()); } }
    for v in faces { packet.extend_from_slice(&v.to_le_bytes()); }Ok(())
}
struct Tree { centers:Vec<[f64;3]>,bounds:Vec<[f64;6]>,boxes:Vec<[f64;6]>,skip:Vec<u32>,leaf:Vec<[u32;2]> }
impl Tree {
    fn build(&mut self,list:&mut [u32],from:u32) {
        let node=self.skip.len();let mut b=[f64::INFINITY,f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
        for &face in list.iter() { for a in 0..3 { let v=self.bounds[face as usize];if v[a]<b[a] { b[a]=v[a]; }if v[a+3]>b[a+3] { b[a+3]=v[a+3]; } } }
        self.boxes.push(b);self.skip.push(0);
        if list.len()<=10 { self.leaf.push([from,from+list.len() as u32]); }
        else {
            self.leaf.push([NONE,NONE]);let mut axis=0;for a in 1..3 { if b[a+3]-b[a]>b[axis+3]-b[axis] { axis=a; } }
            list.sort_by(|&a,&b|self.centers[a as usize][axis].partial_cmp(&self.centers[b as usize][axis]).unwrap());
            let middle=list.len()/2;let (left,right)=list.split_at_mut(middle);self.build(left,from);self.build(right,from+middle as u32);
        }
        self.skip[node]=self.skip.len() as u32;
    }
}
