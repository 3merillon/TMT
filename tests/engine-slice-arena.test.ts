// Ported from Pinionfall src/gpu/gpu-slice-arena.test.ts (MIT, same owner)
/**
 * GpuSliceArena — the contract that lets a slice stand in for a dedicated buffer: aligned offsets, exact sizes, no overlap
 * between live slices, zeroed on alloc, reuse only after the frame-clock slack, oversize refused, surplus empty chunks
 * released. Driven by a fake device that records every createBuffer/writeBuffer.
 */
import { describe, expect, it } from 'vitest';
import { GpuSliceArena, type GpuSlice } from '../src/engine/gpu/slice-arena';

interface FakeBuffer { id: number; size: number; destroyed: boolean; bytes: Uint8Array; label: string }
function fakeDevice() {
  const buffers: FakeBuffer[] = [];
  const writes: { buf: FakeBuffer; offset: number; size: number; allZero: boolean }[] = [];
  const device = {
    createBuffer(d: { size: number; label?: string }) {
      const b: FakeBuffer = { id: buffers.length, size: d.size, destroyed: false, bytes: new Uint8Array(d.size), label: d.label ?? '' };
      (b as unknown as { destroy: () => void }).destroy = () => { b.destroyed = true; };
      buffers.push(b);
      return b as unknown as GPUBuffer;
    },
    queue: {
      writeBuffer(buf: GPUBuffer, offset: number, data: BufferSource, dataOffset = 0, size?: number) {
        const b = buf as unknown as FakeBuffer;
        const src = data instanceof Uint8Array ? data : new Uint8Array((data as ArrayBufferView).buffer);
        const n = size ?? src.length - dataOffset;
        if (b.destroyed) throw new Error('write to destroyed buffer');
        if (offset + n > b.size) throw new Error('write out of range');
        let allZero = true;
        for (let i = 0; i < n; i++) { b.bytes[offset + i] = src[dataOffset + i]; if (src[dataOffset + i] !== 0) allZero = false; }
        writes.push({ buf: b, offset, size: n, allZero });
      },
    },
  };
  return { device: device as unknown as ConstructorParameters<typeof GpuSliceArena>[0], buffers, writes };
}

