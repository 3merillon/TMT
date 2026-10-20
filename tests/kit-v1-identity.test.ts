/**
 * Kit legacy mapping (W1-KIT; formerly the W0 v1-identity test). Kit v2 replaced the v1 geometry, so this test
 * no longer pins bit-identity with the pre-kit literals. It pins what legacy callers still rely on:
 * - the Appendix A mapping resolves every v1 loadout to a legal v2 assembly;
 * - the physics stations of the legacy gears (Scout, Grip) keep kit v1's dimensions (halfSpacing 0.55, belt
 *   widths 0.23 / 0.31, half lengths 0.59 / 0.62, r 0.19 at y −0.26, the nine tread-contact stations), so the
 *   8-entry wheelSuspension / treadContacts contract is unchanged;
 * - the Dome keeps kit v1's trunnion (hull [0, 0.4, 0.12] at yaw 0) and the shared sensor, so legacy muzzle
 *   and line-of-sight maths is unchanged;
 * - the legacy helpers (kitWheelOffsets, kitTrunnionPivot, kitTrackHalfLength, kitBumpStops, V1_PROXY) stay
 *   consistent with the assembly; the v1 catalogue and stat derivation are untouched.
 * It imports only the kit (the simulation-side modules change in parallel streams).
 */
import { describe, expect, it } from 'vitest';
import type { Loadout } from '../src/game/contracts';
import { assembleKit, isLegalKitLoadout, kitLoadoutFromLegacy } from '../src/game/kit';
import { assembleLegacy, kitBumpStops, kitTrackHalfLength, kitTrunnionPivot, kitWheelOffsets, V1_PROXY } from '../src/game/kit/assembly';
import { V1_MODULE_CATALOG, v1TankStats } from '../src/game/kit/catalog';
import * as D from '../src/game/kit/dimensions';

const LEGACY: Loadout[] = (['scout', 'grip'] as const).flatMap(tracks => (['mortar', 'cannon', 'rail'] as const)
  .flatMap(barrel => (['light', 'heavy'] as const).map(armor => ({ tracks, barrel, armor }))));

describe('kit legacy mapping', () => {
  it('resolves every v1 loadout to a legal v2 assembly through Appendix A', () => {
    for (const loadout of LEGACY) {
      const kit = kitLoadoutFromLegacy(loadout);
      expect(isLegalKitLoadout(kit)).toBe(true);
      expect(assembleLegacy(loadout)).toBe(assembleKit(kit));
      expect(assembleLegacy({ ...loadout })).toBe(assembleLegacy(loadout));
    }
  });

  it('keeps the legacy gears\' physics stations at the kit v1 dimensions', () => {
    const v1 = { scout: { width: 0.23, halfLength: 0.59 }, grip: { width: 0.31, halfLength: 0.62 } } as const;
    for (const loadout of LEGACY) {
      const a = assembleLegacy(loadout), hl = v1[loadout.tracks].halfLength;
      expect(a.running.halfSpacing).toBe(D.TRACK_HALF_SPACING);
      expect(a.running.trackWidth).toBe(v1[loadout.tracks].width);
      expect(kitTrackHalfLength(a)).toBe(hl);
      // Driver-left (+X) rear→front, then driver-right: the TankState.wheelSuspension order.
      expect(a.running.stations.map(s => [s.side, s.z, s.y0, s.radius])).toEqual(([1, -1] as const).flatMap(side =>
        [0, 1, 2, 3].map(i => [side, D.wheelStationZ(i, hl), D.ROAD_WHEEL_CENTER_Y, D.ROAD_WHEEL_RADIUS])));
      expect(a.running.treadStations).toEqual(D.treadStationsFor(hl));
      expect(a.running.droop).toBe(D.SUSPENSION_MAX_DROOP);
      expect(a.running.compression).toBe(D.SUSPENSION_MAX_COMPRESSION);
      expect(kitWheelOffsets(a)).toEqual(a.running.stations.map(s => [s.side * D.TRACK_HALF_SPACING, D.SUPPORT_GROUND_Y, s.z]));
      expect(kitWheelOffsets(a)).toBe(kitWheelOffsets(a));
    }
  });

  it('keeps the Dome trunnion and the shared sensor of kit v1 (legacy muzzle and sight maths)', () => {
    for (const loadout of LEGACY) {
      const a = assembleLegacy(loadout);
      expect(a.frames.turretRing.position).toEqual([...D.TURRET_RING]);
      expect(a.frames.trunnion.position).toEqual([...D.TRUNNION]);
      expect(a.frames.sensor.position).toEqual([...D.SENSOR]);
      expect(kitTrunnionPivot(a)).toEqual({ axisPoint: [0, 0.4, -0.08], forward: 0.2 });
      // Barrel lengths (muzzle frame) equal the v1 catalogue lengths the simulation still reads.
      expect(a.frames.muzzle.position[2]).toBe(V1_MODULE_CATALOG.barrel[loadout.barrel].length);
      expect(a.weapon.barrelLength).toBe(D.WEAPON_DIMENSIONS[loadout.barrel].length);
    }
  });

  it('keeps the v1 proxy layout that tank-collision reads (hull, armour, fenders, turret, mantlet, sleeve, tube)', () => {
    const a = assembleLegacy({ tracks: 'grip', barrel: 'cannon', armor: 'heavy' });
    expect(V1_PROXY).toEqual({ hull: 0, armor: 1, fender: [2, 3], turret: 4, breech: 5, sleeve: 6, shaft: 7 });
    expect(a.proxies.slice(0, 4).map(p => p.parent)).toEqual(['hull', 'hull', 'hull', 'hull']);
    expect(a.proxies[V1_PROXY.armor].box.rotation).toBeDefined();
    expect(a.proxies[V1_PROXY.fender[0]].box.center[0]).toBeGreaterThan(0);
    expect(a.proxies[V1_PROXY.fender[1]].box.center[0]).toBeLessThan(0);
    expect(a.proxies[V1_PROXY.turret].parent).toBe('turret');
    for (const i of [V1_PROXY.breech, V1_PROXY.sleeve, V1_PROXY.shaft]) expect(a.proxies[i].parent).toBe('cradle');
    // The tube box reaches the muzzle.
    const tube = a.proxies[V1_PROXY.shaft].box;
    expect(tube.center[2] + tube.half[2]).toBeGreaterThanOrEqual(a.weapon.barrelLength);
    expect(kitBumpStops(a)).toEqual([-1, 1].map(side => ({ center: [side * 0.55, D.BUMP_STOP.y, 0], half: [0.31 / 2, D.BUMP_STOP.halfHeight, D.BUMP_STOP.halfLength] })));
  });

  it('leaves the v1 catalogue and stat derivation untouched', () => {
    expect(v1TankStats({ tracks: 'scout', barrel: 'mortar', armor: 'light' })).toMatchObject({ mass: 9.3, minSpeed: 1.8, maxSpeed: 12.6, maxHealth: 100 });
    expect(v1TankStats({ tracks: 'grip', barrel: 'rail', armor: 'heavy' })).toMatchObject({ mass: 15.1, minSpeed: 2.8, maxSpeed: 23, maxHealth: 130, mitigation: 0.12 });
  });
});
