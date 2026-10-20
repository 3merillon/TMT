/**
 * Workshop model (pure): slot tabs over the kit catalogue, part cards with stats from `assembleKit(...).stats`,
 * and the fitting budget. Host replacements preserve compatible equipment and explicitly preview required dependencies.
 */
import type { KitLoadoutIds } from '../api/match';
import { assembleKit, KIT_PART_IDS, KIT_SLOTS, validateKitLoadout, type KitLoadout, type KitPartStats, type SlotId } from '../kit';
import { lockedKitParts, partEntitlement, SPECIAL_DESIGNS } from '../meta/special-designs';
import type { ProgressProfile } from '../meta/profile';
import { LOADOUT_BUDGET } from '../modules';

export const FITTING_BUDGET = LOADOUT_BUDGET;
export const SLOT_LABELS: Readonly<Record<SlotId, string>> = Object.freeze({ hull: 'Hull', runningGear: 'Running gear', turret: 'Turret', weapon: 'Weapon', utility: 'Accessories' });
export const PART_INFO: Readonly<Record<SlotId, Readonly<Record<string, { name: string; blurb: string }>>>> = Object.freeze({
  hull: { skiff: { name: 'Skiff', blurb: 'A light racing hull. Quick, thin plate.' }, warden: { name: 'Warden', blurb: 'The balanced field hull.' },
    bastion: { name: 'Bastion', blurb: 'Heavy hull with a mounted reactive armor package; slower to relocate.' } },
  runningGear: { scout: { name: 'Scout tracks', blurb: 'Torsion arms: fast relocation, less lateral grip.' },
    grip: { name: 'Grip tracks', blurb: 'Bogies and return rollers: stable on slopes and under recoil.' },
    crawler: { name: 'Crawler', blurb: 'Interleaved wheels that climb crater lips.' } },
  turret: { dome: { name: 'Dome', blurb: 'The classic cast turret.' }, wedge: { name: 'Wedge', blurb: 'A low, angled turret.' },
    cradle: { name: 'Cradle', blurb: 'An open mount with a wide elevation range.' } },
  weapon: { mortar: { name: 'Arc mortar', blurb: 'Broad blast and a controllable high arc.' }, cannon: { name: 'Field cannon', blurb: 'Stronger direct hits; a smaller crater.' },
    rail: { name: 'Rail lance', blurb: 'Fast, precise and heavy; a narrow blast.' }, autocannon: { name: 'Scout autocannon', blurb: 'A light, compact rapid-action gun. Lower hit damage with agile handling.' } },
  utility: { antenna: { name: 'Field antenna', blurb: 'Flexible radio mast. Visual equipment; no targeting bonus.' }, radar: { name: 'Saucer radar', blurb: 'Rotating scanner on a powered pedestal. Visual equipment; uses the standard radar action.' },
    periscope: { name: 'Periscope', blurb: 'Protected optical head. Visual equipment; standard line-of-sight rules apply.' }, smoke: { name: 'Smoke launcher', blurb: 'Angled screening tubes. Visual equipment; standard smoke ammunition is unchanged.' },
    whip_short: { name: 'Compact whip', blurb: 'Short protected radio aerial. Cosmetic arrangement.' },
    yagi: { name: 'Directional array', blurb: 'Supported directional antenna array. Cosmetic communications equipment.' },
    point_defense: { name: 'Point-defense preview', blurb: 'Articulated twin-barrel mount. Visual preview only: does not intercept shells or engage aircraft.' } },
});

// Canonical special-part metadata shares its player-facing names with progression.
for (const design of SPECIAL_DESIGNS) for (const p of design.parts) {
  (PART_INFO[p.slot] as Record<string, { name: string; blurb: string }>)[p.id] = { name: p.name, blurb: `${design.name} — ${p.slot === 'utility' ? 'Animated cosmetic equipment; no additional combat ability.' : design.description}` };
}

