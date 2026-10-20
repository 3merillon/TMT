/** Deterministic content hashes (I9 replay checks): cyrb53-style 2×32-bit mixing over canonical JSON. Pure. */

/** Canonical JSON: object keys sorted, -0 written as 0, undefined members dropped. Throws on non-finite numbers. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(`canonicalJson: non-finite number ${item}`);
      return Object.is(item, -0) ? 0 : item;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) sorted[key] = (item as Record<string, unknown>)[key];
      return sorted;
    }
    return item;
  });
}

/** 64-bit hash of a string as 16 hex digits. */
export function hashString(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Hash of a game snapshot (or any JSON value) for replay and determinism checks. */
export function snapshotHash(value: unknown): string { return hashString(canonicalJson(value)); }
