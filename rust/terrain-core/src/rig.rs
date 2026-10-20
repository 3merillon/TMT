//! Running-gear presentation rig: the belt solver of src/game/kit/belt.ts and `GearRig.pose` of
//! src/game/kit/running.ts, operation for operation, writing the KitPose instance buffers (links, then the wheel
//! buffer in WHEEL_BUFFER_ORDER) as rows of affine 3×4 matrices. Presentation only: never hashed, never replayed.
use crate::core::Outcome;
use crate::tread::{jmax, jmin};
use std::f64::consts::PI;

const MAX_SEGS: usize = 64;
const LINE: u8 = 0; const ARC: u8 = 1; const POLYLINE: u8 = 2;
const BELT_GROUND_CLEARANCE: f64 = 0.029;
const MAX_SAG: f64 = 0.03;

/// geometry/hypot.ts hypot2 (the builtin's max-scaled Kahan sum).
fn hypot2(x: f64, y: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs()); let mut max = 0f64; if ax > max { max = ax; } if ay > max { max = ay; }
    if max == f64::INFINITY { return max; } if x.is_nan() || y.is_nan() { return x + y; } if max == 0. { return max; }
    let (mut sum, mut comp) = (0f64, 0f64);
    for v in [ax, ay] { let n = v / max; let summand = n * n - comp; let pre = sum + summand; comp = (pre - sum) - summand; sum = pre; }
    sum.sqrt() * max
}
fn clamp(v: f64, min: f64, max: f64) -> f64 { jmax(min, jmin(max, v)) }

struct Belt {
    cz: Vec<f64>, cy: Vec<f64>, cr: Vec<f64>, idler: usize, pivot: [f64; 2], travel: f64, rest_angle: f64, arm_length: f64,
    nominal: f64, length: f64, link_reach: f64, slack: f64,
    seg_count: usize, seg_kind: [u8; MAX_SEGS], seg_length: [f64; MAX_SEGS], seg_z: [f64; MAX_SEGS], seg_y: [f64; MAX_SEGS], seg_r: [f64; MAX_SEGS],
    seg_a0: [f64; MAX_SEGS], seg_dz: [f64; MAX_SEGS], seg_dy: [f64; MAX_SEGS], seg_n: [usize; MAX_SEGS], seg_pts: Vec<Vec<f64>>, seg_cum: Vec<Vec<f64>>, cum: [f64; MAX_SEGS + 1],
    epoch: f64, pair_epoch: Vec<f64>, pair_ok: Vec<bool>, pair_d: Vec<f64>, pair_nz: Vec<f64>, pair_ny: Vec<f64>, pair_angle: Vec<f64>,
    chain_circle: [usize; 32], chain_next: [i32; 32], chain_from: [f64; 32], chain_to: [f64; 32], chain_nz: [f64; 32], chain_ny: [f64; 32], chain_count: usize,
    near: Vec<usize>, xs: Vec<f64>, lo: Vec<f64>, hi: Vec<f64>, floor: Vec<f64>, ys: Vec<f64>, vx: Vec<f64>, vy: Vec<f64>, links: Vec<f64>,
}
/// A belt's ground: none, a sorted terrain envelope [(z, y)], or coarse heights at stations.
pub(crate) enum Ground { None, Terrain(Vec<f64>), Coarse(Vec<f64>, Vec<f64>) }
impl Ground {
    fn at(&self, z: f64) -> f64 {
        match self {
            Ground::None => f64::NAN,
            Ground::Terrain(p) => {
                let n = p.len() / 2;
                if z <= p[0] { return p[1]; } if z >= p[(n - 1) * 2] { return p[(n - 1) * 2 + 1]; }
                let mut i = 0; while i + 1 < n - 1 && p[(i + 1) * 2] < z { i += 1; }
                let t = (z - p[i * 2]) / jmax(1e-9, p[(i + 1) * 2] - p[i * 2]);
                p[i * 2 + 1] + (p[(i + 1) * 2 + 1] - p[i * 2 + 1]) * t
            }
            Ground::Coarse(stations, h) => {
                if z <= stations[0] { return h[0]; } if z >= stations[8] { return h[8]; }
                let mut i = 0; while i < 7 && z > stations[i + 1] { i += 1; }
                let t = (z - stations[i]) / (stations[i + 1] - stations[i]);
                h[i] + (h[i + 1] - h[i]) * t
            }
        }
    }
    fn some(&self) -> bool { !matches!(self, Ground::None) }
}

