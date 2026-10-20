import { afterAll, beforeAll, expect, it } from 'vitest';
import { testMatchCore } from './helpers/native-match';
import { SphereWorld } from './helpers/sphere-world';
import { NativeCombat } from '../src/game/native-combat';
import { NativeMatch } from '../src/game/native-match';
import { GameSimulation, FIXED_DT } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import type { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { ImpactEvent, ProjectileState, TerrainHit, V3 } from '../src/game/contracts';
import { normalize, segmentSphere } from '../src/game/math';

let core: RustTerrainCore;
beforeAll(async () => { core = await testMatchCore(); }); afterAll(() => core?.dispose());
const setup = () => practiceSetup({ seed: 19, mode: 'local', player: { tracks: 'scout', barrel: 'cannon', armor: 'light' } });
function world(native: boolean) {
  const w = new SphereWorld(); w.createBallistics = undefined;
  w.createMatchLifecycle = native ? (s, state) => new NativeMatch(core, s, state) : undefined;
  w.createCombat = native ? (s, state, kit) => new NativeCombat(core, s, state, kit) : undefined;
  return w;
}
const combat = (sim: GameSimulation) => (sim as unknown as { nativeCombat: NativeCombat }).nativeCombat;
const lifecycle = (sim: GameSimulation) => (sim as unknown as { nativeMatch: NativeMatch }).nativeMatch;
function impact(sim: GameSimulation, p: ProjectileState, h: TerrainHit, direct: number | null): ImpactEvent {
  (sim as unknown as { impact(p: ProjectileState, h: TerrainHit, d: number | null): void }).impact(p, h, direct);
  return sim.step(0).find(e => e.type === 'impact') as ImpactEvent;
}
function compareHits(a: ImpactEvent['hits'], b: ImpactEvent['hits']) {
  expect(a!.length).toBe(b!.length);
  a!.forEach((h, i) => { const other = b![i]; expect({ ...h, exposure: 0 }).toEqual({ ...other, exposure: 0 }); expect(h.exposure).toBeCloseTo(other.exposure, 12); });
}
it.each(['local', 'drive'] as const)('preserves direct/splash damage, all armor sectors, friendly fire, impulses and consumption in %s', mode => {
  for (const friendly of [false, true]) for (const rail of [false, true]) {
    const s = setup(); s.mode = mode; s.rules.friendlyFire = friendly;
    if (rail) s.tanks[0].loadout.weapon = 'rail';
    s.tanks[1].loadout = { hull: 'bastion', armor: 'reactive', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
    const aWorld = world(true), bWorld = world(false), a = new GameSimulation(aWorld, s), b = new GameSimulation(bWorld, s);
    try {
      for (const sim of [a, b]) { sim.state.tanks[0].position = [20, 20, 0]; sim.state.tanks[1].position = [0, 20, 0]; }
      for (const munition of ['explosive', 'heavy', 'incendiary', 'nuclear'] as const) for (const direct of [null, 1])
        for (const offset of [[0, 0, .8], [.8, 0, 0], [-.8, 0, 0], [0, 0, -.8], [0, .8, 0], [0, .45, .8], [.8, -.3, 0], [0, 0, 0]] as V3[]) {
          const rotation: [number, number, number, number] = rail ? [0, 1, 0, 0] : [0, 0, 0, 1];
          for (const sim of [a, b]) { sim.state.tanks[1].rotation = rotation; sim.state.tanks[1].velocity = [0, 0, 0]; }
          const changes = { health: 1000, reactiveArmor: 0, team: friendly ? 1 : 0 };
          combat(a).restore(1, changes); Object.assign(b.state.tanks[1], changes);
          // Obstructed analytic fallback and clear rays exercise identical native
          // exposure arithmetic; production resident queries are tested separately.
          const blocked = offset[0] !== 0;
          const hit: TerrainHit = { point: [offset[0], 20 + offset[1], offset[2]], normal: normalize(offset), distance: 1, material: 0 };
          aWorld.raycast = bWorld.raycast = () => blocked ? hit : null;
          const p: ProjectileState = { id: 1, owner: 0, position: hit.point, velocity: [0, 0, -1], age: .1, munition };
          for (let repeat = 0; repeat < 2; repeat++) {
            compareHits(impact(a, p, hit, direct).hits, impact(b, p, hit, direct).hits);
            for (let i = 0; i < 2; i++) {
              expect(a.state.tanks[i].health).toBe(b.state.tanks[i].health);
              expect(a.state.tanks[i].reactiveArmor).toBe(b.state.tanks[i].reactiveArmor);
              a.state.tanks[i].velocity.forEach((x, axis) => expect(x).toBeCloseTo(b.state.tanks[i].velocity[axis], 11));
            }
          }
        }
    } finally { a.dispose(); b.dispose(); }
  }
});

it('keeps health, ammo, charge and match settlement resident; rejects invalid batches and stale queries atomically', () => {
  const s = setup(); s.rules.startCharge = 3; s.rules.ammo.explosive = 1;
  const sim = new GameSimulation(world(true), s), n = combat(sim), m = lifecycle(sim), tank = sim.state.tanks[0];
  const id = (n as unknown as { id: number }).id;
  try {
    expect(n.spend(0, 'explosive')).toBe(true); tank.ammo!.explosive = 50;
    expect(n.spend(0, 'explosive')).toBe(false); expect(tank.ammo!.explosive).toBe(0);
    expect(n.spend(0, 'nuclear')).toBe(true); tank.charge = 100;
    expect(n.scan(0)).toBe(false); expect(tank.charge).toBe(0);
    tank.charge = 100; m.action('hold', 0); expect(m.settle(() => 1)).toBe('turn'); expect(tank.charge).toBe(1);
    n.damage(0, 1); expect(tank.charge).toBe(1);
    const before = core.combatCommand(id, 0);
    expect(() => core.combatCommand(id, 3, [2, 0, 1, .1, 0, 10, 99, 1, .1, 0, 20])).toThrow('Unknown combat unit');
    expect(core.combatCommand(id, 0)).toEqual(before);
    const hit: TerrainHit = { point: tank.position, normal: [0, 1, 0], distance: 0, material: 0 };
    const p: ProjectileState = { id: 1, owner: 0, position: hit.point, velocity: [0, 0, 1], age: .5 };
    expect(() => n.impact(p, hit, 0, { core, kind: 1, id: 0xffffffff, range: 100 }, () => { throw new Error('Host query'); })).toThrow('Unknown query snapshot');
    expect(core.combatCommand(id, 0)).toEqual(before);
    expect(() => n.restore(0, { health: NaN })).toThrow('Invalid combat descriptor'); expect(core.combatCommand(id, 0)).toEqual(before);
    const hp = tank.health; tank.health = 99999; n.damage(0, 2); expect(tank.health).toBe(hp - 2);
    expect(n.fall(1)).toBe(true); expect(n.fall(1)).toBe(false);
    sim.state.tanks[1].health = 99999; expect(m.settle(() => 1)).toBe('finish'); expect(sim.state.winner).toBe(0);
  } finally { sim.dispose(); }
  expect(() => core.combatCommand(id, 0)).toThrow('Unknown resident combat');
});

it('preserves ordered sphere selection, strict hit ties, owner immunity and dead-unit exclusion', () => {
  const sim = new GameSimulation(world(true), setup()), n = combat(sim);
  let seed = 1947; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  try {
    for (let i = 0; i < 600; i++) {
      const from: V3 = [random() - .5, random() - .5, random() - .5], dir = normalize([random(), random(), random()]);
      const centers: V3[] = [[random(), random(), random()], [random(), random(), random()]];
      centers.forEach((p, id) => { sim.state.tanks[id].position = p; });
      const age = i % 2 ? .3 : 0, dead = i % 5 === 0;
      n.restore(1, { health: dead ? 0 : 100 });
      const prior: TerrainHit | null = i % 3 ? { distance: .2, point: from, normal: dir, material: 7 } : null;
      const selected = { shape: 'sphere' as const, center: centers[0], radius: .7 };
      let nearest = prior?.distance ?? Infinity, victim: number | null = null, selectedHit = false;
      const at = segmentSphere(from, dir, 4, selected.center, .7);
      if (at !== null && at < nearest) { nearest = at; selectedHit = true; }
      for (let id = 0; id < 2; id++) {
        if (id === 1 && dead || id === 0 && age < .3) continue;
        const t = segmentSphere(from, dir, 4, centers[id], .7);
        if (t !== null && t < nearest) { nearest = t; victim = id; }
      }
      // A poisoned health mirror cannot resurrect a resident dead target.
      sim.state.tanks[1].health = 100;
      const actual = n.resolve(from, dir, 4, age, 0, true, selected, prior);
      expect(actual.victim).toBe(victim); expect(actual.hitTarget).toBe(selectedHit);
      expect(actual.hit?.distance ?? Infinity).toBe(nearest);
    }
  } finally { sim.dispose(); }
});

it('preserves the complete seeded duel through four thousand ticks', () => {
  const s = practiceSetup({ seed: 11, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
  const a = new GameSimulation(world(true), s), b = new GameSimulation(world(false), s);
  try {
    for (const sim of [a, b]) { sim.aim(0, 1, .5, .25); sim.fire(0); sim.endMove(0); }
    for (let tick = 0; tick < 4000; tick++) {
      expect(a.step(FIXED_DT), `events at ${tick}`).toEqual(b.step(FIXED_DT));
      expect(a.state, `state at ${tick}`).toEqual(b.state);
      for (const sim of [a, b]) {
        if (sim.stalledOn?.serial) sim.completeLegacyCarve();
        if (sim.state.phase === 'aim' && sim.state.active === 0 && sim.state.phaseTime > .3) {
          sim.aim(0, .6 + (sim.state.turn % 5) * .2, .7, .4); sim.fire(0);
        }
      }
    }
  } finally { a.dispose(); b.dispose(); }
});
