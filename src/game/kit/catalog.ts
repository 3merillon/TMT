/**
 * Kit part catalogue (W0-KIT, W1-KIT): part ids, validation (ids and sockets), the legacy mapping and stats.
 *
 * - `V1_MODULE_CATALOG` / `v1TankStats`: the v1 gameplay catalogue and stat derivation, unchanged (modules.ts
 *   re-exports them for the legacy simulation until W1-GAME switches to `assembleKit(...).stats`).
 * - `kitStats`: the v2 derivation (Experience §1.11): mass = Σ parts, mobility = √(11/mass), speed and fuel
 *   from the gear, HP = hull + turret bonus, tempo = hull × turret × weapon. Launch speeds, blast, damage
 *   and recoil stay kit v1's exactly (ballistics are GAME's).
 * Pure data and functions: safe for the simulation.
 */
import type { Loadout } from '../contracts';
import { WEAPON_DIMENSIONS } from './dimensions';
import { socketMismatch } from './sockets';
import type { GearId, HullId, KitLoadout, KitLoadoutIdsLike, KitPartStats, SlotId, TurretId, UtilityId, WeaponId } from './types';

/** Thrown for unknown ids, unimplemented parts and socket mismatches. */
export class KitError extends Error {
  constructor(message: string, readonly slot?: SlotId, readonly id?: string) { super(message); this.name = 'KitError'; }
}

export const KIT_SLOTS: readonly SlotId[] = Object.freeze(['hull', 'runningGear', 'turret', 'weapon', 'utility']);

/** Every id that validates (plan Appendix A, Wave 1 set). */
export const KIT_PART_IDS = Object.freeze({
  hull: Object.freeze(['skiff', 'warden', 'bastion', 'aether_hull', 'forge_hull'] as const),
  runningGear: Object.freeze(['scout', 'grip', 'crawler', 'aether_drive', 'forge_tracks'] as const),
  turret: Object.freeze(['dome', 'wedge', 'cradle', 'aether_crown', 'forge_casemate'] as const),
  weapon: Object.freeze(['mortar', 'cannon', 'rail', 'autocannon', 'arc_cannon', 'forge_mortar'] as const),
  utility: Object.freeze(['antenna', 'radar', 'periscope', 'smoke', 'whip_short', 'yagi', 'point_defense', 'aether_vane', 'steam_sentinel'] as const),
}) satisfies Record<SlotId, readonly string[]>;

/** The legacy-mapped subset (the only ids that assembled in Wave 0). Every Wave-1 id assembles since W1-KIT. */
export const KIT_W0_PARTS = Object.freeze({
  hull: Object.freeze(['warden', 'bastion'] as const),
  runningGear: Object.freeze(['scout', 'grip'] as const),
  turret: Object.freeze(['dome'] as const),
  weapon: Object.freeze(['mortar', 'cannon', 'rail'] as const),
  utility: Object.freeze(['antenna'] as const),
}) satisfies Record<SlotId, readonly string[]>;
export type W0HullId = typeof KIT_W0_PARTS.hull[number];
export type W0GearId = typeof KIT_W0_PARTS.runningGear[number];

/** Canonical equipment has no purchase, rarity, skin, or account fields. */
export const V1_MODULE_CATALOG = {
  tracks: {
    scout: { name: 'Scout tracks', cost: 2, mass: 2, speed: 4.6, grip: 5, moveDistance: 7.5, description: 'Fast relocation; less lateral grip.' },
    grip: { name: 'Grip tracks', cost: 3, mass: 3, speed: 3.5, grip: 10, moveDistance: 6, description: 'Stable on slopes and under recoil; slower.' },
  },
  barrel: {
    mortar: { name: 'Arc mortar', cost: 2, mass: 1.8, minSpeed: 1.8, maxSpeed: 12.6, blastRadius: 2.6, damage: 61, recoil: 1.7, length: WEAPON_DIMENSIONS.mortar.length, description: 'Broad blast and a controllable high arc.' },
    cannon: { name: 'Field cannon', cost: 3, mass: 2.4, minSpeed: 2.2, maxSpeed: 16, blastRadius: 2.25, damage: 70, recoil: 2.5, length: WEAPON_DIMENSIONS.cannon.length, description: 'Stronger direct hits; a smaller crater.' },
    rail: { name: 'Rail lance', cost: 5, mass: 3.6, minSpeed: 2.8, maxSpeed: 23, blastRadius: 2, damage: 88, recoil: 4.2, length: WEAPON_DIMENSIONS.rail.length, description: 'Fast, precise and heavy; a narrow blast.' },
  },
  armor: {
    light: { name: 'Light hull', cost: 1, mass: 1.5, maxHealth: 100, mitigation: 0, description: 'Mobile and responsive.' },
    heavy: { name: 'Heavy hull', cost: 3, mass: 4.5, maxHealth: 130, mitigation: 0.12, description: 'More protection; greater mass slows relocation.' },
  },
} as const;

