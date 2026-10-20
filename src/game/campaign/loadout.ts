/** Persistent, deterministic crew training and four-slot campaign equipment. */
import type { ProgressProfile } from '../meta/profile';
export interface CrewBuild { gunner: number; driver: number; commander: number; gadgets: string[]; ultimate: 'nuclear' | 'hammer' | 'lance' | null }
export const TRAINING = {
  gunner: ['Fast breech · 10% faster reload', 'Cooling jacket · 20% less coax heat', 'Barrel proofing · 10% more shell damage', 'AP belts · 50% more coax damage', 'Gun drill · another 15% faster reload'],
  driver: ['Reinforced hull · 15% more hull', 'Field mechanic · repair restores another 10%', 'Blast discipline · halve self-blast damage', 'Spall lining · take 15% less damage', 'Reserve dynamo · 50% faster charge regeneration'],
  commander: ['Spotter net · contacts last 50% longer', 'Crew coordination · allies reload 20% faster', 'Depot drill · capture twice as fast', 'Field hospital · nearby allies slowly repair', 'Airdrop repair · charge repair costs 25% less'],
} as const;
export const GADGETS = [
  { id: 'repair-kit', name: 'Repair Kit', text: 'Two free 40% repairs per mission.' },
  { id: 'lucky-cog', name: 'Lucky Cog', text: 'Main gun reloads 8% faster.' },
  { id: 'mags-compass', name: "Mags’ Compass", text: 'Contacts stay marked three seconds longer.' },
  { id: 'branns-rivets', name: "Brann’s Rivets", text: '15% less damage through front armor.' },
  { id: 'lantern-shard', name: 'Lantern Shard', text: 'Highlights nearby Tin Toys.' },
] as const;
export const ULTIMATES = [
  { id: 'nuclear', name: 'Nuclear shell', rank: 6, text: 'One nuclear shell, launched after a three-second warning.' },
  { id: 'hammer', name: 'Forge Hammer', rank: 9, text: 'A heavy seismic blast beneath your hull after a three-second warning. Stand clear of allies.' },
  { id: 'lance', name: 'Orbital Lance', rank: 12, text: 'Strike the nearest visible enemy after a three-second warning.' },
] as const;
export function crewBuild(value?: Partial<CrewBuild>, rank = 30, unlocks?: readonly string[]): CrewBuild {
  let remaining = Math.max(0, Math.min(30, Math.floor(rank)));
  const tier = (n: unknown) => { const v = typeof n === 'number' && Number.isSafeInteger(n) ? Math.max(0, Math.min(5, remaining, n)) : 0; remaining -= v; return v; };
  const gunner = tier(value?.gunner), driver = tier(value?.driver), commander = tier(value?.commander);
  const gadgets = [...new Set(Array.isArray(value?.gadgets) ? value.gadgets : [])].filter(id => GADGETS.some(g => g.id === id) && (!unlocks || unlocks.includes(`gadget:${id}`))).slice(0, 4);
  const ultimate = ULTIMATES.find(u => u.id === value?.ultimate && rank >= u.rank)?.id ?? null;
  return { gunner, driver, commander, gadgets, ultimate };
}
export function profileCrew(profile: ProgressProfile): CrewBuild { return crewBuild(profile.crew, profile.rank, profile.unlocks); }
