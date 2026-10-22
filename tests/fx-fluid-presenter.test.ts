import { describe, expect, it, vi } from 'vitest';
import type { GameSnapshot, Q4, TankState, V3 } from '../src/game/contracts';
import { assembleKit, KIT_PART_IDS, V1_PROXY, type HullBox, type KitLoadout } from '../src/game/kit';
import { rotate } from '../src/game/math';
import { fluidPresenter, tankFluidBoxes } from '../src/game/presentation/fluid-presenter';
import type { ViewServices } from '../src/game/presentation/presenters';
import { previousWaterHulls, stableWaterHulls } from '../src/engine/passes/fluids/hull-motion';
import { selectWaterHulls, structuralWaterHulls } from '../src/game/presentation/structural-water';
import { debrisWaterHulls } from '../src/game/presentation/debris-water';
import type { RigidShard } from '../src/game/presentation/debris-dynamics';
import type { WorldQuery } from '../src/game/contracts';
import { WATER_MAX_HULLS } from '../src/engine/passes/fluids/liquid-params';
import type { WaterHull } from '../src/engine/passes/fluids/water';

const kits: KitLoadout[] = KIT_PART_IDS.hull.flatMap(hull => KIT_PART_IDS.runningGear.map(runningGear =>
  ({ hull, runningGear, turret: 'dome', weapon: 'mortar', utility: 'antenna' })));
