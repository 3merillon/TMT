import type { SmcStamp } from '../../engine/scene/surface-memory';
import type { V3 } from '../contracts';

export interface TrackTrail { at: V3; forward: V3; ground: number }
export interface TrackContact { center: V3; forward: V3; halfLength: number; halfWidth: number; load: number }
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a: V3, b: V3, t: number) => a.map((v, i) => v + (b[i] - v) * t) as V3;
const normalized = (v: V3): V3 => { const n = Math.hypot(...v); return v.map(x => x / Math.max(n, 1e-9)) as V3; };

/** Sweep the whole loaded belt, retaining its orientation even during lateral slip. */
export function sweepTrack(contact: TrackContact, previous: TrackTrail | null, pitch: number): { trail: TrackTrail; stamps: SmcStamp[] } {
  const { center, forward, halfLength, halfWidth, load } = contact;
  const delta = previous ? center.map((v, i) => v - previous.at[i]) as V3 : [0, 0, 0] as V3;
  const travel = Math.hypot(...delta);
  const direction = previous ? normalized(mix(previous.forward, forward, 0.5)) : forward;
  const along = dot(delta, direction);
  const angle = previous ? Math.acos(Math.min(1, Math.max(-1, dot(previous.forward, forward)))) : 0;
  const ground = (previous?.ground ?? 0) + (travel < 0.8 ? along : 0);
  const trail = { at: center, forward, ground };
  if (travel > 0.8 || angle > 0.8) return { trail, stamps: [] }; // Teleport: no connecting scar.
  const scrub = travel > 0.008 ? Math.sqrt(Math.max(0, travel * travel - along * along)) / travel : 0;
  const steps = Math.max(1, Math.ceil((travel + angle * halfLength) / Math.max(0.04, halfWidth * 0.45)));
  const stamps: SmcStamp[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const phase = (previous?.ground ?? ground) + along * t;
    stamps.push({ center: previous ? mix(previous.at, center, t) : center,
      forward: previous ? normalized(mix(previous.forward, forward, t)) : forward,
      halfLength, halfWidth, strength: Math.min(0.85, 0.45 + 0.4 * load), soft: 0.2, endSoft: 0.06,
      tread: [(phase - halfLength) / pitch, (phase + halfLength) / pitch], scrub });
  }
  return { trail, stamps };
}
