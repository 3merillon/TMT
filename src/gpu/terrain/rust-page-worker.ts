import { RustPageWorkerRuntime, type RustPageRequest } from './rust-page-worker-runtime';
const runtime = new RustPageWorkerRuntime();
// Serialize asynchronous initialization/cache reads. Two logical shards can share a worker.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<RustPageRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try { const result = await runtime.run(request); self.postMessage(result, [result.packet.words.buffer, result.packet.values.buffer]); }
    catch (error) { self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
