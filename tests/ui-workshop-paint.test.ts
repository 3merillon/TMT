import { afterEach, describe, expect, it } from 'vitest';
import type { MeshDesc, SceneRegistry, Vec3 } from '../src/engine';
import { MAX_PAINT_DABS, defaultAppearance, equippedAppearance, sanitizeCosmetics, type PaintDab } from '../src/game/meta/cosmetics';
import { activeKit, defaultProfile, exportProfile, importProfile, withAppearance, withLoadout } from '../src/game/meta/profile';
import { tankSurface } from '../src/game/presentation/tank-surface';
import { buildStats, partCards, replacementKit, sameKit, WorkshopInstallGuard } from '../src/game/ui/workshop-model';
import { DEFAULT_BRUSH, PaintSession, retainedPaint } from '../src/game/workshop/paint';
import { currentVehicleAppearance, disableWorkshopSandbox, enableWorkshopSandbox, workshopSandbox } from '../src/game/workshop/sandbox';
import { WorkshopTank } from '../src/game/workshop/tank';
import { WORKSHOP_TANK_SCALE } from '../src/game/workshop/dimensions';
import { componentPaintGeometry } from '../src/game/presentation/paint-geometry';
import { paintTextureTiles } from '../src/game/presentation/paint-raster';

const kit = { hull: 'skiff', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };
const dab: PaintDab = { slot: 'hull', partId: 'skiff', group: 'hull', position: [.2, .1, .3], normal: [0, 1, 0], radius: .14, color: '#e5c080', opacity: .6, softness: .4 };
afterEach(disableWorkshopSandbox);

describe('persistent surface designs', () => {
  it('round trips bounded strokes, customized camouflage and lamps without affecting gameplay', () => {
    const original = defaultProfile(), appearance = { ...defaultAppearance(), finish: { pattern: 'woodland' as const, colors: ['#678f54', '#3c4c30', '#c0a677'] as [string, string, string], scale: 1.4 }, paint: [dab], lights: false };
    const profile = withAppearance(original, appearance), imported = importProfile(exportProfile(profile));
    expect(imported.ok).toBe(true); if (!imported.ok) return;
    expect(equippedAppearance(imported.profile.cosmetics)).toEqual(appearance);
    expect(profile.loadouts).toEqual(original.loadouts); expect(profile.stats).toEqual(original.stats);
    expect(buildStats(activeKit(profile))).toEqual(buildStats(activeKit(original)));
  });
  it('repairs malformed payloads and enforces profile storage limits', () => {
    const input = { ...defaultAppearance(), paint: [dab, { ...dab, position: [NaN, 0, 0] }, { ...dab, normal: [0, 0, 0] }, { ...dab, color: 'url(evil)' }] };
    expect(sanitizeCosmetics({ appearance: input }).appearance?.paint).toEqual([dab]);
    const bounded = sanitizeCosmetics({ appearance: { ...input, paint: Array(500).fill(dab) } }).appearance!;
    expect(bounded.paint).toHaveLength(MAX_PAINT_DABS);
    expect(sanitizeCosmetics({ appearance: { ...input, paint: [{ ...dab, slot: 'utility', partId: 'whip_short' }] } }).appearance?.paint).toHaveLength(1);
  });
  it('commits whole gestures, supports redo, cancels independently, resets and bounds history', () => {
    const original = defaultAppearance(), session = new PaintSession(original, kit);
    const geometry = componentPaintGeometry(kit).find(g => g.slot === 'hull' && g.lod === 0)!;
    const chart = geometry.charts.find(c => c.width > 25 && c.height > 25)!;
    const hit = { ...dab, position: [0, 1, 2].map(k => chart.points.reduce((s, p) => s + p[k] / 3, 0)) as [number, number, number], normal: chart.normals[0] };
    session.begin(); session.dab(hit, DEFAULT_BRUSH); session.dab(hit, { ...DEFAULT_BRUSH, color: '#ff0000' }); session.end();
    expect(paintTextureTiles(session.value)).toBeGreaterThan(0); expect(original.paintTextures).toBeUndefined();
    const painted = session.value;
    session.undo(); expect(session.value.paintTextures).toBeUndefined(); session.redo(); expect(session.value).toEqual(painted);
    session.begin(); session.dab(hit, { ...DEFAULT_BRUSH, eraser: true }); session.end(); expect(session.value).not.toEqual(painted);
    session.undo(); expect(session.value).toEqual(painted); session.reset(); expect(session.value.paintTextures).toHaveLength(0);
    expect(session.original).toEqual(original);
    for (let i = 0; i < 50; i++) session.change({ ...session.value, lights: i % 2 === 0 });
    let undos = 0; while (session.canUndo) { session.undo(); undos++; } expect(undos).toBe(32);
  });
  it('keeps retained equipment paint and never applies another component or incompatible model', () => {
    const appearance = { ...defaultAppearance(), paint: [dab, { ...dab, slot: 'turret' as const, partId: 'dome', group: 'turret' }] };
    expect(retainedPaint(appearance, { ...kit, hull: 'bastion' })).toHaveLength(1);
    expect(tankSurface(appearance, kit, 'hull', 'hull').marks).toHaveLength(0); // legacy paint is baked; only damage uses marks
    expect(tankSurface(appearance, { ...kit, hull: 'warden' }, 'hull', 'hull').marks).toHaveLength(0);
    expect(tankSurface(appearance, kit, 'weapon', 'hull').marks).toHaveLength(0);
    expect(tankSurface(appearance, kit, 'turret', 'hatch').marks).toHaveLength(0);
  });
});

