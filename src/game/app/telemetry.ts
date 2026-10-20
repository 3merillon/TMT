/** window.__tmtGame (read-only diagnostics for browser qualification; scripts/capture.ts reads it) and the
 * ?residentCheck JSON in #resident-diagnostics. Other modules add keys through registerTelemetry. */
import type { GameView } from '../view';
import type { GameSession } from './session';
import { devFlags } from './dev-flags';
import { collectTelemetry, registerTelemetry } from './hooks';

/** Registers the session keys (ready, mode, phase, active, tick, turn, terrainVersion, terrain, performance,
 * camera, snapshot, resident) and returns the refresher of the resident diagnostics, called with the HUD. */
export function installTelemetry(game: GameSession, view: GameView): () => void {
  for (const [key, read] of Object.entries(game.telemetryFields())) registerTelemetry(key, read);
  // Read-only diagnostics make browser qualification reproducible without exposing live setters.
  Object.defineProperty(window, '__tmtGame', { configurable: true, get: collectTelemetry });
  Object.defineProperty(window, '__tmtMemory', { configurable: true, value: () => game.memoryTelemetry() });
  // Visibility gates (docs/visibility-architecture.md): read-only probes of the SDF, the fog of war and the simulation's sight.
  Object.defineProperty(window, '__tmtVisibility', { configurable: true, value: view.visibilityDebug() });
  if (!devFlags.residentCheck) return () => {};
  // Explicit development telemetry lives in the DOM so browser qualification can
  // inspect committed state without invoking setters or relying on private globals.
  const script = document.createElement('script');
  script.type = 'application/json'; script.id = 'resident-diagnostics'; document.body.append(script);
  return () => {
    const world = game.world, state = game.snapshot;
    if (!world || !state) return;
    script.textContent = JSON.stringify({ ready: game.ready, phase: state.phase, tick: state.tick,
      terrainVersion: world.version, preparationMs: game.preparationMs, frame: view.telemetry(), camera: view.cameraTelemetry(), footprints: view.telemetry().footprintCount,
      tanks: state.tanks.map(t => ({ position: t.position, velocity: t.velocity })), ...world.diagnostics() });
  };
}
