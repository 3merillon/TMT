//! Experimental batch ABI, not a production terrain compiler. No dependencies or JS callbacks.
//! All buffers live in one instance. Host owns allocation lifetime and validates sizes.
use std::alloc::{alloc_zeroed, dealloc, Layout};

#[no_mangle]
pub extern "C" fn allocate(bytes: usize) -> *mut u8 {
    let layout = Layout::from_size_align(bytes.max(1), 8).unwrap();
    unsafe { alloc_zeroed(layout) }
}

#[no_mangle]
pub unsafe extern "C" fn release(ptr: *mut u8, bytes: usize) {
    dealloc(ptr, Layout::from_size_align(bytes.max(1), 8).unwrap());
}

#[inline(always)]
fn f(x: f64) -> f64 { (x as f32) as f64 }

// Input: n, fa, fb, then four (wa, wb, x, y, z) records. Output: four binary64
// weights, four f32 barycentrics widened to f64, xyz, and the two rounded operands.
#[no_mangle]
pub unsafe extern "C" fn intersections(input: *const f64, output: *mut f64, count: usize) {
    let src = std::slice::from_raw_parts(input, count * 23);
    let dst = std::slice::from_raw_parts_mut(output, count * 13);
    for i in 0..count {
        let a = &src[i * 23..i * 23 + 23];
        let b = &mut dst[i * 13..i * 13 + 13];
        b.fill(0.0);
        let n = a[0] as usize;
        let fa = a[1]; let fb = a[2]; let t = fa / (fa - fb);
        for k in 0..n {
            let w = a[3 + k * 5] * (1.0 - t) + a[4 + k * 5] * t;
            b[k] = w; b[4 + k] = f(w);
        }
        for axis in 0..3 {
            let origin = a[5 + axis]; let mut delta = 0.0;
            for k in 1..n { delta = f(delta + f(f(a[5 + k * 5 + axis] - origin) * b[4 + k])); }
            b[8 + axis] = f(origin + delta);
        }
        b[11] = f(fa); b[12] = f(fb);
    }
}

// Gather the four ORIGINAL f32 samples for each (field, tet), preserving the TS
// classification of zeros. Output bits: 1 = negative, 2 = positive, 3 = crossing.
#[no_mangle]
pub unsafe extern "C" fn classify(samples: *const f32, vertices: *const u32, tasks: *const u32,
                                 output: *mut u32, positions: usize, count: usize) {
    for i in 0..count {
        let field = *tasks.add(i * 2) as usize;
        let tet = *tasks.add(i * 2 + 1) as usize;
        let mut negative = false; let mut positive = false;
        for k in 0..4 {
            let v = *samples.add(field * positions + *vertices.add(tet * 4 + k) as usize);
            negative |= v < 0.0; positive |= v > 0.0;
        }
        *output.add(i) = (negative as u32) | ((positive as u32) << 1);
    }
}
