import { describe, expect, it } from 'vitest';
import type { SceneRegistry } from '../src/engine';
import type { LightInit, MeshDesc } from '../src/engine/contracts';
import { assembleKit, buildKitMesh, KIT_PART_IDS, legalKitLoadouts } from '../src/game/kit';
import { kitContextOf } from '../src/game/kit/assembly';
import { DECK_Y, glacisSlope, glacisY } from '../src/game/kit/parts/hulls/common';
import { BASTION_ARMOR } from '../src/game/kit/parts/hulls/bastion';
import { defaultAppearance } from '../src/game/meta/cosmetics';
import { tankSurface } from '../src/game/presentation/tank-surface';
import { paintedMesh } from '../src/game/presentation/paint-atlas';
import { componentPaintGeometry } from '../src/game/presentation/paint-geometry';
import { PaintSession, DEFAULT_BRUSH } from '../src/game/workshop/paint';
import { reactiveArmorMeshes } from '../src/game/presentation/reactive-armor-mesh';
import { VehicleLights } from '../src/game/presentation/vehicle-lights';
import { composeTRS, TankViews } from '../src/game/presentation/tank-view';
import { clearOnlineAppearances, configureOnlineAppearances, publishOnlineAppearance } from '../src/game/presentation/online-appearance';
import { practiceSetup } from '../src/game/api/match';
import { GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';
import { geometryBudget } from './helpers/kit-geometry-budget';

const kit = { hull: 'bastion', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna', armor: 'reactive' } as const;
function fakeScene() {
  let id = 0; const meshes = new Map<number, MeshDesc>(), lights = new Map<number, LightInit>(), instances = new Set<number>();
  const scene = { meshes: { create: (d: MeshDesc) => { const h = { id: id++ }; meshes.set(h.id, d); return h; }, destroy: (h: { id: number }) => meshes.delete(h.id) },
    instances: { add: () => { const h = { id: id++ }; instances.add(h.id); return h; }, set() {}, setVisibility() {}, remove: (h: { id: number }) => instances.delete(h.id) },
    lights: { add: (l: LightInit) => { const h = { id: id++ }; lights.set(h.id, l); return h; }, update: (h: { id: number }, l: Partial<LightInit>) => lights.set(h.id, { ...lights.get(h.id)!, ...l }), remove: (h: { id: number }) => lights.delete(h.id) }, get: () => undefined } as unknown as SceneRegistry;
  return { scene, meshes, lights, instances };
}
describe('vehicle presentation state', () => {
  it('retains compatible articulated paint and rejects replacement component paint', () => {
    const geometry = componentPaintGeometry(kit).find(g => g.slot === 'turret' && g.group === 'turret' && g.lod === 0)!;
    const chart = geometry.charts.find(c => c.width > 15 && c.height > 15)!;
    const session = new PaintSession(defaultAppearance(), kit);
    session.dab({ slot: 'turret', partId: 'dome', group: 'turret', position: [0, 1, 2].map(k => chart.points.reduce((s, p) => s + p[k] / 3, 0)) as [number, number, number], normal: chart.normals[0] }, DEFAULT_BRUSH);
    const appearance = session.value, mesh = buildKitMesh(assembleKit(kit), 0).parts.find(p => p.part === 'turret')!;
    expect(paintedMesh(mesh, appearance, kit, 'turret', 0).paintTexture).toBeDefined();
    expect(paintedMesh(mesh, appearance, { ...kit, turret: 'wedge' }, 'turret', 0).paintTexture).toBeUndefined();
    expect(paintedMesh(mesh, appearance, kit, 'hull', 0).paintTexture).toBeUndefined();
    expect(tankSurface(appearance, kit, undefined, 'turret').marks).toHaveLength(0);
  });
  it('removes only the consumed reactive covers and keeps all mounting trays', () => {
    const a = assembleKit(kit), intact = reactiveArmorMeshes(a, 0), spent = reactiveArmorMeshes(a, 0, 1);
    expect(intact.map(x => x.bit)).toEqual([1, 2, 4, 8]);
    expect([...intact[0].mesh.attrs].some(a => ((a >>> 16) & 255) === 0)).toBe(true);
    expect([...spent[0].mesh.attrs].some(a => ((a >>> 16) & 255) === 0)).toBe(false);
    expect(spent[0].mesh.indices.length).toBeGreaterThan(0);
    expect(spent[1].mesh.positions).toEqual(intact[1].mesh.positions);
  });
  it('seats reactive front trays on the current heavy glacis for every running gear', () => {
    for (const runningGear of KIT_PART_IDS.runningGear) {
      const a = assembleKit({ ...kit, runningGear }), ctx = kitContextOf(a);
      const angle = Math.atan(-glacisSlope(ctx.hull, (ctx.hull.deckFront + ctx.hull.nose[0]) / 2));
      const p = reactiveArmorMeshes(a, 0)[0].mesh.positions;
      let minimum = Infinity, maximum = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        const separation = (p[i + 1] - glacisY(ctx.hull, p[i + 2])) * Math.cos(angle);
        minimum = Math.min(minimum, separation); maximum = Math.max(maximum, separation);
        expect(p[i + 1]).toBeLessThan(DECK_Y + .025);
      }
      expect(minimum).toBeCloseTo(BASTION_ARMOR - .001, 5);
      expect(maximum).toBeLessThan(BASTION_ARMOR + .05);
    }
  });
  it('includes reactive cassettes in the unchanged complete-vehicle rendering budgets', () => {
    for (const l of legalKitLoadouts().filter(l => l.hull === 'bastion')) {
      const loadout = { ...l, armor: 'reactive' as const }, a = assembleKit(loadout);
      for (const lod of [0, 1, 2] as const) {
        const base = geometryBudget(loadout, lod), armor = reactiveArmorMeshes(a, lod);
        const budget = { triangles: base.triangles + armor.reduce((sum, p) => sum + p.mesh.indices.length / 3, 0), draws: base.draws + armor.length };
        expect(budget.triangles, `${a.key}/LOD${lod}`).toBeLessThanOrEqual([20000, 6000, 1200][lod]);
        expect(budget.draws).toBeLessThanOrEqual(24);
      }
    }
  });
  it('mounts shadowed headlights to rotated hulls and releases the fixed light allocation', () => {
    const f = fakeScene(), lamps = new VehicleLights(f.scene, assembleKit(kit));
    const model = composeTRS([3, 4, 5], [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]);
    lamps.update(model, true, 1, 123); expect(f.lights.size).toBe(2);
    expect([...f.lights.values()].map(l => l.sourceCasterId)).toEqual([123, 123]);
    for (const l of f.lights.values()) { expect(l.castShadow).toBe(true); expect(l.direction![0]).toBeGreaterThan(.9); expect(l.direction![1]).toBeLessThan(0); expect(l.position[0]).toBeGreaterThan(3); }
    lamps.update(model, false); expect(f.lights.size).toBe(0);
    lamps.update(model, true); lamps.dispose(); expect(f.lights.size).toBe(0);
  });
  it('bounds combat marks, keeps them through LOD/pose changes and never writes them into saved appearance', () => {
    const f = fakeScene(), views = new TankViews(f.scene);
    const sim = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'grip', barrel: 'cannon', armor: 'heavy' } }));
    const state = structuredClone(sim.state), t = state.tanks[0]; t.position = [0, 0, 0]; t.rotation = [0, 0, 0, 1]; t.kit = { ...kit };
    views.update(state, 1 / 60, t => t.id === 0, () => 100);
    for (let i = 0; i < 30; i++) {
      views.impact({ type: 'impact', position: [0, .02, 1.5], normal: [0, 0, 1], radius: .1, owner: 1, hits: [{ tank: 0, direct: true, damage: 30, exposure: 1, lethal: false }] });
    }
    t.turretYaw = 1; t.recoil = .8; views.update(state, 1 / 60, t => t.id === 0, () => 3);
    const scars = [...f.meshes.values()].flatMap(m => m.tankSurface?.marks?.filter(m => m.damage) ?? []);
    expect(scars).toHaveLength(24);
    expect(scars.every(m => m.position[2] < 1.2)).toBe(true);
    expect(t).not.toHaveProperty('appearance'); expect(t).not.toHaveProperty('scars');
    views.dispose(); expect(f.meshes.size).toBe(0); expect(f.instances.size).toBe(0); expect(f.lights.size).toBe(0);
  });
  it('applies an online appearance arriving after initial rendering and replaces it on the next frame', () => {
    configureOnlineAppearances('paint-test');
    const f = fakeScene(), views = new TankViews(f.scene);
    try {
      const sim = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'grip', barrel: 'cannon', armor: 'heavy' } }));
      const state = structuredClone(sim.state), tank = state.tanks[0]; tank.kit = { ...kit };
      views.update(state, 1 / 60, t => t.id === 0, () => 100);
      expect([...f.meshes.values()].some(mesh => mesh.paintTexture)).toBe(false);
      const session = new PaintSession(defaultAppearance(), kit);
      const geometry = componentPaintGeometry(kit).find(g => g.slot === 'hull' && g.lod === 0)!;
      const chart = geometry.charts.find(c => c.width > 25 && c.height > 25)!;
      session.begin(); session.dab({ slot: 'hull', partId: kit.hull, group: geometry.group, position: [0, 1, 2].map(k => chart.points.reduce((s, p) => s + p[k] / 3, 0)) as [number, number, number], normal: chart.normals[0] }, DEFAULT_BRUSH); session.end();
      publishOnlineAppearance(tank.id, session.value);
      views.update(state, 1 / 60, t => t.id === 0, () => 100);
      expect([...f.meshes.values()].some(mesh => mesh.paintTexture)).toBe(true);
      publishOnlineAppearance(tank.id, defaultAppearance());
      views.update(state, 1 / 60, t => t.id === 0, () => 100);
      expect([...f.meshes.values()].some(mesh => mesh.paintTexture)).toBe(false);
    } finally { views.dispose(); clearOnlineAppearances(); }
  });
  it('switches off both lens glow and beams on a destroyed vehicle', () => {
    const f = fakeScene(), views = new TankViews(f.scene);
    const sim = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'grip', barrel: 'cannon', armor: 'heavy' } }));
    const state = structuredClone(sim.state), t = state.tanks[0]; t.kit = { ...kit };
    views.update(state, 1 / 60, t => t.id === 0, () => 100);
    expect([...f.meshes.values()].filter(m => m.tankSurface).every(m => m.tankSurface!.lights)).toBe(true);
    expect(f.lights.size).toBe(2);
    t.health = 0; views.update(state, 1 / 60, t => t.id === 0, () => 100);
    expect([...f.meshes.values()].filter(m => m.tankSurface).every(m => m.tankSurface!.lights === false)).toBe(true);
    expect(f.lights.size).toBe(0);
    views.dispose();
  });
});
