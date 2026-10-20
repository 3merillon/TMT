/**
 * pitchLimits(yaw): physical front-arc clearance for every (hull, gear, turret, weapon), class-appropriate
 * depression for the distinct body profiles, continuity outside the front-arc edges, periodicity,
 * the turret's maximum, and conservativeness (the gun clears the hull at the limit, tube in and recoiled).
 */
import { describe, expect, it } from 'vitest';
import { assembleKit, FRONT_ARC, KIT_PART_IDS, legalKitLoadouts, type KitAssembly } from '../src/game/kit';
import { kitContext } from '../src/game/kit/build';
import { PITCH_MAX_SLOPE } from '../src/game/kit/pitch';
import { restState } from '../src/game/kit/rig';
import { overlapsAt, PosedKit, type KitOverlap } from '../src/game/kit/validate';

const DEG = Math.PI / 180;
/** Every (hull, gear, turret, weapon) once (the utility does not change the gun's clearance over the hull). */
const COMBOS = legalKitLoadouts().filter(l => l.utility === 'antenna').map(l => assembleKit(l));
const range = (a: KitAssembly) => a.joints.find(j => j.name === 'cradle')!.limits!;
const nonGunGroups = (posed: PosedKit) => [...new Set(posed.refs.filter(ref => ref.group !== 'cradle' && ref.group !== 'barrel').map(ref => ref.group))];

describe('kit pitch limits', () => {
  it('keeps the physical front arc within the joint range, and the joint maximum everywhere', () => {
    expect(COMBOS).toHaveLength(520);
    expect(FRONT_ARC).toBeCloseTo(12 * DEG, 12);
    const failures: string[] = [];
    for (const a of COMBOS) {
      const [lo, hi] = range(a);
      for (let d = -12; d <= 12; d += 0.25) {
        const min = a.pitchLimits(d * DEG).min;
        if (!(min >= lo - 1e-12 && min <= 0)) failures.push(`${a.key} yaw ${d}: ${min} outside [${lo - 1e-12}, 0]`);
      }
      for (let d = 0; d < 360; d += 3) {
        const lim = a.pitchLimits(d * DEG);
        if (!Object.is(lim.max, hi) || !(lim.min >= lo - 1e-12 && lim.min <= hi)) failures.push(`${a.key} yaw ${d}: [${lim.min}, ${lim.max}] outside [${lo - 1e-12}, ${hi}]`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('preserves useful depression for each distinct hull front and the mechanical turret ranges', () => {
    // A low scout bow retains deep depression; a stepped medium and a thick siege
    // deck trade some of that clearance for their visible structural armor volume.
    const depression = { skiff: -30, warden: -25, bastion: -10, aether_hull: -25, forge_hull: -10 };
    for (const hull of KIT_PART_IDS.hull) {
      const best = Math.min(...COMBOS.filter(a => a.loadout.hull === hull).map(a => Math.max(...[-12, -6, 0, 6, 12].map(d => a.pitchLimits(d * DEG).min))));
      expect(best / DEG, hull).toBeLessThanOrEqual(depression[hull] + 1e-9);
    }
    // The turret design targets (brief): Dome −15..+75, Wedge −30..+62, Cradle −5..+88.
    const target = { dome: [-15, 75], wedge: [-30, 62], cradle: [-5, 88], aether_crown: [-20, 75], forge_casemate: [-25, 65] } as const;
    for (const a of COMBOS) expect(range(a).map(v => Math.round(v / DEG))).toEqual([...target[a.loadout.turret]]);
  });

  it('is continuous and periodic, with bounded slope through every front shoulder and rear stack', () => {
    const failures: string[] = [];
    for (const a of COMBOS) {
      const n = 720, h = 2 * Math.PI / n;
      for (let i = 0; i < n; i++) {
        const y = i * h, m0 = a.pitchLimits(y).min, m1 = a.pitchLimits(y + h).min;
        const forward = a.pitchLimits(y + 2 * Math.PI).min, backward = a.pitchLimits(y - 2 * Math.PI).min;
        // Match toBeCloseTo(..., 9)'s strict half-unit tolerance for every original sample.
        if (!(Math.abs(forward - m0) < 10 ** -9 / 2 && Math.abs(backward - m0) < 10 ** -9 / 2)) failures.push(`${a.key} yaw ${i}: nonperiodic ${backward}, ${m0}, ${forward}`);
        const slope = Math.abs(m1 - m0) / h;
        if (!(slope <= PITCH_MAX_SLOPE + 1e-6 && Math.abs(m1 - m0) < 0.1)) failures.push(`${a.key} at ${(y / DEG).toFixed(1)}°: slope ${slope}, difference ${Math.abs(m1 - m0)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('is conservative: the gun clears the hull at the limit with the tube in and recoiled', () => {
    for (const a of COMBOS.filter((_, i) => i % 4 === 0)) {
      const ctx = kitContext(a.loadout), rest = restState(ctx), posed = new PosedKit(a);
      // The assertion only concerns gun/non-gun pairs; retain every such pair
      // without checking unrelated running-gear pairs and discarding them later.
      const others = nonGunGroups(posed);
      for (let d = 0; d < 360; d += 15) {
        const yaw = d * DEG, pitch = a.pitchLimits(yaw).min;
        for (const recoil of [0, 1]) {
          const gunHull = posed.place({ ...rest, yaw, pitch, recoil }).overlaps('', ['cradle', 'barrel'], others);
          expect(gunHull, `${a.key} yaw ${d} recoil ${recoil}`).toEqual([]);
        }
      }
    }
  });

  it('checks the same gun pairs as the original all-pair query, including deliberately intersecting poses', () => {
    const normalize = (overlaps: KitOverlap[]) => overlaps.map(({ a, b, ...rest }) => ({ ...rest, pair: [a, b].sort().join(' / ') })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    let intersections = 0;
    for (const a of COMBOS.filter((_, i) => i % 64 === 0 || i === COMBOS.length - 1)) {
      const posed = new PosedKit(a), rest = restState(posed.ctx), others = nonGunGroups(posed);
      for (const yaw of [0, Math.PI / 2, Math.PI]) for (const recoil of [0, 1]) for (const pitch of [range(a)[0], -Math.PI / 2]) {
        const state = { ...rest, yaw, pitch, recoil };
        const expected = overlapsAt(a, state).filter(o => /^(cradle|barrel)/.test(o.a) !== /^(cradle|barrel)/.test(o.b));
        const actual = posed.place(state).overlaps('', ['cradle', 'barrel'], others);
        intersections += expected.length;
        expect(normalize(actual), `${a.key} yaw ${yaw} pitch ${pitch} recoil ${recoil}`).toEqual(normalize(expected));
      }
    }
    expect(intersections).toBeGreaterThan(0);
  });

  it('raises the limit where the gun passes over the engine deck and the stacks', () => {
    const warden = assembleKit({ hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' });
    // Over the rear deck the stacks force the gun up; straight back it dips between them.
    for (const side of [[145, 150, 155], [205, 210, 215]]) {
      const overStack = Math.max(...side.map(d => warden.pitchLimits(d * DEG).min));
      expect(overStack).toBeGreaterThan(warden.pitchLimits(180 * DEG).min + 5 * DEG);
    }
    expect(warden.pitchLimits(180 * DEG).min).toBeGreaterThan(range(warden)[0]);
  });
});
