/**
 * URL of the bundled engine AudioWorklet. The brief sketches `new URL('./worklets/engine-processor.ts', import.meta.url)`,
 * but outside a `new Worker(...)` call Vite treats that as a raw asset: the build would ship untranspiled TypeScript
 * with a non-JavaScript MIME type, which `audioWorklet.addModule` rejects. `?worker&url` is Vite's way to bundle a
 * worker-like entry (transpiled, hashed, served as JS in dev and build) and hand back its URL.
 * Only index.ts imports this, so the Node tests never see the Vite-specific query.
 */
import engineProcessorUrl from './engine-processor.ts?worker&url';

export const ENGINE_WORKLET_URL: string = engineProcessorUrl;
