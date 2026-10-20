//! Engine v21 resident tread profiles: `sampleTrackTerrain` (src/game/tread-contact.ts) on the composed query world,
//! operation for operation, so the heights and envelopes equal the host's bit for bit. The host keyed its cache on the
//! world revision, the gear and the exact pose; the engine keeps the last profile per unit under the same key. Tread
//! profiles are a presentation sample: they are not part of the canonical image.
use crate::core::Outcome;

/// Per-unit gear words: nine tread stations, half spacing, half track width, the belt's half length.
pub(crate) const GEAR_WORDS: usize = 12;
const BUDGET: f64 = 512.;
const MAX_LINES: usize = 192;
const MAX_BREAKS: usize = 4096;

/// JS Math.min / Math.max: NaN wins, and -0 orders below +0.
pub(crate) fn jmin(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a < b || a == b && a.is_sign_negative() { a } else { b } }
pub(crate) fn jmax(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a > b || a == b && b.is_sign_negative() { a } else { b } }
/// math.ts rotateInto.
fn rotate(vx: f64, vy: f64, vz: f64, q: [f64; 4]) -> [f64; 3] {
    let (qx, qy, qz, qw) = (q[0], q[1], q[2], q[3]);
    let tx = 2. * (qy * vz - qz * vy); let ty = 2. * (qz * vx - qx * vz); let tz = 2. * (qx * vy - qy * vx);
    [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx]
}

#[derive(Default)]
struct Polygons { data: Vec<f64>, first: Vec<usize>, size: Vec<usize>, low: Vec<f64>, high: Vec<f64> }
impl Polygons {
    fn clear(&mut self) { self.data.clear(); self.first.clear(); self.size.clear(); self.low.clear(); self.high.clear(); }
    fn vertices(&self) -> usize { self.data.len() / 3 }
    fn count(&self) -> usize { self.first.len() }
    /// Keep the vertices appended since `from` as a polygon (an empty clip is dropped).
    fn close(&mut self, from: usize) {
        let to = self.vertices(); if to == from { return; }
        self.first.push(from); self.size.push(to - from);
        for axis in 0..3 {
            let (mut lo, mut hi) = (self.data[from * 3 + axis], self.data[from * 3 + axis]);
            for v in from + 1..to { lo = jmin(lo, self.data[v * 3 + axis]); hi = jmax(hi, self.data[v * 3 + axis]); }
            self.low.push(lo); self.high.push(hi);
        }
    }
}
/// One Sutherland–Hodgman pass: the `n` vertices of `src` from vertex `from` against axis·sign ≥ boundary·sign.
fn clip(src: &[f64], from: usize, n: usize, axis: usize, boundary: f64, sign: f64, dst: &mut Polygons) {
    for i in 0..n {
        let a = (from + i) * 3; let b = (from + (i + 1) % n) * 3;
        let da = (src[a + axis] - boundary) * sign; let db = (src[b + axis] - boundary) * sign;
        if da >= -1e-10 { dst.data.extend_from_slice(&src[a..a + 3]); }
        if da < 0. && db > 0. || da > 0. && db < 0. {
            let at = da / (da - db);
            dst.data.extend([src[a] + (src[b] - src[a]) * at, src[a + 1] + (src[b + 1] - src[a + 1]) * at, src[a + 2] + (src[b + 2] - src[a + 2]) * at]);
        }
    }
}
fn slab(src: &[f64], from: usize, n: usize, axis: usize, min: f64, max: f64, via: &mut Polygons, dst: &mut Polygons) {
    via.clear(); clip(src, from, n, axis, min, 1., via); let v = via.vertices(); clip(&via.data, 0, v, axis, max, -1., dst);
}
fn outside(low: f64, high: f64, min: f64, max: f64) -> bool { high - min < -1e-10 || min <= max && low - max > 1e-10 }

