/**
 * The lazily loaded audio chunk: index.ts imports this in the first idle period after the page starts (or on an
 * earlier match start or gesture), so the engine code never weighs on the initial bundle. It binds the Vite-bundled
 * worklet URL and the public asset base (the effects bank and the score stems) to the integrator.
 */
import { TankAudioIntegrator, type IntegratorOptions } from './integrator';
import { ENGINE_WORKLET_URL } from './worklets/engine-url';
import { installUiSounds } from './sfx/ui';

export function createAudioEngine(ctx: AudioContext, o: Omit<IntegratorOptions, 'workletUrl'> = {}): TankAudioIntegrator {
  return new TankAudioIntegrator(ctx, { baseUrl: import.meta.env.BASE_URL, ...o, workletUrl: ENGINE_WORKLET_URL });
}
export type { TankAudioIntegrator };

/** Document-level UI sounds (button clicks, slider ticks); returns the uninstaller. */
export function installUi(engine: TankAudioIntegrator, doc: Document): () => void {
  return installUiSounds(engine.m, doc);
}
