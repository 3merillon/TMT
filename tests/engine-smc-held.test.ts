/** Held SMC stamps (surface-memory.ts SmcHeldQuads): a repeat of the previous frame's held quad is skipped only while
 * nothing lowered the cube, and a quad absent for a frame is drawn again when it returns. */
import { describe, expect, it } from 'vitest';
import { planSmcStamp, SmcHeldQuads, type SmcQuad, type SmcStamp } from '../src/engine/scene/surface-memory';

const R = 18.4;
const track = (z: number): SmcStamp => ({ center: [0, R, z], forward: [0, 0, 1], halfLength: 0.4, halfWidth: 0.12, strength: 0.8, soft: 0.2, endSoft: 0.06, tread: [1, 3] });
function frame(held: SmcHeldQuads, stamps: SmcStamp[], lowered = false): SmcQuad[] {
  const keep: SmcQuad[] = [];
  held.filter(stamps.flatMap(s => planSmcStamp(s)), lowered, keep);
  held.flip();
  return keep;
}

describe('held SMC stamps', () => {
  it('draws a parked contact once, again after every lowering, and whatever moved', () => {
    const held = new SmcHeldQuads();
    expect(frame(held, [track(0)])).toHaveLength(1);
    expect(frame(held, [track(0)])).toHaveLength(0);
    expect(frame(held, [track(0)], true)).toHaveLength(1);
    expect(frame(held, [track(0), track(1)])).toHaveLength(1);
    expect(frame(held, [track(0), track(1)])).toHaveLength(0);
    expect(frame(held, [])).toHaveLength(0);
    // Absent for a frame: no longer known to be drawn since the last lowering.
    expect(frame(held, [track(0)])).toHaveLength(1);
  });

  it('compares the packed quad bits and the face', () => {
    const held = new SmcHeldQuads();
    frame(held, [track(0)]);
    expect(frame(held, [{ ...track(0), strength: 0.8000001 }])).toHaveLength(1);
    const seam: SmcStamp = { center: [R / Math.SQRT2, R / Math.SQRT2, 0.3], forward: [0, 0, 1], halfLength: 0.4, halfWidth: 0.16, strength: 0.8 };
    expect(frame(held, [seam])).toHaveLength(2);
    expect(frame(held, [seam])).toHaveLength(0);
  });
});