fn append(z: f64, y: f64, pz: &mut Vec<f64>, py: &mut Vec<f64>) {
    let n = pz.len();
    if n > 0 && (pz[n - 1] - z).abs() < 1e-9 && (py[n - 1] - y).abs() < 1e-8 { return; }
    if n > 1 && ((py[n - 1] - py[n - 2]) * (z - pz[n - 1]) - (y - py[n - 1]) * (pz[n - 1] - pz[n - 2])).abs() < 1e-9 { pz.pop(); py.pop(); }
    pz.push(z); py.push(y);
}
/// Exact upper envelope of the projected band boundary, as (z, y) pairs, or None past the budget.
fn upper_envelope(p: &Polygons, low: f64, high: f64, floor: f64) -> Option<Vec<f64>> {
    let (mut lo_, mut hi_, mut slope_, mut icpt) = (vec![low], vec![high], vec![0.], vec![floor]);
    let d = &p.data;
    for k in 0..p.count() {
        let (first, n) = (p.first[k], p.size[k]);
        for index in 0..n {
            let a = (first + index) * 3; let b = (first + (index + 1) % n) * 3; let (az, bz) = (d[a + 2], d[b + 2]);
            if (bz - az).abs() < 1e-10 { continue; }
            let lo = jmax(low, jmin(az, bz)); let hi = jmin(high, jmax(az, bz));
            if hi - lo < 1e-10 { continue; }
            if lo_.len() == MAX_LINES { return None; }
            let slope = (d[b + 1] - d[a + 1]) / (bz - az);
            lo_.push(lo); hi_.push(hi); slope_.push(slope); icpt.push(d[a + 1] - slope * az);
        }
    }
    let lines = lo_.len();
    let mut breaks = Vec::with_capacity(lines * 2);
    for i in 0..lines { breaks.push(lo_[i]); breaks.push(hi_[i]); }
    for a in 0..lines { let (lo_a, hi_a) = (lo_[a], hi_[a]); for b in a + 1..lines {
        if lo_[b] >= hi_a || hi_[b] <= lo_a { continue; }
        let lower = jmax(lo_a, lo_[b]) + 1e-9; let upper = jmin(hi_a, hi_[b]) - 1e-9;
        if !(lower < upper) { continue; }
        let slope = slope_[a] - slope_[b];
        if slope.abs() < 1e-10 { continue; }
        let z = (icpt[b] - icpt[a]) / slope;
        if z > lower && z < upper { breaks.push(z); if breaks.len() > MAX_BREAKS { return None; } }
    } }
    // Stable ascending order with -0 equal to +0: the host's sort with its zeros restored to input order.
    breaks.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut order: Vec<usize> = Vec::with_capacity(lines);
    for i in 0..lines { let v = lo_[i]; let mut j = order.len(); order.push(i); while j > 0 && lo_[order[j - 1]] > v { order[j] = order[j - 1]; j -= 1; } order[j] = i; }
    let (mut entered, mut active) = (0, Vec::with_capacity(lines));
    let (mut pz, mut py) = (Vec::new(), Vec::new());
    for index in 0..breaks.len().saturating_sub(1) {
        let (lo, hi) = (breaks[index], breaks[index + 1]);
        if hi - lo < 1e-9 { continue; }
        let mid = (lo + hi) * 0.5;
        while entered < lines && lo_[order[entered]] <= mid { active.push(order[entered]); entered += 1; }
        let (mut winner, mut height) = (0, floor); let mut k = 0;
        while k < active.len() {
            let line = active[k];
            if hi_[line] < mid { active.swap_remove(k); continue; }
            let y = slope_[line] * mid + icpt[line];
            if y > height || y == height && line < winner { height = y; winner = line; }
            k += 1;
        }
        append(lo, slope_[winner] * lo + icpt[winner], &mut pz, &mut py);
        append(hi, slope_[winner] * hi + icpt[winner], &mut pz, &mut py);
    }
    if pz.len() > 128 { return None; }
    Some(pz.iter().zip(&py).flat_map(|(z, y)| [*z, *y]).collect())
}

