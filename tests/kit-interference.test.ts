/**
 * Kit interference, fast tier (W1-KIT). The full sweep (every legal assembly, 2° / 1° steps, 3^4 suspension
 * combinations × 3 belt phases plus the 7 × 7 neighbouring-station grid) runs in kit-interference.slow.test.ts;
 * this file runs:
 * - the rest pose of every (hull, gear, turret, weapon) with a rotating utility;
 * - the complete turret (B) and gun-vs-turret (C) sweeps, and coarse running-gear (A) and gun-over-hull (D) sweeps;
 * - regressions: exhausts inboard of the track channel (never over or inside a belt), the Skiff headlights vs
 *   a −30° Wedge gun, the Cradle's radar vs its mantlet at +88°, belts conformed to terrain under alternating
 *   stations at half, three-quarter and full travel at every belt phase, and neighbouring stations over a fine
 *   grid of deflections (the Scout's trailing arms: fix round 2);
 * - that the checker is not vacuous: forcing the gun below its limit or a wheel past its bump stop is caught.
 */
import { describe, expect, it } from 'vitest';
import { assembleKit, KIT_PART_IDS, legalKitLoadouts, type KitLoadout } from '../src/game/kit';
import { kitContext, kitGeometry } from '../src/game/kit/build';
import { restState } from '../src/game/kit/rig';
import { gearRig, SUSPENSION } from '../src/game/kit/running';
import { groundThroughWheels, NEIGHBOUR_LEVELS, OVERLAP_TOLERANCE, overlapsAt, PosedKit, sweepRunningGear, validateKit } from '../src/game/kit/validate';
import { INSTANCED_GROUPS } from '../src/game/kit/parts/types';

const DEG = Math.PI / 180;
const UTILITIES = KIT_PART_IDS.utility;
const COVER: KitLoadout[] = legalKitLoadouts()
  .filter((l, i, list) => list.findIndex(o => o.hull === l.hull && o.runningGear === l.runningGear && o.turret === l.turret && o.weapon === l.weapon) === i)
  .map((l, i) => ({ ...l, utility: UTILITIES[i % UTILITIES.length] }));
const describeOverlaps = (list: { a: string; b: string; depth: number; state: string }[]) => list.slice(0, 5).map(o => `${o.a} × ${o.b} ${(o.depth * 1000).toFixed(1)} mm @ ${o.state}`);

