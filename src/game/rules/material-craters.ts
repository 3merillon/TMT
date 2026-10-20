/** Material-dependent craters (rust-engine-v22, docs/architecture.md). Dense materials resist a blast: each
 * terrain material id is cut by the impact's crater scaled about the impact point by that material's factor, so a
 * shot at a building's base leaves its foundation standing in a wider soil crater. This table is the only copy;
 * the terrain service, presentation and tests read it from here. Pure and deterministic. */
import type { V3 } from '../contracts';
import type { MunitionId } from '../munitions';
import { CRATER_CENTER_LIFT, craterProfile } from './crater';

/** Source material ids (src/gpu/terrain/planet.ts): 1 the planet's soil, 2 bedrock (about 1 u under the surface) and
 * the protected core, 3 building concrete. Ids not listed are cut at full size. */
export const MATERIAL_CRATER_SCALE: Readonly<Record<number, number>> = Object.freeze({ 1: 1, 2: 0.8, 3: 0.6 });

/** One cutter of a material crater: the sphere that removes the materials in `materials` (bit `1 << id`). */
export interface CraterShell { readonly materials: number; readonly center: V3; readonly radius: number }

/** The crater scale of a material for a munition: nuclear ignores resistance, heavy demolition halves it. */
export function craterScale(material: number, munition: MunitionId = 'explosive'): number {
  const scale = MATERIAL_CRATER_SCALE[material] ?? 1;
  return munition === 'nuclear' ? 1 : munition === 'heavy' ? (1 + scale) / 2 : scale;
}

/** The lifted-centre crater of rules/crater.ts plus its material shells. The full-size shell keeps craterProfile's
 * exact centre and radius and covers every material without a smaller scale. A smaller scale s gives the crater
 * scaled by s about the hit point (centre lift and radius × s); it lies inside the full sphere, so `center`/`radius`
 * bound every shell. `shells` is absent when every material is cut at full size (the plain v21 crater). Shells are
 * ordered by descending radius, then ascending mask. */
export function materialCrater(hit: V3, normal: V3, radius: number, munition: MunitionId = 'explosive'): { center: V3; radius: number; shells?: CraterShell[] } {
  const profile = craterProfile(hit, normal, radius);
  const byScale = new Map<number, number>();
  for (const key of Object.keys(MATERIAL_CRATER_SCALE)) {
    const material = Number(key), scale = craterScale(material, munition);
    if (scale !== 1) byScale.set(scale, (byScale.get(scale) ?? 0) | (1 << material));
  }
  if (!byScale.size) return profile;
  let reduced = 0; for (const mask of byScale.values()) reduced |= mask;
  const length = Math.hypot(normal[0], normal[1], normal[2]), lift = CRATER_CENTER_LIFT * profile.radius / length;
  const shells: CraterShell[] = [{ materials: (~reduced) >>> 0, center: profile.center, radius: profile.radius }];
  for (const [scale, mask] of [...byScale].sort((a, b) => b[0] - a[0] || a[1] - b[1]))
    shells.push({ materials: mask >>> 0, center: [0, 1, 2].map(a => hit[a] + normal[a] * (lift * scale)) as V3, radius: profile.radius * scale });
  return { ...profile, shells };
}