/** Longitudinal / lateral track traction per v1 gear (formerly inline in getTankStats). */
export const V1_TRACTION = Object.freeze({
  scout: Object.freeze({ traction: 1.7, lateralTraction: 1.5 }),
  grip: Object.freeze({ traction: 3, lateralTraction: 2.4 }),
});

export interface V1TankStats {
  cost: number; mass: number; speed: number; grip: number; moveDistance: number;
  traction: number; lateralTraction: number; motorAcceleration: number;
  minSpeed: number; maxSpeed: number; blastRadius: number; damage: number;
  recoil: number; barrelLength: number; maxHealth: number; mitigation: number;
}

/** The v1 stat derivation (unchanged operation order); callers validate the loadout first. */
export function v1TankStats(loadout: Loadout): V1TankStats {
  const tracks = V1_MODULE_CATALOG.tracks[loadout.tracks];
  const barrel = V1_MODULE_CATALOG.barrel[loadout.barrel];
  const armor = V1_MODULE_CATALOG.armor[loadout.armor];
  const mass = 4 + tracks.mass + barrel.mass + armor.mass;
  const mobility = Math.sqrt(9.3 / mass);
  const traction = V1_TRACTION[loadout.tracks];
  return {
    cost: tracks.cost + barrel.cost + armor.cost, mass,
    speed: tracks.speed * mobility, grip: tracks.grip, moveDistance: tracks.moveDistance * mobility,
    traction: traction.traction, lateralTraction: traction.lateralTraction,
    motorAcceleration: 12 * mobility,
    minSpeed: barrel.minSpeed, maxSpeed: barrel.maxSpeed, blastRadius: barrel.blastRadius,
    damage: barrel.damage, recoil: barrel.recoil, barrelLength: barrel.length,
    maxHealth: armor.maxHealth, mitigation: armor.mitigation,
  };
}

const NO_STATS: KitPartStats = Object.freeze({ cost: 0, mass: 0, hp: 0, tempo: 1, speed: 0, fuel: 0, climbDeg: 0,
  traction: 0, lateralTraction: 0, minSpeed: 0, maxSpeed: 0, blastRadius: 0, damage: 0, recoil: 0, mitigation: 0 });
const part = (stats: Partial<KitPartStats>): KitPartStats => Object.freeze({ ...NO_STATS, ...stats });
const { tracks: T, barrel: B, armor: A } = V1_MODULE_CATALOG;

/**
 * Per-part v1 stats in kit vocabulary. Gear `speed`/`fuel` are the base values before the mobility
 * factor; `tempo` is a neutral multiplier (1) and `climbDeg` is not modelled in v1 (0).
 */
export const KIT_V1_PART_STATS = Object.freeze({
  hull: Object.freeze({
    warden: part({ cost: A.light.cost, mass: A.light.mass, hp: A.light.maxHealth, mitigation: A.light.mitigation }),
    bastion: part({ cost: A.heavy.cost, mass: A.heavy.mass, hp: A.heavy.maxHealth, mitigation: A.heavy.mitigation }),
  }),
  runningGear: Object.freeze({
    scout: part({ cost: T.scout.cost, mass: T.scout.mass, speed: T.scout.speed, fuel: T.scout.moveDistance, ...V1_TRACTION.scout }),
    grip: part({ cost: T.grip.cost, mass: T.grip.mass, speed: T.grip.speed, fuel: T.grip.moveDistance, ...V1_TRACTION.grip }),
  }),
  turret: Object.freeze({ dome: part({}) }),
  weapon: Object.freeze({
    mortar: part({ cost: B.mortar.cost, mass: B.mortar.mass, minSpeed: B.mortar.minSpeed, maxSpeed: B.mortar.maxSpeed, blastRadius: B.mortar.blastRadius, damage: B.mortar.damage, recoil: B.mortar.recoil }),
    cannon: part({ cost: B.cannon.cost, mass: B.cannon.mass, minSpeed: B.cannon.minSpeed, maxSpeed: B.cannon.maxSpeed, blastRadius: B.cannon.blastRadius, damage: B.cannon.damage, recoil: B.cannon.recoil }),
    rail: part({ cost: B.rail.cost, mass: B.rail.mass, minSpeed: B.rail.minSpeed, maxSpeed: B.rail.maxSpeed, blastRadius: B.rail.blastRadius, damage: B.rail.damage, recoil: B.rail.recoil }),
  }),
  utility: Object.freeze({ antenna: part({}) }),
});

