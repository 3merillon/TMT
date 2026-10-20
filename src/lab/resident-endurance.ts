import type { WorldQuery, V3 } from '../game/contracts';
import type { SphereCut } from '../gpu/terrain/contracts';
import { normalize } from '../game/math';

/** Reproducible overlapping impacts: forty shots in the same north-pole bricks,
 * then shots around the equator. Targets use accepted terrain, like gameplay. */
export function enduranceCut(world: WorldQuery, index: number): SphereCut {
  const angle = index * 2.399963229728653;
  const direction = normalize(index < 40 ? [3 * Math.cos(angle), 18, 3 * Math.sin(angle)] : [18 * Math.cos(angle), 2 * Math.sin(angle * .7), 18 * Math.sin(angle)]);
  const center = world.surface(direction)?.point ?? direction.map(v => v * 18) as V3;
  return { id: `endurance-${index}`, center, radius: 2.6, repeat: 'impact' };
}
