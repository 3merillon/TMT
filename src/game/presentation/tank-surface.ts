import type { TankSurface, Vec3 } from '../../engine/contracts';
import type { KitLoadoutIdsLike, SlotId } from '../kit/types';
import { appearanceFinish, type TankAppearance } from '../meta/cosmetics';

export function linearPaint(hex: string): Vec3 {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [16, 8, 0].map(shift => { const x = ((value >>> shift) & 255) / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }) as Vec3;
}

/** A copied, presentation-only descriptor; geometry, simulation and saved paint are immutable. */
export function tankSurface(appearance: TankAppearance, loadout: KitLoadoutIdsLike, slot: SlotId | undefined, group: string): TankSurface {
  const finish = appearanceFinish(appearance);
  // Custom and legacy paint is baked by paintedMesh. The mark stream is reserved for temporary combat scars.
  return { damage: 0, colors: finish.colors.map(linearPaint) as [Vec3, Vec3, Vec3], pattern: ['solid', 'woodland', 'geometric', 'stripe'].indexOf(finish.pattern),
    scale: finish.scale, wear: .42, lights: appearance.lights !== false, marks: [] };
}