describe('kit interference (fast)', () => {
  it('has no overlap deeper than 1 mm at rest', () => {
    expect(OVERLAP_TOLERANCE).toBe(0.001);
    for (const l of COVER) {
      const a = assembleKit(l);
      expect(describeOverlaps(overlapsAt(a, restState(kitContext(l)), 'rest')), a.key).toEqual([]);
    }
  });

  it('passes the full turret and gun-vs-turret sweeps and coarse running-gear and gun-over-hull sweeps', () => {
    const B = validateKit({ checks: ['B'] }), C = validateKit({ checks: ['C'] });
    expect(describeOverlaps(B.overlaps)).toEqual([]);
    expect(describeOverlaps(C.overlaps)).toEqual([]);
    expect(B.states).toBeGreaterThan(50000);
    expect(C.states).toBeGreaterThan(40000);
    const A = validateKit({ checks: ['A'], phases: [0], suspension: [-SUSPENSION.droop, SUSPENSION.compression], neighbourLevels: 0 });
    const D = validateKit({ checks: ['D'], yawStep: 6 * DEG, pitchStep: 2 * DEG });
    expect(describeOverlaps(A.overlaps)).toEqual([]);
    expect(describeOverlaps(D.overlaps)).toEqual([]);
    expect(A.assemblies).toBe(4680);
  }, 120000);

  it('keeps every exhaust inboard of the track channel and venting away from the tracks', () => {
    for (const hull of KIT_PART_IDS.hull) for (const runningGear of KIT_PART_IDS.runningGear) {
      const l: KitLoadout = { hull, runningGear, turret: 'dome', weapon: 'cannon', utility: 'antenna' }, ctx = kitContext(l), a = assembleKit(l);
      const exhaust = (kitGeometry(ctx, 0).groups.get('hull') ?? []).flatMap(s => s.hulls).filter(p => p.tag === 'exhaust');
      expect(exhaust.length, a.key).toBeGreaterThan(0);
      for (const p of exhaust) {
        // Clearly inside the belts' inner edges (not over the tracks), with 2 cm to spare.
        expect(Math.max(Math.abs(p.box[0]), Math.abs(p.box[3])), `${a.key} exhaust x`).toBeLessThan(ctx.beltInner - 0.02);
      }
      expect(a.frames.exhausts.length).toBeGreaterThan(0);
      for (const f of a.frames.exhausts) {
        expect(Math.abs(f.position[0])).toBeLessThan(ctx.beltInner - 0.02);
        // +Z of the outlet frame: rearward, upward, or down behind the rear plate; never sideways at the tracks.
        const [x, y, z, w] = f.rotation, dir = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
        expect(dir[2] < -0.3 || dir[1] > 0.5 || f.position[2] < ctx.hull.rear, `${a.key} outlet direction ${dir.map(v => v.toFixed(2))}`).toBe(true);
        expect(Math.abs(dir[0])).toBeLessThan(0.5);
      }
    }
  });

  it('keeps the Skiff headlights clear of a −30° Wedge gun and the Cradle radar clear of its mantlet at +88°', () => {
    for (const weapon of ['cannon', 'rail'] as const) for (const yaw of [-12, -6, 0, 6, 12]) {
      const l: KitLoadout = { hull: 'skiff', runningGear: 'scout', turret: 'wedge', weapon, utility: 'antenna' }, a = assembleKit(l);
      for (const recoil of [0, 1]) expect(describeOverlaps(overlapsAt(a, { ...restState(kitContext(l)), yaw: yaw * DEG, pitch: -30 * DEG, recoil }))).toEqual([]);
    }
    const l: KitLoadout = { hull: 'warden', runningGear: 'grip', turret: 'cradle', weapon: 'cannon', utility: 'radar' }, a = assembleKit(l);
    for (let spin = 0; spin < 360; spin += 30) for (const recoil of [0, 1]) {
      expect(describeOverlaps(overlapsAt(a, { ...restState(kitContext(l)), pitch: 88 * DEG, recoil, head: [spin * DEG, 0] }))).toEqual([]);
    }
  });

  it('keeps the links off the wheels on terrain that explains alternating stations at half to full travel, at every belt phase', () => {
    // Round 1 covered half travel only: at full travel the Crawler's belt was pressed into the notch between a
    // drooped and a compressed interleaved wheel (9.4 mm links × wheels; fixed in belt.ts: taut string, link reach).
    for (const runningGear of KIT_PART_IDS.runningGear) {
      const l: KitLoadout = { hull: 'warden', runningGear, turret: 'wedge', weapon: 'cannon', utility: 'antenna' }, ctx = kitContext(l), a = assembleKit(l);
      const { droop, compression } = SUSPENSION, y0 = ctx.gear.wheelY0, pitch = gearRig(ctx.gear).layout.pitch;
      for (const travel of [0.5, 0.75, 1]) {
        const up = [compression, -droop, compression, -droop].map(d => y0 + d * travel), down = [-droop, compression, -droop, compression].map(d => y0 + d * travel);
        for (const wheelY of [[up, down], [down, up]] as const) for (let k = 0; k < 12; k++) {
          const state = { ...restState(ctx), wheelY, ground: groundThroughWheels(ctx, wheelY), phase: [k / 12 * pitch, k / 12 * pitch] as [number, number] };
          expect(describeOverlaps(overlapsAt(a, state, `travel ${travel} phase ${k}/12`)), a.key).toEqual([]);
        }
      }
    }
  });

  it('keeps neighbouring stations clear over a fine grid of their deflections (trailing arms travel fore–aft)', () => {
    // Round 1 swept the 3 levels droop / rest / compression only: a Scout wheel at full droop moved 8 mm into a
    // half-drooped neighbour (r 0.19 on 0.393 spacing; fixed with r 0.18 visual tyres, parts/gear/scout.ts).
    for (const runningGear of KIT_PART_IDS.runningGear) {
      const a = assembleKit({ hull: 'warden', runningGear, turret: 'dome', weapon: 'cannon', utility: 'antenna' });
      const r = sweepRunningGear(a, { suspension: [], phases: [], neighbourLevels: NEIGHBOUR_LEVELS });
      expect(r.states, a.key).toBe(3 * NEIGHBOUR_LEVELS ** 2 * 2);
      expect(describeOverlaps(r.overlaps), a.key).toEqual([]);
    }
    expect(NEIGHBOUR_LEVELS).toBeGreaterThanOrEqual(7);
  });

  it('catches a gun forced below its limit and a wheel forced past its bump stop', () => {
    const l: KitLoadout = { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' }, a = assembleKit(l), rest = restState(kitContext(l));
    const lim = a.pitchLimits(Math.PI).min;
    const forced = overlapsAt(a, { ...rest, yaw: Math.PI, pitch: lim - 12 * DEG });
    expect(forced.some(o => /^(cradle|barrel)/.test(o.a) || /^(cradle|barrel)/.test(o.b))).toBe(true);
    const y0 = kitContext(l).gear.wheelY0, up = [y0, y0, y0, y0 + 0.3];
    const bumped = overlapsAt(a, { ...rest, wheelY: [up, [y0, y0, y0, y0]] });
    expect(bumped.length).toBeGreaterThan(0);
    for (const o of bumped) { expect(o.depth).toBeGreaterThan(OVERLAP_TOLERANCE); for (let k = 0; k < 3; k++) expect(o.max[k]).toBeGreaterThanOrEqual(o.min[k] - 1e-9); }
  });

  it('reuses only the stationary physical side and covers both parity blocks of link instances', () => {
    const l: KitLoadout = { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
    const a = assembleKit(l), ctx = kitContext(l), rest = restState(ctx), { pitch } = gearRig(ctx.gear).layout;
    // Rest is visited first, then deliberately invalid compression. Reusing a
    // changing side as though it were stationary would silently miss these hits.
    const swept = sweepRunningGear(a, { suspension: [0, 0.3], phases: [0, 0.34], neighbourLevels: 0 });
    const pair = (o: { a: string; b: string }) => [o.a, o.b].sort().join('|');
    const found = new Set(swept.overlaps.map(pair));
    const posed = new PosedKit(a, ['hull', ...INSTANCED_GROUPS]);
    for (const side of [0, 1] as const) for (const pattern of [[0.3, 0.3, 0.3, 0.3], [0.3, 0, 0.3, 0]]) {
      const up = pattern.map(v => ctx.gear.wheelY0 + v);
      const direct = posed.place({ ...rest, wheelY: side === 0 ? [up, rest.wheelY[1]] : [rest.wheelY[0], up], phase: [0.34 * pitch, 0.34 * pitch] }).overlaps();
      expect(direct.length, `forced side ${side}`).toBeGreaterThan(0);
      expect(direct.filter(o => !found.has(pair(o))).map(pair), `missed side ${side}`).toEqual([]);
    }
  });
});
