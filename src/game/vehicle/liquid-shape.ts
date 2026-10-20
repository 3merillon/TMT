/** Shared physical body/track envelope for liquid displacement and drive resistance. */
import type { TankState, V3 } from '../contracts';
import { assembleKit, kitRunningEnvelope, tankKit, V1_PROXY, type HullBox, type KitAssembly } from '../kit';
import { SUSPENSION_TRAVEL_SCALE } from '../kit/dimensions';

interface FluidEnvelope { body: HullBox; tracks: readonly HullBox[]; belly: number }
const envelopes = new WeakMap<KitAssembly, FluidEnvelope>();

/** Geometry is assembled once per kit. The broad body stops at the belly; only the
 * two narrow belts occupy the space below it, so shallow water can pass between them. */
function envelope(a: KitAssembly): FluidEnvelope {
  const cached = envelopes.get(a);
  if (cached) return cached;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const i of [V1_PROXY.hull, ...V1_PROXY.fender]) {
    const b = a.proxies[i].box;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], b.center[axis] - b.half[axis]);
      max[axis] = Math.max(max[axis], b.center[axis] + b.half[axis]);
    }
  }
  const body: HullBox = { center: min.map((v, i) => (v + max[i]) / 2) as V3,
    half: min.map((v, i) => (max[i] - v) / 2) as V3 };
  const rest = kitRunningEnvelope(a, [a.running.stations.slice(0, 4).map(s => s.y0), a.running.stations.slice(4).map(s => s.y0)]);
  const tracks = [0, 1].map(side => ({ center: [(side === 0 ? 1 : -1) * a.running.halfSpacing, 0, rest[side * 3].center[2]] as V3,
    half: [a.running.trackWidth / 2, 0, rest[side * 3].half[2]] as V3 }));
  const result = { body, tracks, belly: min[1] };
  envelopes.set(a, result);
  return result;
}

/** Stable slots: body, driver-left (+X), driver-right (-X). Lower edges use the
 * physical wheel stations, without the visual rig's release filter or pitch-table work.
 * This is a three-box fluid approximation, not a change to tank geometry or collision. */
export function tankFluidBoxes(tank: TankState): readonly HullBox[] {
  const a = assembleKit(tankKit(tank)), e = envelope(a), r = a.running;
  return [e.body, ...e.tracks.map((track, side): HullBox => {
    let bottom = Infinity;
    for (let i = side * 4; i < side * 4 + 4; i++) {
      const station = r.stations[i];
      const compression = Math.max(-r.droop, Math.min(r.compression, ((tank.wheelSuspension[i] ?? .5) - .5) * SUSPENSION_TRAVEL_SCALE));
      bottom = Math.min(bottom, station.y0 + compression - station.radius - .05);
    }
    // The body owns everything above the belly plane. No overlapping volumes.
    const top = e.belly;
    return { center: [track.center[0], (bottom + top) / 2, track.center[2]],
      half: [track.half[0], (top - bottom) / 2, track.half[2]] };
  })];
}
