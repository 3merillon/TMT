/** Optional equipment, never cosmetics. A reactive kit has four independently consumed hull sections. */
import type { KitLoadout } from './types';

export const REACTIVE_ARMOR = Object.freeze({ mass: 2, cost: 2, blastReduction: .4, railReduction: .15 });
/** Bits in TankState.reactiveArmor: 1 means that section has already fired. Driver-left is local +X. */
export const ARMOR_SECTION = Object.freeze({ front: 1, left: 2, right: 4, rear: 8 } as const);
export type ArmorSection = keyof typeof ARMOR_SECTION;
export const hasReactiveArmor = (loadout: Pick<KitLoadout, 'hull' | 'armor'>): boolean => loadout.hull === 'bastion' && loadout.armor === 'reactive';
