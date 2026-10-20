import { kitContext, kitGeometry } from '../../src/game/kit/build';
import { INSTANCED_GROUPS, type InstancedGroup } from '../../src/game/kit/parts/types';
import { gearRig, lod2LinkInstances } from '../../src/game/kit/running';
import type { KitLoadout } from '../../src/game/kit/types';

/** Exact submitted index/instance counts, without baking identical AO buffers thousands of times. */
export function geometryBudget(loadout: KitLoadout, lod: 0 | 1 | 2): { triangles: number; draws: number } {
  const ctx = kitContext(loadout), geo = kitGeometry(ctx, lod), layout = gearRig(ctx.gear).layout;
  let triangles = 0, draws = 0;
  for (const [group, shapes] of geo.groups) {
    const count = shapes.reduce((sum, shape) => sum + shape.mb.idx.length / 3, 0);
    if (!count) continue;
    draws++;
    const instances = INSTANCED_GROUPS.includes(group as InstancedGroup)
      ? group === 'links' && lod === 2 ? lod2LinkInstances(layout.linkCount) : layout.counts[group as InstancedGroup]
      : 1;
    triangles += count * instances;
  }
  return { triangles, draws };
}
