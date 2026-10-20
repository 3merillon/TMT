import { describe, expect, it } from 'vitest';
import './helpers/realtime';
import { RealtimeCore } from '../src/game/realtime/core';
import type { TankState } from '../src/game/contracts';

describe('native field query ABI', () => {
  it('batches more than 128 candidates without truncation or overwriting the output buffer', () => {
    const core = new RealtimeCore();
    const tanks = Array.from({ length: 600 }, (_, id) => ({ id, position: [id % 2 ? 2 : 1, 0, 0], health: id === 256 ? 0 : 1,
      retired: id === 258 } as TankState));
    expect(core.area([0, 0, 0], 1, tanks)).toEqual(tanks.filter(t => t.id % 2 === 0 && t.health > 0 && !t.retired).map(t => t.id));
    expect(core.area([0, 0, 0], 1, [])).toEqual([]);
    expect(core.area([0, 0, 0], NaN, tanks)).toEqual([]);
    expect(core.area([0, 0, 0], -1, tanks)).toEqual([]);
  });
  it('normalizes incoming velocity and distinguishes the front and rear shield hemisphere', () => {
    const core = new RealtimeCore(), shield = { direction: [0, 0, 1] as [number, number, number], cosine: .5 };
    expect(core.shieldBlocks(shield, [0, 0, -100])).toBe(true);
    expect(core.shieldBlocks(shield, [0, 0, 100])).toBe(false);
    expect(core.shieldBlocks(shield, [100, 0, 0])).toBe(false);
    expect(core.shieldBlocks(shield, [0, 0, 0])).toBe(false);
    expect(core.shieldBlocks({ ...shield, cosine: -1 }, [0, 0, 100])).toBe(true);
  });
});
