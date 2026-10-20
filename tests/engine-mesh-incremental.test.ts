/**
 * The instance table's incremental upload: writes that change nothing are dropped, beginFrame visits only slots that
 * can still change, and the dirty range covers every changed slot, so a buffer that receives only the dirty ranges
 * holds exactly what a whole-table upload every frame would hold.
 */
import { describe, expect, it } from 'vitest';
import { INSTANCE_FLOATS, InstanceTable } from '../src/engine/passes/gbuffer/part-mesh-data';

/** The per-frame prev copy as it was written before the incremental table: every live slot, every frame. */
function referenceBeginFrame(data: Float32Array, drawn: Float32Array, live: (slot: number) => boolean, fresh: Set<number>, high: number): void {
  for (let s = 0; s < high; s++) {
    if (!live(s)) continue;
    const o = s * INSTANCE_FLOATS;
    if (fresh.has(s)) { fresh.delete(s); data.copyWithin(o + 16, o, o + 16); drawn.set(data.subarray(o, o + 16), s * 16); continue; }
    for (let k = 0; k < 16; k++) { const prev = drawn[s * 16 + k]; data[o + 16 + k] = prev; drawn[s * 16 + k] = data[o + k]; }
  }
}

describe('incremental instance table', () => {
  it('matches the whole-table prev copy and uploads every changed slot', () => {
    let seed = 7;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const t = new InstanceTable(4);
    const ref = { data: new Float32Array(0), drawn: new Float32Array(0), fresh: new Set<number>() };
    const gpu: number[] = [];
    const live = new Set<number>();
    const matrix = () => Float32Array.from({ length: 16 }, () => random() < 0.3 ? 0 : Math.round(random() * 8) / 4);
    let mismatches = 0;
    for (let frame = 0; frame < 1500; frame++) {
      const ops = Math.floor(random() * 6);
      for (let n = 0; n < ops; n++) {
        const r = random(), slots = [...live];
        if ((r < 0.2 && slots.length < 48) || !slots.length) {
          const m = matrix(), s = t.add(1 + Math.floor(random() * 3), { model: m, visibility: random() });
          live.add(s); ref.fresh.add(s);
          if (ref.data.length < t.slotCapacity * INSTANCE_FLOATS) {
            const data = new Float32Array(t.slotCapacity * INSTANCE_FLOATS); data.set(ref.data); ref.data = data;
            const drawn = new Float32Array(t.slotCapacity * 16); drawn.set(ref.drawn); ref.drawn = drawn;
          }
          ref.data.set(t.data.subarray(s * INSTANCE_FLOATS, (s + 1) * INSTANCE_FLOATS), s * INSTANCE_FLOATS);
          ref.drawn.set(m, s * 16);
          continue;
        }
        const s = slots[Math.floor(random() * slots.length)];
        if (r < 0.32) { t.remove(s); live.delete(s); ref.fresh.delete(s); }
        else if (r < 0.75) { const m = random() < 0.5 ? t.model(s).slice() : matrix(); t.set(s, m); ref.data.set(m, s * INSTANCE_FLOATS); }
        else if (r < 0.85) { t.setVisibility(s, random()); ref.data.set(t.data.subarray(s * INSTANCE_FLOATS + 32, (s + 1) * INSTANCE_FLOATS), s * INSTANCE_FLOATS + 32); }
        else if (r < 0.95) { t.restart(s); ref.fresh.add(s); }
        else { t.dataDirty = true; }
      }
      t.beginFrame();
      referenceBeginFrame(ref.data, ref.drawn, s => live.has(s), ref.fresh, t.highWater);
      if (t.dataDirty) {
        for (let i = t.dirtyFirst * INSTANCE_FLOATS; i < t.dirtyEnd * INSTANCE_FLOATS; i++) gpu[i] = t.data[i];
        t.dataDirty = false;
      }
      for (const s of live) {
        const o = s * INSTANCE_FLOATS;
        for (let k = 0; k < INSTANCE_FLOATS; k++) {
          if (k < 32 && !Object.is(t.data[o + k], ref.data[o + k])) mismatches++;
          if (!Object.is(gpu[o + k], t.data[o + k])) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
  });

  it('drops unchanged writes and settles a still instance', () => {
    const t = new InstanceTable();
    const m = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]);
    const s = t.add(1, { model: m });
    t.beginFrame(); t.dataDirty = false;
    t.set(s, m.slice());
    t.setVisibility(s, 1);
    t.beginFrame();
    expect(t.dataDirty).toBe(false);
    t.restart(s);
    t.set(s, Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 3, 4, 1]));
    t.beginFrame();
    expect([t.prevModel(s)[12], t.model(s)[12]]).toEqual([5, 5]);
    expect([t.dirtyFirst, t.dirtyEnd]).toEqual([s, s + 1]);
  });
});
