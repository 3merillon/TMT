/**
 * Frame graph (plan §4.5): a STATIC ordered list of slots; modules register PassDecls into slots and `order` breaks ties
 * (then registration order). No automatic reordering — the order is explicit, as in Pinionfall, but declared.
 *
 * - Textures are declared with a size class (internal | half | quarter | display | displayHalf | [w, h]) and allocated by the graph.
 * - `history: true` textures are ping-pong pairs (`resources.history(n)` = last frame's), never aliased.
 * - Transient textures are aliased greedily: two textures with the same descriptor whose pass lifetimes do not overlap
 *   share one GPUTexture. A pass that WRITES a transient texture first in the frame must clear or fully overwrite it.
 * - Dev validation (per frame): a read of a transient texture that no earlier pass wrote this frame throws
 *   (read-before-write); `history:<n>` reads require a history texture; any resource access outside the pass's declared
 *   reads/writes throws (including an undeclared history read).
 * - ONE command encoder and ONE submit per frame; every pass gets `timestampWrites(name)`.
 */
import type { FrameGraphApi, FrameResources, FrameSlot, FrameState, PassContext, PassDecl, TextureDecl } from '../contracts';
import { textureKey, TransientTexturePool, type TextureRequest } from '../gpu/resources';

export const FRAME_SLOTS: readonly FrameSlot[] = [
  'upload', 'compute.pre', 'compute.sim', 'compute.commit', 'shadows', 'gbuffer.opaque', 'gbuffer.foliage',
  'ao', 'lighting', 'clouds', 'transparent', 'taa', 'post.dof', 'overlay', 'post.bloom', 'composite', 'debug',
];
const SLOT_INDEX = new Map(FRAME_SLOTS.map((s, i) => [s, i]));

export const HISTORY_PREFIX = 'history:';

interface Allocated { textures: GPUTexture[]; views: GPUTextureView[]; size: [number, number]; physical: number[] }
interface Physical { texture: GPUTexture; view: GPUTextureView; key: string; lastUse: number }
interface Registered { decl: PassDecl; seq: number }

type GraphDevice = Pick<GPUDevice, 'createCommandEncoder'> & { queue: Pick<GPUQueue, 'submit'> };
export interface FrameGraphContext {
  readonly device: GraphDevice & Pick<GPUDevice, 'createTexture'>;
  deferDestroy(r: GPUTexture | GPUBuffer | null | undefined): void;
  readonly tickIndex: number;
}
export interface FrameGraphHooks {
  /** After every pass, before finish/submit (timestamp resolve, readback copies). */
  beforeSubmit?(encoder: GPUCommandEncoder): void;
  /** Right after submit (readback maps, deferred-destroy tick). */
  afterSubmit?(): void;
  /** Wrap the encoder handed to passes (e.g. draw counting). */
  instrument?(encoder: GPUCommandEncoder): GPUCommandEncoder;
}

export class FrameGraphError extends Error {}

export class FrameGraph implements FrameGraphApi {
  readonly slots = FRAME_SLOTS;
  private readonly passes: Registered[] = [];
  private readonly textures = new Map<string, TextureDecl>();
  private readonly importedTextures = new Map<string, () => { texture: GPUTexture; view: GPUTextureView }>();
  private readonly importedCache = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();
  private readonly buffers = new Map<string, GPUBuffer>();
  private readonly allocated = new Map<string, Allocated>();
  private physical: Physical[] = [];
  private readonly everWritten = new Set<string>();
  private sorted: PassDecl[] = [];
  private dirty = true;
  private seq = 0;
  private display: [number, number] = [1, 1];
  private internal: [number, number] = [1, 1];
  private frameIndex = 0;
  readonly pool: TransientTexturePool;
  /** Passes that ran in the last executed frame (names, in order). */
  lastExecuted: string[] = [];
  submits = 0;

