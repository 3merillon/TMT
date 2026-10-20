/** CPU page compiler only: no renderer, solver ownership or accepted-world mutation. */
import { ResidentArrangement, type OwnershipMask, type PreparedResidentField, type TetRequest } from './arrangement';
import { residentLattice } from './lattice';
import { residentPlanet, type ResidentGameProfile } from './planet';
import { readPageCache, writePageCache, PAGE_CACHE_VERSION, generatorHash } from './page-cache';
import { packPages } from './page-packet';
import type { TerrainStructure } from '../../game/terrain-structures';
import type { PlanetType } from '../../game/planet-field';

export interface PageWorkerRequest {
  id: number; shard?: number; init?: { seed: number; structures: readonly TerrainStructure[]; profile: ResidentGameProfile; kind?: PlanetType; cache?: boolean; workers?: number };
  truncate: number; cutCount: number; fields: PreparedResidentField[]; requests: TetRequest[]; revision: number;
  /** Ownership masks from index `maskStart` on: the worker keeps every mask it was sent (0 replaces its list). */
  masks: readonly OwnershipMask[]; maskStart?: number;
}
interface Shard { arrangement: ResidentArrangement; generator: string; masks: OwnershipMask[]; warm?: ReturnType<typeof setTimeout> }
const shards = new Map<number, Shard>();
// Static lattice and sample words are immutable. Sharing them within a physical worker avoids multiplying these
// replicas when four workers execute eight logical shards. Recipe/cut/trace histories remain separate.
let shared: { key: string; input: ReturnType<typeof residentPlanet>; lattice: ReturnType<typeof residentLattice>; owner: ResidentArrangement } | undefined;
/** After a cache hit nothing was sampled: sample the fields one per task in the background, so the first edit does
 * not pay for them and requests still interleave. */
function warmSamples(state: Shard, from = 0): void {
  if (state.warm !== undefined) clearTimeout(state.warm);
  state.warm = setTimeout(() => { state.warm = undefined; if (from >= state.arrangement.fields.length) return; void state.arrangement.samples[from]; warmSamples(state, from + 1); }, 0);
}
self.onmessage = async (event: MessageEvent<PageWorkerRequest>) => {
  const request = event.data, started = performance.now();
  const stages: Record<string, number> = {}; let at = started;
  const lap = (name: string) => { const now = performance.now(); stages[name] = now - at; at = now; };
  try {
    const shard = request.shard ?? 0;
    if (request.init) {
      const key = JSON.stringify([request.init.seed, request.init.structures, request.init.profile, request.init.kind]);
      const reuse = shared?.key === key ? shared : undefined;
      const input = reuse?.input ?? residentPlanet(request.init.seed, request.init.structures, request.init.profile, request.init.kind);
      const lattice = reuse?.lattice ?? residentLattice(input.bounds);
      // Samples are lazy (and support-limited): a cache hit compiles nothing and samples nothing.
      const arrangement = new ResidentArrangement(lattice, input.sources, 2048, true, true, true);
      if (reuse) for (let i = 0; i < arrangement.fields.length; i++) Object.defineProperty(arrangement.samples, i, { configurable: true, enumerable: true, get: () => reuse.owner.samples[i] });
      else shared = { key, input, lattice, owner: arrangement };
      const previous = shards.get(shard); if (previous?.warm !== undefined) clearTimeout(previous.warm);
      shards.set(shard, { arrangement, generator: request.init.cache ? generatorHash(input) : '', masks: [] });
    }
    lap('initialize');
    const state = shards.get(shard); if (!state) throw new Error('Page worker was not initialized');
    const { arrangement, generator } = state;
    const maskStart = request.maskStart ?? 0;
    if (!maskStart) state.masks = []; else if (maskStart !== state.masks.length) throw new Error('Terrain worker ownership masks are out of sync');
    const masks = state.masks;
    for (const mask of request.masks) masks.push(mask);
    arrangement.rollbackFields(request.truncate, request.cutCount);
    for (const field of request.fields) arrangement.appendPreparedField(field);
    const whole = request.requests.every(r => r.tets === null);
    const key = request.init?.cache && request.revision === 1 && whole && !request.fields.length && !masks.length
      ? JSON.stringify([PAGE_CACHE_VERSION, generator, request.init.seed, request.init.profile, request.init.workers ?? 0, request.requests.map(r => r.brick)]) : undefined;
    let packet = key ? await readPageCache(key) : undefined; const cacheHit = !!packet;
    lap('cache');
    if (!packet) { const compiled = arrangement.compileTets(request.requests, request.revision, masks); lap('compile'); packet = packPages(compiled); lap('pack'); if (whole) arrangement.releaseCaches(); }
    // Write a separate backing buffer in the background: neither disk latency
    // nor a cache failure holds the first playable frame hostage.
    if (key && !cacheHit) void writePageCache(key, { ...packet, words: packet.words.slice(), values: packet.values.slice() });
    lap('cacheCopy');
    self.postMessage({ id: request.id, packet, milliseconds: performance.now() - started, cacheHit, stages }, [packet.words.buffer, packet.values.buffer]);
    if (cacheHit) warmSamples(state);
  } catch (error) { self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
};