export interface StatLine { key: keyof KitPartStats; label: string; unit: string; digits: number; higherIsBetter: boolean }
export const STAT_LINES: readonly StatLine[] = Object.freeze([
  { key: 'hp', label: 'Armour', unit: 'HP', digits: 0, higherIsBetter: true },
  { key: 'speed', label: 'Speed', unit: 'm/s', digits: 1, higherIsBetter: true },
  { key: 'fuel', label: 'Move range', unit: 'm', digits: 1, higherIsBetter: true },
  { key: 'damage', label: 'Damage', unit: '', digits: 0, higherIsBetter: true },
  { key: 'blastRadius', label: 'Blast', unit: 'm', digits: 2, higherIsBetter: true },
  { key: 'maxSpeed', label: 'Muzzle speed', unit: 'm/s', digits: 1, higherIsBetter: true },
  { key: 'mass', label: 'Mass', unit: 't', digits: 1, higherIsBetter: false },
]);

export type PartStatus = 'fitted' | 'available' | 'over-budget' | 'coming-soon' | 'incompatible' | 'locked';
export interface PartCard { id: string; name: string; blurb: string; status: PartStatus; cost: number | null; stats: KitPartStats | null; reason: string; adjustments?: string[]; canPurchase?: boolean; price?: number }

export function partName(slot: SlotId, id: string): string { return PART_INFO[slot][id]?.name ?? id; }
export function kitSummary(ids: KitLoadoutIds): string {
  return KIT_SLOTS.map(slot => partName(slot, ids[slot])).join(' · ');
}

/** Stats of an assembled loadout, or null when a part is not built yet. */
export function buildStats(ids: KitLoadoutIds): KitPartStats | null {
  try { return assembleKit(validateKitLoadout(ids)).stats; } catch { return null; }
}

/** One card per catalogue part in `slot`, judged as if it replaced the current part. */
export function partCards(ids: KitLoadoutIds, slot: SlotId, budget = FITTING_BUDGET, profile?: ProgressProfile): PartCard[] {
  const current: KitLoadout = validateKitLoadout(ids), currentCost = assembleKit(current).stats.cost;
  // Like the budget, only a part a swap would add can block it: a saved build holding unowned blueprints can still shed them.
  const alreadyLocked = profile ? lockedKitParts(profile, current) : [];
  return (KIT_PART_IDS[slot] as readonly string[]).map(id => {
    const info = PART_INFO[slot][id] ?? { name: id, blurb: '' };
    const candidate = replacementKit(current, slot, id) as KitLoadout;
    const adjustments = KIT_SLOTS.filter(other => other !== slot && current[other] !== candidate[other]).map(other => `${partName(other, current[other])} → ${partName(other, candidate[other])}`);
    if ((current.armor ?? 'standard') !== (candidate.armor ?? 'standard')) adjustments.push(candidate.armor === 'reactive' ? 'Reactive armor package included' : 'Reactive armor removed with hull');
    const adjustmentText = adjustments.length ? `Auto-fit: ${adjustments.join('; ')}. ` : '';
    let stats: KitPartStats;
    try { stats = assembleKit(validateKitLoadout(candidate)).stats; }
    catch (error) { return { id, ...info, status: 'incompatible', cost: null, stats: null, reason: error instanceof Error ? error.message : 'Mount incompatible with this build' }; }
    const fitted = current[slot] === id;
    const entitlement = profile && partEntitlement(profile, id), locked = profile ? lockedKitParts(profile, candidate).filter(part => !alreadyLocked.includes(part)) : [];
    if (locked.length) return { id, ...info, adjustments, status: 'locked', cost: stats.cost, stats,
      canPurchase: entitlement?.canPurchase, price: entitlement?.price,
      reason: `${adjustmentText}${entitlement && !entitlement.owned ? entitlement.reason : `Requires owned blueprints: ${locked.join(', ')}`}${stats.cost > budget ? `. Over fitting budget (${stats.cost} / ${budget})` : ''}` };
    // An over-budget build (saved before a cost change, say) must always be able to step back down: a swap that does
    // not raise its cost is allowed even while the total is still above the budget.
    if (!fitted && stats.cost > budget && stats.cost > currentCost) return { id, ...info, adjustments, status: 'over-budget', cost: stats.cost, stats, reason: `${adjustmentText}Over budget (${stats.cost} / ${budget})` };
    const reducing = stats.cost > budget ? ' · lowers an over-budget build' : '';
    return { id, ...info, adjustments, status: fitted ? 'fitted' : 'available', cost: stats.cost, stats, reason: fitted ? 'Fitted' : `${adjustmentText}${Number.isFinite(budget) ? `Cost ${stats.cost} / ${budget}${reducing}` : `Sandbox · cost ${stats.cost}`}` };
  });
}

