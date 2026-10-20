/** Where the cosmetic debris world runs. A native world steps it in a worker with its own engine instance and publishes
 * complete shard states at most a frame late; otherwise (no engine, no Worker, ?debris=main) it runs in-process through
 * the same messages. Either way TerrainDebris sees one DebrisResult per posted frame, in order. */
import type * as RAPIER from '@dimforge/rapier3d-compat';
import { DebrisHost, type DebrisFrame, type DebrisResult } from './debris-host';
import type { DebrisWorkerMessage, DebrisWorkerReply } from './debris-worker';

export interface DebrisChannel {
  readonly kind: 'worker' | 'main';
  /** Frames posted but not yet answered. */
  readonly pending: number;
  /** Set once the channel can no longer step the world. */
  readonly failure?: string;
  post(frame: DebrisFrame, transfer?: Transferable[]): void;
  /** Every result received since the last call, oldest first. */
  take(): DebrisResult[];
  dispose(): void;
}
export class LocalDebrisChannel implements DebrisChannel {
  readonly kind = 'main'; readonly pending = 0; failure?: string;
  private readonly host: DebrisHost; private results: DebrisResult[] = [];
  constructor(createWorld: () => RAPIER.World | undefined) { this.host = new DebrisHost(createWorld); }
  post(frame: DebrisFrame): void {
    if (this.failure) return;
    try { this.results.push(this.host.apply(frame)); } catch (error) { this.failure = error instanceof Error ? error.message : String(error); }
  }
  take(): DebrisResult[] { const out = this.results; this.results = []; return out; }
  dispose(): void { this.host.dispose(); }
}
export class WorkerDebrisChannel implements DebrisChannel {
  readonly kind = 'worker'; pending = 0; failure?: string;
  private results: DebrisResult[] = [];
  private readonly worker: Worker;
  constructor(module: WebAssembly.Module) {
    this.worker = new Worker(new URL('./debris-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<DebrisWorkerReply>) => {
      const reply = event.data;
      if (reply.kind === 'error') { this.fail(reply.error); return; }
      this.pending--; this.results.push(reply.result);
    };
    this.worker.onerror = event => this.fail(event.message || 'Debris worker failed');
    this.worker.onmessageerror = () => this.fail('Debris worker message could not be decoded');
    this.send({ kind: 'init', module });
  }
  private send(message: DebrisWorkerMessage, transfer: Transferable[] = []): void { this.worker.postMessage(message, transfer); }
  private fail(error: string): void { if (this.failure) return; this.failure = error; console.warn('Debris worker stopped; debris continues on the main thread:', error); this.worker.terminate(); }
  post(frame: DebrisFrame, transfer: Transferable[] = []): void { if (this.failure) return; this.pending++; this.send({ kind: 'frame', frame }, transfer); }
  take(): DebrisResult[] { const out = this.results; this.results = []; return out; }
  dispose(): void { this.worker.terminate(); }
}