impl Belt {
    fn new(circles: &[[f64; 3]], pivot: [f64; 2], travel: f64) -> Belt {
        let n = circles.len(); let idler = n - 1; let c = circles[idler];
        let mut b = Belt {
            cz: circles.iter().map(|c| c[0]).collect(), cy: circles.iter().map(|c| c[1]).collect(), cr: circles.iter().map(|c| c[2]).collect(), idler, pivot, travel,
            arm_length: hypot2(c[0] - pivot[0], c[1] - pivot[1]), rest_angle: (c[1] - pivot[1]).atan2(c[0] - pivot[0]),
            nominal: 0., length: 0., link_reach: 0., slack: 0.,
            seg_count: 0, seg_kind: [0; MAX_SEGS], seg_length: [0.; MAX_SEGS], seg_z: [0.; MAX_SEGS], seg_y: [0.; MAX_SEGS], seg_r: [0.; MAX_SEGS],
            seg_a0: [0.; MAX_SEGS], seg_dz: [0.; MAX_SEGS], seg_dy: [0.; MAX_SEGS], seg_n: [0; MAX_SEGS], seg_pts: vec![Vec::new(); MAX_SEGS], seg_cum: vec![Vec::new(); MAX_SEGS], cum: [0.; MAX_SEGS + 1],
            epoch: 0., pair_epoch: vec![-1.; n * n], pair_ok: vec![false; n * n], pair_d: vec![0.; n * n], pair_nz: vec![0.; n * n], pair_ny: vec![0.; n * n], pair_angle: vec![0.; n * n],
            chain_circle: [0; 32], chain_next: [0; 32], chain_from: [0.; 32], chain_to: [0.; 32], chain_nz: [0.; 32], chain_ny: [0.; 32], chain_count: 0,
            near: Vec::with_capacity(n), xs: Vec::new(), lo: Vec::new(), hi: Vec::new(), floor: Vec::new(), ys: Vec::new(), vx: Vec::new(), vy: Vec::new(), links: Vec::new(),
        };
        b.place_idler(0.); b.build(&Ground::None); b.nominal = b.length; b
    }
    fn place_idler(&mut self, offset: f64) {
        let a = self.rest_angle - offset / self.arm_length;
        self.cz[self.idler] = self.pivot[0] + a.cos() * self.arm_length; self.cy[self.idler] = self.pivot[1] + a.sin() * self.arm_length;
    }
    fn length_at(&mut self, offset: f64) -> f64 { self.place_idler(offset); self.hull(); self.hull_length() }
    fn update(&mut self, wheels: &[f64], count: usize, ground: &Ground) {
        self.epoch += 1.;
        for i in 0..count { self.cz[i] = wheels[i * 2]; self.cy[i] = wheels[i * 2 + 1]; }
        let (mut lo, mut hi) = (-self.travel, self.travel);
        let at_lo = self.length_at(lo); let at_hi = self.length_at(hi);
        let offset = if at_hi <= self.nominal { hi } else if at_lo >= self.nominal { lo } else {
            for _ in 0..24 { let mid = (lo + hi) / 2.; let m = self.length_at(mid); if m < self.nominal { lo = mid; } else { hi = mid; } if hi - lo < 1e-5 { break; } }
            (lo + hi) / 2.
        };
        self.place_idler(offset); self.build(ground);
    }
    fn wrap(&mut self) -> usize {
        let n = self.cz.len(); let tau = PI * 2.; let (idler, epoch) = (self.idler, self.epoch);
        let mut start = 0; for i in 1..n { if self.cz[i] + self.cr[i] > self.cz[start] + self.cr[start] { start = i; } }
        let (mut i, mut theta, mut count, mut turned) = (start, PI / 2., 0usize, 0f64);
        loop {
            let (mut best, mut best_delta, mut best_dist, mut bz, mut by) = (-1i32, f64::INFINITY, f64::INFINITY, 0., 0.);
            let (az, ay, ar) = (self.cz[i], self.cy[i], self.cr[i]);
            for j in 0..n {
                if j == i { continue; }
                let p = i * n + j; let (d, nz, ny, angle);
                if self.pair_epoch[p] == epoch {
                    if !self.pair_ok[p] { continue; }
                    d = self.pair_d[p]; nz = self.pair_nz[p]; ny = self.pair_ny[p]; angle = self.pair_angle[p];
                } else {
                    let keep = i != idler && j != idler;
                    if keep { self.pair_epoch[p] = epoch; self.pair_ok[p] = false; }
                    let (dz, dy) = (self.cz[j] - az, self.cy[j] - ay);
                    d = hypot2(dz, dy);
                    if d < 1e-9 { continue; }
                    let along = (ar - self.cr[j]) / d;
                    if along.abs() >= 1. { continue; }
                    let perp = (1. - along * along).sqrt();
                    nz = (dz * along - dy * perp) / d; ny = (dy * along + dz * perp) / d; angle = nz.atan2(ny);
                    if keep { self.pair_ok[p] = true; self.pair_d[p] = d; self.pair_nz[p] = nz; self.pair_ny[p] = ny; self.pair_angle[p] = angle; }
                }
                let delta = (((angle - theta) % tau) + tau) % tau;
                if delta < best_delta - 1e-10 || (delta - best_delta).abs() <= 1e-10 && d < best_dist { best = j as i32; best_delta = delta; best_dist = d; bz = nz; by = ny; }
            }
            let to_start = if i == start && count > 0 { (((PI / 2. - theta) % tau) + tau) % tau } else { f64::INFINITY };
            if best < 0 || to_start <= best_delta + 1e-10 || turned + jmin(best_delta, to_start) > tau * 1.5 || count >= 31 {
                self.chain_circle[count] = i; self.chain_from[count] = theta; self.chain_to[count] = theta + if to_start.is_finite() { to_start } else { 0. };
                self.chain_next[count] = -1;
                return count + 1;
            }
            self.chain_circle[count] = i; self.chain_from[count] = theta; self.chain_to[count] = theta + best_delta;
            self.chain_next[count] = best; self.chain_nz[count] = bz; self.chain_ny[count] = by;
            turned += best_delta; count += 1;
            i = best as usize; theta = bz.atan2(by);
        }
    }
    fn hull(&mut self) { self.chain_count = self.wrap(); }
    fn hull_length(&self) -> f64 {
        let mut total = 0.;
        for k in 0..self.chain_count {
            let i = self.chain_circle[k]; total += (self.chain_to[k] - self.chain_from[k]) * self.cr[i];
            let j = self.chain_next[k]; if j < 0 { continue; } let j = j as usize;
            let (nz, ny) = (self.chain_nz[k], self.chain_ny[k]);
            total += hypot2(self.cz[j] + nz * self.cr[j] - self.cz[i] - nz * self.cr[i], self.cy[j] + ny * self.cr[j] - self.cy[i] - ny * self.cr[i]);
        }
        total
    }
    #[allow(clippy::too_many_arguments)]
    fn push_seg(&mut self, at: usize, kind: u8, length: f64, z: f64, y: f64, r: f64, a0: f64, dz: f64, dy: f64) -> usize {
        self.seg_kind[at] = kind; self.seg_length[at] = length; self.seg_z[at] = z; self.seg_y[at] = y; self.seg_r[at] = r; self.seg_a0[at] = a0; self.seg_dz[at] = dz; self.seg_dy[at] = dy; at + 1
    }
    fn polyline(&mut self, at: usize, n: usize) {
        if self.seg_pts[at].len() < (n + 1) * 2 { self.seg_pts[at] = vec![0.; (n + 1) * 4]; self.seg_cum[at] = vec![0.; (n + 1) * 2]; }
        self.seg_n[at] = n;
    }
    fn build(&mut self, ground: &Ground) {
        self.hull();
        let mut count = 0;
        for k in 0..self.chain_count {
            let i = self.chain_circle[k]; let sweep = self.chain_to[k] - self.chain_from[k];
            if sweep * self.cr[i] > 1e-9 { count = self.push_seg(count, ARC, sweep * self.cr[i], self.cz[i], self.cy[i], self.cr[i], self.chain_from[k], 0., 0.); }
            let j = self.chain_next[k]; if j < 0 { continue; } let j = j as usize;
            let (nz, ny) = (self.chain_nz[k], self.chain_ny[k]);
            let (z0, y0, z1, y1) = (self.cz[i] + nz * self.cr[i], self.cy[i] + ny * self.cr[i], self.cz[j] + nz * self.cr[j], self.cy[j] + ny * self.cr[j]);
            let l = hypot2(z1 - z0, y1 - y0);
            if l > 1e-9 { count = self.push_seg(count, LINE, l, z0, y0, 0., 0., (z1 - z0) / l, (y1 - y0) / l); }
        }
        self.seg_count = count;
        let mut total = 0.; for i in 0..count { total += self.seg_length[i]; }
        self.slack = if self.nominal > 0. { self.nominal - total } else { 0. };
        if self.slack > 1e-5 { self.sag(self.slack); }
        if ground.some() { self.lift_ground(ground); }
        self.cum[0] = 0.; for i in 0..count { self.cum[i + 1] = self.cum[i] + self.seg_length[i]; }
        self.length = self.cum[count];
    }
    fn support_at(&self, z: f64) -> f64 {
        let mut best = f64::NEG_INFINITY;
        for k in 0..self.cz.len() { let dz = z - self.cz[k]; if dz.abs() < self.cr[k] { best = jmax(best, self.cy[k] + (self.cr[k] * self.cr[k] - dz * dz).sqrt()); } }
        best
    }
    fn sag(&mut self, slack: f64) {
        let count = self.seg_count; let mut total = 0.;
        for i in 0..count { if self.seg_kind[i] == LINE && self.seg_dz[i] > 0.5 { total += self.seg_length[i]; } }
        if total <= 0. { return; }
        for i in 0..count {
            if self.seg_kind[i] != LINE || !(self.seg_dz[i] > 0.5) { continue; }
            let (len, sz, sy, sdz, sdy) = (self.seg_length[i], self.seg_z[i], self.seg_y[i], self.seg_dz[i], self.seg_dy[i]);
            let share = slack * len / total;
            let depth = jmin(MAX_SAG, (3. * len * share / 8.).sqrt());
            let n = jmax(12., (len / 0.01).ceil()) as usize; self.polyline(i, n);
            self.seg_cum[i][0] = 0.;
            for k in 0..=n {
                let t = k as f64 / n as f64; let z = sz + sdz * len * t; let y_line = sy + sdy * len * t;
                let mut y = y_line - depth * 4. * t * (1. - t);
                if k > 0 && k < n { y = jmin(y_line, jmax(y, self.support_at(z))); }
                let pts = &mut self.seg_pts[i]; pts[k * 2] = z; pts[k * 2 + 1] = y;
                if k > 0 { let step = hypot2(z - pts[k * 2 - 2], y - pts[k * 2 - 1]); let cum = &mut self.seg_cum[i]; cum[k] = cum[k - 1] + step; }
            }
            self.seg_kind[i] = POLYLINE; self.seg_length[i] = self.seg_cum[i][n];
        }
    }
    fn lift_ground(&mut self, ground: &Ground) {
        for i in 0..self.seg_count {
            if self.seg_kind[i] != LINE || self.seg_dz[i] > -0.5 { continue; }
            let (len, sz, sy, sdz, sdy) = (self.seg_length[i], self.seg_z[i], self.seg_y[i], self.seg_dz[i], self.seg_dy[i]);
            let n = jmax(12., (len / 0.01).ceil()) as usize;
            if self.xs.len() < n + 1 { for v in [&mut self.xs, &mut self.lo, &mut self.hi, &mut self.ys, &mut self.floor] { *v = vec![0.; n * 2 + 2]; } }
            let mut rises = false;
            for k in 1..n {
                let t = k as f64 / n as f64; let z = sz + sdz * len * t; let y = sy + sdy * len * t;
                self.floor[k] = ground.at(z) + BELT_GROUND_CLEARANCE;
                if self.floor[k] > y + 1e-6 { rises = true; }
            }
            if !rises { continue; }
            let step = len / n as f64; let reach = (self.link_reach / (sdz * step).abs() - 1e-9).ceil();
            self.near_circles(sz, sz + sdz * len, self.link_reach + (sdz * step).abs() * reach.abs());
            let mut lifted = false;
            for k in 0..=n {
                let t = k as f64 / n as f64; let z = sz + sdz * len * t; let y = sy + sdy * len * t;
                self.xs[k] = len * t;
                if k == 0 || k == n { self.lo[k] = y; self.hi[k] = y; continue; }
                let mut c = jmin(self.ceiling_at(z - self.link_reach), self.ceiling_at(z + self.link_reach));
                let mut j = -reach; while j <= reach { c = jmin(c, self.ceiling_at(z + sdz * step * j)); j += 1.; }
                self.hi[k] = jmax(y, jmin(c, y + 1.));
                self.lo[k] = jmin(self.floor[k], self.hi[k]);
                if self.lo[k] > y + 1e-6 { lifted = true; }
            }
            if !lifted { continue; }
            self.taut(n);
            self.polyline(i, n);
            self.seg_cum[i][0] = 0.;
            for k in 0..=n {
                let pts = &mut self.seg_pts[i]; pts[k * 2] = sz + sdz * self.xs[k]; pts[k * 2 + 1] = self.ys[k];
                if k > 0 { let step = hypot2(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1]); let cum = &mut self.seg_cum[i]; cum[k] = cum[k - 1] + step; }
            }
            self.seg_kind[i] = POLYLINE; self.seg_length[i] = self.seg_cum[i][n];
        }
    }
    fn near_circles(&mut self, za: f64, zb: f64, margin: f64) {
        let lo = jmin(za, zb) - margin - 1e-6; let hi = jmax(za, zb) + margin + 1e-6;
        self.near.clear();
        for k in 0..self.cz.len() { if !(lo <= hi) || self.cz[k] + self.cr[k] >= lo && self.cz[k] - self.cr[k] <= hi { self.near.push(k); } }
    }
    fn ceiling_at(&self, z: f64) -> f64 {
        let mut best = f64::INFINITY;
        for &k in &self.near { let dz = z - self.cz[k]; if dz.abs() < self.cr[k] { best = jmin(best, self.cy[k] - (self.cr[k] * self.cr[k] - dz * dz).sqrt()); } }
        best
    }
    /// belt.ts taut(): the taut string through the corridor xs/lo/hi[0..=n] into ys.
    fn taut(&mut self, n: usize) {
        let (x, lo, hi) = (&self.xs, &self.lo, &self.hi);
        let area = |ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64| (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        let (vx, vy) = (&mut self.vx, &mut self.vy); vx.clear(); vy.clear();
        vx.push(x[0]); vy.push(lo[0]);
        let (mut ai, mut ay, mut li, mut ly, mut ui, mut uy) = (0usize, lo[0], 0usize, lo[0], 0usize, lo[0]);
        let mut i = 1;
        while i <= n {
            let ax = x[ai];
            if li == ai || area(ax, ay, x[li], ly, x[i], lo[i]) >= 0. {
                if ui == ai || area(ax, ay, x[ui], uy, x[i], lo[i]) < 0. { li = i; ly = lo[i]; }
                else { ai = ui; ay = uy; vx.push(x[ai]); vy.push(ay); li = ai; ui = ai; ly = ay; uy = ay; i = ai + 1; continue; }
            }
            if ui == ai || area(ax, ay, x[ui], uy, x[i], hi[i]) <= 0. {
                if li == ai || area(ax, ay, x[li], ly, x[i], hi[i]) > 0. { ui = i; uy = hi[i]; }
                else { ai = li; ay = ly; vx.push(x[ai]); vy.push(ay); li = ai; ui = ai; ly = ay; uy = ay; i = ai + 1; continue; }
            }
            i += 1;
        }
        vx.push(x[n]); vy.push(lo[n]);
        let m = vx.len(); let mut v = 0;
        for k in 0..=n {
            while v + 2 < m && vx[v + 1] <= x[k] { v += 1; }
            let t = (x[k] - vx[v]) / jmax(1e-12, vx[v + 1] - vx[v]);
            self.ys[k] = vy[v] + (vy[v + 1] - vy[v]) * if t < 0. { 0. } else if t > 1. { 1. } else { t };
        }
    }
    fn point(&self, distance: f64) -> (f64, f64) {
        let l = self.length; let d = ((distance % l) + l) % l;
        let (mut lo, mut hi) = (0usize, self.seg_count);
        while hi - lo > 1 { let mid = (lo + hi) >> 1; if self.cum[mid] <= d { lo = mid; } else { hi = mid; } }
        let r = d - self.cum[lo];
        match self.seg_kind[lo] {
            ARC => { let a = self.seg_a0[lo] + r / self.seg_r[lo]; (self.seg_z[lo] + a.sin() * self.seg_r[lo], self.seg_y[lo] + a.cos() * self.seg_r[lo]) }
            LINE => (self.seg_z[lo] + self.seg_dz[lo] * r, self.seg_y[lo] + self.seg_dy[lo] * r),
            _ => {
                let (cum, pts, n) = (&self.seg_cum[lo], &self.seg_pts[lo], self.seg_n[lo]);
                let mut k = 0;
                if cum[n] - cum[n] == 0. { let mut hk = n - 1; while k < hk { let mid = (k + hk) >> 1; if cum[mid + 1] < r { k = mid + 1; } else { hk = mid; } } }
                else { while k + 1 < n && cum[k + 1] < r { k += 1; } }
                let u = (r - cum[k]) / jmax(1e-12, cum[k + 1] - cum[k]); let t = if u < 0. { 0. } else if u > 1. { 1. } else { u };
                let (z0, y0) = (pts[k * 2], pts[k * 2 + 1]);
                (z0 + (pts[k * 2 + 2] - z0) * t, y0 + (pts[k * 2 + 3] - y0) * t)
            }
        }
    }
    /// The seats (y, z, angle) of `count` links into self.links.
    fn seat_links(&mut self, phase: f64, count: usize, half_shoe: f64) {
        self.links.resize(count * 3, 0.);
        for i in 0..count {
            let distance = (i as f64 / count as f64 + phase / self.nominal) * self.length;
            let (oz, oy) = self.point(distance); let (bz, by) = self.point(distance - half_shoe); let (az, ay) = self.point(distance + half_shoe);
            let (dz, dy) = (az - bz, ay - by); let o = i * 3;
            self.links[o + 2] = (-dy).atan2(dz);
            let (mz, my) = ((az + bz) / 2. - oz, (ay + by) / 2. - oy);
            if mz * -dy + my * dz > 0. { self.links[o + 1] = oz + mz; self.links[o] = oy + my; } else { self.links[o + 1] = oz; self.links[o] = oy; }
        }
    }
}

