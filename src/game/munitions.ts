import type { Loadout } from './contracts';
import { getTankStats } from './modules';
import { assembleLegacy } from './kit/assembly';
import type { KitAssembly } from './kit/types';
import { LAUNCH_SPEED_SCALE } from './world-constants';

export const MUNITIONS = {
  explosive: { name: 'High explosive', description: 'Standard blast, fast fragments, balanced damage.', radius: 1, speed: 1, damage: 1, effect: 'blast', windFactor: 1 },
  heavy: { name: 'Heavy demolition', description: 'Slower shell. Wider crater and heavier terrain fragments.', radius: 1.35, speed: .78, damage: 1.2, effect: 'blast', windFactor: .6 },
  incendiary: { name: 'Incendiary', description: 'Hot impact followed by lingering fire and smoke. Damage is applied on impact.', radius: 1, speed: .9, damage: .85, effect: 'incendiary', windFactor: 1 },
  nuclear: { name: 'Nuclear', description: 'Large blast, powerful ejecta, and a rising mushroom cloud. Keep your distance.', radius: 1.85, speed: .68, damage: 2.3, effect: 'nuclear', windFactor: .6 },
} as const;
export type MunitionId = keyof typeof MUNITIONS;
export function validMunition(value: unknown): value is MunitionId {
  return typeof value === 'string' && Object.hasOwn(MUNITIONS, value);
}

/** A kit assembly, or a v1 loadout (validated against the v1 budget, then mapped through the kit). */
export type MunitionSource = Loadout | KitAssembly;
function assemblyOf(source: MunitionSource): KitAssembly {
  if ('stats' in source) return source;
  getTankStats(source); // Throws for an invalid or over-budget v1 loadout, as before.
  return assembleLegacy(source);
}

export function munitionStats(source: MunitionSource, id: MunitionId = 'explosive') {
  const weapon = assemblyOf(source).stats, ammo = MUNITIONS[id];
  return { radius: weapon.blastRadius * ammo.radius, damage: weapon.damage * ammo.damage, effect: ammo.effect };
}

/** Launch speed from the kit's weapon stats (plan §3: × LAUNCH_SPEED_SCALE); more slider travel for close shots. */
export function munitionSpeed(source: MunitionSource, power: number, id: MunitionId = 'explosive'): number {
  const stats = assemblyOf(source).stats;
  const fraction = Number.isFinite(power) ? Math.max(0, Math.min(1, power)) : 0;
  return LAUNCH_SPEED_SCALE * (stats.minSpeed + (stats.maxSpeed - stats.minSpeed) * fraction ** 1.5) * MUNITIONS[id].speed;
}

/** Wind drift multiplier (Experience §1.10: HE 1.0, heavy 0.6, rail 0.2): munition × weapon. */
export function windFactor(kit: KitAssembly, id: MunitionId = 'explosive'): number {
  return MUNITIONS[id].windFactor * (kit.loadout.weapon === 'rail' ? .2 : 1);
}