describe('unrestricted workshop boundary', () => {
  it('bypasses budget alone, keeping actual mount errors explicit', () => {
    const expensive = { ...kit, hull: 'bastion', runningGear: 'crawler', weapon: 'rail', utility: 'smoke' };
    const normal = partCards(expensive, 'turret');
    const guard = new WorkshopInstallGuard();
    for (const card of normal.filter(card => card.status === 'over-budget')) {
      expect(guard.begin(0, expensive, 'turret', card.id)).toBeNull();
      expect(guard.begin(0, expensive, 'turret', card.id, Infinity)).not.toBeNull();
    }
    const incompatible = partCards({ ...kit, turret: 'wedge', weapon: 'cannon' }, 'weapon', Infinity).find(card => card.status === 'incompatible');
    expect(incompatible).toBeDefined(); expect(incompatible?.reason).not.toBe('');
    expect(guard.begin(0, { ...kit, turret: 'wedge', weapon: 'cannon' }, 'weapon', incompatible!.id, Infinity)).toBeNull();
  });
  it('keeps sandbox builds and appearance out of saved ownership and supports explicit test use', () => {
    const profile = defaultProfile(), snapshot = exportProfile(profile); enableWorkshopSandbox(profile);
    workshopSandbox.kit = { ...kit, hull: 'bastion', armor: 'reactive' };
    workshopSandbox.appearance = { ...defaultAppearance(), paint: [dab], lights: false };
    expect(exportProfile(profile)).toBe(snapshot);
    workshopSandbox.testing = true; expect(currentVehicleAppearance()).toEqual(workshopSandbox.appearance);
    disableWorkshopSandbox(); expect(workshopSandbox).toEqual({ active: false, testing: false, kit: null, appearance: null });
  });
  it('migrates optional armor and resets incompatible hull armor without affecting other equipment', () => {
    const reactive = { ...kit, hull: 'bastion', armor: 'reactive' as const }, profile = withLoadout(defaultProfile(), 0, reactive);
    const imported = importProfile(exportProfile(profile)); if (!imported.ok) throw Error(imported.error);
    expect(activeKit(imported.profile).armor).toBe('reactive');
    expect(sameKit(reactive, { ...reactive, armor: 'standard' })).toBe(false);
    expect(replacementKit(reactive, 'hull', 'skiff')).toEqual(kit);
  });
  it('fits Wedge with the necessary cannon atomically and preserves already compatible equipment', () => {
    const from = { ...kit, hull: 'warden' }, paired = replacementKit(from, 'turret', 'wedge');
    expect(paired).toEqual({ ...from, turret: 'wedge', weapon: 'cannon' });
    expect(replacementKit({ ...from, weapon: 'rail' }, 'turret', 'wedge')).toEqual({ ...from, turret: 'wedge', weapon: 'rail' });
    const card = partCards(from, 'turret', Infinity).find(c => c.id === 'wedge')!;
    expect(card.status).toBe('available'); expect(card.adjustments).toEqual(['Arc mortar → Field cannon']); expect(card.stats).toEqual(buildStats(paired));
    const guard = new WorkshopInstallGuard(), job = guard.begin(0, from, 'turret', 'wedge', Infinity)!;
    expect(guard.complete(job.token, 0, from)?.candidate).toEqual(paired);
    expect(partCards(from, 'turret', 1).find(c => c.id === 'wedge')?.status).toBe('over-budget');
    expect(replacementKit({ ...kit, turret: 'cradle' }, 'hull', 'bastion')).toEqual({ ...kit, hull: 'bastion', turret: 'dome', armor: 'reactive' });
  });
  it('includes reactive armor when selecting a new heavy hull and preserves explicit standard or legacy heavy builds', () => {
    const heavy = replacementKit(kit, 'hull', 'bastion');
    expect(heavy.armor).toBe('reactive');
    const card = partCards(kit, 'hull', Infinity).find(c => c.id === 'bastion')!;
    expect(card.adjustments).toContain('Reactive armor package included');
    expect(card.stats!.mass - buildStats({ ...heavy, armor: 'standard' })!.mass).toBeCloseTo(2);
    expect(card.cost! - buildStats({ ...heavy, armor: 'standard' })!.cost).toBe(2);
    const stripped = { ...heavy, armor: 'standard' as const };
    expect(replacementKit(stripped, 'hull', 'bastion')).toEqual(stripped);
    const legacy = { ...kit, hull: 'bastion' };
    expect(replacementKit(legacy, 'hull', 'bastion')).toEqual(legacy);
    expect(replacementKit(heavy, 'hull', 'warden').armor).toBeUndefined();
  });
});

