/** Typed engine event bus ('planetChanged' | 'terrainCommitted' | 'resize' | 'tierChanged' | 'frameEnd'). */
import type { EngineEventMap, EngineEventName, EngineEvents } from './contracts';

export class EventBus implements EngineEvents {
  private readonly listeners = new Map<EngineEventName, Set<(e: never) => void>>();

  on<K extends EngineEventName>(name: K, cb: (e: EngineEventMap[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); }
    set.add(cb as (e: never) => void);
    return () => { set!.delete(cb as (e: never) => void); };
  }

  emit<K extends EngineEventName>(name: K, e: EngineEventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try { (cb as (e: EngineEventMap[K]) => void)(e); } catch (error) { console.warn(`[engine] "${name}" listener threw`, error); }
    }
  }

  clear(): void { this.listeners.clear(); }
}
