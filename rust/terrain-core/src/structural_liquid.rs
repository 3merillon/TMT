//! Structural drag uses saved basin levels, never rendered wave readback.
//! Collider bounds approximate immersion; occupied collider volume weights the compound.
use rapier3d::prelude::*;
use std::collections::HashMap;

pub struct LiquidBox { center: Vector, half: Vector, volume: f32 }

pub fn immersion(body: &RigidBody, colliders: &ColliderSet, cache: &mut HashMap<ColliderHandle, LiquidBox>, planet: Vector, level: f32) -> f32 {
    let mut total = 0.;
    let mut wet = 0.;
    for &handle in body.colliders() {
        let collider = &colliders[handle];
        let bounds = cache.entry(handle).or_insert_with(|| {
            let aabb = collider.shape().compute_local_aabb();
            LiquidBox { center: aabb.center(), half: aabb.half_extents(), volume: collider.volume() }
        });
        let pose = *body.position() * collider.position_wrt_parent().copied().unwrap_or(Pose::IDENTITY);
        let radial = pose * bounds.center - planet;
        let up = radial / radial.length().max(1e-6);
        let local_up = pose.rotation.inverse() * up;
        let half = bounds.half.dot(local_up.abs());
        let fraction = ((level - radial.length() + half) / (2. * half).max(1e-6)).clamp(0., 1.);
        total += bounds.volume;
        wet += bounds.volume * fraction;
    }
    if total > 0. { wet / total } else { 0. }
}