  constructor(private readonly ctx: FrameGraphContext, private readonly timings: { getWrites(name: string): GPURenderPassTimestampWrites | undefined } | null,
    private readonly options: { dev?: boolean } = {}) {
    // Labels 'screen:<name>': the VRAM ledger reports graph textures as the "screen targets" budget line (plan §10.3).
    this.pool = new TransientTexturePool(ctx as unknown as ConstructorParameters<typeof TransientTexturePool>[0], 'screen', 2);
  }

  get dev(): boolean { return !!this.options.dev; }

  declareTexture(name: string, decl: TextureDecl): void {
    if (name.startsWith(HISTORY_PREFIX)) throw new FrameGraphError(`texture name may not start with "${HISTORY_PREFIX}"`);
    if (this.importedTextures.has(name) || this.buffers.has(name)) throw new FrameGraphError(`"${name}" is already imported`);
    const prev = this.textures.get(name);
    if (prev && JSON.stringify(prev) === JSON.stringify(decl)) return;
    this.textures.set(name, { ...decl });
    this.dirty = true;
  }

  importTexture(name: string, get: () => { texture: GPUTexture; view: GPUTextureView }): void {
    if (this.textures.has(name)) throw new FrameGraphError(`"${name}" is a graph texture`);
    this.importedTextures.set(name, get);
    this.importedCache.delete(name);
  }

  importBuffer(name: string, buffer: GPUBuffer): void {
    if (this.textures.has(name)) throw new FrameGraphError(`"${name}" is a graph texture`);
    this.buffers.set(name, buffer);
  }

  addPass(p: PassDecl): () => void {
    if (!SLOT_INDEX.has(p.slot)) throw new FrameGraphError(`pass "${p.name}": unknown slot "${p.slot}"`);
    if (this.passes.some(r => r.decl.name === p.name)) throw new FrameGraphError(`pass "${p.name}" is already registered`);
    const entry: Registered = { decl: p, seq: this.seq++ };
    this.passes.push(entry);
    this.dirty = true;
    return () => {
      const i = this.passes.indexOf(entry);
      if (i >= 0) { this.passes.splice(i, 1); this.dirty = true; }
    };
  }

  setSize(display: readonly [number, number], internal: readonly [number, number]): void {
    const d: [number, number] = [Math.max(1, Math.round(display[0])), Math.max(1, Math.round(display[1]))];
    const i: [number, number] = [Math.max(1, Math.round(internal[0])), Math.max(1, Math.round(internal[1]))];
    if (d[0] === this.display[0] && d[1] === this.display[1] && i[0] === this.internal[0] && i[1] === this.internal[1]) return;
    this.display = d; this.internal = i;
    this.dirty = true;
  }

  get sizes(): { display: [number, number]; internal: [number, number] } { return { display: [...this.display], internal: [...this.internal] }; }

  sizeOf(decl: TextureDecl): [number, number] {
    const s = decl.size;
    if (typeof s !== 'string') return [Math.max(1, s[0]), Math.max(1, s[1])];
    const [iw, ih] = this.internal;
    if (s === 'internal') return [iw, ih];
    if (s === 'half') return [Math.max(1, Math.ceil(iw / 2)), Math.max(1, Math.ceil(ih / 2))];
    if (s === 'quarter') return [Math.max(1, Math.ceil(iw / 4)), Math.max(1, Math.ceil(ih / 4))];
    if (s === 'displayHalf') return [Math.max(1, Math.ceil(this.display[0] / 2)), Math.max(1, Math.ceil(this.display[1] / 2))];
    return [...this.display];
  }

  /** Ordered pass list (slot, order, registration). */
  orderedPasses(): readonly PassDecl[] {
    if (this.dirty) this.compile();
    return this.sorted;
  }

