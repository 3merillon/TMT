// Ported from Pinionfall src/gpu/bind-group-resource-cache.ts (MIT, same owner)
/**
 * BindGroupResourceCache — reuse a bind group while EVERY resource it binds keeps its identity.
 *
 * A bind group over the same resource objects binds the same memory, so reusing it is byte-identical — PROVIDED the
 * compare covers the FULL entry list, not a hand-picked key (a missed key = a stale binding after a pool realloc).
 * Placeholders are resources too: push the RESOLVED resource (after any `?? placeholder`), so a placeholder → real swap
 * misses (Pinionfall once sampled a 1×1 placeholder cube forever because the placeholder was not in the key).
 *
 * Usage: `const k = cache.begin(); k.push(bufA, viewB, …); let g = cache.lookup();
 * if (!g) { g = device.createBindGroup(…); cache.store(g); }`, pushing in binding order.
 *
 * A small keyed set (default 4 slots) rather than a one-slot compare: ping-pong inputs (history parity) alternate, so a
 * one-slot form misses every frame. The set is cleared on overflow so retired (resize-destroyed) views are not pinned.
 */
export class BindGroupResourceCache<T = GPUBindGroup> {
  private readonly keys: unknown[][] = [];
  private readonly groups: T[] = [];
  private readonly scratch: unknown[] = [];

  constructor(private readonly maxSlots = 4) {}

  /** Reset and return the scratch key array; push every resource ref into it. */
  begin(): unknown[] {
    this.scratch.length = 0;
    return this.scratch;
  }

  /** The cached group whose key equals the scratch list element-for-element, or null. */
  lookup(): T | null {
    const s = this.scratch;
    for (let k = 0; k < this.keys.length; k++) {
      const key = this.keys[k];
      if (key.length !== s.length) continue;
      let same = true;
      for (let i = 0; i < s.length; i++) {
        if (key[i] !== s[i]) { same = false; break; }
      }
      if (same) return this.groups[k];
    }
    return null;
  }

  /** Remember `group` under the current scratch key (copied). Overflow clears the whole set. */
  store(group: T): void {
    if (this.keys.length >= this.maxSlots) this.clear();
    this.keys.push(this.scratch.slice());
    this.groups.push(group);
  }

  /** lookup() or build-and-store in one call. */
  get(build: () => T): T {
    const hit = this.lookup();
    if (hit) return hit;
    const g = build();
    this.store(g);
    return g;
  }

  clear(): void {
    this.keys.length = 0;
    this.groups.length = 0;
  }

  get size(): number { return this.keys.length; }
}

/** The identity of a GPUBindingResource for cache keys (a `{ buffer, offset, size }` literal is keyed by its parts). */
export function pushBindingKey(key: unknown[], r: GPUBindingResource): void {
  const b = r as GPUBufferBinding;
  if (b && typeof b === 'object' && 'buffer' in b && b.buffer) { key.push(b.buffer, b.offset ?? 0, b.size ?? -1); return; }
  key.push(r);
}
