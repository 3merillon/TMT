/**
 * Kit mass properties (W1-KIT): mass = Σ part masses, the arcade keel, COM y ≤ −0.20, tip ≥ 60°, pitch-over
 * ≥ 55° for every legal assembly; the COM and inertia respond to the parts the way a player expects.
 */
import { describe, expect, it } from 'vitest';
import { assembleKit, legalKitLoadouts } from '../src/game/kit';
import { kitContext } from '../src/game/kit/build';
import { INERTIA_FLOOR_PER_MASS, SPEED_SCALE } from '../src/game/kit/handling';
import { ARCADE_KEEL, COM_TARGET_Z, massProperties } from '../src/game/kit/mass';
import { massReport } from '../src/game/kit/validate';

const ALL = legalKitLoadouts();

describe('kit mass', () => {
  it('keeps every legal assembly low, stable and trimmed', () => {
    let worst = { comY: -Infinity, tip: Infinity, over: Infinity };
    for (const l of ALL) {
      const a = assembleKit(l), r = massReport(a);
      expect(r.comY, a.key).toBeLessThanOrEqual(-0.2);
      expect(r.tipDeg, a.key).toBeGreaterThanOrEqual(60);
      expect(r.pitchOverDeg, a.key).toBeGreaterThanOrEqual(55);
      expect(a.massProps.com[0]).toBe(0);
      expect(r.comZ).toBeCloseTo(COM_TARGET_Z, 6);
      worst = { comY: Math.max(worst.comY, r.comY), tip: Math.min(worst.tip, r.tipDeg), over: Math.min(worst.over, r.pitchOverDeg) };
    }
    expect(worst.comY).toBeLessThan(-0.2);
  });

  it('sums the part masses and moves ARCADE_KEEL of the above-belt mass into the keel', () => {
    for (const l of ALL.filter((_, i) => i % 7 === 0)) {
      const a = assembleKit(l), ctx = kitContext(l), p = massProperties(ctx);
      const parts = [ctx.hull, ctx.gear, ctx.turret, ctx.weapon, ctx.utility].reduce((s, x) => s + x.stats.mass, 0);
      expect(a.massProps.mass).toBeCloseTo(parts, 9);
      expect(a.massProps.mass).toBeCloseTo(a.stats.mass, 9);
      expect(p.keel.mass).toBeCloseTo((parts - ctx.gear.stats.mass) * ARCADE_KEEL, 9);
      // The keel stays inside the lower hull.
      expect(p.keel.center[1] - p.keel.half[1]).toBeGreaterThanOrEqual(-0.2801);
      expect(p.keel.half[0]).toBeLessThan(ctx.lowerHalfWidth);
      for (const v of a.massProps.inertia) expect(v).toBeGreaterThan(0);
      // A tank is long and wide but flat: the yaw inertia (about y) is the largest.
      const [ix, iy, iz] = a.massProps.inertia;
      expect(iy).toBeGreaterThan(ix);
      expect(iy).toBeGreaterThan(iz);
    }
  });

  it('responds to the parts: heavier hulls and weapons weigh more, inertia follows', () => {
    const base = { runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' } as const;
    const skiff = assembleKit({ ...base, hull: 'skiff' }), warden = assembleKit({ ...base, hull: 'warden' }), bastion = assembleKit({ ...base, hull: 'bastion' });
    expect(skiff.massProps.mass).toBeLessThan(warden.massProps.mass);
    expect(warden.massProps.mass).toBeLessThan(bastion.massProps.mass);
    const mortar = assembleKit({ ...base, hull: 'warden', weapon: 'mortar' }), rail = assembleKit({ ...base, hull: 'warden', weapon: 'rail' });
    expect(rail.massProps.mass).toBeGreaterThan(mortar.massProps.mass);
    // Inertia grows with mass for the same layout.
    expect(bastion.massProps.inertia[1]).toBeGreaterThan(skiff.massProps.inertia[1]);
  });

  it('keeps kit v1 handling proportions for the vehicle model (R6 fallback, handling.ts)', () => {
    expect([...INERTIA_FLOOR_PER_MASS]).toEqual([0.45, 0.5, 0.24]);
    expect(SPEED_SCALE).toBe(0.88);
    for (const l of ALL) {
      const a = assembleKit(l), ctx = kitContext(l), p = massProperties(ctx);
      for (let k = 0; k < 3; k++) {
        // The floor or the part-box value, whichever is larger (today the floor on every axis: the keel halves the box value).
        expect(a.massProps.inertia[k]).toBeCloseTo(Math.max(p.boxInertia[k], a.massProps.mass * INERTIA_FLOOR_PER_MASS[k]), 12);
        expect(p.boxInertia[k]).toBeGreaterThan(0);
        expect(p.boxInertia[k]).toBeLessThan(a.massProps.inertia[k] + 1e-12);
      }
      // Top speed: the Experience §1.11 formula × SPEED_SCALE; the legacy default build drives at kit v1's 4.6 u/s.
      expect(a.stats.speed).toBeCloseTo((ctx.gear.stats.speed ?? 0) * Math.sqrt(11 / a.stats.mass) * SPEED_SCALE, 12);
    }
    const v1Default = assembleKit({ hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' });
    expect(v1Default.stats.speed).toBeGreaterThan(4.55);
    expect(v1Default.stats.speed).toBeLessThan(4.65);
  });
});
