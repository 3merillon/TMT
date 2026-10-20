import { describe, expect, it } from 'vitest';
import { kitContext, kitGeometry } from '../src/game/kit/build';
import { KIT_PART_IDS, legalKitLoadouts } from '../src/game/kit/catalog';
import { Shape, sweep } from '../src/game/kit/geometry/shapes';
import { KIT_FLAG, type MeshBuilder } from '../src/game/kit/geometry/mesh';
import { stackPath } from '../src/game/kit/parts/hulls/warden';
import { headlightMounts, hullCrewAccess } from '../src/game/kit/parts/hulls/common';
import { HULLS } from '../src/game/kit/parts';
import { penetration } from '../src/game/kit/geometry/convex';
import { MAT_ID, type KitLoadout } from '../src/game/kit/types';

/** Intersections with an axis-parallel line, including triangles facing either way. */
function crossings(mesh: MeshBuilder, axis: number, uValue: number, vValue: number): number[] {
  const u = (axis + 1) % 3, v = (axis + 2) % 3, hits: number[] = [];
  for (let i = 0; i < mesh.idx.length; i += 3) {
    const p = mesh.idx.slice(i, i + 3).map(k => mesh.p.slice(k * 3, k * 3 + 3));
    const ax = p[1][u] - p[0][u], ay = p[1][v] - p[0][v], bx = p[2][u] - p[0][u], by = p[2][v] - p[0][v];
    const d = ax * by - ay * bx;
    if (Math.abs(d) < 1e-12) continue;
    const x = uValue - p[0][u], y = vValue - p[0][v], a = (x * by - y * bx) / d, b = (ax * y - ay * x) / d;
    if (a >= -1e-7 && b >= -1e-7 && a + b <= 1 + 1e-7) hits.push(p[0][axis] + a * (p[1][axis] - p[0][axis]) + b * (p[2][axis] - p[0][axis]));
  }
  return hits;
}

const base: KitLoadout = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };

