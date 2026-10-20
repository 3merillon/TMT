// Importable Worker types avoid replacing the browser DOM globals used by the game.
declare module 'cloudflare:workers' {
  import type { CloudflareWorkersModule } from '@cloudflare/workers-types';
  export const DurableObject: typeof CloudflareWorkersModule.DurableObject;
}
