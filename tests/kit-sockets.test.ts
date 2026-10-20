/**
 * Kit sockets (W1-KIT): shared frames across variants, class compatibility and the design rules the sockets
 * encode (track channel, fender clearance, exhaust placement, trunnion at the front face, roof behind the
 * mantlet, the tube tail inside the mantlet).
 */
import { describe, expect, it } from 'vitest';
import { assembleKit, KIT_PART_IDS, legalKitLoadouts, type KitLoadout } from '../src/game/kit';
import { kitContext, kitGeometry } from '../src/game/kit/build';
import { GEARS, HULLS, TURRETS, WEAPONS } from '../src/game/kit/parts';
import {
  classInRange, HULL_RING_RANGE, RING_FRAME, RING_RADIUS, SENSOR_POSITION, SPONSON_UNDERSIDE, TRACK_CHANNEL_MARGIN, TUBE_TAIL_Z, TURRET_RING_CLASS,
  TURRET_TRUNNION_RANGE, WEAPON_CLASS,
} from '../src/game/kit/sockets';

const BASE: KitLoadout = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };

describe('kit sockets', () => {
  it('shares the turret-ring frame across every hull and the station frames across every hull per gear', () => {
    for (const l of legalKitLoadouts()) {
      const a = assembleKit(l);
      expect(a.frames.turretRing.position).toEqual([...RING_FRAME]);
      expect(a.frames.turretRing.rotation).toEqual([0, 0, 0, 1]);
      expect(a.frames.sensor.position).toEqual([...SENSOR_POSITION]);
    }
    for (const gear of KIT_PART_IDS.runningGear) {
      const ref = assembleKit({ ...BASE, runningGear: gear });
      for (const hull of KIT_PART_IDS.hull) {
        const a = assembleKit({ ...BASE, hull, runningGear: gear });
        expect(a.running.stations).toEqual(ref.running.stations);
        expect(a.running.sprocket).toEqual(ref.running.sprocket);
        expect(a.running.idler).toEqual(ref.running.idler);
      }
    }
  });

  it('shares each turret\'s trunnion and utility sockets across hulls and weapons, and each weapon\'s muzzle across turrets', () => {
    for (const l of legalKitLoadouts()) {
      const a = assembleKit(l);
      expect(a.frames.trunnion.position).toEqual([...TURRETS[l.turret].spec.trunnion]);
      expect(a.frames.utility.position).toEqual([...TURRETS[l.turret].spec.utility]);
      expect(a.frames.muzzle.position).toEqual([0, 0, WEAPONS[l.weapon].spec.barrelLength]);
      expect(a.weapon.recoilTravel).toBe(WEAPONS[l.weapon].spec.recoilTravel);
    }
    expect(Object.fromEntries(KIT_PART_IDS.weapon.map(w => [w, WEAPONS[w].spec.recoilTravel]))).toEqual({ mortar: 0.06, cannon: 0.105, rail: 0.14, autocannon: 0.065, arc_cannon: 0.09, forge_mortar: 0.12 });
  });

  it('matches ring classes (hull range ∋ turret class) and trunnion classes (turret range ∋ weapon class)', () => {
    expect(HULL_RING_RANGE).toEqual({ skiff: ['S', 'M'], warden: ['S', 'L'], bastion: ['M', 'L'], aether_hull: ['S', 'M'], forge_hull: ['M', 'L'] });
    for (const l of legalKitLoadouts()) {
      expect(classInRange(TURRET_RING_CLASS[l.turret], HULL_RING_RANGE[l.hull])).toBe(true);
      expect(classInRange(WEAPON_CLASS[l.weapon], TURRET_TRUNNION_RANGE[l.turret])).toBe(true);
      expect(kitContext(l).ringRadius).toBe(RING_RADIUS[TURRET_RING_CLASS[l.turret]]);
    }
  });

  it('keeps the track channel clear: lower-hull half-width = c − w/2 − 0.015, fender underside ≥ top run + 0.05', () => {
    for (const gear of KIT_PART_IDS.runningGear) for (const hull of KIT_PART_IDS.hull) {
      const ctx = kitContext({ ...BASE, hull, runningGear: gear }), g = GEARS[gear];
      expect(ctx.lowerHalfWidth).toBeCloseTo(g.halfSpacing - g.width / 2 - TRACK_CHANNEL_MARGIN, 12);
      expect(SPONSON_UNDERSIDE).toBeGreaterThanOrEqual(ctx.topRunY + 0.05 - 1e-9);
      // No hull body piece reaches into the track band below the sponson underside.
      const hullPieces = kitGeometry(ctx, 0).groups.get('hull')!.flatMap(s => s.hulls).filter(p => p.tag === 'hull-body');
      for (const p of hullPieces) if (p.box[1] < SPONSON_UNDERSIDE - 1e-6) expect(Math.max(Math.abs(p.box[0]), Math.abs(p.box[3]))).toBeLessThanOrEqual(ctx.lowerHalfWidth + 1e-6);
    }
  });

  it('places exhausts outside the track band and the idler sweep (deck stacks inboard; rear pipes within |x| ≤ W − r − 0.02)', () => {
    for (const hull of KIT_PART_IDS.hull) for (const gear of KIT_PART_IDS.runningGear) {
      const a = assembleKit({ ...BASE, hull, runningGear: gear }), ctx = kitContext(a.loadout);
      const pieces = kitGeometry(ctx, 0).groups.get('hull')!.flatMap(s => s.hulls).filter(p => p.tag === 'exhaust');
      expect(pieces.length).toBeGreaterThan(0);
      expect(a.frames.exhausts).toHaveLength(2);
      for (const p of pieces) {
        const maxX = Math.max(Math.abs(p.box[0]), Math.abs(p.box[3]));
        // Inboard of the belt's inner edge by at least 2 cm (never over the track band).
        expect(maxX, `${hull}.${gear}`).toBeLessThan(ctx.beltInner - 0.02);
        if (HULLS[hull].spec.exhaustKind === 'rear') expect(maxX).toBeLessThanOrEqual(ctx.lowerHalfWidth - 0.02 + 1e-6);
      }
      for (const e of a.frames.exhausts) expect(Math.abs(e.position[0])).toBeLessThan(ctx.beltInner - 0.04);
    }
  });

  it('puts every trunnion at its turret front face, keeps the roof and utilities behind the mantlet, and seats the tube tail in the mantlet', () => {
    for (const l of legalKitLoadouts()) {
      const ctx = kitContext(l), t = TURRETS[l.turret].spec, geo = kitGeometry(ctx, 0);
      const body = geo.groups.get('turret')!.flatMap(s => s.hulls).filter(p => ['dome', 'wedge-body', 'bustle', 'cupola', 'hatch-ring', 'yoke'].includes(p.tag));
      // Front face: no body piece reaches past the trunnion plane within the mantlet's width.
      for (const p of body) if (Math.min(Math.abs(p.box[0]), Math.abs(p.box[3])) < 0.05) expect(p.box[5], `${l.turret}:${p.tag}`).toBeLessThanOrEqual(t.trunnion[2] + 0.075);
      // The utility socket sits behind z_trunnion − (R_mantlet + 0.03).
      expect(t.utility[2]).toBeLessThan(t.trunnion[2] - (ctx.mantletRadius + 0.03));
      // Tube radius ≤ 0.075 and its full-recoil tail inside the mantlet.
      const w = WEAPONS[l.weapon].spec;
      expect(w.tubeRadius).toBeLessThanOrEqual(0.075);
      expect(Math.hypot(TUBE_TAIL_Z, w.tubeRadius)).toBeLessThan(ctx.mantletRadius);
      const tube = geo.groups.get('barrel')!.flatMap(s => s.hulls);
      for (const p of tube) expect(p.box[2] - w.recoilTravel).toBeGreaterThanOrEqual(TUBE_TAIL_Z - 1e-9);
    }
  });
});
