// Ported from Pinionfall src/gpu/gpu-slice-arena.ts (MIT, same owner)
/**
 * GPU SLICE ARENA — many tiny GPUBuffers become ranges of a few large ones.
 *
 * WHY: on Chromium's D3D12 backend (measured on the RTX 3080 target, 2026-09-13)
 * every GPUBuffer occupies at least one placed-resource block of dedicated VRAM,
 * whatever its size: 5,000 × 16-byte uniforms cost +312 MB, 15,000 mixed tiny
 * buffers +624 MB, and destroying them returned ~0 (the backend keeps its heaps).
 * A settled town held ~18,000 buffers averaging < 64 KB — about 42 MB of data
 * occupying roughly 0.75–1.15 GB of the card, invisible to the VRAM tracker, which
 * counts bytes. One arena chunk holding the same data costs its own size.
 *
 * CONTRACT (what makes a slice interchangeable with a dedicated buffer):
 *  - `offset` is a multiple of `align` (256 = the WebGPU maximum for both
 *    min{Uniform,Storage}BufferOffsetAlignment), so a slice binds as a range.
 *  - `size` is exactly the requested size: bind it as `{buffer, offset, size}` so
 *    WGSL arrayLength() and minBindingSize see the dedicated buffer's length.
 *  - A slice never moves. Growth = alloc a new slice, copy, free the old one.
 *  - A new slice reads as zeros (the arena writes zeros over it), matching
 *    createBuffer, for any command encoded after `alloc` returns.
 *  - `free` is DEFERRED: the range is reused only after `freeSlackTicks` ticks of
 *    the frame clock (the deferred-destroy slack), because an in-flight
 *    command buffer may still reference the previous owner's range.
 *  - Keep different KINDS in different arenas (e.g. draw args vs visible slots):
 *    two ranges of one buffer bound writable in one usage scope must not overlap,
 *    and separate kinds make that trivially true.
 *  - Requests above `maxSliceBytes` return null: the caller keeps its own buffer.
 */

export interface GpuSlice {
    readonly buffer: GPUBuffer;
    readonly offset: number;
    readonly size: number;
    /** Aligned bytes reserved in the chunk (>= size). Internal. */
    readonly reserved: number;
    /** Chunk index. Internal. */
    readonly chunk: number;
}

export interface GpuSliceArenaOptions {
    label: string;
    usage: GPUBufferUsageFlags;
    /** Bytes per backing buffer. Default 4 MiB. */
    chunkBytes?: number;
    /** Offset alignment. Default 256. */
    align?: number;
    /** Largest slice served; bigger requests return null. Default chunkBytes / 4. */
    maxSliceBytes?: number;
    /** Frame-clock ticks a freed range waits before reuse. Default 3. */
    freeSlackTicks?: number;
    /** Monotone frame clock (ctx.tickIndex in the engine). */
    tick: () => number;
    /** Destroys a backing buffer no slice can reference any more (ctx.deferDestroy in the engine). */
    destroyBuffer?: (buf: GPUBuffer) => void;
    /** Skip the zero write for kinds whose every byte is written before use. */
    zeroOnAlloc?: boolean;
}

type ArenaDevice = Pick<GPUDevice, 'createBuffer'> & { queue: Pick<GPUQueue, 'writeBuffer'> };

interface Block { start: number; len: number }
interface Chunk {
    buffer: GPUBuffer | null;
    free: Block[];        // sorted by start, coalesced, reusable now
    live: number;         // live slice count
    liveBytes: number;
    emptySinceTick: number;
}
interface PendingFree { chunk: number; start: number; len: number; tick: number }

export interface GpuSliceArenaStats {
    label: string;
    chunks: number;
    chunkBytes: number;
    liveSlices: number;
    liveBytes: number;
    reservedBytes: number;
    pendingFrees: number;
    peakChunks: number;
    allocs: number;
    frees: number;
    oversize: number;
}

export class GpuSliceArena {
    private readonly device: ArenaDevice;
    private readonly opts: Required<Omit<GpuSliceArenaOptions, 'destroyBuffer'>> & { destroyBuffer?: (b: GPUBuffer) => void };
    private readonly chunks: Chunk[] = [];
    private readonly pending: PendingFree[] = [];
    private zeros = new Uint8Array(0);
    private _liveSlices = 0;
    private _liveBytes = 0;
    private _reserved = 0;
    private _peakChunks = 0;
    private _allocs = 0;
    private _frees = 0;
    private _oversize = 0;

    constructor(device: ArenaDevice, options: GpuSliceArenaOptions) {
        const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
        const align = options.align ?? 256;
        if (chunkBytes % align !== 0) throw new Error(`GpuSliceArena ${options.label}: chunkBytes must be a multiple of align`);
        this.device = device;
        this.opts = {
            label: options.label, usage: options.usage, chunkBytes, align,
            maxSliceBytes: Math.min(options.maxSliceBytes ?? chunkBytes / 4, chunkBytes),
            freeSlackTicks: options.freeSlackTicks ?? 3,
            tick: options.tick, destroyBuffer: options.destroyBuffer,
            zeroOnAlloc: options.zeroOnAlloc ?? true,
        };
    }

