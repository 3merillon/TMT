/** The cosmetic debris world in its own engine instance, off the main thread (DebrisHost behind DebrisChannel). */
import { RustTerrainCore } from '../../gpu/terrain/rust-core';
import { NativePhysicsWorld } from '../native-physics';
import { DebrisHost, type DebrisFrame, type DebrisResult } from './debris-host';

export type DebrisWorkerMessage = { kind: 'init'; module: WebAssembly.Module } | { kind: 'frame'; frame: DebrisFrame };
export type DebrisWorkerReply = { kind: 'result'; result: DebrisResult } | { kind: 'error'; error: string };
let ready: Promise<DebrisHost> | undefined;
const reply = (message: DebrisWorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);
self.onmessage = async (event: MessageEvent<DebrisWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.kind === 'init') {
      ready = RustTerrainCore.createEngine(message.module).then(core => new DebrisHost(() => new NativePhysicsWorld(core).api));
      return;
    }
    if (!ready) throw new Error('Debris worker is not initialized');
    // Frames apply in arrival order: each awaits the same settled promise, so none overtakes another.
    const result = (await ready).apply(message.frame);
    reply({ kind: 'result', result }, [result.state.buffer, result.splashes.buffer]);
  } catch (error) {
    reply({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