type M = [f64; 16];
fn identity() -> M { let mut m = [0.; 16]; m[0] = 1.; m[5] = 1.; m[10] = 1.; m[15] = 1.; m }
fn translate(x: f64, y: f64, z: f64) -> M { let mut m = identity(); m[12] = x; m[13] = y; m[14] = z; m }
fn rot_x(a: f64) -> M { let (c, s) = (a.cos(), a.sin()); let mut m = identity(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; m }
fn rot_y(a: f64) -> M { let (c, s) = (a.cos(), a.sin()); let mut m = identity(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; m }
fn rot_z(a: f64) -> M { let (c, s) = (a.cos(), a.sin()); let mut m = identity(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; m }
fn scale(x: f64, y: f64, z: f64) -> M { let mut m = identity(); m[0] = x; m[5] = y; m[10] = z; m }
fn mul(a: &M, b: &M) -> M {
    let mut o = [0.; 16];
    for c in 0..4 { let (b0, b1, b2, b3) = (b[c * 4], b[c * 4 + 1], b[c * 4 + 2], b[c * 4 + 3]);
        for r in 0..4 { o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3; } }
    o
}
fn put(out: &mut [f64], index: usize, m: &M) {
    let o = index * 12;
    out[o..o + 12].copy_from_slice(&[m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]]);
}

#[derive(Clone, Copy, PartialEq)]
enum Suspension { Torsion, Bogie, Rocker }
struct Wheel { station: usize, dz: f64, dx: f64, radius: f64 }
pub(crate) struct Rig {
    suspension: Suspension, half_spacing: f64, wheel_y0: f64, arm_length: f64, rocker_half: f64, wheel_radius: f64, spring_top: f64,
    wheels: Vec<Wheel>, rollers: Vec<[f64; 3]>, sprocket: [f64; 3], idler: [f64; 3], tensioner: [f64; 2], z: [f64; 4],
    link_count: usize, pitch: f64, link_fraction: f64, belts: [Belt; 2], centres: Vec<f64>, flip_y: M, flip_z: M,
    /// Instance offsets in the wheel buffer (WHEEL_BUFFER_ORDER) and the total instance count.
    at_sprockets: usize, at_idlers: usize, at_rollers: usize, at_arms: usize, at_bogies: usize, at_springs: usize, at_tensioners: usize, wheel_instances: usize,
}
impl Rig {
    /// Words: [suspension (0 torsion, 1 bogie, 2 rocker), halfLength, wheelY0, armLength, rockerHalf, wheelRadius, halfSpacing,
    /// springTop, tensioner dz, dy, travel, idler z y r, sprocket z y r, belt shoe, link fraction, reach clearance, link count,
    /// wheels W, (station, dz, dx, radius)*W, rollers R, (z, y, r)*R].
    pub(crate) fn new(d: &[f64]) -> Outcome<Rig> {
        let invalid = || "Invalid gear rig".to_string();
        if d.len() < 23 || d.iter().any(|x| !x.is_finite()) { return Err(invalid()); }
        let suspension = match d[0] as i32 { 0 => Suspension::Torsion, 1 => Suspension::Bogie, 2 => Suspension::Rocker, _ => return Err(invalid()) };
        let nw = d[21] as usize; let rollers_at = 22 + nw * 4;
        if d[21].fract() != 0. || d.len() <= rollers_at || nw != match suspension { Suspension::Torsion => 4, Suspension::Bogie => 4, Suspension::Rocker => 8 } { return Err(invalid()); }
        let nr = d[rollers_at] as usize; if d[rollers_at].fract() != 0. || d.len() != rollers_at + 1 + nr * 3 || d[20] < 2. || d[20].fract() != 0. { return Err(invalid()); }
        let wheels: Vec<Wheel> = d[22..rollers_at].chunks_exact(4).map(|w| Wheel { station: w[0] as usize, dz: w[1], dx: w[2], radius: w[3] }).collect();
        if wheels.iter().any(|w| w.station > 3) { return Err(invalid()); }
        let rollers: Vec<[f64; 3]> = d[rollers_at + 1..].chunks_exact(3).map(|r| [r[0], r[1], r[2]]).collect();
        let half_length = d[1]; let z = [0, 1, 2, 3].map(|i| (i as f64 / 3. * 2. - 1.) * half_length);
        let (wheel_y0, wheel_radius, shoe) = (d[2], d[5], d[17]);
        let mut circles: Vec<[f64; 3]> = wheels.iter().map(|w| [z[w.station] + w.dz, wheel_y0 - (wheel_radius - w.radius), w.radius + shoe]).collect();
        circles.extend(&rollers); circles.push([d[14], d[15], d[16]]); circles.push([d[11], d[12], d[13]]);
        let pivot = [d[11] + d[8], d[12] + d[9]];
        let mut belts = [Belt::new(&circles, pivot, d[10]), Belt::new(&circles, pivot, d[10])];
        let link_count = d[20] as usize; let nominal = belts[0].nominal;
        for b in &mut belts { b.link_reach = nominal / link_count as f64 * d[18] * 0.5 + d[19]; }
        let counts = [nw * 2, 2, 2, nr * 2, if suspension == Suspension::Bogie { 0 } else { 8 }, match suspension { Suspension::Torsion => 0, Suspension::Bogie => 4, Suspension::Rocker => 8 },
            if suspension == Suspension::Bogie { 4 } else { 0 }, 2];
        let mut at = [0usize; 9]; for k in 0..8 { at[k + 1] = at[k] + counts[k]; }
        Ok(Rig { suspension, half_spacing: d[6], wheel_y0, arm_length: d[3], rocker_half: d[4], wheel_radius, spring_top: d[7], wheels, rollers,
            sprocket: [d[14], d[15], d[16]], idler: [d[11], d[12], d[13]], tensioner: [d[8], d[9]], z, link_count, pitch: nominal / link_count as f64, link_fraction: d[18],
            belts, centres: vec![0.; nw * 2], flip_y: rot_y(PI), flip_z: rot_z(PI),
            at_sprockets: at[1], at_idlers: at[2], at_rollers: at[3], at_arms: at[4], at_bogies: at[5], at_springs: at[6], at_tensioners: at[7], wheel_instances: at[8] })
    }
    fn hub_drop(&self, w: &Wheel) -> f64 { self.wheel_radius - w.radius }
    fn wheel_centres(&mut self, y: &[f64]) {
        let (z, out) = (self.z, &mut self.centres);
        match self.suspension {
            Suspension::Torsion => for i in 0..4 { let a = clamp((y[i] - self.wheel_y0) / self.arm_length, -1., 1.).asin(); out[i * 2] = z[i] + self.arm_length * (1. - a.cos()); out[i * 2 + 1] = y[i]; },
            Suspension::Bogie => for b in 0..2 {
                let (ya, yc) = (y[b * 2], y[b * 2 + 1]); let zb = (z[b * 2] + z[b * 2 + 1]) / 2.; let yb = (ya + yc) / 2.; let h = self.rocker_half;
                let s = clamp((yc - ya) / (2. * h), -1., 1.); let c = (1. - s * s).sqrt();
                out[b * 4] = zb - h * c; out[b * 4 + 1] = yb - h * s; out[b * 4 + 2] = zb + h * c; out[b * 4 + 3] = yb + h * s;
            },
            Suspension::Rocker => for i in 0..4 {
                let a = clamp((y[i] - self.wheel_y0) / self.arm_length, -1., 1.).asin(); let zi = z[i] + self.arm_length * (1. - a.cos());
                out[i * 4] = zi - self.rocker_half; out[i * 4 + 1] = y[i]; out[i * 4 + 2] = zi + self.rocker_half; out[i * 4 + 3] = y[i];
            },
        }
        for i in 0..self.wheels.len() { out[i * 2 + 1] -= self.wheel_radius - self.wheels[i].radius; }
    }
    fn turned(&self, sx: f64, x: f64, y: f64, zz: f64, spin: f64) -> M { let a = translate(x, y, zz); if sx > 0. { mul(&a, &rot_x(spin)) } else { mul(&a, &mul(&rot_x(spin), &self.flip_y)) } }
    fn hinged(&self, sx: f64, x: f64, y: f64, zz: f64, angle: f64) -> M { let a = translate(x, y, zz); if sx > 0. { mul(&a, &rot_x(angle)) } else { mul(&a, &mul(&self.flip_z, &rot_x(-angle))) } }
    pub(crate) fn instances(&self) -> (usize, usize) { (self.link_count * 2, self.wheel_instances) }
    /// Pose both sides into `links` and `wheels` (12 words per instance). `sides[s]` is the TankState side s (0 = +X):
    /// four station heights, the belt phase and its ground.
    pub(crate) fn pose(&mut self, arm_x: f64, rock_x: f64, sides: &[([f64; 4], f64, Ground); 2], links: &mut [f64], wheels: &mut [f64]) {
        let (c, z, nw, nr, n) = (self.half_spacing, self.z, self.wheels.len(), self.rollers.len(), self.link_count);
        for mesh_side in 0..2usize {
            let sx = if mesh_side == 0 { -1. } else { 1. }; let input = &sides[if sx > 0. { 0 } else { 1 }];
            self.wheel_centres(&input.0);
            let centres = std::mem::take(&mut self.centres);
            self.belts[mesh_side].update(&centres, nw, &input.2);
            let half_shoe = self.pitch * self.link_fraction * 0.5;
            self.belts[mesh_side].seat_links(input.1, n, half_shoe);
            let even = n.div_ceil(2); let odd = n - even;
            for i in 0..n {
                let s = &self.belts[mesh_side].links[i * 3..i * 3 + 3];
                let slot = if i % 2 == 0 { mesh_side * even + i / 2 } else { 2 * even + mesh_side * odd + (i - 1) / 2 };
                put(links, slot, &mul(&translate(sx * c, s[0], s[1]), &rot_x(s[2])));
            }
            for i in 0..nw {
                let w = &self.wheels[i]; let m = self.turned(sx, sx * (c + w.dx), centres[i * 2 + 1], centres[i * 2], input.1 / w.radius);
                put(wheels, mesh_side * nw + i, &m);
            }
            self.centres = centres;
            for i in 0..nr { let r = self.rollers[i]; put(wheels, self.at_rollers + mesh_side * nr + i, &self.turned(sx, sx * c, r[1], r[0], input.1 / r[2])); }
            put(wheels, self.at_sprockets + mesh_side, &self.turned(sx, sx * c, self.sprocket[1], self.sprocket[0], input.1 / self.sprocket[2]));
            let (iz, iy) = (self.belts[mesh_side].cz[self.belts[mesh_side].idler], self.belts[mesh_side].cy[self.belts[mesh_side].idler]);
            put(wheels, self.at_idlers + mesh_side, &self.turned(sx, sx * c, iy, iz, input.1 / self.idler[2]));
            let (pz, py) = (self.idler[0] + self.tensioner[0], self.idler[1] + self.tensioner[1]);
            put(wheels, self.at_tensioners + mesh_side, &self.hinged(sx, sx * arm_x, py, pz, (iy - py).atan2(-(iz - pz))));
            let y = &input.0;
            if self.suspension != Suspension::Bogie {
                for i in 0..4 {
                    let a = clamp((y[i] - self.wheel_y0) / self.arm_length, -1., 1.).asin();
                    let w = &self.wheels[if self.suspension == Suspension::Torsion { i } else { i * 2 }];
                    put(wheels, self.at_arms + mesh_side * 4 + i, &self.hinged(sx, sx * arm_x, self.wheel_y0 - self.hub_drop(w), z[i] + self.arm_length, a));
                }
            }
            if self.suspension == Suspension::Bogie {
                for b in 0..2 {
                    let (ya, yc) = (y[b * 2], y[b * 2 + 1]); let zb = (z[b * 2] + z[b * 2 + 1]) / 2.; let yb = (ya + yc) / 2.;
                    let tilt = clamp((yc - ya) / (2. * self.rocker_half), -1., 1.).asin();
                    put(wheels, self.at_bogies + mesh_side * 2 + b, &self.hinged(sx, sx * rock_x, yb, zb, -tilt));
                    let bottom = yb + 0.03; let length = jmax(0.01, self.spring_top - bottom);
                    let m = mul(&translate(sx * rock_x, bottom, zb), &scale(1., length, 1.));
                    put(wheels, self.at_springs + mesh_side * 2 + b, &if sx > 0. { m } else { mul(&m, &self.flip_y) });
                }
            } else if self.suspension == Suspension::Rocker {
                for i in 0..4 {
                    let a = clamp((y[i] - self.wheel_y0) / self.arm_length, -1., 1.).asin(); let zi = z[i] + self.arm_length * (1. - a.cos());
                    put(wheels, self.at_bogies + mesh_side * 4 + i, &self.hinged(sx, sx * rock_x, y[i], zi, 0.));
                }
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct Rigs { rigs: std::collections::HashMap<u32, Rig>, next: u32 }
impl Rigs {
    pub(crate) fn create(&mut self, d: &[f64]) -> Outcome<u32> { let rig = Rig::new(d)?; self.next += 1; self.rigs.insert(self.next, rig); Ok(self.next) }
    pub(crate) fn remove(&mut self, id: u32) { self.rigs.remove(&id); }
    pub(crate) fn get(&mut self, id: u32) -> Outcome<&mut Rig> { self.rigs.get_mut(&id).ok_or_else(|| "Unknown gear rig".into()) }
}
/// Pose input [armX, rockX, then per TankState side: y0..y3, phase, ground mode (0 none, 1 terrain: n, (z, y)*n; 2 coarse:
/// n, heights*n, stations*n)]. Output: link instances then wheel-buffer instances, 12 words each.
pub(crate) fn pose(rig: &mut Rig, d: &[f64], out: &mut Vec<u8>) -> Outcome<()> {
    let invalid = || "Invalid gear rig pose".to_string();
    if d.len() < 2 { return Err(invalid()); }
    let mut at = 2; let mut sides: Vec<([f64; 4], f64, Ground)> = Vec::with_capacity(2);
    for _ in 0..2 {
        let head = d.get(at..at + 6).ok_or_else(invalid)?; let y = [head[0], head[1], head[2], head[3]]; let phase = head[4]; at += 6;
        let ground = match head[5] as i32 {
            0 => Ground::None,
            1 => { let n = *d.get(at).ok_or_else(invalid)? as usize; if n == 0 { return Err(invalid()); } let p = d.get(at + 1..at + 1 + n * 2).ok_or_else(invalid)?.to_vec(); at += 1 + n * 2; Ground::Terrain(p) }
            2 => { let n = *d.get(at).ok_or_else(invalid)? as usize; if n != 9 { return Err(invalid()); } let h = d.get(at + 1..at + 10).ok_or_else(invalid)?.to_vec(); let s = d.get(at + 10..at + 19).ok_or_else(invalid)?.to_vec(); at += 19; Ground::Coarse(s, h) }
            _ => return Err(invalid()),
        };
        sides.push((y, phase, ground));
    }
    if at != d.len() { return Err(invalid()); }
    let sides: [([f64; 4], f64, Ground); 2] = sides.try_into().map_err(|_| invalid())?;
    let (l, w) = rig.instances(); let mut links = vec![0.; l * 12]; let mut wheels = vec![0.; w * 12];
    rig.pose(d[0], d[1], &sides, &mut links, &mut wheels);
    out.clear(); for x in links.iter().chain(&wheels) { out.extend_from_slice(&x.to_le_bytes()); }
    Ok(())
}