function mockScene() {
  let serial = 0; const meshes = new Map<number, MeshDesc>();
  const scene = { meshes: { create: (mesh: MeshDesc) => { const id = ++serial; meshes.set(id, mesh); return { id }; }, destroy: (handle: { id: number }) => meshes.delete(handle.id) },
    instances: { add: () => ({ id: ++serial }), remove() {}, set() {}, setVisibility() {} }, get() { return undefined; },
    lights: { add: () => ({ id: ++serial }), update() {}, remove() {} } } as unknown as SceneRegistry;
  return { scene, meshes };
}
describe('actual workshop paint surface picking', () => {
  it('returns component-local anchors, follows the lift, and excludes the running gear', () => {
    const { scene, meshes } = mockScene(), tank = new WorkshopTank(scene, kit, [0, 0, 0]);
    let origin: Vec3 = [0, 4, .8], hit = tank.paintRaycast(origin, [0, -1, 0]);
    for (const x of [-.3, -.2, .1, .2, .3]) { if (hit?.slot === 'hull') break; origin = [x, 4, .8]; hit = tank.paintRaycast(origin, [0, -1, 0]); }
    expect(hit?.slot).toBe('hull'); expect(hit?.partId).toBe('skiff'); expect(hit?.normal[1]).toBeGreaterThan(0);
    tank.setRoot([1, 2, 3]); const moved = tank.paintRaycast([origin[0] + 1, origin[1] + 2, origin[2] + 3], [0, -1, 0]);
    for (let i = 0; i < 3; i++) expect(moved?.position[i]).toBeCloseTo(hit!.position[i], 10);
    tank.setAppearance({ ...defaultAppearance(), paint: [{ ...dab, ...hit! }] });
    const painted = [...meshes.values()].find(mesh => mesh.label === `workshop:tank:hull:${hit!.group}`)!;
    expect(painted.tankSurface?.marks).toHaveLength(0);
    expect(painted.paintTexture?.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
    expect(painted.paintTexture?.uv.length).toBe(painted.positions.length / 3 * 2);
    for (const slot of ['hull', 'turret', 'weapon', 'utility'] as const) tank.setVisible(slot, false);
    expect(tank.paintRaycast([1.9, 2, 6], [0, 0, -1])).toBeNull(); tank.dispose(); expect(meshes.size).toBe(0);
  });
});
