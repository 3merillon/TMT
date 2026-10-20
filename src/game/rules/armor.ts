/** Directional mitigation layered onto the existing bounded blast/exposure model; no penetration solver. */
import type { Q4, TankState, V3 } from '../contracts';
import type { KitAssembly, WeaponId } from '../kit/types';
import { ARMOR_SECTION, hasReactiveArmor, REACTIVE_ARMOR, type ArmorSection } from '../kit/armor';
import type { MunitionId } from '../munitions';

/** World vector to hull frame, without allocating a rendering object. */
function local(v: V3, q: Q4): V3 {
  const x = -q[0], y = -q[1], z = -q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}

export interface ArmorHit { point: V3; direct: boolean; weapon: WeaponId; munition: MunitionId }
export interface ArmorResponse { mitigation: number; multiplier: number; section: ArmorSection | 'roof'; reactiveSpent: number }

/** Pure query. Applying the returned bit to TankState is the simulation's responsibility. The contact is the
 * accepted spherical projectile envelope, so sectors are intentionally coarse, not per-pixel block hit tests. */
export function armorResponse(tank: Pick<TankState, 'position' | 'rotation' | 'reactiveArmor'>, kit: KitAssembly, hit: ArmorHit): ArmorResponse {
  const p = local([hit.point[0] - tank.position[0], hit.point[1] - tank.position[1], hit.point[2] - tank.position[2]], tank.rotation);
  const horizontal = Math.hypot(p[0], p[2]);
  const section: ArmorResponse['section'] = p[1] > horizontal * .8 ? 'roof'
    : Math.abs(p[2]) >= Math.abs(p[0]) ? p[2] >= 0 ? 'front' : 'rear' : p[0] >= 0 ? 'left' : 'right';
  // Close splash retains the previous all-round value. Direct shots reward facing the glacis and flanking.
  const directional = section === 'front' ? 1.5 : section === 'rear' ? .45 : section === 'roof' ? .3 : 1;
  const mitigation = Math.min(.55, kit.stats.mitigation * (hit.direct ? directional : 1));
  let reactiveSpent = 0, reduction = 0;
  // Upper turret/roof, exposed running gear, nearby splash and nuclear effects bypass the hull cassettes.
  if (hit.direct && section !== 'roof' && p[1] >= -.15 && p[1] <= .3 && hit.munition !== 'nuclear' && hasReactiveArmor(kit.loadout)) {
    const bit = ARMOR_SECTION[section];
    if (!((tank.reactiveArmor ?? 0) & bit)) {
      reactiveSpent = bit;
      reduction = hit.weapon === 'rail' ? REACTIVE_ARMOR.railReduction : REACTIVE_ARMOR.blastReduction;
    }
  }
  return { mitigation, multiplier: (1 - mitigation) * (1 - reduction), section, reactiveSpent };
}
