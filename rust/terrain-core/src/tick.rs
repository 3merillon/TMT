//! Engine v17 resident tick head. One call runs the pre-physics part of a fixed
//! tick in the host's original order by invoking the same validated match,
//! flight and controller operations: motion refresh, move permission, journal
//! drive admission, tick start, wind sample and the bound controller's drive.
//! A failure leaves later stages unrun, exactly as a throwing host call did.
use crate::{core::Outcome, Handle};
fn words(b: &[u8]) -> Vec<f64> { b.chunks_exact(8).map(|x| f64::from_le_bytes(x.try_into().unwrap())).collect() }
fn clean(x: f64) -> f64 { if x.is_finite() { x.clamp(-1., 1.) } else { 0. } }
fn call(h: &mut Handle, id: u32, op: u32, args: &[f64]) -> Outcome<Vec<f64>> {
    let mut out = Vec::new();
    h.matches.command(id, op, args, &mut h.combats, &mut h.queries, h.physics.as_mut(), &mut h.flights, &mut out)?; Ok(words(&out))
}
/// Input [throttle, steer, controller kind (0 host, 1 legacy, 2 personality), controller id].
/// Output [movable, mode, throttle, steer, wind count, wind.., snapshot count, snapshot.., motion..];
/// mode 0 = no drive this tick, 1 = the host selects the active input, 2 = engine-computed input.
pub(crate) fn head(h: &mut Handle, id: u32) -> Outcome<()> {
    let d = h.physics_words.clone();
    if d.len() != 4 || d.iter().any(|x| !x.is_finite()) || d[0].abs() > 1. || d[1].abs() > 1. || !(d[2] == 0. || d[2] == 1. || d[2] == 2.) || d[3] < 0. || d[3] > u32::MAX as f64 || d[3].fract() != 0.
        { return Err("Invalid resident tick head".into()); }
    // A misnamed controller is rejected before the journal or the clock change.
    let unit = h.matches.active_unit(id)?;
    if d[2] == 1. { h.brains.require_bound(d[3] as u32, id, unit)?; } else if d[2] == 2. { h.profiles.require_bound(d[3] as u32, id, unit)?; }
    let motion = call(h, id, 42, &[])?;
    let movable = call(h, id, 11, &[3., 0., 0., 0.])?[0] == 1.;
    call(h, id, 30, &[d[0], d[1]])?;
    let snapshot = call(h, id, 2, &[])?;
    let (tick, active) = (snapshot[0], snapshot[3] as usize);
    if active != unit { return Err("Resident tick start changed the active unit".into()); }
    let context = h.matches.shot_context(id)?;
    let mut wind = Vec::new(); h.flights.command(context, 0, 0, &[tick], &mut h.queries, h.physics.as_ref(), &mut wind)?; let wind = words(&wind);
    let (mut mode, mut input) = (0., [0., 0.]);
    if movable && h.matches.unit_alive(id, active, &h.combats)? {
        mode = 1.;
        if d[2] != 0. {
            let controller = d[3] as u32; let mut out = Vec::new();
            if d[2] == 1. { h.brains.command(controller, 3, &[], &mut h.matches, &h.combats, &mut out)?; }
            else { h.profiles.command(controller, 3, &[], &h.matches, &h.combats, &mut out)?; }
            let w = words(&out); mode = 2.; input = [clean(w[0]), clean(w[1])];
        }
    }
    let mut w = vec![movable as u8 as f64, mode, input[0], input[1], wind.len() as f64];
    w.extend(&wind); w.push(snapshot.len() as f64); w.extend(&snapshot); w.extend(&motion);
    h.output.clear(); for x in w { h.output.extend_from_slice(&x.to_le_bytes()); } Ok(())
}
/// Engine v18 chassis leg: chassis binding, contact aggregation, articulated
/// collider poses (translation then rotation, in tank order), the queued force
/// flush and the chassis control tick, through the same match/physics operations
/// the host issued one by one. Input [pairs P, (tank, body)*P, poses K,
/// (collider, t3, q4)*K, queue length L, force queue (physics op 51 words), chassis
/// tick packet (match op 44 words)]; output is the chassis tick's words.
pub(crate) fn chassis(h: &mut Handle, id: u32) -> Outcome<()> {
    let d = h.physics_words.clone(); let integer = |x: f64| x >= 0. && x <= u32::MAX as f64 && x.fract() == 0.;
    let invalid = || "Invalid resident chassis leg".to_string();
    let pairs = *d.first().ok_or_else(invalid)?; if !integer(pairs) { return Err(invalid()); }
    let poses_at = 1 + pairs as usize * 2; let poses = *d.get(poses_at).ok_or_else(invalid)?; if !integer(poses) { return Err(invalid()); }
    let queue_at = poses_at + 1 + poses as usize * 8; let queue = *d.get(queue_at).ok_or_else(invalid)?; if !integer(queue) { return Err(invalid()); }
    let tick_at = queue_at + 1 + queue as usize; if tick_at > d.len() || d[poses_at + 1..queue_at].chunks_exact(8).any(|r| !integer(r[0])) { return Err(invalid()); }
    call(h, id, 38, &d[..poses_at])?;
    call(h, id, 43, &[])?;
    let physics = h.physics.as_mut().ok_or("Engine physics is absent")?; let mut scratch = Vec::new();
    for r in d[poses_at + 1..queue_at].chunks_exact(8) { physics.command(33, r[0] as u32, &r[1..4], &mut scratch)?; physics.command(34, r[0] as u32, &r[4..8], &mut scratch)?; }
    if queue > 0. { physics.command(51, 0, &d[queue_at + 1..tick_at], &mut scratch)?; }
    let w = call(h, id, 44, &d[tick_at..])?;
    h.output.clear(); for x in w { h.output.extend_from_slice(&x.to_le_bytes()); } Ok(())
}
/// Engine v19 solver leg: the solver step (physics op 50), one batched snapshot
/// of the structural bodies the host presents (op 52, replacing a read per
/// body), the composed query pose sync and the chassis after-physics publication
/// (match op 39). Frozen-body release, which changes no pose, follows in the host.
/// Input [step length S, step packet (op 50 words), body count B, bodies, query
/// world (or -1), dt]; output [event count E, events, snapshot count N, snapshot,
/// query changed, after-physics words..].
pub(crate) fn solver(h: &mut Handle, id: u32) -> Outcome<()> {
    let d = h.physics_words.clone(); let invalid = || "Invalid resident solver leg".to_string();
    let count = |x: Option<&f64>| x.copied().filter(|x| *x >= 0. && x.fract() == 0. && *x <= u32::MAX as f64).ok_or_else(invalid);
    let s = count(d.first())? as usize; let b = count(d.get(1 + s))? as usize; let tail = 2 + s + b;
    if d.len() != tail + 2 || !(d[tail] == -1. || d[tail] >= 0. && d[tail].fract() == 0. && d[tail] <= u32::MAX as f64) { return Err(invalid()); }
    let physics = h.physics.as_mut().ok_or("Engine physics is absent")?;
    let mut events = Vec::new(); physics.command(50, 0, &d[1..1 + s], &mut events)?;
    let mut snapshot = Vec::new(); if b > 0 { physics.command(52, 0, &d[2 + s..tail], &mut snapshot)?; }
    let changed = if d[tail] >= 0. { h.queries.world_sync(d[tail] as u32, h.physics.as_ref().unwrap())? } else { false };
    let motion = call(h, id, 39, &[d[tail + 1]])?;
    let mut w = vec![(events.len() / 8) as f64]; w.extend(words(&events)); w.push((snapshot.len() / 8) as f64); w.extend(words(&snapshot)); w.push(changed as u8 as f64); w.extend(motion);
    h.output.clear(); for x in w { h.output.extend_from_slice(&x.to_le_bytes()); } Ok(())
}
/// Engine v20 tick tail. Runs the post-solver operations of a fixed tick in the
/// host's order and returns their outputs as records the host replays with its
/// original handling: action motion (12), fall kills (combat 2, tag 102),
/// after-motion (4), the live shot (49, 57, shot 50, 51; abort 56 on failure),
/// settlement (5, with the shot clear 52 that retiring flights performs),
/// contacts every sixth tick (17, 26) and aim expiry (hold 10, then settlement).
/// It stops for host services and resumes (op 68) where it stopped: 1 tick hooks,
/// 2 a host-serviced shot, 3 an impact, 4 host-serviced contacts.
/// Start input [radius, movable, brain, throttle, steer, blocked, serial, tick
/// hooks, segment hooks, lease kind, id, range, tempo per unit]; resume input
/// [stage, blocked, serial]. Output [status, record count, (tag, length, words)*].
/// Engine v21 (op 70) appends [world revision, floor, ceiling, gear words per unit] to the start input and returns
/// each unit's tread profile after the first batch as record 103 [unit, 1, profile..] or, when the profile is the one
/// last returned, [unit, 0].
pub(crate) fn tail(h: &mut Handle, id: u32, resume: bool, treads: bool) -> Outcome<()> {
    let d = h.physics_words.clone(); let flag = |x: f64| x == 0. || x == 1.;
    let invalid = || "Invalid resident tick tail".to_string();
    let mut tread: Option<Vec<f64>> = None;
    let (stage, params) = if resume {
        let t = h.matches.take_tail(id)?.ok_or("No resident tick tail is waiting")?;
        if d.len() != 3 || d[0] != t.stage as f64 || !flag(d[1]) || !flag(d[2]) { h.matches.set_tail(id, Some(t))?; return Err(invalid()); }
        let mut p = t.params; p[5] = d[1]; p[6] = d[2]; (t.stage, p)
    } else {
        h.matches.set_tail(id, None)?; let n = h.matches.tail_info(id)?.units;
        let extra = if treads { 3 + crate::tread::GEAR_WORDS * n } else { 0 };
        if d.len() != 12 + n + extra || d.iter().any(|x| !x.is_finite()) || d[0] <= 0. || [1, 2, 5, 6, 7, 8].iter().any(|&i| !flag(d[i])) || d[3].abs() > 1. || d[4].abs() > 1.
            || !(d[9] == 0. || d[9] == 1. || d[9] == 2.) || d[10] < 0. || d[10].fract() != 0. || d[11] <= 0. || d[12..12 + n].iter().any(|&t| t <= 0.) { return Err(invalid()); }
        if treads { tread = Some(d[12 + n..].to_vec()); }
        (0, d[..12 + n].to_vec())
    };
    let mut records: Vec<f64> = Vec::new(); let mut count = 0.;
    let mut record = |tag: f64, w: &[f64], records: &mut Vec<f64>| { records.extend([tag, w.len() as f64]); records.extend_from_slice(w); count += 1.; };
    let lease = [params[9], params[10], params[11]];
    let settle = |h: &mut Handle, records: &mut Vec<f64>, record: &mut dyn FnMut(f64, &[f64], &mut Vec<f64>)| -> Outcome<()> {
        if params[5] == 1. || h.matches.tail_info(id)?.phase == 3 { return Ok(()); }
        let s = call(h, id, 5, &params[12..])?; let event = s[13]; record(5., &s, records);
        if event == 1. || event == 2. { let c = call(h, id, 52, &[])?; record(52., &c, records); }
        Ok(())
    };
    let mut status = 0.; let mut stage = stage;
    loop {
        match stage {
            0 => {
                let w = call(h, id, 12, &[])?; record(12., &w, &mut records);
                let info = h.matches.tail_info(id)?;
                if !info.drive { for unit in 0..info.units { if h.matches.fallen(id, unit, params[0], &h.combats)? {
                    let mut out = Vec::new(); h.combats.command(h.matches.combat_of(id)?, 2, &[unit as f64], &mut h.queries, h.physics.as_ref(), &mut out)?;
                    let mut w = vec![unit as f64]; w.extend(words(&out)); record(102., &w, &mut records);
                } } }
                stage = 1; if params[7] == 1. { status = 1.; break; }
            }
            1 => {
                stage = 2;
                if h.matches.tail_info(id)?.phase != 1 { stage = 3; continue; }
                let w = call(h, id, 4, &params[1..5])?; record(4., &w, &mut records);
                let rows = call(h, id, 49, &[])?; let live = rows[0] > 0.; record(49., &rows, &mut records);
                if !live { continue; }
                if params[8] == 1. || lease[0] == 0. { status = 2.; break; }
                let shot = (|| -> Outcome<Vec<f64>> {
                    let s = call(h, id, 57, &[])?; record(57., &s, &mut records);
                    let a = call(h, id, 50, &lease)?; record(50., &a, &mut records);
                    let f = call(h, id, 51, if a.len() == 21 { &a[13..21] } else { &[] })?; record(51., &f, &mut records); Ok(f)
                })();
                let f = match shot { Ok(f) => f, Err(e) => { call(h, id, 56, &[])?; return Err(e); } };
                if f[3] != 0. { status = 3.; break; }
            }
            2 => { settle(h, &mut records, &mut record)?; stage = 3; }
            3 => {
                stage = 4;
                if h.matches.tail_info(id)?.tick % 6. == 0. {
                    if lease[0] == 0. { status = 4.; break; }
                    let w = call(h, id, 17, &lease)?; if w[0] != 0. { return Err("Resident contacts requested host queries".into()); }
                    if w[1] != 0. { let rows = call(h, id, 26, &[])?; record(26., &rows, &mut records); }
                }
            }
            4 => {
                if h.matches.tail_info(id)?.phase == 0 { settle(h, &mut records, &mut record)?; }
                let info = h.matches.tail_info(id)?;
                if info.aim_expired {
                    let w = call(h, id, 10, &[4., info.active as f64, params[6], 0.])?; let admitted = w[13] == 1.; record(10., &w, &mut records);
                    if admitted { settle(h, &mut records, &mut record)?; }
                }
                break;
            }
            _ => return Err(invalid()),
        }
    }
    // Tread profiles sample the poses the first batch left: nothing in the tail moves a chassis before a host service.
    if let Some(t) = tread {
        let (lease_id, units) = (params[10] as u32, h.matches.tail_info(id)?.units);
        if params[9] != 2. { h.matches.tread_cache(id)?.clear(); }
        else { for unit in 0..units {
            let pose = h.matches.unit_pose(id, unit)?; let gear = &t[3 + unit * crate::tread::GEAR_WORDS..3 + (unit + 1) * crate::tread::GEAR_WORDS];
            let key: Vec<u64> = [lease_id as f64, t[0], t[1], t[2]].iter().chain(&pose).chain(gear).map(|x| x.to_bits()).collect();
            let cache = h.matches.tread_cache(id)?; if cache.len() < units { cache.resize(units, (Vec::new(), Vec::new())); }
            if cache[unit].0 == key { record(103., &[unit as f64, 0.], &mut records); continue; }
            let (queries, physics) = (&mut h.queries, h.physics.as_ref().ok_or("Engine physics is absent")?);
            let mut query = |op: u32, args: &[f64]| -> Outcome<Vec<f64>> { let mut out = Vec::new(); queries.world_run(lease_id, op, args, physics, &mut out)?; Ok(words(&out)) };
            let profile = crate::tread::profile(&pose, gear, t[1], t[2], &mut query)?;
            let mut w = vec![unit as f64, 1.]; w.extend(&profile); record(103., &w, &mut records);
            h.matches.tread_cache(id)?[unit] = (key, profile);
        } }
    }
    if status != 0. { h.matches.set_tail(id, Some(crate::match_state::Tail { stage, params: params.clone() }))?; }
    let mut out = vec![status, count]; out.extend(records);
    h.output.clear(); for x in out { h.output.extend_from_slice(&x.to_le_bytes()); } Ok(())
}
