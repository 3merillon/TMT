/** Bounded compiler worker: source samples remain resident; construction scratch is recycled per job. */
import { RustTerrainCore } from './rust-core';
import { readPageCache, writePageCache } from './page-cache';

export type RustWorkerMessage = { kind: 'init'; module: WebAssembly.Module; initial: Uint8Array }
  | { kind: 'compile'; id: number; input: Uint8Array; cacheKey?: string };
let core: RustTerrainCore | undefined;
self.onmessage = async (event: MessageEvent<RustWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.kind === 'init') {
      core?.dispose(); core = await RustTerrainCore.create(message.module, undefined, message.initial);
      self.postMessage({ kind: 'ready', memoryBytes: core.memoryBytes }); return;
    }
    if (!core) throw new Error('Rust terrain worker is not initialized');
    const start = performance.now(), stages: Record<string, number> = {}; let at = start;
    const cached = message.cacheKey ? await readPageCache(message.cacheKey) : undefined;
    if (cached) { self.postMessage({ kind: 'result', id: message.id, packet: cached, stages: {}, milliseconds: performance.now() - start, memoryBytes: core.memoryBytes, fallbacks: 0, cacheHit: true }, [cached.words.buffer, cached.values.buffer]); return; }
    const packet = core.compileEncoded(message.input, stage => { const now = performance.now(); stages[stage] = now - at; at = now; });
    core.resetConstruction(); stages.recycle = performance.now() - at;
    // IndexedDB snapshots the packet before transfer detaches its arrays. Await the
    // write only at startup; its result never bypasses normal coordinator admission.
    if (message.cacheKey) await writePageCache(message.cacheKey, packet, 128);
    self.postMessage({ kind: 'result', id: message.id, packet, stages, milliseconds: performance.now() - start, memoryBytes: core.memoryBytes, fallbacks: core.fallbackCount }, [packet.words.buffer, packet.values.buffer]);
  } catch (error) {
    self.postMessage({ kind: 'error', id: message.kind === 'compile' ? message.id : undefined, error: error instanceof Error ? error.message : String(error) });
  }
};