describe('GpuSliceArena', () => {
  it('aligns offsets, keeps exact sizes, zeroes on alloc and refuses oversize', () => {
    const tick = 0;
    const { device, buffers, writes } = fakeDevice();
    const arena = new GpuSliceArena(device, { label: 't', usage: 0, chunkBytes: 4096, tick: () => tick });
    const a = arena.alloc(16)!, b = arena.alloc(300)!, c = arena.alloc(1)!;
    expect([a.offset % 256, b.offset % 256, c.offset % 256]).toEqual([0, 0, 0]);
    expect([a.size, b.size, c.size]).toEqual([16, 300, 1]);
    expect(a.offset + 256 <= b.offset && b.offset + 512 <= c.offset).toBe(true);
    expect(buffers.length).toBe(1);
    expect(writes.length === 3 && writes.every(w => w.allZero) && writes[1].size === 300).toBe(true);
    expect(arena.alloc(1025)).toBeNull();
    expect(arena.stats().oversize).toBe(1);
    expect(arena.alloc(0)).toBeNull();
    expect(arena.alloc(-5)).toBeNull();
    expect(arena.alloc(1024)?.size).toBe(1024);
  });

  it('defers reuse until the slack elapsed and throws on double free', () => {
    let tick = 10;
    const { device, buffers } = fakeDevice();
    const arena = new GpuSliceArena(device, { label: 'd', usage: 0, chunkBytes: 1024, maxSliceBytes: 1024, tick: () => tick });
    const s = arena.alloc(1024)!;
    arena.free(s);
    expect(() => arena.free(s)).toThrow();
    const t1 = arena.alloc(1024)!;
    expect(t1.buffer !== s.buffer || t1.offset !== s.offset).toBe(true);
    const chunksBefore = buffers.length;
    tick += 3;
    arena.free(t1);
    tick += 3;
    const t2 = arena.alloc(1024)!;
    expect(buffers.length).toBe(chunksBefore);
    expect(t2.buffer).toBe(s.buffer);
    expect(t2.offset).toBe(s.offset);
  });

  it('random walk: no live overlap, stats agree, reuse respects the slack, chunk count bounded', () => {
    let seed = 0x9e3779b9;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let tick = 0;
    const { device } = fakeDevice();
    const arena = new GpuSliceArena(device, { label: 'r', usage: 0, chunkBytes: 16384, tick: () => tick });
    const live: GpuSlice[] = [];
    const freedAt = new Map<string, number>();
    let overlapBad = 0, slackBad = 0, statsBad = 0, peakReserved = 0;
    for (let step = 0; step < 20000; step++) {
      if (step % 50 === 0) tick++;
      if (live.length > 0 && rnd() < 0.45) {
        const s = live.splice(Math.floor(rnd() * live.length), 1)[0];
        for (let k = 0; k < s.reserved; k += 256) freedAt.set(`${(s.buffer as unknown as FakeBuffer).id}:${s.offset + k}`, tick);
        arena.free(s);
      } else {
        const size = 1 + Math.floor(rnd() * (rnd() < 0.9 ? 700 : 4096));
        const s = arena.alloc(size);
        if (!s) continue;
        const id = (s.buffer as unknown as FakeBuffer).id;
        for (let k = 0; k < s.reserved; k += 256) {
          const f = freedAt.get(`${id}:${s.offset + k}`);
          if (f !== undefined && tick - f < 3) slackBad++;
        }
        for (const o of live) if (o.buffer === s.buffer && s.offset < o.offset + o.reserved && o.offset < s.offset + s.reserved) overlapBad++;
        if (s.offset + s.size > (s.buffer as unknown as FakeBuffer).size) overlapBad++;
        live.push(s);
      }
      const st = arena.stats();
      peakReserved = Math.max(peakReserved, st.reservedBytes);
      if (st.liveSlices !== live.length || st.liveBytes !== live.reduce((a, s) => a + s.size, 0)) statsBad++;
    }
    expect(overlapBad).toBe(0);
    expect(slackBad).toBe(0);
    expect(statsBad).toBe(0);
    expect(arena.stats().peakChunks).toBeLessThanOrEqual(Math.ceil(1.5 * peakReserved / 16384) + 2);
  });

  it('releases surplus empty chunks through destroyBuffer and keeps one', () => {
    let tick = 0;
    const destroyed: GPUBuffer[] = [];
    const { device } = fakeDevice();
    const arena = new GpuSliceArena(device, { label: 'e', usage: 0, chunkBytes: 1024, maxSliceBytes: 1024, tick: () => tick, destroyBuffer: b => destroyed.push(b) });
    const slices = [arena.alloc(1024)!, arena.alloc(1024)!, arena.alloc(1024)!];
    expect(arena.stats().chunks).toBe(3);
    for (const s of slices) arena.free(s);
    for (let i = 0; i < 12; i++) { tick++; arena.reclaim(); }
    expect(destroyed.length).toBe(2);
    expect(arena.stats().chunks).toBe(1);
    expect(arena.alloc(512)).not.toBeNull();
    expect(arena.stats().chunks).toBe(1);
    arena.destroy();
    expect(destroyed.length).toBe(3);
    expect(arena.stats().chunks).toBe(0);
  });

  it('skips the zero write when zeroOnAlloc is false', () => {
    const { device, writes } = fakeDevice();
    const arena = new GpuSliceArena(device, { label: 'z', usage: 0, chunkBytes: 1024, tick: () => 0, zeroOnAlloc: false });
    arena.alloc(100);
    expect(writes.length).toBe(0);
  });
});