  /** Sort, compute lifetimes, (re)allocate textures with greedy aliasing. */
  compile(): void {
    this.sorted = [...this.passes].sort((a, b) =>
      (SLOT_INDEX.get(a.decl.slot)! - SLOT_INDEX.get(b.decl.slot)!) || ((a.decl.order ?? 0) - (b.decl.order ?? 0)) || (a.seq - b.seq)).map(r => r.decl);
    // Lifetimes over the static order.
    const first = new Map<string, number>(); const last = new Map<string, number>();
    this.sorted.forEach((p, i) => {
      for (const n of [...p.reads, ...p.writes]) {
        const name = n.startsWith(HISTORY_PREFIX) ? n.slice(HISTORY_PREFIX.length) : n;
        if (!this.textures.has(name)) continue;
        if (!first.has(name)) first.set(name, i);
        last.set(name, i);
      }
    });
    // Release the previous allocation to the pool, then re-acquire (same descriptors come straight back).
    const before = new Map<string, GPUTexture>();
    for (const [name, a] of this.allocated) before.set(name, a.textures[0]);
    for (const a of this.allocated.values()) for (const t of a.textures) this.pool.release(t);
    this.allocated.clear();
    this.physical = [];
    const transient: { name: string; decl: TextureDecl; first: number; last: number }[] = [];
    for (const [name, decl] of this.textures) {
      if (!first.has(name)) continue; // declared but unused: not allocated
      if (decl.history || decl.persistent) {
        const count = decl.history ? 2 : 1;
        const size = this.sizeOf(decl);
        const textures: GPUTexture[] = [];
        for (let k = 0; k < count; k++) textures.push(this.pool.acquire(this.request(decl, size), decl.history ? `${name}#${k}` : name));
        this.allocated.set(name, { textures, views: textures.map(t => t.createView()), size, physical: [] });
      } else transient.push({ name, decl, first: first.get(name)!, last: last.get(name)! });
    }
    transient.sort((a, b) => a.first - b.first || (a.name < b.name ? -1 : 1));
    for (const t of transient) {
      const size = this.sizeOf(t.decl);
      const req = this.request(t.decl, size);
      const key = textureKey(req);
      let pi = this.physical.findIndex(p => p.key === key && p.lastUse < t.first);
      if (pi < 0) {
        const texture = this.pool.acquire(req, t.name);
        this.physical.push({ texture, view: texture.createView(), key, lastUse: t.last });
        pi = this.physical.length - 1;
      } else this.physical[pi].lastUse = t.last;
      const p = this.physical[pi];
      this.allocated.set(t.name, { textures: [p.texture], views: [p.view], size, physical: [pi] });
    }
    // Contents do not survive a reallocation: persistent textures must be written again before they are read.
    for (const [name, a] of this.allocated) if (before.get(name) !== a.textures[0]) this.everWritten.delete(name);
    this.pool.trim();
    this.dirty = false;
  }

  private request(decl: TextureDecl, size: [number, number]): TextureRequest {
    return { format: decl.format, width: size[0], height: size[1], usage: decl.usage, mipLevelCount: decl.mipLevelCount };
  }

  /** name → physical texture index for transient textures (aliasing introspection for tests/telemetry). */
  aliasing(): Record<string, number> {
    if (this.dirty) this.compile();
    const out: Record<string, number> = {};
    for (const [name, a] of this.allocated) if (a.physical.length) out[name] = a.physical[0];
    return out;
  }

  get physicalTextureCount(): number { return this.physical.length; }

  private texEntry(name: string): { texture: GPUTexture; view: GPUTextureView; size: readonly [number, number] } {
    const a = this.allocated.get(name);
    if (a) {
      const k = a.textures.length === 2 ? this.frameIndex & 1 : 0;
      return { texture: a.textures[k], view: a.views[k], size: a.size };
    }
    const imp = this.importedTextures.get(name);
    if (imp) {
      let c = this.importedCache.get(name);
      if (!c) { c = imp(); this.importedCache.set(name, c); }
      return { ...c, size: [c.texture.width, c.texture.height] };
    }
    if (this.textures.has(name)) throw new FrameGraphError(`texture "${name}" is declared but no pass reads or writes it`);
    throw new FrameGraphError(`unknown texture "${name}"`);
  }