describe('tank construction regressions', () => {
  it('keeps both point-defense receiver skins clear of the central housing faces', () => {
    const head = kitGeometry(kitContext({ ...base, utility: 'point_defense' }), 0).groups.get('head')![0].mb;
    // Rays through exposed side panels cross both solids. The outermost receiver
    // skin needs real clearance from the gunmetal housing, not coincident faces.
    for (const [y, z] of [[.003, -.019], [-.007, -.013], [.009, -.022]]) {
      const hits = crossings(head, 0, y, z).sort((a, b) => a - b);
      expect(hits.length).toBeGreaterThanOrEqual(4);
      expect(hits[1] - hits[0]).toBeGreaterThan(.001);
      expect(hits.at(-1)! - hits.at(-2)!).toBeGreaterThan(.001);
    }
  });

  it('marks the visible headlamp optics without lighting other glass or painted housings', () => {
    for (const hull of KIT_PART_IDS.hull) for (const lod of [0, 1] as const) {
      const ctx = kitContext({ ...base, hull, utility: 'periscope' });
      const groups = kitGeometry(ctx, lod).groups;
      const mounts = headlightMounts(ctx);
      for (const p of mounts) {
        // The front center of the opaque lens is the surface seen through the aperture.
        const centers = groups.get('hull')!.flatMap(s => s.mb.mat.flatMap((mat, i) =>
          Math.hypot(s.mb.p[i * 3] - p[0], s.mb.p[i * 3 + 1] - p[1], s.mb.p[i * 3 + 2] - p[2] - .024) < 1e-6 ? [{ mat, flags: s.mb.flags[i] }] : []));
        expect(centers.length).toBeGreaterThan(0);
        expect(centers.every(v => v.mat === MAT_ID.glass && (v.flags & KIT_FLAG.headlight) !== 0)).toBe(true);
      }
      for (const [group, shapes] of groups) for (const shape of shapes) {
        shape.mb.flags.forEach((flags, i) => {
          if (!(flags & KIT_FLAG.headlight)) return;
          expect(group).toBe('hull');
          expect([MAT_ID.glass, MAT_ID.signal]).toContain(shape.mb.mat[i]);
          expect(mounts.some(p => Math.hypot(...p.map((v, axis) => shape.mb.p[i * 3 + axis] - v)) < .04)).toBe(true);
        });
      }
    }
  });
  it('keeps the three structural fronts distinct with an actual open channel beside the scout crew tub', () => {
    const tops: number[] = [];
    for (const hull of ['skiff', 'warden', 'bastion'] as const) {
      const ctx = kitContext({ ...base, hull, runningGear: 'scout' });
      const pieces = kitGeometry(ctx, 0).groups.get('hull')!;
      tops.push(Math.max(...pieces.flatMap(s => crossings(s.mb, 1, 0.55, 0))));
      const channel = pieces.flatMap(s => crossings(s.mb, 1, 0, ctx.lowerHalfWidth + 0.04)).filter(y => y > 0.12);
      if (hull === 'skiff') expect(channel, 'independent scout walkways leave a visible gap').toEqual([]);
      else expect(channel.length, `${hull} has structural shoulders`).toBeGreaterThan(0);
    }
    expect(tops[0]).toBeLessThan(0);
    expect(tops[1]).toBeGreaterThan(tops[0] + 0.07);
    expect(tops[2]).toBeGreaterThan(tops[1] + 0.09);
  });

  it('leaves every bore unobstructed through the sleeve, accelerator coils and muzzle brake at all LODs', () => {
    for (const weapon of KIT_PART_IDS.weapon) for (const lod of [0, 1, 2] as const) {
      const ctx = kitContext({ ...base, weapon }), geo = kitGeometry(ctx, lod);
      for (const group of ['barrel', 'cradle'] as const) for (const shape of geo.groups.get(group) ?? []) {
        const blocked = crossings(shape.mb, 2, 0, 0).filter(z => z > ctx.mantletRadius + 0.005 && z <= ctx.weapon.barrelLength + 0.001);
        expect(blocked, `${weapon} LOD${lod} ${group} bore`).toEqual([]);
      }
      const barrel = geo.groups.get('barrel')![0].mb;
      const chamber = crossings(barrel, 2, 0, 0).filter(z => z >= -0.1 && z <= ctx.mantletRadius);
      expect(chamber.length, `${weapon} LOD${lod} recessed chamber closes rear view`).toBeGreaterThan(0);
      let inward = 0;
      for (let i = 0; i < barrel.vertexCount; i++) {
        const x = barrel.p[i * 3], y = barrel.p[i * 3 + 1], z = barrel.p[i * 3 + 2];
        if (Math.abs(Math.hypot(x, y) - ctx.weapon.boreRadius) < 1e-5 && z < 0.2 && x * barrel.n[i * 3] + y * barrel.n[i * 3 + 1] < -0.01) inward++;
      }
      expect(inward, `${weapon} LOD${lod} full-depth inward bore walls`).toBeGreaterThan(0);
    }
  });

  it('keeps one crew hatch on the turret and cuts its roof through to the interior well', () => {
    const openings = { dome: [.13, -.15, .2], wedge: [.1, -.1, .145], aether_crown: [.105, -.155, .212], forge_casemate: [.125, -.225, .2] } as const;
    for (const turret of ['dome', 'wedge', 'aether_crown', 'forge_casemate'] as const) for (const lod of [0, 1] as const) {
      const ctx = kitContext({ ...base, turret }), geo = kitGeometry(ctx, lod);
      const [x, z, floor] = openings[turret];
      const intersections = [...geo.groups.get('turret')!].flatMap(s => crossings(s.mb, 1, z, x));
      expect(intersections.some(y => Math.abs(y - floor) < 1e-6)).toBe(true);
      expect(intersections.filter(y => y > floor + 1e-5), `${turret} LOD${lod} closed roof in opening`).toEqual([]);
    }
    for (const hull of KIT_PART_IDS.hull) {
      const geo = kitGeometry(kitContext({ ...base, hull }), 0);
      expect([...geo.groups.values()].flatMap(shapes => shapes.flatMap(s => s.hulls)).some(piece => piece.tag === 'deck-hatch'), `${hull} has no duplicate raised deck hatch inside the turret sweep`).toBe(false);
    }
  });

  it('adds a seated hull hatch only for the open cradle, including after cached enclosed builds', () => {
    for (const hull of [...new Set(legalKitLoadouts().filter(l => l.turret === 'cradle').map(l => l.hull))]) for (const lod of [0, 1] as const) {
      const closed = kitGeometry(kitContext({ ...base, hull }), lod);
      const open = kitGeometry(kitContext({ ...base, hull, turret: 'cradle' }), lod);
      const hullPieces = (geo: typeof open) => geo.groups.get('hull')!.flatMap(s => s.hulls).filter(p => p.tag === 'deck-hatch');
      expect(hullPieces(closed), `${hull} enclosed turret has no second hatch`).toEqual([]);
      expect(hullPieces(open).length, `${hull} open cradle retains crew access at LOD${lod}`).toBeGreaterThan(0);
      expect(open.groups.get('hatch') ?? []).toEqual([]);
      // Distinct cached hull geometry must survive switching in both directions.
      expect(hullPieces(kitGeometry(kitContext({ ...base, hull }), lod))).toEqual([]);
      const bounds = hullPieces(open).map(p => p.box);
      expect(Math.max(...bounds.map(b => b[4])) - Math.min(...bounds.map(b => b[1]))).toBeLessThan(.15);
    }
  });

  it('backs the full trunnion journal footprint with turret cheek material', () => {
    for (const turret of KIT_PART_IDS.turret) {
      const ctx = kitContext({ ...base, turret }), shapes = kitGeometry(ctx, 0).groups.get('turret')!;
      for (const [dy, dz] of [[0, 0], [.024, 0], [-.024, 0], [0, .024], [0, -.024]]) {
        const hits = shapes.flatMap(s => crossings(s.mb, 0, ctx.turret.trunnion[1] + dy, ctx.turret.trunnion[2] + dz));
        expect(hits.some(x => x > ctx.mantletRadius + .005 && x < .4), `${turret} right bearing ${dy},${dz}`).toBe(true);
        expect(hits.some(x => x < -ctx.mantletRadius - .005 && x > -.4), `${turret} left bearing ${dy},${dz}`).toBe(true);
      }
    }
  });

  it('centers both cast and faceted lower shells on their rotating bearing axis', () => {
    for (const turret of ['dome', 'aether_crown'] as const) for (const lod of [0, 1, 2] as const) {
      const shapes = kitGeometry(kitContext({ ...base, turret }), lod).groups.get('turret')!;
      // This section misses the open gun slot and bearing rim, measuring the
      // actual shell triangles rather than an authored center constant.
      const hits = shapes.flatMap(s => crossings(s.mb, 2, .22, .045));
      expect(hits.length).toBeGreaterThan(1);
      expect(Math.min(...hits) + Math.max(...hits), `${turret} LOD${lod} shell center`).toBeCloseTo(0, 6);
    }
  });

  it('seats every visible hull hatch vertex within its hardware height of actual rendered deck triangles', () => {
    for (const loadout of legalKitLoadouts().filter(l => l.turret === 'cradle' && l.weapon === 'cannon' && l.utility === 'antenna')) for (const lod of [0, 1, 2] as const) {
      const ctx = kitContext(loadout), hatch = new Shape(), body = new Shape();
      hatch.detail = body.detail = [1, .5, .25][lod];
      HULLS[loadout.hull].build(ctx, { get: () => body }); hullCrewAccess(hatch, ctx);
      for (const hatchPiece of hatch.hulls) for (const lamp of body.hulls.filter(p => p.tag === 'lights'))
        expect(penetration(hatchPiece, lamp), `${loadout.hull}/${loadout.runningGear} hatch versus headlamp`).toBeLessThanOrEqual(.001);
      for (let i = 0; i < hatch.mb.vertexCount; i++) {
        const [x, y, z] = hatch.mb.p.slice(i * 3, i * 3 + 3);
        const deck = crossings(body.mb, 1, z, x);
        expect(deck.length, `${loadout.hull}/${loadout.runningGear} LOD${lod} hatch has structure underneath`).toBeGreaterThan(0);
        // Hinge brackets embed a few millimetres into the sloping host; the
        // 18 mm raised nose plate must never conceal the lid itself.
        expect(y - Math.max(...deck), `${loadout.hull}/${loadout.runningGear} LOD${lod} hatch is not buried in deck armor`).toBeGreaterThan(-.012);
        expect(y - Math.max(...deck), `${loadout.hull}/${loadout.runningGear} LOD${lod} hatch seating`).toBeLessThan(.06);
      }
    }
  });

  it('builds exhaust annular rims with coherent radial frames and outward triangle winding', () => {
    const s = new Shape();
    sweep(s, null, stackPath(1), 0.03, 12, { bend: 0.048, bore: { radius: 0.0216, depth: 0.042, mat: MAT_ID.darkSteel } });
    const m = s.mb;
    for (let i = 0; i < m.idx.length; i += 3) {
      const [a, b, c] = m.idx.slice(i, i + 3), p = [a, b, c].map(k => m.p.slice(k * 3, k * 3 + 3));
      const u = p[1].map((x, k) => x - p[0][k]), v = p[2].map((x, k) => x - p[0][k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const shading = [0, 1, 2].map(k => m.n[a * 3 + k] + m.n[b * 3 + k] + m.n[c * 3 + k]);
      expect(n.reduce((sum, x, k) => sum + x * shading[k], 0), `exhaust triangle ${i / 3}`).toBeGreaterThan(0);
    }
  });
});