export function sameKit(a: KitLoadoutIds, b: KitLoadoutIds): boolean { return KIT_SLOTS.every(slot => a[slot] === b[slot]) && (a.armor ?? 'standard') === (b.armor ?? 'standard'); }
/** A newly selected Bastion includes reactive armor. Existing builds retain their chosen armor configuration. */
export function replacementKit(ids: KitLoadoutIds, slot: SlotId, id: string): KitLoadoutIds {
  const next = { ...ids, [slot]: id };
  if (slot === 'hull') {
    if (id !== 'bastion') delete next.armor;
    else if (ids.hull !== 'bastion') next.armor = 'reactive';
  }
  try { validateKitLoadout(next); return next; } catch { /* Host changes may require matching dependent modules. */ }
  if (slot !== 'hull' && slot !== 'turret') return next;
  const turrets = slot === 'turret' ? [id] : [...new Set([next.turret, 'dome', 'wedge', 'cradle'])];
  const weapons = [...new Set([next.weapon, 'cannon', 'mortar', 'autocannon', 'rail'])];
  for (const turret of turrets) for (const weapon of weapons) {
    const candidate = { ...next, turret, weapon };
    try { validateKitLoadout(candidate); return candidate; } catch { /* Try the next actual socket-compatible assembly. */ }
  }
  return next; // Preserve the genuine error for the catalogue card; never invent a permissive mount.
}

export interface StatComparison extends StatLine { before: number; after: number; delta: number; change: 'better' | 'worse' | 'same' }
/** Every comparison comes from the very same assembly used by matches. */
export function compareStats(before: KitPartStats, after: KitPartStats): StatComparison[] {
  return STAT_LINES.map(line => {
    const delta = after[line.key] - before[line.key];
    const unchanged = Math.abs(delta) < 0.5 * 10 ** -line.digits;
    return { ...line, before: before[line.key], after: after[line.key], delta,
      change: unchanged ? 'same' : (delta > 0) === line.higherIsBetter ? 'better' : 'worse' };
  });
}

export interface WorkshopFit { token: number; index: number; installed: KitLoadoutIds; candidate: KitLoadoutIds; slot: SlotId; id: string }
/** A cancelled / superseded mechanical job can never commit a profile change. */
export class WorkshopInstallGuard {
  private serial = 0;
  private pending: WorkshopFit | null = null;
  begin(index: number, installed: KitLoadoutIds, slot: SlotId, id: string, budget = FITTING_BUDGET, profile?: ProgressProfile): WorkshopFit | null {
    this.cancel();
    const card = partCards(installed, slot, budget, profile).find(part => part.id === id);
    if (!card || card.status !== 'available') return null;
    return this.pending = { token: this.serial, index, installed: { ...installed }, candidate: replacementKit(installed, slot, id), slot, id };
  }
  cancel(): void { this.serial++; this.pending = null; }
  complete(token: number, index: number, installed: KitLoadoutIds): WorkshopFit | null {
    const job = this.pending;
    if (!job || job.token !== token || job.index !== index || !sameKit(job.installed, installed)) return null;
    this.pending = null;
    return job;
  }
}

/** A copy with one part swapped when that part assembles within budget; otherwise the loadout unchanged. */
export function fitPart(ids: KitLoadoutIds, slot: SlotId, id: string, budget = FITTING_BUDGET): KitLoadoutIds {
  const card = partCards(ids, slot, budget).find(c => c.id === id);
  return card && (card.status === 'available' || card.status === 'fitted') ? replacementKit(ids, slot, id) : ids;
}