function tank(kit = kits[0], id = 0): TankState {
  return { id: id as TankState['id'], kit, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0,
    turretYaw: 0, barrelPitch: 0, power: .5, health: 100, charge: 0, movement: 0, recoil: 0, suspension: [.5, .5, .5, .5],
    trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [1, 1],
    yawVelocity: 0, wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-1.2),
    loadout: { tracks: 'scout', barrel: 'mortar', armor: 'light' } };
}
const snapshot = (tanks: TankState[]) => ({ tanks }) as GameSnapshot;
const lower = (b: HullBox, a: number) => b.center[a] - b.half[a];
const upper = (b: HullBox, a: number) => b.center[a] + b.half[a];
const localWaterHull = (b: HullBox): WaterHull => ({ centre: b.center, half: b.half, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
function harness() {
  const setHulls = vi.fn<(hulls: readonly WaterHull[]) => void>(), configure = vi.fn();
  const presenter = fluidPresenter();
  presenter.install({ scene: { get: () => ({ setHulls, configure }) } } as unknown as ViewServices);
  return { presenter, configure, setHulls, hulls: () => setHulls.mock.lastCall![0] };
}

describe('tank fluid contact', () => {
  it('couples debris using its displayed mesh size, centre and rotation rather than its splash radius', () => {
    const p: RigidShard & { id: number } = { id: 9,
      positions: new Float32Array([-1,-.2,-.5, 1,.6,.5]), rotation: [0,0,Math.SQRT1_2,Math.SQRT1_2], angularVelocity: [0,0,0],
      body: { position: [0,18,0], velocity: [2,-3,0], radius: .03, age: 0, bounces: 0, sleeping: false } };
    const initial = debrisWaterHulls([p])[0];
    expect(initial.id).toBe('debris:9');
    expect(initial.half[0]).toBe(1); expect(initial.half[1]).toBeCloseTo(.4); expect(initial.half[2]).toBe(.5);
    expect(initial.centre[0]).toBeCloseTo(-.2); expect(initial.centre[1]).toBeCloseTo(18);
    expect(initial.axes[0][1]).toBeCloseTo(1);
    p.body.position = [0,17.8,1];
    const moved = debrisWaterHulls([p])[0];
    expect(moved.half).toBe(initial.half);
    expect(moved.centre[1]).toBeCloseTo(17.8); expect(moved.centre[2]).toBe(1);
    expect(initial.centre[1]).toBeCloseTo(18);
    expect(previousWaterHulls([moved], [initial])).toEqual([initial]);
  });

  it('shares sixteen surface-body slots without displacing the eight tanks or retaining removed debris', () => {
    const hull = (id: string, y: number, size: number): WaterHull => ({ id, centre: [0,y,0], half: [size,size,size], axes: [[1,0,0],[0,1,0],[0,0,1]] });
    const world = { liquidBasins: () => ({ n: 1, labels: new Uint8Array(6).fill(1), basins: [{ level: 18, material: 'water' }] }) } as unknown as WorldQuery;
    const large = hull('debris:large', 18.1, .6), chunks = [hull('chunk:1', 18, 1)];
    const pieces = [...Array.from({ length: 40 }, (_, i) => hull(`debris:${i}`, 18, .1)), large, hull('debris:airborne', 23, 1)];
    const selected = selectWaterHulls([...pieces, ...chunks], world);
    expect(selected).toHaveLength(16); expect(selected).toContain(large); expect(selected).toContain(chunks[0]);
    expect(selected.some(h => h.id === 'debris:airborne')).toBe(false);
    expect(selectWaterHulls([...pieces, ...chunks].reverse(), world)).toEqual(selected);
    const setHulls = vi.fn(), configure = vi.fn(), presenter = fluidPresenter();
    let debris: readonly WaterHull[] = pieces;
    presenter.install({ world: () => world, debrisWaterHulls: () => debris, scene: { get: () => ({ setHulls, configure }) } } as unknown as ViewServices);
    const tanks = Array.from({ length: 8 }, (_, id) => tank(kits[id], id));
    presenter.onUpdate!(snapshot(tanks), 1 / 60);
    const first: WaterHull[] = setHulls.mock.lastCall![0];
    expect(first).toHaveLength(40); expect(first.filter(h => h.id?.startsWith('tank:'))).toHaveLength(24);
    expect(first).toContain(large); expect(first.length + 1).toBe(WATER_MAX_HULLS);
    debris = []; presenter.onUpdate!(snapshot(tanks), 1 / 60);
    expect(setHulls.mock.lastCall![0]).toHaveLength(24);
    presenter.reset!(); expect(setHulls.mock.lastCall![0]).toEqual([]);
  });

  it('keeps chunk histories separate through insertions, removals and recuts', () => {
    const hull = (id: string, x: number): WaterHull => ({ id, centre: [x, 18, 0], half: [1,1,1], axes: [[1,0,0],[0,1,0],[0,0,1]] });
    const a = hull('chunk:1', 0), b = hull('chunk:2', 10), c = hull('chunk:3', 20);
    const moved = hull('chunk:2', 11);
    expect(previousWaterHulls([moved, c], [a, b])).toEqual([b, c]);
    expect(previousWaterHulls([], [a, b])).toEqual([]);
    expect(previousWaterHulls([hull('chunk:4', 10)], [b])[0].id).toBe('chunk:4');
  });

  it('feeds moving structural envelopes even with no tanks and retains immutable local geometry', () => {
    const body = { id: 7, position: [0,18,0] as V3, rotation: [0,0,0,1] as Q4,
      shapes: [{ vertices: new Float32Array([-1,-.5,-1, 1,.5,1]), indices: new Uint32Array(), offset: [0,1,0] as V3 }] };
    const world = { collisionBodies: () => [body] } as unknown as WorldQuery;
    const first = structuralWaterHulls(world);
    expect(first[0]).toMatchObject({ id: 'chunk:7', centre: [0,19,0], half: [1,.5,1] });
    body.position[1] = 17;
    const second = structuralWaterHulls(world);
    expect(second[0].centre).toEqual([0,18,0]); expect(second[0].half).toBe(first[0].half);
    const setHulls = vi.fn(), p = fluidPresenter();
    p.install({ world: () => world, scene: { get: () => ({ setHulls }) } } as unknown as ViewServices);
    p.onUpdate!(snapshot([]), 1 / 60);
    expect(setHulls.mock.lastCall![0]).toEqual(second);
  });
  it.each(kits)('$hull/$runningGear wets both tracks in 0.1 u water while the belly stays dry', kit => {
    const t = tank(kit), a = assembleKit(kit), boxes = tankFluidBoxes(t), [body, left, right] = boxes;
    expect(boxes).toHaveLength(3);
    expect(tankFluidBoxes(t)[0]).toBe(body); // Cached kit geometry, not rebuilt per frame.
    expect(left.center[0]).toBe(a.running.halfSpacing);
    expect(right.center[0]).toBe(-a.running.halfSpacing);
    for (const track of [left, right]) {
      expect(track.half[0] * 2).toBeCloseTo(a.running.trackWidth, 12);
      expect(lower(track, 1)).toBeCloseTo(-.5, 12);
      expect(upper(track, 1)).toBeCloseTo(lower(body, 1), 12);
    }
    // Vertical wet-column intersection: waterline -0.4, ground -0.5.
    const wet = (b: HullBox) => Math.max(0, Math.min(-.4, upper(b, 1)) - Math.max(-.5, lower(b, 1)));
    expect(wet(body)).toBe(0);
    expect(wet(left)).toBeCloseTo(.1, 12);
    expect(wet(right)).toBeCloseTo(.1, 12);
    expect(lower(left, 0)).toBeGreaterThan(0);
    expect(upper(right, 0)).toBeLessThan(0); // Open water beneath the central belly.
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const overlap = [0, 1, 2].map(axis => Math.max(0, Math.min(upper(boxes[i], axis), upper(boxes[j], axis))
        - Math.max(lower(boxes[i], axis), lower(boxes[j], axis)))).reduce((v, edge) => v * edge, 1);
      expect(overlap).toBeLessThan(1e-12);
    }
    for (const i of [V1_PROXY.hull, ...V1_PROXY.fender]) for (let axis = 0; axis < 3; axis++) {
      expect(lower(body, axis)).toBeLessThanOrEqual(lower(a.proxies[i].box, axis) + 1e-12);
      expect(upper(body, axis)).toBeGreaterThanOrEqual(upper(a.proxies[i].box, axis) - 1e-12);
    }
  });

  it.each(KIT_PART_IDS.runningGear)('%s follows independent physical suspension limits without filling the belly gap', runningGear => {
    const t = tank({ ...kits[0], runningGear });
    t.wheelSuspension = [0, .5, .8, 1, 1, 1, 1, 1];
    const [body, left, right] = tankFluidBoxes(t);
    expect(lower(left, 1)).toBeCloseTo(-.62, 12);
    expect(lower(right, 1)).toBeCloseTo(-.415, 12);
    expect(upper(left, 1)).toBeCloseTo(lower(body, 1), 12);
    expect(upper(right, 1)).toBeCloseTo(lower(body, 1), 12);
    expect(left.half[1]).toBeGreaterThan(0);
    expect(right.half[1]).toBeGreaterThan(0);
  });

  it('translates and rotates every gear envelope with the rendered root', () => {
    const h = harness();
    const q: Q4 = [1 / Math.sqrt(30), 2 / Math.sqrt(30), 3 / Math.sqrt(30), 4 / Math.sqrt(30)];
    for (const runningGear of KIT_PART_IDS.runningGear) {
      const t = tank({ ...kits[0], runningGear });
      t.position = [3, 19, -7]; t.rotation = q;
      h.presenter.onUpdate!(snapshot([t]), 1 / 60);
      const locals = tankFluidBoxes(t), result = h.hulls();
      for (let i = 0; i < 3; i++) {
        const rotated = rotate(locals[i].center, q);
        result[i].centre.forEach((v, axis) => expect(v).toBeCloseTo(rotated[axis] + t.position[axis], 12));
        expect(result[i].half).toEqual(locals[i].half);
        for (let axis = 0; axis < 3; axis++) {
          const basis: V3 = [0, 0, 0]; basis[axis] = 1;
          result[i].axes[axis].forEach((v, k) => expect(v).toBeCloseTo(rotate(basis, q)[k], 12));
        }
      }
    }
  });

  it('keeps 24 ordered slots for eight tanks plus room for the dev proxy, and uses matching interpolation', () => {
    const h = harness(), tanks = Array.from({ length: 8 }, (_, id) => tank(kits[id], id));
    tanks.forEach((t, i) => { t.position = [i * 3, 20, 0]; });
    const reversed = [...tanks].reverse();
    h.presenter.onUpdate!(snapshot(reversed), 1 / 60, { alpha: .25,
      prev: reversed.map(t => ({ ...t, position: [t.position[0], 18, 0] })),
      curr: reversed.map(t => ({ ...t, position: [t.position[0], 22, 0] })) });
    const first = h.hulls();
    expect(first).toHaveLength(24);
    expect(first.length + 1).toBeLessThanOrEqual(WATER_MAX_HULLS);
    for (let i = 0; i < 8; i++) for (let slot = 0; slot < 3; slot++) {
      const b = tankFluidBoxes(tanks[i])[slot];
      expect(first[i * 3 + slot].centre).toEqual([i * 3 + b.center[0], 19 + b.center[1], b.center[2]]);
    }
    tanks.forEach(t => { t.position[1] = 19; });
    h.presenter.onUpdate!(snapshot(tanks), 1 / 60);
    expect(h.hulls()).toEqual(first);
    expect(h.configure).toHaveBeenCalledOnce();
    h.presenter.onUpdate!(snapshot([]), 1 / 60);
    expect(h.hulls()).toEqual([]);
    h.presenter.reset!();
    expect(h.hulls()).toEqual([]);
  });

  it('retains sub-4 mm suspension chatter, then admits accumulated shape change', () => {
    const t = tank(), initial = tankFluidBoxes(t).map(localWaterHull);
    let previous = initial;
    for (const bottomTravel of [.001, -.002, .003]) {
      t.wheelSuspension.fill(.5 + bottomTravel / .4);
      previous = stableWaterHulls(tankFluidBoxes(t).map(localWaterHull), previous);
      expect(previous[1]).toBe(initial[1]); expect(previous[2]).toBe(initial[2]);
    }
    t.wheelSuspension.fill(.5 + .006 / .4);
    const next = stableWaterHulls(tankFluidBoxes(t).map(localWaterHull), previous);
    expect(next[1]).not.toBe(initial[1]);
    expect(next[1].centre[1] - next[1].half[1]).toBeCloseTo(-.494, 12);
    // Previous poses own their dimensions; later input mutation cannot corrupt motion history.
    const changed = tankFluidBoxes(t).map(localWaterHull), saved = stableWaterHulls(changed, []);
    (changed[1].half as number[])[1] += 1;
    expect(saved[1].half[1]).toBe(next[1].half[1]);
  });
});
