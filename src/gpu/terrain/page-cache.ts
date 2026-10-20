import type { PackedResidentPages } from './page-packet';
import type { ResidentWorldInput } from './fixtures';
import { BRICK_SIDE, CELL_SIDE } from './contracts';

// Cache immutable initial source topology only. Every load still passes seam,
// volume, GPU construction and collider admission before becoming playable.
/** The generator hash of residentPlanet(7) (profile v2). tests/terrain-page-cache.test.ts recomputes it: any change
 * to planet generation, structures or source descriptors fails that test until this constant (and so the cache
 * version) is updated. The runtime key also carries the hash of the exact input being compiled. */
export const PLANET_7_GENERATOR_HASH = '4c00cfb687fdde9b';
/** v4 retains the boundary subdivisions of rounded-flat traces; v3 packets have already discarded those traces. */
export const PAGE_CACHE_VERSION = `resident-source-pages-v4-${PLANET_7_GENERATOR_HASH}`;

/** A cheap fingerprint of a world input: every source descriptor (ids, bounds, material, anchor, field ids, supports,
 * shading surfaces) plus each field's samples at fixed probe points inside its support. It changes whenever the
 * generator produces different sources or different scalar words at those points. */
export function generatorHash(input: ResidentWorldInput): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x9e3779b9 | 0;
  const mix = (text: string) => { for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x5bd1e995); h2 ^= h2 >>> 13; } };
  const scratch = new Float32Array(1), bits = new Uint32Array(scratch.buffer);
  const word = (value: number) => { scratch[0] = value; mix(bits[0].toString(36)); mix(';'); };
  mix(JSON.stringify({ name: input.name, bounds: input.bounds, cell: CELL_SIDE, brick: BRICK_SIDE, staticSurface: !!input.staticSurface, local: !!input.localConstruction, uniform: !!input.uniformRegions }));
  for (const source of input.sources) {
    mix(JSON.stringify({ id: source.id, bounds: source.bounds, material: source.material, anchor: source.anchor ?? null }));
    for (const field of source.fields ?? []) {
      mix(JSON.stringify({ id: field.id, support: field.support ?? null, surface: field.surface ?? null }));
      const box = field.support ?? input.bounds;
      for (let i = 0; i < 27; i++) {
        const t = [i % 3, Math.floor(i / 3) % 3, Math.floor(i / 9)].map(k => (k + 0.5) / 3);
        word(Math.fround(field.sample([0, 1, 2].map(a => box.min[a] + (box.max[a] - box.min[a]) * t[a]) as [number, number, number])));
      }
    }
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('tmt-resident-preparation', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('pages', { keyPath: 'key' }).createIndex('used', 'used'); };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('Terrain cache unavailable'));
});
export async function readPageCache(key: string): Promise<PackedResidentPages | undefined> {
  let db: IDBDatabase | undefined;
  try {
    db = await database(); const connection = db;
    return await new Promise((resolve, reject) => {
      const tx = connection.transaction('pages', 'readonly'), store = tx.objectStore('pages'), request = store.get(key);
      let packet: PackedResidentPages | undefined;
      request.onsuccess = () => { packet = request.result?.packet; };
      tx.oncomplete = () => resolve(packet); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } catch { return undefined; } finally { db?.close(); }
}
/** Keeps at most `limit` partitions (two complete planets at the maximum worker count). */
export async function writePageCache(key: string, packet: PackedResidentPages, limit = 16): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await database(); const connection = db;
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction('pages', 'readwrite'), store = tx.objectStore('pages');
      store.put({ key, packet, used: Date.now() });
      const count = store.count(); count.onsuccess = () => {
        let remove = count.result - limit;
        if (remove <= 0) return; const cursor = store.index('used').openKeyCursor();
        cursor.onsuccess = () => { const entry = cursor.result; if (entry && remove-- > 0) { store.delete(entry.primaryKey); entry.continue(); } };
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } catch {/* Quota/private-mode failures only cost a future recompilation. */} finally { db?.close(); }
}
