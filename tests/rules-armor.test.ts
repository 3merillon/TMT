import { setCombatState } from './helpers/native-match';
import { describe, expect, it } from 'vitest';
import { assembleKit, ARMOR_SECTION, KIT_PART_IDS, kitKey, legalKitLoadouts, validateKitLoadout, type KitLoadout } from '../src/game/kit';
import { armorResponse } from '../src/game/rules/armor';
import type { ProjectileState, TankState, TerrainHit, V3 } from '../src/game/contracts';
import { practiceSetup } from '../src/game/api/match';
import { FIXED_DT, GameSimulation, MatchReplay } from '../src/game/simulation';
import { TANK_TARGET_RADIUS } from '../src/game/rules/aim-target';
import { SphereWorld } from './helpers/sphere-world';
import { chassisShapes } from '../src/game/vehicle/chassis';

const EQUIPMENT = { runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' } as const;
const HEAVY: KitLoadout = { ...EQUIPMENT, hull: 'bastion', armor: 'reactive' };
const pose: Pick<TankState, 'position' | 'rotation' | 'reactiveArmor'> = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
const damage = (hull: KitLoadout['hull'], point: V3, armor?: KitLoadout['armor']) => Math.round(70 * armorResponse(pose,
  assembleKit({ ...EQUIPMENT, hull, armor }), { point, direct: true, weapon: 'cannon', munition: 'explosive' }).multiplier);

describe('armor equipment and directional protection', () => {
  it('keeps every cosmetic accessory stat, mass distribution and handling identical', () => {
    for (const hull of KIT_PART_IDS.hull) {
      const reference = assembleKit({ ...EQUIPMENT, hull });
      for (const utility of KIT_PART_IDS.utility) {
        const variant = assembleKit({ ...EQUIPMENT, hull, utility });
        expect(variant.stats).toEqual(reference.stats);
        expect(variant.massProps).toEqual(reference.massProps);
        expect(chassisShapes(variant)).toEqual(chassisShapes(reference));
      }
    }
  });
  it('preserves old loadouts and keys, adds optional Bastion armor without accepting invalid variants', () => {
    const standard = { ...EQUIPMENT, hull: 'bastion' } as const;
    expect(validateKitLoadout({ ...standard, armor: 'standard' })).toEqual(standard);
    expect(kitKey({ ...standard, armor: 'standard' })).toBe(kitKey(standard));
    expect(validateKitLoadout(HEAVY)).toEqual(HEAVY);
    expect(() => validateKitLoadout({ ...HEAVY, hull: 'skiff' })).toThrow(/Bastion/);
    expect(() => validateKitLoadout({ ...standard, armor: 'unlimited' })).toThrow(/armor/);
    const a = assembleKit(standard), b = assembleKit(HEAVY);
    expect(b).not.toBe(a);
    expect(b.stats.mass - a.stats.mass).toBeCloseTo(2, 10);
    expect(b.massProps.mass).toBeCloseTo(b.stats.mass, 10);
    expect(b.stats.cost - a.stats.cost).toBe(2);
    expect(b.massProps.inertia[1]).toBeGreaterThan(a.massProps.inertia[1]);
    expect(b.stats.speed).toBeLessThan(a.stats.speed);
    expect(b.stats.hp).toBe(a.stats.hp);
    expect(() => assembleKit({ ...standard, armor: 0 } as unknown as KitLoadout)).toThrow(/armor/);
    for (const l of legalKitLoadouts().filter(l => l.hull === 'bastion')) {
      const normal = assembleKit(l), reactive = assembleKit({ ...l, armor: 'reactive' });
      expect(reactive.stats.mass - normal.stats.mass).toBeCloseTo(2, 10);
      expect(reactive.massProps.mass).toBeCloseTo(reactive.stats.mass, 10);
      expect(reactive.massProps.com[1]).toBeLessThan(-.2);
    }
  });

  it('compares otherwise identical cannon hits and exposes the heavy rear and roof', () => {
    expect(['skiff', 'warden', 'bastion'].map(h => damage(h as KitLoadout['hull'], [0, 0, .8]))).toEqual([70, 60, 44]);
    expect(damage('bastion', [.8, 0, 0])).toBe(53);
    expect(damage('bastion', [0, 0, -.8])).toBe(62);
    expect(damage('bastion', [0, .8, 0])).toBe(65);
    expect(damage('bastion', [0, 0, .8], 'reactive')).toBe(26);
  });

  it('bounds consumption to four independent sections and keeps the damage query pure', () => {
    const kit = assembleKit(HEAVY), tank = structuredClone(pose);
    for (const [point, bit] of [[[0, 0, .8], 1], [[.8, 0, 0], 2], [[-.8, 0, 0], 4], [[0, 0, -.8], 8]] as const) {
      const hit = { point: [...point] as V3, direct: true, weapon: 'cannon', munition: 'explosive' } as const;
      const first = armorResponse(tank, kit, hit);
      expect(first.reactiveSpent).toBe(bit);
      expect(tank.reactiveArmor ?? 0).not.toBe((tank.reactiveArmor ?? 0) | bit);
      tank.reactiveArmor = (tank.reactiveArmor ?? 0) | first.reactiveSpent;
      const second = armorResponse(tank, kit, hit);
      expect(second.reactiveSpent).toBe(0);
      expect(first.multiplier / second.multiplier).toBeCloseTo(.6, 12);
    }
    expect(tank.reactiveArmor).toBe(15);
    expect(HEAVY).not.toHaveProperty('reactiveArmor');
  });

  it('leaves splash, nuclear, upper turret, roof and exposed running gear untriggered; rail only receives 15%', () => {
    const kit = assembleKit(HEAVY), front = { point: [0, 0, .8] as V3, direct: true, weapon: 'cannon', munition: 'explosive' } as const;
    for (const hit of [{ ...front, direct: false }, { ...front, munition: 'nuclear' as const },
      { ...front, point: [0, .45, .8] as V3 }, { ...front, point: [0, .8, 0] as V3 }, { ...front, point: [.8, -.3, 0] as V3 }]) {
      expect(armorResponse(pose, kit, hit).reactiveSpent).toBe(0);
    }
    const rail = armorResponse(pose, kit, { ...front, weapon: 'rail' });
    expect(rail.reactiveSpent).toBe(ARMOR_SECTION.front);
    expect(rail.multiplier).toBeCloseTo(.625 * .85, 12);
    const turned = { ...pose, rotation: [0, 1, 0, 0] as TankState['rotation'] };
    expect(armorResponse(turned, kit, { ...front, point: [0, 0, -.8] }).section).toBe('front');
  });
});

describe('reactive combat state', () => {
  function setup() {
    const s = practiceSetup({ seed: 7, mode: 'local', player: { tracks: 'scout', armor: 'light', barrel: 'cannon' } });
    s.tanks[0].spawn = { up: [0, 1, 0], heading: 0 };
    s.tanks[1].spawn = { up: [0, 1, .3], heading: Math.PI };
    s.tanks[1].loadout = { ...HEAVY };
    return s;
  }
  it('applies consumption once in simulation and respects friendly fire and drive-test invulnerability', () => {
    const game = new GameSimulation(new SphereWorld(), setup()), target = game.state.tanks[1];
    target.position = [0, 20, 0]; target.rotation = [0, 0, 0, 1];
    const hit: TerrainHit = { point: [0, 20, .8], normal: [0, 0, 1], distance: 1, material: 0 };
    const projectile: ProjectileState = { id: 1, owner: 0, position: hit.point, velocity: [0, 0, -1], age: .1 };
    const impact = (game as unknown as { impact(p: ProjectileState, h: TerrainHit, tank: number): void }).impact.bind(game);
    const initial = target.health;
    impact(projectile, hit, 1);
    expect(initial - target.health).toBe(26);
    expect(target.reactiveArmor).toBe(1);
    expect(game.step(0)).toContainEqual(expect.objectContaining({ type: 'impact', hits: expect.arrayContaining([expect.objectContaining({ tank: 1, reactiveSpent: 1 })]) }));
    const second = target.health;
    impact(projectile, hit, 1);
    expect(second - target.health).toBe(44);
    expect(target.reactiveArmor).toBe(1);
    const fresh = new GameSimulation(new SphereWorld(), setup());
    expect(fresh.state.tanks[1].reactiveArmor).toBeUndefined();
    expect(fresh.setup.tanks[1].loadout).not.toHaveProperty('reactiveArmor');
    const friendlySetup = setup(); friendlySetup.rules.friendlyFire = false;
    const friendly = new GameSimulation(new SphereWorld(), friendlySetup), ally = friendly.state.tanks[1];
    setCombatState(friendly, 1, { team: 0 }); ally.position = [0, 20, 0]; ally.rotation = [0, 0, 0, 1];
    (friendly as unknown as { impact(p: ProjectileState, h: TerrainHit, tank: number): void }).impact(projectile, hit, 1);
    expect(ally.reactiveArmor).toBeUndefined(); expect(ally.health).toBe(ally.maxHealth);
    const driveSetup = setup(); driveSetup.mode = 'drive';
    const drive = new GameSimulation(new SphereWorld(), driveSetup), protectedTank = drive.state.tanks[1];
    protectedTank.position = [0, 20, 0]; protectedTank.rotation = [0, 0, 0, 1];
    (drive as unknown as { impact(p: ProjectileState, h: TerrainHit, tank: number): void }).impact(projectile, hit, 1);
    expect(protectedTank.reactiveArmor).toBeUndefined();
    expect(protectedTank.health).toBe(protectedTank.maxHealth);
  });

  it('replays a real direct shot, including a spent section and health, from a JSON checkpoint', () => {
    const world = new SphereWorld(), game = new GameSimulation(world, setup()), target = game.state.tanks[1];
    const aim = game.solveAimTarget(0, { point: [...target.position], object: { kind: 'tank', id: 'tank:1',
      collider: { shape: 'sphere', center: [...target.position], radius: TANK_TARGET_RADIUS } } }, { yaw: 0, pitch: -.08, power: .7 });
    expect(aim.status).toBe('ready');
    expect(game.command(0, { k: 'aim', ...aim.aim! })).toBe(true);
    expect(game.fire(0)).toBe(true);
    const events = [];
    for (let i = 0; i < 360 && !game.stalledOn; i++) events.push(...game.step(FIXED_DT));
    expect(target.reactiveArmor, JSON.stringify({ events, target, aim })).toBe(1);
    game.completeLegacyCarve();
    const checkpoint = JSON.parse(JSON.stringify(game.checkpoint())), replay = new MatchReplay(new SphereWorld(), checkpoint);
    for (let i = 0; i < 1000 && !replay.done; i++) {
      const result = replay.advance(30);
      if (result === 'stalled' && replay.simulation.stalledOn?.serial) replay.simulation.completeLegacyCarve();
    }
    expect(replay.verified()).toBe(true);
    expect(replay.simulation.state.tanks[1].reactiveArmor).toBe(1);
    expect(replay.simulation.state.tanks[1].health).toBe(target.health);
  });
});
