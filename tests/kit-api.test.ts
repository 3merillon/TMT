/**
 * Kit API (W0-KIT, W1-KIT): ids and socket validation, the Appendix A mapping, tankKit, assembly caching and
 * immutability, v2 stats, and the renderer-agnostic, deterministic boundary of src/game/kit.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Loadout, TankState } from '../src/game/contracts';
import {
  assembleKit, buildKitMesh, createKitPose, isLegalKitLoadout, KIT_PART_IDS, KIT_SLOTS, KitError, kitKey, kitLoadoutFromLegacy, kitLoadoutToLegacy,
  legalKitLoadouts, poseKit, tankKit, validateKitLoadout, type KitLoadout, type KitLoadoutIdsLike,
} from '../src/game/kit';
import { socketMismatch } from '../src/game/kit/sockets';
import { SPEED_SCALE } from '../src/game/kit/handling';

const LEGACY: Loadout[] = (['scout', 'grip'] as const).flatMap(tracks => (['mortar', 'cannon', 'rail'] as const)
  .flatMap(barrel => (['light', 'heavy'] as const).map(armor => ({ tracks, barrel, armor }))));
const WARDEN: KitLoadout = { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };
function tank(loadout: Loadout, kit?: KitLoadoutIdsLike): TankState & { kit?: KitLoadoutIdsLike } {
  return { id: 0, position: [0, 18.5, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: 0, power: .5, health: 100,
    charge: 0, movement: 0, recoil: 0, suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0],
    trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0, wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-1.2), loadout, ...(kit ? { kit } : {}) };
}

describe('kit api', () => {
  it('maps every legacy loadout through plan Appendix A and back', () => {
    for (const loadout of LEGACY) {
      const kit = kitLoadoutFromLegacy(loadout);
      expect(kit).toEqual({ hull: loadout.armor === 'light' ? 'warden' : 'bastion', runningGear: loadout.tracks, turret: 'dome', weapon: loadout.barrel, utility: 'antenna' });
      expect(kitLoadoutFromLegacy({ ...loadout })).toBe(kit);
      expect(Object.isFrozen(kit)).toBe(true);
      expect(kitLoadoutToLegacy(kit)).toEqual(loadout);
      // Every mapped loadout is legal (the dome takes every weapon class).
      expect(isLegalKitLoadout(kit)).toBe(true);
    }
    expect(kitLoadoutToLegacy({ hull: 'skiff', runningGear: 'crawler', turret: 'wedge', weapon: 'rail', utility: 'radar' })).toEqual({ tracks: 'grip', barrel: 'rail', armor: 'light' });
    for (const bad of [null, {}, { tracks: 'scout', barrel: 'mortar' }, { tracks: 'tank', barrel: 'mortar', armor: 'light' }, { tracks: '__proto__', barrel: 'constructor', armor: 'toString' }]) {
      expect(() => kitLoadoutFromLegacy(bad as unknown as Loadout)).toThrow(KitError);
    }
  });

  it('validates ids per slot and rejects unknown ones', () => {
    for (const slot of KIT_SLOTS) {
      for (const bad of ['', 'Warden', 'ironside', 7, undefined]) {
        let error: unknown;
        try { validateKitLoadout({ ...WARDEN, [slot]: bad } as unknown as KitLoadoutIdsLike); } catch (caught) { error = caught; }
        expect(error, `${slot}=${String(bad)}`).toBeInstanceOf(KitError);
        expect((error as KitError).slot).toBe(slot);
        expect((error as KitError).message).toContain(slot);
      }
    }
    expect(() => validateKitLoadout(null as unknown as KitLoadoutIdsLike)).toThrow(KitError);
    expect(KIT_PART_IDS).toEqual({
      hull: ['skiff', 'warden', 'bastion', 'aether_hull', 'forge_hull'], runningGear: ['scout', 'grip', 'crawler', 'aether_drive', 'forge_tracks'],
      turret: ['dome', 'wedge', 'cradle', 'aether_crown', 'forge_casemate'], weapon: ['mortar', 'cannon', 'rail', 'autocannon', 'arc_cannon', 'forge_mortar'],
      utility: ['antenna', 'radar', 'periscope', 'smoke', 'whip_short', 'yagi', 'point_defense', 'aether_vane', 'steam_sentinel'],
    });
  });

  it('rejects socket mismatches (ring class hull × turret, trunnion class turret × weapon) with the slot named', () => {
    // Bastion's ring is M–L; the open cradle needs S.
    expect(socketMismatch('bastion', 'cradle', 'mortar')?.slot).toBe('turret');
    // The cradle's trunnion takes S–M; the rail is L. The wedge takes M–L; the mortar is S.
    expect(socketMismatch('warden', 'cradle', 'rail')?.slot).toBe('weapon');
    expect(socketMismatch('warden', 'wedge', 'mortar')?.slot).toBe('weapon');
    let error: unknown;
    try { validateKitLoadout({ ...WARDEN, hull: 'bastion', turret: 'cradle' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(KitError);
    expect((error as KitError).slot).toBe('turret');
    expect((error as KitError).message).toMatch(/socket mismatch/);
    expect(() => assembleKit({ ...WARDEN, turret: 'cradle', weapon: 'rail' })).toThrow(/socket mismatch/);
    // Legal set: 5 gears × 9 utilities × 104 legal (hull, turret, weapon) triples.
    const legal = legalKitLoadouts();
    expect(legal).toHaveLength(4680);
    for (const l of legal) expect(isLegalKitLoadout(l)).toBe(true);
    for (const slot of KIT_SLOTS) for (const id of KIT_PART_IDS[slot]) expect(legal.some(l => l[slot] === id), `${slot}:${id}`).toBe(true);
  });

  it('assembles every legal loadout and caches deep-frozen assemblies by key', () => {
    const a = assembleKit(WARDEN);
    expect(a.key).toBe('warden.scout.dome.mortar.antenna');
    expect(kitKey(WARDEN)).toBe(a.key);
    expect(assembleKit({ ...WARDEN })).toBe(a);
    expect(assembleKit(kitLoadoutFromLegacy({ tracks: 'scout', barrel: 'mortar', armor: 'light' }))).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.running.stations[0])).toBe(true);
    expect(() => { (a.frames.muzzle.position as number[])[2] = 9; }).toThrow();
    for (const l of legalKitLoadouts()) {
      const k = assembleKit(l);
      expect(k.loadout).toEqual(l);
      expect(k.running.stations).toHaveLength(8);
    }
  });

  it('derives the v2 stats from the parts (Experience §1.11) and keeps kit v1 ballistics', () => {
    const a = assembleKit({ hull: 'skiff', runningGear: 'scout', turret: 'cradle', weapon: 'mortar', utility: 'antenna' });
    // Experience §1.11 example: mass 8.1, speed 5.8, fuel 10.7. The top speed carries the R6 fallback scale
    // (handling.ts): 5.83 × 0.88 = 5.13.
    expect(a.stats.mass).toBeCloseTo(8.1, 10);
    expect(a.stats.speed / SPEED_SCALE).toBeCloseTo(5.8, 1);
    expect(a.stats.speed).toBeCloseTo(5.0 * Math.sqrt(11 / 8.1) * 0.88, 10);
    expect(a.stats.fuel).toBeCloseTo(10.7, 1);
    expect(a.stats.hp).toBe(90);
    expect(a.stats.tempo).toBeCloseTo(0.92 * 0.95 * 1.0, 12);
    expect(a.stats.cost).toBe(2 + 2 + 2 + 2 + 1);
    expect(a.stats.climbDeg).toBe(32);
    expect(assembleKit({ ...WARDEN, weapon: 'rail' }).stats.hp).toBe(130); // Warden 120 + Dome 10
    // Today's launch speeds, blast, damage and recoil exactly (ballistics are GAME's).
    const v1 = { mortar: [1.8, 12.6, 2.6, 61, 1.7], cannon: [2.2, 16, 2.25, 70, 2.5], rail: [2.8, 23, 2, 88, 4.2] } as const;
    for (const weapon of ['mortar', 'cannon', 'rail'] as const) {
      const s = assembleKit({ ...WARDEN, weapon }).stats;
      expect([s.minSpeed, s.maxSpeed, s.blastRadius, s.damage, s.recoil]).toEqual([...v1[weapon]]);
    }
    expect(assembleKit({ ...WARDEN, hull: 'bastion' }).stats.mitigation).toBe(0.25);
  });

  it('reads a tank kit through tankKit: explicit ids when present, else the legacy mapping', () => {
    const legacy: Loadout = { tracks: 'grip', barrel: 'rail', armor: 'heavy' };
    expect(tankKit(tank(legacy))).toBe(kitLoadoutFromLegacy(legacy));
    const explicit = { hull: 'skiff', runningGear: 'crawler', turret: 'wedge', weapon: 'rail', utility: 'radar' };
    expect(tankKit(tank(legacy, explicit))).toEqual(explicit);
    expect(assembleKit(tankKit(tank(legacy, explicit))).key).toBe('skiff.crawler.wedge.rail.radar');
    expect(() => tankKit(tank(legacy, { ...explicit, hull: 'tank' }))).toThrow(KitError);
  });

  it('produces mesh and pose data through the public barrel', () => {
    const a = assembleKit(WARDEN), mesh = buildKitMesh(a, 0), pose = createKitPose(a);
    poseKit(a, tank({ tracks: 'scout', barrel: 'mortar', armor: 'light' }), pose);
    expect(mesh.key).toBe(a.key);
    expect(mesh.parts.length).toBeGreaterThan(8);
    expect(pose.joints.get('turret')).toHaveLength(16);
    expect(pose.linkInstances.length).toBeGreaterThan(0);
  });

  it('keeps src/game/kit renderer-agnostic and deterministic: no three, DOM, clocks or randomness', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const file of walk('src/game/kit')) {
      const text = code(readFileSync(file, 'utf8'));
      expect(text, file).not.toMatch(/from ['"]three/);
      expect(text, file).not.toMatch(/\b(window|document|localStorage|requestAnimationFrame)\./);
      expect(text, file).not.toMatch(/\bDate\.now\(|new Date\(|Math\.random\(/);
      if (!file.endsWith('validate.ts')) expect(text, file).not.toMatch(/performance\.now\(/);
      expect(text, file).not.toMatch(/from ['"](\.\.\/)+engine\//);
    }
    expect(readFileSync('src/game/kit/types.ts', 'utf8').split('\n')[0]).toBe('// @contract v1 — docs/architecture.md#contracts-and-invariants');
  });
});