    /** A zero-filled range of `size` bytes, or null when `size` exceeds maxSliceBytes. */
    alloc(size: number): GpuSlice | null {
        const { align, maxSliceBytes, chunkBytes } = this.opts;
        if (!(size > 0) || size > maxSliceBytes) { if (size > maxSliceBytes) this._oversize++; return null; }
        this.reclaim();
        const need = Math.ceil(size / align) * align;
        let ci = -1, bi = -1;
        for (let c = 0; c < this.chunks.length && ci < 0; c++) {
            const ch = this.chunks[c];
            if (!ch.buffer) continue;
            for (let b = 0; b < ch.free.length; b++) if (ch.free[b].len >= need) { ci = c; bi = b; break; }
        }
        if (ci < 0) {
            ci = this.chunks.findIndex(ch => ch.buffer === null);
            const buffer = this.device.createBuffer({
                label: `${this.opts.label}:arena#${ci < 0 ? this.chunks.length : ci}`,
                size: chunkBytes, usage: this.opts.usage,
            });
            const chunk: Chunk = { buffer, free: [{ start: 0, len: chunkBytes }], live: 0, liveBytes: 0, emptySinceTick: -1 };
            if (ci < 0) { ci = this.chunks.length; this.chunks.push(chunk); } else this.chunks[ci] = chunk;
            bi = 0;
            const n = this.chunks.filter(ch => ch.buffer).length;
            if (n > this._peakChunks) this._peakChunks = n;
        }
        const ch = this.chunks[ci];
        const blk = ch.free[bi];
        const offset = blk.start;
        if (blk.len === need) ch.free.splice(bi, 1);
        else { blk.start += need; blk.len -= need; }
        ch.live++; ch.liveBytes += size; ch.emptySinceTick = -1;
        this._liveSlices++; this._liveBytes += size; this._reserved += need; this._allocs++;
        if (this.opts.zeroOnAlloc) {
            if (this.zeros.length < size) this.zeros = new Uint8Array(Math.max(size, 256));
            this.device.queue.writeBuffer(ch.buffer!, offset, this.zeros, 0, size);
        }
        return { buffer: ch.buffer!, offset, size, reserved: need, chunk: ci };
    }

    /** Deferred release of a slice. Freeing the same slice twice is a bug and throws. */
    free(slice: GpuSlice): void {
        const ch = this.chunks[slice.chunk];
        if (!ch || ch.buffer !== slice.buffer) throw new Error(`GpuSliceArena ${this.opts.label}: slice does not belong to this arena`);
        for (const p of this.pending) if (p.chunk === slice.chunk && p.start === slice.offset) throw new Error(`GpuSliceArena ${this.opts.label}: double free`);
        this.pending.push({ chunk: slice.chunk, start: slice.offset, len: slice.reserved, tick: this.opts.tick() });
        ch.live--; ch.liveBytes -= slice.size;
        this._liveSlices--; this._liveBytes -= slice.size; this._reserved -= slice.reserved; this._frees++;
    }

    /** Return ranges whose slack has elapsed to their free lists; release surplus
     *  empty chunks (keeping one). Called from alloc; callers may also call it. */
    reclaim(): void {
        const now = this.opts.tick();
        const cutoff = now - this.opts.freeSlackTicks;
        if (this.pending.length > 0) {
            let w = 0;
            for (let r = 0; r < this.pending.length; r++) {
                const p = this.pending[r];
                if (p.tick <= cutoff) this.insertFree(this.chunks[p.chunk], p.start, p.len);
                else this.pending[w++] = p;
            }
            this.pending.length = w;
        }
        let keptEmpty = false;
        for (const ch of this.chunks) {
            if (!ch.buffer || ch.live > 0) continue;
            const whole = ch.free.length === 1 && ch.free[0].start === 0 && ch.free[0].len === this.opts.chunkBytes;
            const hasPending = this.pending.some(p => this.chunks[p.chunk] === ch);
            if (!whole || hasPending) continue;
            if (!keptEmpty) { keptEmpty = true; continue; }
            if (ch.emptySinceTick < 0) { ch.emptySinceTick = now; continue; }
            if (now - ch.emptySinceTick > this.opts.freeSlackTicks) {
                const buf = ch.buffer; ch.buffer = null; ch.free = [];
                if (this.opts.destroyBuffer) this.opts.destroyBuffer(buf); else buf.destroy();
            }
        }
    }

    private insertFree(ch: Chunk, start: number, len: number): void {
        const f = ch.free;
        let i = 0;
        while (i < f.length && f[i].start < start) i++;
        f.splice(i, 0, { start, len });
        if (i + 1 < f.length && f[i].start + f[i].len === f[i + 1].start) { f[i].len += f[i + 1].len; f.splice(i + 1, 1); }
        if (i > 0 && f[i - 1].start + f[i - 1].len === f[i].start) { f[i - 1].len += f[i].len; f.splice(i, 1); }
    }

    stats(): GpuSliceArenaStats {
        return {
            label: this.opts.label,
            chunks: this.chunks.filter(c => c.buffer).length,
            chunkBytes: this.opts.chunkBytes,
            liveSlices: this._liveSlices, liveBytes: this._liveBytes, reservedBytes: this._reserved,
            pendingFrees: this.pending.length, peakChunks: this._peakChunks,
            allocs: this._allocs, frees: this._frees, oversize: this._oversize,
        };
    }

    /** Release every backing buffer (world teardown). Outstanding slices become invalid. */
    destroy(): void {
        for (const ch of this.chunks) {
            if (!ch.buffer) continue;
            if (this.opts.destroyBuffer) this.opts.destroyBuffer(ch.buffer); else ch.buffer.destroy();
            ch.buffer = null; ch.free = []; ch.live = 0; ch.liveBytes = 0;
        }
        this.pending.length = 0;
        this._liveSlices = 0; this._liveBytes = 0; this._reserved = 0;
    }
}
