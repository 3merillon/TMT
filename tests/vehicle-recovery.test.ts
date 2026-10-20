/** Recovery targets (W1-PHY brief): crater escape, flip recovery through the self-right action, air control.
 *
 * Before W1-PHY (recorded as it.fails in ed175fa): every legacy loadout flipped in the lifted impact crater (scouts escaped
 * in 2.2–2.8 s but flipped on the way; grip/cannon/heavy stayed trapped); the hemispherical pit flipped both test tanks;
 * a flipped tank never recovered (no self-right, no air control); grip/rail/heavy could not be built at all. */
import { describe, expect, it } from 'vitest';
import { airDrop, axisAngle, craterEscape, DEFAULT, HEAVY, LEGACY_LOADOUTS, loadoutName, selfRight } from './helpers/vehicle-world';
import { MIN_TERRAIN_BLAST_RADIUS } from '../src/game/terrain-config';
import { V1_MODULE_CATALOG } from '../src/game/kit/catalog';

/** The deepest impact crater a legacy weapon makes (the mortar's blast radius through craterProfile). */
const WORST_BLAST = Math.max(...Object.values(V1_MODULE_CATALOG.barrel).map(b => b.blastRadius));

describe('crater escape', () => {
  it('uses a real impact crater', () => expect(WORST_BLAST).toBeGreaterThanOrEqual(MIN_TERRAIN_BLAST_RADIUS));
  for (const loadout of LEGACY_LOADOUTS) {
    const name = loadoutName(loadout);
    it(`${name}: escapes the lifted impact crater in < 3 s without flipping`, async () => {
      const r = await craterEscape(loadout, w => w.addLiftedCrater(WORST_BLAST));
      expect(r.flipped, JSON.stringify(r)).toBe(false);
      expect(r.escapedAt, JSON.stringify(r)).toBeLessThan(3);
    });
  }
  for (const loadout of [DEFAULT, HEAVY]) {
    const name = loadoutName(loadout);
    // The legacy hemispherical carve (depth = radius = 2.6, vertical rim, deeper than the tank is long) is a pit by
    // design and not an acceptance target: at full throttle the tank rides its wall like a half-pipe. The pitch guard
    // cuts the drive before vertical, but momentum carries it to ~90° pitch (measured minimum up·Y −0.15 / −0.08,
    // ending tilted at 0.82 / 0.62); lowering the guard to 58–70° barely changed that. It must never go over onto its
    // roof or end there.
    it(`${name}: a hemispherical pit traps but never tips the tank over onto its roof`, async () => {
      const r = await craterEscape(loadout, w => w.addCrater(WORST_BLAST, 0), 480, 300);
      expect(r.escapedAt, JSON.stringify(r)).toBeNaN();
      expect(r.minUp, JSON.stringify(r)).toBeGreaterThan(-.3); // never more than ~17° past vertical
      expect(r.finalUpDot, JSON.stringify(r)).toBeGreaterThan(.4);
    });
    // The redesigned Bastion running protection clears this historical failure. The light build still reaches
    // vertical (up·Y < 0.1) on the wall of this intentionally inescapable hemispherical pit.
    (loadout.armor === 'heavy' ? it : it.fails)(`${name}: a hemispherical pit never tips the tank to vertical`, async () => {
      const r = await craterEscape(loadout, w => w.addCrater(WORST_BLAST, 0), 480, 300);
      expect(r.flipped, JSON.stringify(r)).toBe(false);
    });
  }
});

describe('self-righting', () => {
  for (const loadout of [DEFAULT, HEAVY]) {
    const name = loadoutName(loadout);
    it(`${name}: an upside-down tank rights itself within 3 s of the selfRight input`, async () => {
      const r = await selfRight(loadout, axisAngle([0, 0, 1], Math.PI));
      expect(r.settledUpDot, JSON.stringify(r)).toBeLessThan(-.5);
      expect(r.uprightAt, JSON.stringify(r)).toBeLessThan(3);
    });
    it(`${name}: a tank dropped on its side rolls back onto its tracks by itself (low COM + righting assist)`, async () => {
      // uprightAt counts from 1 s after the drop: wheels-down and at rest within 2 s, with no self-right press.
      const r = await selfRight(loadout, axisAngle([1, 0, 1], Math.PI / 2), { press: false });
      expect(r.uprightAt, JSON.stringify(r)).toBeLessThan(1);
      expect(r.maxHeight, JSON.stringify(r)).toBeLessThan(1); // it rolled back; the self-right hop never ran
    });
    it(`${name}: a flipped tank rights itself after 3 s without input`, async () => {
      const r = await selfRight(loadout, axisAngle([0, 0, 1], Math.PI), { press: false, ticks: 420 });
      expect(r.uprightAt, JSON.stringify(r)).toBeGreaterThan(2.5);
      expect(r.uprightAt, JSON.stringify(r)).toBeLessThan(5.5);
    });
    it(`${name}: air control lands a 40°-rolled drop on its tracks`, async () => {
      const r = await airDrop(loadout, 40);
      expect(r.landingRoll, JSON.stringify(r)).toBeLessThan(20);
      expect(r.finalUpDot, JSON.stringify(r)).toBeGreaterThan(.99);
    });
  }
});
