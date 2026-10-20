import { describe, expect, it, vi } from 'vitest';
import { VehicleWorld } from './helpers/vehicle-world';
import { vehicleCollisionGeometry } from '../src/game/vehicle/wreck-geometry';
import { add, rotate } from '../src/game/math';
import type { V3 } from '../src/game/contracts';
import { UNIT_KINDS, type UnitKind } from '../src/game/campaign/mission';
import type { RealtimeUnitSpec } from '../src/game/realtime/match';

describe.each([false, true])('wreck gravity, native=%s', native => {
  it.each(Object.keys(UNIT_KINDS) as UnitKind[])('drops and settles %s on its remaining geometry with no powered support', async kind => {
    vi.stubEnv('TMT_NATIVE_PHYSICS', native ? '1' : '0');
    const w = await VehicleWorld.create();
    try {
      w.addPlane();
      const spec: Omit<RealtimeUnitSpec, 'spawn'> = UNIT_KINDS[kind];
      const t = w.addTank({ position: [0, 4, 0], kit: spec.loadout }); t.visualKind = spec.visualKind; t.health = 0;
      w.run(30, () => ({ throttle: 1, steer: 1, selfRight: true }));
      expect(t.position[1]).toBeLessThan(3.5);
      w.run(570, () => ({ throttle: 1, steer: 1, selfRight: true }));
      const geometry = vehicleCollisionGeometry(t);
      const lowest = Math.min(...geometry.map(vertices => {
        let min = Infinity;
        for (let i = 0; i < vertices.length; i += 3) min = Math.min(min, add(t.position, rotate([vertices[i], vertices[i + 1], vertices[i + 2]], t.rotation))[1]);
        return min;
      }));
      expect(lowest).toBeGreaterThan(-.04); expect(lowest).toBeLessThan(.06);
      expect(Math.hypot(...t.velocity)).toBeLessThan(.08);
      expect(t.trackContact).toEqual([0, 0]); expect(t.trackSpeeds).toEqual([0, 0]);
      const before = [...t.position] as V3;
      // Terrain loss must wake a settled wreck; there is no cached height holding it up.
      w.physics.stage([], []).commit(); w.run(45);
      expect(t.position[1]).toBeLessThan(before[1] - 1);
    } finally { w.dispose(); vi.unstubAllEnvs(); }
  });
});