/// The profile of one unit: [18 heights, n0, (z, y)*n0, n1, (z, y)*n1]. `pose` is position then rotation (x, y, z, w);
/// `gear` is GEAR_WORDS long. `query(op, args)` runs a composed world query and returns its words.
pub(crate) fn profile(pose: &[f64], gear: &[f64], floor: f64, ceiling: f64, query: &mut dyn FnMut(u32, &[f64]) -> Outcome<Vec<f64>>) -> Outcome<Vec<f64>> {
    let stations = &gear[..9]; let (spacing, half_width, end) = (gear[9], gear[10], gear[11]);
    let position = [pose[0], pose[1], pose[2]]; let q = [pose[3], pose[4], pose[5], pose[6]];
    let up = rotate(0., 1., 0., q);
    let mut result = [floor; 18];
    let (mut min, mut max) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for i in 0..2 { for j in 0..2 { for k in 0..2 {
        let c = rotate(if i == 1 { 1. } else { -1. } * (spacing + half_width), if j == 1 { ceiling } else { floor }, if k == 1 { end } else { -end }, q);
        for axis in 0..3 { let corner = position[axis] + c[axis]; min[axis] = jmin(min[axis], corner) - 1e-7; max[axis] = jmax(max[axis], corner) + 1e-7; }
    } } }
    let soup = query(3, &[min[0], min[1], min[2], max[0], max[1], max[2], BUDGET])?;
    let stations_profile = |result: &[f64; 18]| -> Vec<f64> {
        let mut w = result.to_vec(); for side in 0..2 { w.push(9.); for s in 0..9 { w.extend([stations[s], result[side * 9 + s]]); } } w
    };
    if soup[0] == 0. {
        let (mut base, mut clipped, mut band, mut section) = (Polygons::default(), Polygons::default(), Polygons::default(), Polygons::default());
        let inverse = [-q[0], -q[1], -q[2], q[3]];
        let mut tri = [0f64; 9];
        for s in soup[1..].chunks_exact(13) {
            if !(s[9] * up[0] + s[10] * up[1] + s[11] * up[2] > 0.05) { continue; }
            for v in 0..3 { tri[v * 3..v * 3 + 3].copy_from_slice(&rotate(s[v * 3] - position[0], s[v * 3 + 1] - position[1], s[v * 3 + 2] - position[2], inverse)); }
            let y_low = jmin(jmin(tri[1], tri[4]), tri[7]); let y_high = jmax(jmax(tri[1], tri[4]), tri[7]);
            if outside(y_low, y_high, floor, ceiling) { continue; }
            let from = base.vertices(); slab(&tri, 0, 3, 1, floor, ceiling, &mut clipped, &mut base); base.close(from);
        }
        let mut envelopes = Vec::new(); let mut exact = true;
        for side in 0..2 {
            let x = if side == 0 { spacing } else { -spacing }; let (left, right) = (x - half_width, x + half_width);
            band.clear();
            for p in 0..base.count() {
                if outside(base.low[p * 3], base.high[p * 3], left, right) { continue; }
                let from = band.vertices(); slab(&base.data, base.first[p], base.size[p], 0, left, right, &mut clipped, &mut band); band.close(from);
            }
            for station in 0..9 {
                let z = stations[station]; let index = side * 9 + station;
                for p in 0..band.count() {
                    if outside(band.low[p * 3 + 2], band.high[p * 3 + 2], z, z) { continue; }
                    section.clear(); slab(&band.data, band.first[p], band.size[p], 2, z, z, &mut clipped, &mut section);
                    for v in 0..section.vertices() { result[index] = jmax(result[index], section.data[v * 3 + 1]); }
                }
            }
            for station in 0..8 {
                let a = side * 9 + station; let b = a + 1; let (z0, z1) = (stations[station], stations[station + 1]); let span = z1 - z0;
                let (mut raise, mut maximum) = (0f64, jmax(result[a], result[b]));
                for p in 0..band.count() {
                    if outside(band.low[p * 3 + 2], band.high[p * 3 + 2], z0, z1) { continue; }
                    section.clear(); slab(&band.data, band.first[p], band.size[p], 2, z0, z1, &mut clipped, &mut section);
                    let d = &section.data;
                    for v in 0..section.vertices() {
                        let fraction = jmax(0., jmin(1., (d[v * 3 + 2] - z0) / span));
                        raise = jmax(raise, d[v * 3 + 1] - (result[a] * (1. - fraction) + result[b] * fraction));
                        maximum = jmax(maximum, d[v * 3 + 1]);
                    }
                }
                if jmax(result[a], result[b]) + raise > maximum + 1e-8 { result[a] = maximum; result[b] = maximum; } else { result[a] += raise; result[b] += raise; }
            }
            match upper_envelope(&band, -end, end, floor) { Some(e) => envelopes.push(e), None => exact = false }
        }
        if !exact { return Ok(stations_profile(&result)); }
        let mut w = result.to_vec(); for e in envelopes { w.push((e.len() / 2) as f64); w.extend(e); }
        return Ok(w);
    }
    // Bounded centre and width-edge rays when the triangle list overflows.
    let down = [up[0] * -1., up[1] * -1., up[2] * -1.];
    for side in 0..2 { for station in 0..9 { for edge in [-1f64, 0., 1.] {
        let x = if side == 0 { spacing } else { -spacing } + edge * half_width;
        let r = rotate(x, ceiling, stations[station], q); let origin = [position[0] + r[0], position[1] + r[1], position[2] + r[2]];
        let hit = query(0, &[origin[0], origin[1], origin[2], down[0], down[1], down[2], ceiling - floor])?;
        if hit.len() >= 7 && hit[4] * up[0] + hit[5] * up[1] + hit[6] * up[2] > 0.05 {
            let i = side * 9 + station;
            result[i] = jmax(result[i], (hit[1] - position[0]) * up[0] + (hit[2] - position[1]) * up[1] + (hit[3] - position[2]) * up[2]);
        }
    } } }
    Ok(stations_profile(&result))
}