/**
 * Throws KitError on a non-object, a missing slot, an unknown id or a socket mismatch (ring class between
 * hull and turret, trunnion class between turret and weapon; see sockets.ts). Returns a fresh loadout.
 */
export function validateKitLoadout(ids: KitLoadoutIdsLike): KitLoadout {
  if (ids === null || typeof ids !== 'object') throw new KitError('kit loadout must be an object');
  const record = ids as unknown as Record<string, unknown>;
  for (const slot of KIT_SLOTS) {
    const id = record[slot];
    if (typeof id !== 'string' || !(KIT_PART_IDS[slot] as readonly string[]).includes(id)) {
      throw new KitError(`unknown ${slot} id '${String(id)}'`, slot, typeof id === 'string' ? id : undefined);
    }
  }
  const mismatch = socketMismatch(record.hull as HullId, record.turret as TurretId, record.weapon as WeaponId);
  if (mismatch) throw new KitError(mismatch.message, mismatch.slot, record[mismatch.slot] as string);
  if (record.armor !== undefined && record.armor !== 'standard' && record.armor !== 'reactive') throw new KitError(`unknown armor id '${String(record.armor)}'`);
  if (record.armor === 'reactive' && record.hull !== 'bastion') throw new KitError('Reactive armor requires the Bastion hull', 'hull');
  return { hull: record.hull as HullId, runningGear: record.runningGear as GearId, turret: record.turret as TurretId,
    weapon: record.weapon as WeaponId, utility: record.utility as UtilityId, ...(record.armor === 'reactive' ? { armor: 'reactive' as const } : {}) };
}

/** Whether a set of ids is a legal kit loadout (known ids and matching sockets), without throwing. */
export function isLegalKitLoadout(ids: KitLoadoutIdsLike): boolean {
  try { validateKitLoadout(ids); return true; } catch { return false; }
}

/** Every legal standard-armor loadout (ids × socket rules), in slot order. Bastion builds also accept reactive armor. */
export function legalKitLoadouts(): KitLoadout[] {
  const out: KitLoadout[] = [];
  for (const hull of KIT_PART_IDS.hull) for (const runningGear of KIT_PART_IDS.runningGear) for (const turret of KIT_PART_IDS.turret)
    for (const weapon of KIT_PART_IDS.weapon) for (const utility of KIT_PART_IDS.utility) {
      if (!socketMismatch(hull, turret, weapon)) out.push({ hull, runningGear, turret, weapon, utility });
    }
  return out;
}

const LEGACY_HULL: Record<Loadout['armor'], HullId> = { light: 'warden', heavy: 'bastion' };
type Table<T> = Record<string, T | undefined>;
/** tracks → barrel → armor → frozen kit loadout; null-prototype tables so odd keys never resolve. */
const legacyKits: Table<Table<Table<KitLoadout>>> = Object.create(null);
for (const tracks of ['scout', 'grip'] as const) for (const barrel of ['mortar', 'cannon', 'rail'] as const) for (const armor of ['light', 'heavy'] as const) {
  const byBarrel = legacyKits[tracks] ??= Object.create(null) as Table<Table<KitLoadout>>;
  const byArmor = byBarrel[barrel] ??= Object.create(null) as Table<KitLoadout>;
  byArmor[armor] = Object.freeze({ hull: LEGACY_HULL[armor], runningGear: tracks, turret: 'dome', weapon: barrel, utility: 'antenna' });
}

/** Plan Appendix A: armor light→warden, heavy→bastion; tracks→gear; barrel→weapon; turret dome; utility antenna. Returns a shared frozen loadout. */
export function kitLoadoutFromLegacy(l: Loadout): KitLoadout {
  const kit = l !== null && typeof l === 'object' ? legacyKits[l.tracks]?.[l.barrel]?.[l.armor] : undefined;
  if (!kit) throw new KitError(`invalid legacy loadout ${JSON.stringify(l)}`);
  return kit;
}

/** Nearest legacy (v1 `Loadout`) equivalent of a kit loadout, for adapters that still take a Loadout. */
export function kitLoadoutToLegacy(k: KitLoadout): Loadout {
  return { tracks: k.runningGear === 'scout' ? 'scout' : 'grip', barrel: k.weapon === 'autocannon' || k.weapon === 'arc_cannon' ? 'cannon' : k.weapon === 'forge_mortar' ? 'mortar' : k.weapon, armor: k.hull === 'bastion' || k.hull === 'forge_hull' ? 'heavy' : 'light' };
}
