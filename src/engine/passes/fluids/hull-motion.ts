import type { WaterHull } from './water';

/** Align history after removal, recuts and priority changes. A newly observed
 * body starts at rest, so appearing or teleporting into the selected set adds no impulse. */
export function previousWaterHulls(current: readonly WaterHull[], previous: readonly WaterHull[]): WaterHull[] {
  const keyed = new Map(previous.filter(h => h.id !== undefined).map(h => [h.id, h]));
  return current.map((h, i) => (h.id === undefined ? previous[i] : keyed.get(h.id)) ?? h);
}

/** Ignore suspension solver chatter; compare against the retained pose so slow
 * deliberate motion still accumulates and eventually displaces water. */
export function stableWaterHulls(current: readonly WaterHull[], previous: readonly WaterHull[]): WaterHull[] {
  return current.map((h, i) => {
    const p = previous[i];
    if (p) {
      // Bound every corner's movement, including suspension-dependent track extents.
      // Exact half-extent equality let even microscopic suspension changes bypass the deadband.
      let motion = Math.hypot(h.centre[0] - p.centre[0], h.centre[1] - p.centre[1], h.centre[2] - p.centre[2]);
      for (let a = 0; a < 3; a++) {
        const v = h.axes[a], w = p.axes[a], s = h.half[a], t = p.half[a];
        motion += Math.hypot(v[0] * s - w[0] * t, v[1] * s - w[1] * t, v[2] * s - w[2] * t);
      }
      if (motion < 0.004) return p;
    }
    return { ...(h.id === undefined ? {} : { id: h.id }), centre: [...h.centre], axes: h.axes.map(a => [...a]), half: [...h.half] };
  });
}
