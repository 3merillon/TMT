//! Bounded, deterministic realtime tactics and locomotion. The host provides ONLY team observations.
//! No clock, allocation, hidden enemy positions or random damage. ABI 4: 2048 f64 scratch words.
type V = [f64; 3];
static mut WORDS: [f64; 2048] = [0.0; 2048];
fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, s: f64) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn len(a: V) -> f64 {
    dot(a, a).sqrt()
}
fn norm(a: V) -> V {
    let l = len(a);
    if l > 1e-10 {
        mul(a, 1.0 / l)
    } else {
        [0.0, 1.0, 0.0]
    }
}
fn cross(a: V, b: V) -> V {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn get(w: &[f64], i: usize) -> V {
    [w[i], w[i + 1], w[i + 2]]
}
fn put(w: &mut [f64], i: usize, v: V) {
    w[i..i + 3].copy_from_slice(&v);
}
fn offset(from: V, toward: V, angle: f64, distance: f64) -> V {
    let up = norm(from);
    let d = sub(toward, from);
    let ahead = norm(sub(d, mul(up, dot(d, up))));
    let side = add(mul(ahead, angle.cos()), mul(cross(up, ahead), angle.sin()));
    let radius = len(from).max(1.0);
    let a = distance / radius;
    mul(norm(add(mul(up, a.cos()), mul(side, a.sin()))), radius)
}
#[no_mangle]
pub extern "C" fn rt_abi() -> u32 {
    4
}
#[no_mangle]
pub extern "C" fn rt_buffer() -> *mut f64 {
    std::ptr::addr_of_mut!(WORDS).cast()
}

/// in: role,tick,reaction,ready,self xyz,health ratio,leader-present,leader xyz,
/// target-id,contact-since,contact-count,seeded-side,lead-factor. Contacts at 32: id,xyz,velocity,visible,age.
/// out at 1536: goal-present,goal xyz,reverse,face-present,face xyz,fire,lob,target-id,since.
pub fn decide(w: &mut [f64]) {
    w[1536..1568].fill(0.0);
    w[1547] = -1.0;
    let role = w[0] as u32;
    if role == 0 || role == 1 {
        return;
    }
    let p = get(w, 4);
    let tick = w[1];
    let count = (w[14] as usize).min(128);
    let mut best = None;
    let mut score = f64::INFINITY;
    for i in 0..count {
        let k = 32 + i * 9;
        let visible = w[k + 7] > 0.0;
        let age = w[k + 8];
        if !age.is_finite() || age < 0.0 {
            continue;
        }
        let distance = len(sub(get(w, k + 1), p));
        let s = distance + if visible { 0.0 } else { 12.0 };
        if s < score {
            score = s;
            best = Some(k);
        }
    }
    if role == 5 && w[8] > 0.0 && len(sub(get(w, 9), p)) > 5.0 {
        w[1536] = 1.0;
        put(w, 1537, offset(get(w, 9), p, 0.6, 2.5));
    }
    let Some(k) = best else {
        return;
    };
    let target = get(w, k + 1);
    let range = len(sub(target, p));
    let visible = w[k + 7] > 0.0;
    let id = w[k];
    let since = if w[12] == id { w[13] } else { tick };
    w[1547] = id;
    w[1548] = since;
    w[1541] = 1.0;
    // Velocity is derived from successive sightings, never from the enemy's authoritative velocity.
    let lead = if visible {
        (range / 11.0).min(2.0) * w[16].clamp(0.0, 1.0)
    } else {
        0.0
    };
    let predicted = add(target, mul(get(w, k + 4), lead));
    put(w, 1542, predicted);
    let side = if w[15] < 0.0 { -1.0 } else { 1.0 };
    if role == 2 || role == 6 {
        // swarm / flanker: orbit, don't pile into one point
        w[1536] = 1.0;
        put(
            w,
            1537,
            if range > 4.5 {
                if role == 2 {
                    target
                } else {
                    offset(target, p, side * 0.65, 3.0)
                }
            } else {
                offset(target, p, side * 1.2, 3.0)
            },
        );
        return;
    }
    let (near, far) = match role {
        4 => (12.0, 20.0),
        7 => (7.0, 12.0),
        8 => (16.0, 24.0),
        _ => (6.0, 14.0),
    };
    if role != 5 {
        if range > far {
            w[1536] = 1.0;
            put(w, 1537, target);
        } else if range < near {
            w[1536] = 1.0;
            put(w, 1537, target);
            w[1540] = 1.0;
        }
        // A damaged tank preserves its front armor while withdrawing.
        if w[7] < 0.25 && range < far {
            w[1536] = 1.0;
            put(w, 1537, target);
            w[1540] = 1.0;
        }
    }
    w[1546] = if role == 4 { 1.0 } else { 0.0 };
    if w[3] > 0.0 && tick - since >= w[2] && range <= 26.0 && (visible || role == 4) {
        w[1545] = 1.0;
    }
}
#[no_mangle]
pub extern "C" fn rt_decide() {
    unsafe {
        decide(&mut *std::ptr::addr_of_mut!(WORDS));
    }
}

/// Local steering: position 0, forward 3, left 6, goal 9, reverse 12. Result 16 throttle, 17 steer.
pub fn steer(w: &mut [f64]) {
    let d = sub(get(w, 9), get(w, 0));
    let range = len(d);
    let bearing = dot(d, get(w, 6)).atan2(dot(d, get(w, 3)));
    w[17] = (-bearing * 2.0).clamp(-1.0, 1.0);
    w[16] = if w[12] > 0.0 {
        -0.8
    } else if range < 1.2 {
        w[17] = 0.0;
        0.0
    } else if bearing.abs() > 1.2 {
        0.15
    } else {
        (0.35 + range / 6.0).min(1.0) * (1.0 - (bearing.abs() / 2.0).min(0.6))
    };
}
#[no_mangle]
pub extern "C" fn rt_steer() {
    unsafe {
        steer(&mut *std::ptr::addr_of_mut!(WORDS));
    }
}

/// Semi-implicit radial flight: position 0, velocity 3, acceleration 6, dt 9, gravity 10.
pub fn integrate(w: &mut [f64]) {
    let p = get(w, 0);
    let dt = w[9].clamp(0.0, 0.1);
    let v = add(get(w, 3), mul(sub(get(w, 6), mul(norm(p), w[10])), dt));
    put(w, 3, v);
    put(w, 0, add(p, mul(v, dt)));
}
#[no_mangle]
pub extern "C" fn rt_integrate() {
    unsafe {
        integrate(&mut *std::ptr::addr_of_mut!(WORDS));
    }
}

/// Lightweight actors: position 0, velocity 3, forward 6, speed 9, dt 10, air 11,
/// target radius 12, gravity 13, neighbour count 14; neighbour positions at 32. Output position 448.
pub fn movement(w: &mut [f64]) {
    let p = get(w, 0);
    let v = get(w, 3);
    let up = norm(p);
    let dt = w[10].clamp(0.0, 0.05);
    let mut desired = mul(get(w, 6), w[9]);
    for i in 0..(w[14] as usize).min(128) {
        let d = sub(p, get(w, 32 + i * 3));
        let range = len(d);
        if range > 0.001 && range < 1.1 {
            desired = add(desired, mul(d, (1.1 - range) * 2.0 / range));
        }
    }
    desired = sub(desired, mul(up, dot(desired, up)));
    let next = if w[11] > 0.0 {
        let radial = dot(v, up);
        let tangent = sub(v, mul(up, radial));
        let mut a = mul(sub(desired, tangent), 3.0);
        let extent = len(a);
        if extent > 8.0 {
            a = mul(a, 8.0 / extent);
        }
        // Lift balances weight at equilibrium; a finite thrust reserve controls ascent and descent.
        let thrust = (w[13] + (w[12] - len(p)) * 12.0 - radial * 6.0).clamp(0.0, w[13] + 14.0);
        add(v, mul(add(a, mul(up, thrust - w[13])), dt))
    } else {
        desired
    };
    put(w, 448, add(p, mul(next, dt)));
    put(w, 451, next);
}
#[no_mangle]
pub extern "C" fn rt_move() {
    unsafe {
        movement(&mut *std::ptr::addr_of_mut!(WORDS));
    }
}

/// Segment against at most 256 hull/component spheres. Input: from xyz, unit direction xyz,
/// length, count. Records at 32: tank, component (-1 = hull), xyz, radius. Output 1800: tank, component, distance.
pub fn hit_spheres(w: &mut [f64]) {
    let origin = get(w, 0);
    let direction = get(w, 3);
    let mut nearest = w[6];
    w[1800] = -1.0; w[1801] = -1.0; w[1802] = nearest;
    for i in 0..(w[7] as usize).min(256) {
        let k = 32 + i * 6;
        let delta = sub(origin, get(w, k + 2));
        let b = dot(delta, direction);
        let c = dot(delta, delta) - w[k + 5] * w[k + 5];
        let discriminant = b * b - c;
        if discriminant < 0.0 { continue; }
        let distance = if c <= 0.0 { 0.0 } else { -b - discriminant.sqrt() };
        if distance.is_finite() && distance >= 0.0 && distance <= nearest {
            nearest = distance; w[1800] = w[k]; w[1801] = w[k + 1]; w[1802] = distance;
        }
    }
}
#[no_mangle]
pub extern "C" fn rt_hit_spheres() { unsafe { hit_spheres(&mut *std::ptr::addr_of_mut!(WORDS)); } }

/// Impact on staged machinery. Input: count, impact xyz, damage, blast reach, direct component.
/// Records at 32: xyz, radius, health, stage. Only the stage open BEFORE this hit takes damage.
/// Output 1800: total remaining health; component health is updated in place.
pub fn damage_components(w: &mut [f64]) {
    let count = (w[0] as usize).min(16);
    let impact = get(w, 1);
    let mut stage = f64::INFINITY;
    for i in 0..count { let k = 32 + i * 6; if w[k + 4] > 0.0 { stage = stage.min(w[k + 5]); } }
    let mut remaining = 0.0;
    let mut hazard = w[4].max(0.0);
    for i in 0..count {
        let k = 32 + i * 6;
        if w[6] == -2.0 {
            let taken = hazard.min(w[k + 4]); w[k + 4] -= taken; hazard -= taken;
        } else if w[k + 4] > 0.0 && w[k + 5] == stage {
            let reach = w[5].min(0.45).max(0.0) + w[k + 3];
            let exposure = if w[6] == i as f64 { 1.0 } else { (1.0 - len(sub(impact, get(w, k))) / reach).clamp(0.0, 1.0) };
            w[k + 4] = (w[k + 4] - w[4].max(0.0) * exposure).max(0.0);
        }
        remaining += w[k + 4];
    }
    w[1800] = remaining;
}
#[no_mangle]
pub extern "C" fn rt_damage_components() { unsafe { damage_components(&mut *std::ptr::addr_of_mut!(WORDS)); } }

/// Searchlight geometry. Input origin, direction, target, range, cosine half angle, headlights.
/// Output 16: exposure rate. The host separately checks the native terrain ray for cover.
pub fn searchlight(w: &mut [f64]) {
    let delta = sub(get(w, 6), get(w, 0)); let range = len(delta);
    w[16] = 0.0;
    if range > w[9] || range < 1e-8 { return; }
    if w[11] > 0.0 && range < w[9] * 0.65 { w[16] = 1.0; }
    else if dot(mul(delta, 1.0 / range), get(w, 3)) >= w[10] { w[16] = 0.5; }
}
#[no_mangle]
pub extern "C" fn rt_searchlight() { unsafe { searchlight(&mut *std::ptr::addr_of_mut!(WORDS)); } }

/// Shield outward direction, cosine half angle, incoming velocity. Rear hits pass a directional shield.
pub fn shield(w: &mut [f64]) {
    w[16] = if w[3] <= -1.0 || (len(get(w, 4)) > 1e-10 && -dot(norm(get(w, 4)), norm(get(w, 0))) >= w[3]) { 1.0 } else { 0.0 };
}
#[no_mangle]
pub extern "C" fn rt_shield() { unsafe { shield(&mut *std::ptr::addr_of_mut!(WORDS)); } }

/// Bounded radial field query: center, radius, count; records at 32: id,xyz. IDs at 1025, count at 1024.
pub fn area(w: &mut [f64]) {
    let center = get(w, 0); let radius = w[3]; let mut count = 0;
    if radius.is_finite() && radius > 0.0 {
        for i in 0..(w[4] as usize).min(128) {
            let k = 32 + i * 4;
            if len(sub(get(w, k + 1), center)) <= radius { w[1025 + count] = w[k]; count += 1; }
        }
    }
    w[1024] = count as f64;
}
#[no_mangle]
pub extern "C" fn rt_area() { unsafe { area(&mut *std::ptr::addr_of_mut!(WORDS)); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shield_intercepts_front_but_not_rear_or_tangent() {
        let mut w = [0.0; 2048]; w[2] = 1.0; w[3] = 0.2; w[6] = -10.0;
        shield(&mut w); assert_eq!(w[16], 1.0);
        w[6] = 10.0; shield(&mut w); assert_eq!(w[16], 0.0);
        w[6] = 0.0; w[4] = 10.0; shield(&mut w); assert_eq!(w[16], 0.0);
        w[3] = -1.0; shield(&mut w); assert_eq!(w[16], 1.0);
    }
    #[test]
    fn radial_field_includes_boundary_and_ignores_outside() {
        let mut w = [0.0; 2048]; w[3] = 5.0; w[4] = 3.0;
        w[32..44].copy_from_slice(&[7.0, 0.0, 0.0, 0.0, 8.0, 3.0, 4.0, 0.0, 9.0, 3.0, 4.01, 0.0]);
        area(&mut w); assert_eq!(w[1024], 2.0); assert_eq!(&w[1025..1027], &[7.0, 8.0]);
    }
    #[test]
    fn searchlight_requires_cone_or_nearby_headlights() {
        let mut w = [0.0; 2048]; w[5] = 1.0; w[8] = 10.0; w[9] = 20.0; w[10] = 0.95;
        searchlight(&mut w); assert_eq!(w[16], 0.5);
        w[8] = -10.0; searchlight(&mut w); assert_eq!(w[16], 0.0);
        w[11] = 1.0; searchlight(&mut w); assert_eq!(w[16], 1.0);
        w[8] = -21.0; searchlight(&mut w); assert_eq!(w[16], 0.0);
    }
    #[test]
    fn no_contact_no_fire() {
        let mut w = [0.0; 2048];
        w[0] = 3.0;
        w[3] = 1.0;
        decide(&mut w);
        assert_eq!(w[1545], 0.0);
    }
    #[test]
    fn reaction_and_observed_lead() {
        let mut w = [0.0; 2048];
        w[0] = 3.0;
        w[1] = 100.0;
        w[2] = 54.0;
        w[3] = 1.0;
        w[5] = 18.0;
        w[14] = 1.0;
        w[16] = 1.0;
        w[32] = 7.0;
        w[34] = 18.0;
        w[35] = 10.0;
        w[36] = 2.0;
        w[39] = 1.0;
        decide(&mut w);
        assert_eq!(w[1545], 0.0);
        w[12] = 7.0;
        w[13] = 100.0;
        w[1] = 160.0;
        decide(&mut w);
        assert_eq!(w[1545], 1.0);
        assert!(w[1542] > 1.0);
    }
    #[test]
    fn radial_gravity() {
        let mut w = [0.0; 2048];
        w[1] = 18.0;
        w[9] = 1.0 / 60.0;
        w[10] = 9.81;
        integrate(&mut w);
        assert!(w[1] < 18.0);
        assert_eq!(w[0], 0.0);
    }
    #[test]
    fn nearest_component_intercepts_a_fast_shell() {
        let mut w = [0.0; 2048];
        w[5] = 1.0; w[6] = 20.0; w[7] = 2.0;
        w[32..38].copy_from_slice(&[3.0, -1.0, 0.0, 0.0, 9.0, 1.0]);
        w[38..44].copy_from_slice(&[3.0, 2.0, 0.0, 0.0, 7.0, 0.5]);
        hit_spheres(&mut w);
        assert_eq!(w[1800], 3.0); assert_eq!(w[1801], 2.0); assert_eq!(w[1802], 6.5);
        w[6] = 5.0; hit_spheres(&mut w); assert_eq!(w[1800], -1.0);
    }
    #[test]
    fn machinery_stages_do_not_chain_through_armor_in_one_blast() {
        let mut w = [0.0; 2048];
        w[0] = 2.0; w[4] = 100.0; w[5] = 4.0; w[6] = 1.0;
        w[32..38].copy_from_slice(&[0.0, 0.0, 0.0, 0.3, 40.0, 0.0]);
        w[38..44].copy_from_slice(&[0.0, 0.0, 0.0, 0.3, 80.0, 1.0]);
        damage_components(&mut w);
        assert_eq!(w[36], 0.0); assert_eq!(w[42], 80.0); assert_eq!(w[1800], 80.0);
        damage_components(&mut w); assert_eq!(w[1800], 0.0);
    }
}
