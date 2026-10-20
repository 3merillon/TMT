import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  root,
  server: { host: '127.0.0.1', port: 5174, strictPort: true, hmr: false, watch: null, open: false },
});

await server.listen();
server.printUrls();
const stop = () => void server.close().finally(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
