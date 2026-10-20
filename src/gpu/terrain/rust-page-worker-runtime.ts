/** Compatibility worker: preserve the live game's recipe history and packet contract. */
import { RustTerrainCore } from './rust-core';
import { readPageCache, writePageCache } from './page-cache';

export interface RustPageRequest {
  id: number; shard: number; input: Uint8Array;
  init?: { module: WebAssembly.Module; initial: Uint8Array };
  cacheKey?: string;
}
export class RustPageWorkerRuntime {
  private readonly shards = new Map<number, RustTerrainCore>();
  async run(request: RustPageRequest) {
    const started = performance.now(), stages: Record<string, number> = {}; let at = started;
    const lap = (stage: string) => { const now = performance.now(); stages[stage] = now - at; at = now; };
    if (request.init) {
      const core = await RustTerrainCore.create(request.init.module, undefined, request.init.initial);
      this.shards.get(request.shard)?.dispose(); this.shards.set(request.shard, core);
    }
    lap('initialize');
    const core = this.shards.get(request.shard); if (!core) throw new Error('Rust page shard is not initialized');
    let packet = request.cacheKey ? await readPageCache(request.cacheKey) : undefined; const cacheHit = !!packet; lap('cache');
    if (!packet) packet = core.compileEncoded(request.input, lap, false);
    if (request.cacheKey && !cacheHit) void writePageCache(request.cacheKey, { ...packet, words: packet.words.slice(), values: packet.values.slice() });
    lap('cacheCopy');
    return { id: request.id, packet, milliseconds: performance.now() - started, stages, cacheHit, memoryBytes: core.memoryBytes };
  }
  dispose(): void { for (const core of this.shards.values()) core.dispose(); this.shards.clear(); }
}
