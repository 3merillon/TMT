import { describe, expect, it } from 'vitest';
import { Shape } from '../src/game/kit/geometry/shapes';
import { buildGear, buildTyre } from '../src/game/kit/parts/gear/common';
import { SCOUT } from '../src/game/kit/parts/gear/scout';
import { GRIP } from '../src/game/kit/parts/gear/grip';
import { CRAWLER } from '../src/game/kit/parts/gear/crawler';
import { AETHER_DRIVE } from '../src/game/kit/parts/gear/aether-drive';
import { FORGE_TRACKS } from '../src/game/kit/parts/gear/forge-tracks';
import type { GearSpec, GroupId, InstancedGroup, KitContext } from '../src/game/kit/parts/types';
import { gearRig } from '../src/game/kit/running';
import { MAT_ID } from '../src/game/kit/types';

const gears = [SCOUT, GRIP, CRAWLER, AETHER_DRIVE, FORGE_TRACKS];
function prototypes(g: GearSpec, detail = 1) {
  const shapes = new Map<GroupId, Shape>(), beltInner = g.halfSpacing - g.width / 2;
  const ctx = { gear: g, beltInner, lowerHalfWidth: beltInner - .015 } as KitContext;
  buildGear(ctx, { get(group) {
    if (!shapes.has(group)) { const s = new Shape(); s.detail = detail; shapes.set(group, s); }
    return shapes.get(group)!;
  } }, gearRig(g).layout.pitch);
  return shapes;
}

describe('running gear material and geometry designs', () => {
  it('gives every close road-wheel silhouette twenty-four sides with a radial roundness error below one percent', () => {
    for (const g of gears) {
      const s = new Shape(), wheel = g.wheels[0];
      buildTyre(s, wheel.radius, wheel.width, g.wheelStyle);
      const angles = new Set<number>();
      for (let i = 0; i < s.mb.p.length; i += 3) {
        const y = s.mb.p[i + 1], z = s.mb.p[i + 2];
        if (Math.abs(Math.hypot(y, z) - wheel.radius) < 1e-6) angles.add(Math.round(((Math.atan2(z, y) + Math.PI * 2) % (Math.PI * 2)) * 1e6));
      }
      expect(angles.size, g.id).toBe(24);
      expect(1 - Math.cos(Math.PI / angles.size)).toBeLessThan(.01);
    }
  });

  it('builds raised rubber pads protected by separate steel shoes and mechanically distinct fantasy parts', () => {
    for (const g of [GRIP, AETHER_DRIVE, FORGE_TRACKS]) {
      const link = prototypes(g).get('links')!.mb;
      const rubber = link.mat.flatMap((m, i) => m === MAT_ID.rubber ? [i] : []), steel = link.mat.flatMap((m, i) => m === MAT_ID.darkSteel ? [i] : []);
      expect(rubber.length).toBeGreaterThan(0); expect(steel.length).toBeGreaterThan(0);
      const width = (indices: number[]) => Math.max(...indices.map(i => Math.abs(link.p[i * 3])));
      expect(width(rubber)).toBeLessThan(width(steel) * .8);
      expect(Math.max(...rubber.map(i => link.p[i * 3 + 1]))).toBeGreaterThan(Math.max(...steel.map(i => link.p[i * 3 + 1])));
    }
    for (const [variant, base] of [[AETHER_DRIVE, GRIP], [FORGE_TRACKS, CRAWLER]]) {
      const a = prototypes(variant), b = prototypes(base);
      for (const group of ['hubs', 'bogies', 'links'] as const) expect(a.get(group)!.mb.p, `${variant.id} ${group}`).not.toEqual(b.get(group)!.mb.p);
      expect(variant.wheels).toEqual(base.wheels); expect(gearRig(variant).layout.linkCount).toBe(gearRig(base).layout.linkCount);
      expect(variant.stats.cost).toBeGreaterThan(base.stats.cost);
    }
  });

  it('keeps repeated geometry bounded and its surfaces consistently wound', () => {
    for (const g of gears) {
      const counts = gearRig(g).layout.counts;
      let triangles = 0;
      for (const [group, s] of prototypes(g)) {
        triangles += s.mb.triangleCount * counts[group as InstancedGroup];
        const edges = new Map<string, [number, number]>(), key = (i: number) => s.mb.p.slice(i * 3, i * 3 + 3).map(v => Math.round(v * 1e7)).join(',');
        for (let i = 0; i < s.mb.idx.length; i += 3) for (let j = 0; j < 3; j++) {
          const a = key(s.mb.idx[i + j]), b = key(s.mb.idx[i + (j + 1) % 3]);
          if (a === b) continue;
          const id = a < b ? `${a}|${b}` : `${b}|${a}`, count = edges.get(id) ?? [0, 0];
          count[a < b ? 0 : 1]++; edges.set(id, count);
        }
        const conflicts = [...edges.values()].filter(([a, b]) => a !== b && a + b > 1).length;
        expect(conflicts, `${g.id}/${group}`).toBe(0);
      }
      expect(triangles, g.id).toBeLessThan(16000);
    }
  });
});
