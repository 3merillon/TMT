import { expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { DebrisHost, type DebrisFrame } from '../src/game/presentation/debris-host';

it('waits for initial terrain pages before dropping shards, then retains support while the next version loads', async () => {
  await RAPIER.init();
  const host = new DebrisHost(() => undefined);
  const vertices = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map(x => x * .1));
  const base: DebrisFrame = { frame: 0, commands: [], water: [], tanks: [], supports: [], substeps: 60 };
  try {
    const pending = host.apply({ ...base, commands: [['add', { id: 1, positions: vertices, position: [0, 18.5, 0], velocity: [0, 0, 0],
      rotation: [0, 0, 0, 1], angularVelocity: [0, 0, 0], radius: .2, density: 7.5, generation: 1 }]],
      terrain: [{ version: 7, complete: false, set: [['floor', new Float32Array([-5, 18, -5, 5, 18, -5, 5, 18, 5, -5, 18, 5]), new Uint32Array([0, 2, 1, 0, 3, 2])]] }] });
    expect(pending.state[2]).toBe(18.5); expect(pending.state[16]).toBe(0);
    expect(host.apply({ ...base, frame: 1 }).state[16]).toBe(0);
    const ready = host.apply({ ...base, frame: 2, terrain: [{ version: 7, complete: true }] });
    expect(ready.state[2]).toBeCloseTo(18.1, 1); expect(ready.state[16]).toBeCloseTo(1);
    const updating = host.apply({ ...base, frame: 3, terrain: [{ version: 8, complete: false }] });
    expect(updating.state[2]).toBeCloseTo(18.1, 1); expect(updating.state[16]).toBeCloseTo(2);
  } finally { host.dispose(); }
});
