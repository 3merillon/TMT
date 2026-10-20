/** Belief clouds (Experience §1.15 step 1): what a brain believes about each enemy, from its observation only.
 * A visible enemy is one certain hypothesis; a last-known one is a cloud around the sighting whose radius is the
 * observation's uncertainty (enemy fuel × turns since); a heard shot with no contact is a guess along its bearing. */
import type { BotObservation } from '../api/bot';
import type { V3 } from '../contracts';
import { add, distance, frame, mul, normalize, rotate } from '../math';

export interface Hypothesis { position: V3; weight: number }
export interface TargetBelief {
  tank: number | null; team: number | null; visible: boolean; observedAt: number;
  /** Weighted mean of the hypotheses (the aim point before bracketing). */
  centroid: V3; spread: number; hypotheses: Hypothesis[];
}

/** Points on the surface around `center`: the centre (0.4) and six ring points at 0.6 × radius (0.1 each). */
export function cloud(o: Pick<BotObservation, 'world'>, center: V3, radius: number): Hypothesis[] {
  if (radius < .25) return [{ position: [...center], weight: 1 }];
  const up = normalize(center), axes = frame(up, 0), points: Hypothesis[] = [{ position: [...center], weight: .4 }];
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3, offset = add(mul(axes.right, Math.cos(angle) * radius * .6), mul(axes.forward, Math.sin(angle) * radius * .6));
    const direction = normalize(add(center, offset)), height = Math.hypot(...center);
    points.push({ position: mul(direction, height), weight: .1 });
  }
  return points;
}

function centroidOf(hypotheses: readonly Hypothesis[]): V3 {
  let x = 0, y = 0, z = 0, total = 0;
  for (const h of hypotheses) { x += h.position[0] * h.weight; y += h.position[1] * h.weight; z += h.position[2] * h.weight; total += h.weight; }
  return [x / total, y / total, z / total];
}

/** Every enemy belief, visible first then by recency. `forgetTurns` drops sightings older than that many turns of
 * the enemy (approximated by the uncertainty growth: fuel per turn). With a `budget`, the heard-shot ground query is
 * skipped once the tick's trace steps are spent (the guess then sits at the planet radius). */
export function beliefs(o: BotObservation, options: { forgetTurns?: number; fuelPerTurn?: number; budget?: { traceSteps: number } } = {}): TargetBelief[] {
  const team = o.self.team, out: TargetBelief[] = [];
  for (const entry of o.visible) {
    if (entry.team === team) continue;
    out.push({ tank: entry.tank, team: entry.team, visible: true, observedAt: entry.observedAt, centroid: [...entry.position], spread: 0, hypotheses: [{ position: [...entry.position], weight: 1 }] });
  }
  for (const entry of o.lastKnown) {
    if (entry.team === team) continue;
    if (options.forgetTurns !== undefined && options.fuelPerTurn && entry.uncertainty > options.forgetTurns * options.fuelPerTurn + 1e-9) continue;
    const hypotheses = cloud(o, entry.position, entry.uncertainty);
    out.push({ tank: entry.tank, team: entry.team, visible: false, observedAt: entry.observedAt, centroid: centroidOf(hypotheses), spread: entry.uncertainty, hypotheses });
  }
  out.sort((a, b) => Number(b.visible) - Number(a.visible) || b.observedAt - a.observedAt || (a.tank ?? 0) - (b.tank ?? 0));
  if (!out.length && o.sounds.length) {
    // A heard shot: a guess 10 u along the latest bearing, as uncertain as a fresh sighting two turns old.
    const sound = o.sounds[o.sounds.length - 1];
    const direction = rotate([Math.sin(sound.bearing), 0, Math.cos(sound.bearing)], o.self.rotation);
    const up = normalize(o.self.position), angle = 10 / Math.hypot(...o.self.position);
    const guess = normalize(add(mul(up, Math.cos(angle)), mul(normalize(direction), Math.sin(angle))));
    const hit = !options.budget || options.budget.traceSteps > 0 ? o.world.surface(guess) : null, center = hit ? hit.point : mul(guess, o.world.radius);
    const hypotheses = cloud(o, center, 4);
    out.push({ tank: null, team: null, visible: false, observedAt: sound.tick / 60, centroid: centroidOf(hypotheses), spread: 4, hypotheses });
  }
  return out;
}

/** The belief to shoot at: the nearest visible enemy, else the freshest sighting, else a heard guess. */
export function chooseTarget(o: BotObservation, all: readonly TargetBelief[]): TargetBelief | null {
  const visible = all.filter(belief => belief.visible).sort((a, b) => distance(a.centroid, o.self.position) - distance(b.centroid, o.self.position));
  return visible[0] ?? all[0] ?? null;
}
