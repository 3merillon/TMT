import type { TankState, V3 } from '../contracts';
import { assembleKit, tankKit, V1_PROXY } from '../kit';
import { add, dot, mul, normalize, rotate } from '../math';
import type { LiquidQuery } from '../liquids';
import { tankFluidBoxes } from './liquid-shape';

export interface LiquidResistance { submerged: number; speed: number; drag: number; angularDrag: number }
const DRY: LiquidResistance = Object.freeze({ submerged: 0, speed: 1, drag: 0, angularDrag: 0 });
/** Volume-weighted immersion of the body, both tracks and turret. The gun and
 * antenna do not need to disappear before the tank counts as fully submerged. */
export function liquidResistance(tank: TankState, sample: LiquidQuery, planetCenter: V3 = [0, 0, 0]): LiquidResistance {
  const kit = assembleKit(tankKit(tank)), axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => rotate(v as V3, tank.rotation));
  let volume = 0, wet = 0, lava = 0;
  for (const box of [...tankFluidBoxes(tank), kit.proxies[V1_PROXY.turret].box]) {
    const center = add(tank.position, rotate(box.center, tank.rotation)), radial = add(center, mul(planetCenter, -1));
    const up = normalize(radial), r = Math.hypot(...radial), half = box.half.reduce((sum, h, a) => sum + h * Math.abs(dot(axes[a], up)), 0);
    const size = 8 * box.half[0] * box.half[1] * box.half[2], liquid = sample(center);
    const fraction = liquid ? Math.max(0, Math.min(1, (liquid.level - r + half) / Math.max(1e-6, 2 * half))) : 0;
    volume += size; wet += size * fraction;
    if (liquid?.material === 'lava') lava += size * fraction;
  }
  if (wet <= 0 || volume <= 0) return DRY;
  const submerged = Math.min(1, wet / volume), resistance = submerged ** 1.5, viscosity = 1 + .5 * lava / wet;
  const fullSpeed = .6 - .3 * lava / wet;
  return { submerged, speed: 1 - (1 - fullSpeed) * resistance, drag: .35 * resistance * viscosity, angularDrag: 1.2 * resistance * viscosity };
}