  private historyEntry(name: string): GPUTextureView {
    const a = this.allocated.get(name);
    if (!a || a.textures.length !== 2) throw new FrameGraphError(`"${name}" is not a history texture`);
    return a.views[(this.frameIndex + 1) & 1];
  }

  private resourcesFor(p: PassDecl | null): FrameResources {
    const check = (name: string, kind: string) => {
      if (!p || !this.dev) return;
      if (!p.reads.includes(name) && !p.writes.includes(name)) throw new FrameGraphError(`pass "${p.name}" accessed ${kind} "${name}" without declaring it in reads/writes`);
    };
    return {
      texture: name => { check(name, 'texture'); return this.texEntry(name).texture; },
      view: name => { check(name, 'texture'); return this.texEntry(name).view; },
      size: name => { check(name, 'texture'); return this.texEntry(name).size; },
      history: name => {
        if (p && this.dev && !p.reads.includes(HISTORY_PREFIX + name)) throw new FrameGraphError(`pass "${p.name}" read history of "${name}" without declaring "${HISTORY_PREFIX}${name}" in reads`);
        return this.historyEntry(name);
      },
      buffer: name => {
        check(name, 'buffer');
        const b = this.buffers.get(name);
        if (!b) throw new FrameGraphError(`unknown buffer "${name}"`);
        return b;
      },
    };
  }

  /** Resources outside any pass (engine internals, debug tools). Unchecked. */
  get resources(): FrameResources { return this.resourcesFor(null); }

  private validateReads(p: PassDecl, written: Set<string>): void {
    for (const r of p.reads) {
      if (r.startsWith(HISTORY_PREFIX)) {
        const name = r.slice(HISTORY_PREFIX.length);
        if (!this.textures.get(name)?.history) throw new FrameGraphError(`pass "${p.name}" reads "${r}" but "${name}" is not a history texture`);
        continue;
      }
      if (this.buffers.has(r) || this.importedTextures.has(r)) continue;
      const decl = this.textures.get(r);
      if (!decl) throw new FrameGraphError(`pass "${p.name}" reads unknown resource "${r}"`);
      if (written.has(r)) continue;
      if ((decl.persistent || decl.history) && this.everWritten.has(r)) continue;
      throw new FrameGraphError(`read-before-write: pass "${p.name}" reads "${r}" before any pass wrote it this frame`);
    }
    for (const w of p.writes) {
      if (!this.textures.has(w) && !this.buffers.has(w) && !this.importedTextures.has(w)) throw new FrameGraphError(`pass "${p.name}" writes unknown resource "${w}"`);
    }
  }

  /** Encode every enabled pass into one encoder and submit once. */
  execute(frame: FrameState, hooks: FrameGraphHooks = {}): void {
    if (this.dirty) this.compile();
    this.frameIndex = frame.index;
    this.importedCache.clear();
    const raw = this.ctx.device.createCommandEncoder({ label: `frame ${frame.index}` });
    const encoder = hooks.instrument ? hooks.instrument(raw) : raw;
    const written = new Set<string>();
    const executed: string[] = [];
    const timestampWrites = (name: string) => this.timings?.getWrites(name);
    for (const p of this.sorted) {
      if (p.enabled && !p.enabled(frame)) continue;
      if (this.dev) this.validateReads(p, written);
      const c: PassContext = { encoder, frame, resources: this.resourcesFor(p), timestampWrites };
      if (this.dev) raw.pushDebugGroup(p.name);
      p.run(c);
      if (this.dev) raw.popDebugGroup();
      for (const w of p.writes) { written.add(w); this.everWritten.add(w); }
      executed.push(p.name);
    }
    hooks.beforeSubmit?.(raw);
    this.ctx.device.queue.submit([raw.finish()]);
    this.submits++;
    this.lastExecuted = executed;
    hooks.afterSubmit?.();
    this.pool.trim();
  }

  /** Release every graph texture. */
  destroy(): void {
    for (const a of this.allocated.values()) for (const t of a.textures) this.pool.release(t);
    this.allocated.clear();
    this.physical = [];
    this.pool.destroyAll();
  }
}
