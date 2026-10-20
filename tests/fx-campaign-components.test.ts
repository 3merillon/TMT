import { expect, it } from 'vitest';
import { componentMeshes } from '../src/game/presentation/component-meshes';
import { CRAWLER_COMPONENTS } from '../src/game/realtime/components';
import { visibleTankAimProxies } from '../src/game/presentation/aim-target';
import { realtimeRun, realtimeSetup, site, unit } from './helpers/realtime';

it('builds finite machinery at its actual hit locations at every LOD', () => {
  for (const lod of [0, 1, 2] as const) {
    const meshes = componentMeshes(CRAWLER_COMPONENTS, lod);
    for (const component of CRAWLER_COMPONENTS) {
      const mesh = meshes.find(m => m.part === `component:${component.id}`)!;
      expect(mesh.positions.every(Number.isFinite)).toBe(true); expect(mesh.normals.every(Number.isFinite)).toBe(true);
      expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
      for (let axis = 0; axis < 3; axis++) {
        const values = Array.from(mesh.positions).filter((_, i) => i % 3 === axis);
        expect(Math.min(...values)).toBeLessThanOrEqual(component.offset[axis]);
        expect(Math.max(...values)).toBeGreaterThanOrEqual(component.offset[axis]);
      }
    }
    expect(meshes.some(m => m.joint === 'machinery-core-shutter')).toBe(true);
  }
});
it('offers only currently exposed, visible machinery as aim targets', () => {
  const run = realtimeRun(realtimeSetup(), { units: [unit(1, site(12), { components: CRAWLER_COMPONENTS, unarmed: true })] });
  let targets = visibleTankAimProxies(run.match.state, 0, () => true);
  expect(targets.filter(t => t.id.startsWith('component:'))).toHaveLength(4);
  for (const component of run.match.state.tanks[1].components!.slice(0, 4)) component.health = 0;
  targets = visibleTankAimProxies(run.match.state, 0, () => true);
  expect(targets.filter(t => t.id.startsWith('component:'))).toHaveLength(2);
  expect(visibleTankAimProxies(run.match.state, 0, () => false)).toEqual([]); run.match.dispose();
});
