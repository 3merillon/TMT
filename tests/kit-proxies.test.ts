/**
 * Collision proxies (W1-KIT): every non-cosmetic validation piece of the render mesh lies within 5 mm of the
 * proxy boxes (hull / turret / cradle, posed) ∪ the pose-dependent running-gear envelope, over the suspension
 * extremes, hatch, utility head and recoil states, for every (hull, gear, turret, weapon) and every utility.
 * Also: the v1 proxy layout, finite boxes no longer than the fenders (2.4 m), and the running envelope
 * follows the wheels.
 */
import { describe, expect, it } from 'vitest';
import { assembleKit, KIT_PART_IDS, kitRunningEnvelope, legalKitLoadouts, V1_PROXY } from '../src/game/kit';
import { kitContext } from '../src/game/kit/build';
import { BELT_SHOE, SUSPENSION } from '../src/game/kit/running';
import { checkContainment, CONTAINMENT_TOLERANCE } from '../src/game/kit/validate';

const UTILITIES = KIT_PART_IDS.utility;
/** Every (hull, gear, turret, weapon) once, the utility rotating so that each meets every hull and turret. */
const COVER = legalKitLoadouts()
  .filter((l, i, list) => list.findIndex(o => o.hull === l.hull && o.runningGear === l.runningGear && o.turret === l.turret && o.weapon === l.weapon) === i)
  .map((l, i) => ({ ...l, utility: UTILITIES[i % UTILITIES.length] }));

describe('kit proxies', () => {
  it('contain the render geometry within 5 mm over the suspension, hatch, head and recoil states', () => {
    expect(CONTAINMENT_TOLERANCE).toBe(0.005);
    let worst = 0;
    for (const l of COVER) {
      const a = assembleKit(l), r = checkContainment(a);
      expect(r.points, a.key).toBeGreaterThan(1000);
      expect(r.outside, a.key).toEqual([]);
      worst = Math.max(worst, r.worst);
    }
    expect(worst).toBeLessThanOrEqual(CONTAINMENT_TOLERANCE);
    // Every utility met every turret.
    for (const turret of KIT_PART_IDS.turret) for (const utility of UTILITIES) expect(COVER.some(l => l.turret === turret && l.utility === utility), `${turret}+${utility}`).toBe(true);
  });

  it('keep the v1 layout, parents and compact boxes', () => {
    for (const l of COVER.filter((_, i) => i % 5 === 0)) {
      const a = assembleKit(l), p = a.proxies;
      expect(p.length).toBeGreaterThan(8);
      expect(p[V1_PROXY.hull].parent).toBe('hull');
      expect(p[V1_PROXY.turret].parent).toBe('turret');
      for (const i of [V1_PROXY.breech, V1_PROXY.sleeve, V1_PROXY.shaft]) expect(p[i].parent).toBe('cradle');
      for (const { box } of p) {
        for (const h of box.half) { expect(h).toBeGreaterThan(0); expect(h).toBeLessThan(1.25); }
        for (const v of [...box.center, ...box.half]) expect(Number.isFinite(v)).toBe(true);
      }
      // The hull box stays between the track channels; the fenders over them.
      const ctx = kitContext(l);
      expect(p[V1_PROXY.hull].box.half[0]).toBeLessThanOrEqual(ctx.lowerHalfWidth + 0.003);
      for (const i of V1_PROXY.fender) expect(Math.abs(p[i].box.center[0]) + p[i].box.half[0]).toBeLessThanOrEqual(ctx.upperHalfWidth + 0.005);
    }
  });

  it('rejects missing body proxies even when the running envelope still contains the wheels', () => {
    const a = assembleKit({ hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' });
    const result = checkContainment({ ...a, proxies: [] });
    expect(result.points).toBeGreaterThan(1000);
    expect(result.worst).toBeGreaterThan(CONTAINMENT_TOLERANCE);
    expect(result.outside.some(point => point.group === 'hull' || point.group === 'turret')).toBe(true);
  });

  it('contact reach: no hull proxy protrudes past the belt ends, so the belts meet first head-on (fix round 2)', () => {
    // Round 1's fender lips reached 7–9 cm past the belts at 0.55–0.70 above the ground: two tanks spawned nose to
    // nose 2.2 apart already touched, and ramming contacts sat well above the COM (W1-PHY's suite: 12°+ pitch).
    for (const l of legalKitLoadouts()) {
      const a = assembleKit(l), r = a.running;
      const front = r.sprocket.z + r.sprocket.r + BELT_SHOE, rear = r.idler.z - r.idler.r - BELT_SHOE - r.tensionerTravel / 2;
      for (const [i, { box, parent }] of a.proxies.entries()) {
        if (parent !== 'hull') continue;
        // z reach of the (possibly X-rotated) box.
        const angle = box.rotation ? 2 * Math.asin(box.rotation[0]) : 0;
        const reach = Math.abs(box.half[2] * Math.cos(angle)) + Math.abs(box.half[1] * Math.sin(angle));
        expect(box.center[2] + reach, `${a.key} proxy ${i} front`).toBeLessThanOrEqual(front);
        expect(box.center[2] - reach, `${a.key} proxy ${i} rear`).toBeGreaterThanOrEqual(rear);
      }
    }
  });

  it('extend the running-gear envelope with the wheels (droop to compression) and cover the belt ends', () => {
    const a = assembleKit({ hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' }), g = kitContext(a.loadout).gear;
    const at = (d: number) => kitRunningEnvelope(a, [[0, 1, 2, 3].map(() => g.wheelY0 + d), [0, 1, 2, 3].map(() => g.wheelY0 + d)]);
    const low = at(-SUSPENSION.droop)[0], high = at(SUSPENSION.compression)[0];
    expect(low.center[1] - low.half[1]).toBeLessThan(high.center[1] - high.half[1]);
    expect(at(0)).toHaveLength(6);
    for (const env of at(0)) expect(env.center[1] + env.half[1]).toBeLessThan(0.2);
    const main = at(0)[0];
    expect(main.center[2] + main.half[2]).toBeGreaterThanOrEqual(a.running.sprocket.z + a.running.sprocket.r);
    expect(main.center[2] - main.half[2]).toBeLessThanOrEqual(a.running.idler.z - a.running.idler.r);
  });
});
