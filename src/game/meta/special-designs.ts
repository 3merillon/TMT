/** Local, earned equipment entitlements. Sandbox deliberately bypasses these; combat uses kit stats. */
import type { KitLoadout, SlotId } from '../kit/types';
import type { ProgressProfile } from './profile';

export interface SpecialPart { id: string; slot: SlotId; name: string; scrap: number; wins: number }
export interface SpecialDesign { id: string; name: string; description: string; kit: KitLoadout; colors: [string, string, string]; parts: readonly SpecialPart[] }
export const SPECIAL_DESIGNS: readonly SpecialDesign[] = [
  { id: 'aether', name: 'Aether Regent', description: 'Secret electrical reconnaissance set. Discover each component through victories, or buy its blueprint with earned scrap.',
    kit: { hull: 'aether_hull', runningGear: 'aether_drive', turret: 'aether_crown', weapon: 'arc_cannon', utility: 'aether_vane' }, colors: ['#315f60', '#b78340', '#c8d6c8'],
    parts: [{ id: 'aether_hull', slot: 'hull', name: 'Aether regent hull', scrap: 500, wins: 5 }, { id: 'aether_drive', slot: 'runningGear', name: 'Aether drive', scrap: 350, wins: 3 }, { id: 'aether_crown', slot: 'turret', name: 'Aether crown', scrap: 450, wins: 4 }, { id: 'arc_cannon', slot: 'weapon', name: 'Induction arc cannon', scrap: 600, wins: 6 }, { id: 'aether_vane', slot: 'utility', name: 'Aether vane', scrap: 200, wins: 2 }] },
  { id: 'furnace', name: 'Furnace Leviathan', description: 'Heavy steam siege set. Armored castings, massive tracks and a forge mortar; powerful but expensive and slow.',
    kit: { hull: 'forge_hull', runningGear: 'forge_tracks', turret: 'forge_casemate', weapon: 'forge_mortar', utility: 'steam_sentinel' }, colors: ['#5a5143', '#aa6734', '#302d2b'],
    parts: [{ id: 'forge_hull', slot: 'hull', name: 'Furnace leviathan hull', scrap: 850, wins: 10 }, { id: 'forge_tracks', slot: 'runningGear', name: 'Forge tracks', scrap: 550, wins: 7 }, { id: 'forge_casemate', slot: 'turret', name: 'Forge casemate', scrap: 700, wins: 9 }, { id: 'forge_mortar', slot: 'weapon', name: 'Forge siege mortar', scrap: 900, wins: 12 }, { id: 'steam_sentinel', slot: 'utility', name: 'Steam sentinel', scrap: 300, wins: 6 }] },
];
const specialParts = new Map(SPECIAL_DESIGNS.flatMap(design => design.parts.map(part => [part.id, part] as const)));
export interface PartEntitlement { owned: boolean; canPurchase: boolean; price: number; reason: string; part?: SpecialPart }
export function partEntitlement(profile: ProgressProfile, id: string): PartEntitlement {
  const part = specialParts.get(id);
  if (!part) return { owned: true, canPurchase: false, price: 0, reason: 'Standard equipment' };
  const owned = profile.unlocks.includes(`part:${id}`) || profile.stats.wins >= part.wins;
  return { owned, canPurchase: !owned && profile.scrap >= part.scrap, price: part.scrap, part,
    reason: owned ? 'Blueprint owned' : `${part.scrap} scrap or ${part.wins} victories (${profile.stats.wins}/${part.wins})` };
}
/** A duplicate/unaffordable purchase is a no-op. The caller persists only a successful returned profile. */
export function purchaseSpecialPart(profile: ProgressProfile, id: string): ProgressProfile {
  const access = partEntitlement(profile, id);
  if (!access.canPurchase) return profile;
  return { ...profile, scrap: profile.scrap - access.price, unlocks: [...profile.unlocks, `part:${id}`] };
}
/** Rank 1 starts at the accepted fitting budget; higher ranks can field complete fantasy sets. */
export function fittingBudget(profile: Pick<ProgressProfile, 'rank'>): number { return 10 + Math.max(0, Math.min(29, Math.floor(profile.rank) - 1)) * 2; }
export function lockedKitParts(profile: ProgressProfile, kit: KitLoadout): string[] {
  return (['hull', 'runningGear', 'turret', 'weapon', 'utility'] as const).filter(slot => !partEntitlement(profile, kit[slot]).owned).map(slot => kit[slot]);
}
