// @contract v1 — docs/architecture.md#contracts-and-invariants
// app/hooks.ts
import type { GameEvent, GameSnapshot, V3 } from '../contracts';
import type { MatchSetup } from '../api/match';
export interface FrameInfo { realDt: number; simDt: number; snapshot?: import('../contracts').GameSnapshot;
  camera: { position: V3; target: V3; up: V3; fovY: number }; focus: V3 }
export interface GameHooks { onMatchStart?(s: MatchSetup): void; onEvent?(e: import('../contracts').GameEvent, s: import('../contracts').GameSnapshot): void;
  onFrame?(f: FrameInfo): void; onMatchEnd?(r: { winner: number | null; setup: MatchSetup }): void; timeScale?(): number /* presentation only */ }
const hooks = new Map<string, GameHooks>();
const telemetry = new Map<string, () => unknown>();
/** Names are unique; hooks run in registration order. The returned function unregisters. */
export function registerHooks(name: string, h: GameHooks): () => void {
  if (hooks.has(name)) throw new Error(`Game hooks '${name}' are already registered`);
  hooks.set(name, h);
  return () => { if (hooks.get(name) === h) hooks.delete(name); };
}
export function registerTelemetry(key: string, fn: () => unknown): () => void {  // feeds window.__tmtGame[key]
  if (telemetry.has(key)) throw new Error(`Telemetry key '${key}' is already registered`);
  telemetry.set(key, fn);
  return () => { if (telemetry.get(key) === fn) telemetry.delete(key); };
}

// Internal dispatch for app/session.ts and app/loop.ts. A failing hook is reported with its name
// and never stops the other hooks or the frame loop.
function each(stage: string, run: (h: GameHooks) => void): void {
  for (const [name, h] of hooks) {
    try { run(h); } catch (error) { console.error(`Game hook '${name}' failed in ${stage}:`, error); }
  }
}
export function dispatchMatchStart(s: MatchSetup): void { each('onMatchStart', h => h.onMatchStart?.(s)); }
export function dispatchGameEvent(e: GameEvent, s: GameSnapshot): void { each('onEvent', h => h.onEvent?.(e, s)); }
export function dispatchMatchEnd(r: { winner: number | null; setup: MatchSetup }): void { each('onMatchEnd', h => h.onMatchEnd?.(r)); }
export function hasFrameHooks(): boolean { for (const h of hooks.values()) if (h.onFrame) return true; return false; }
export function dispatchFrame(f: FrameInfo): void { each('onFrame', h => h.onFrame?.(f)); }
/** Product of every registered presentation time scale (1 when none is registered). */
export function combinedTimeScale(): number {
  let scale = 1;
  for (const [name, h] of hooks) {
    if (!h.timeScale) continue;
    const value = h.timeScale();
    if (!Number.isFinite(value) || value < 0) { console.error(`Game hook '${name}' returned an invalid time scale ${value}; it is ignored this frame`); continue; }
    scale *= value;
  }
  return scale;
}
/** Evaluates every registered telemetry key in registration order (window.__tmtGame). */
export function collectTelemetry(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, fn] of telemetry) out[key] = fn();
  return out;
}
