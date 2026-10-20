import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
/** Same rules, native engine and terrain generator are required before peers can share a world. */
export function onlineBuild(root: string): string {
  const hash = createHash('sha256');
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (/\.(ts|wasm)$/.test(entry.name)) { hash.update(relative(root, next).replaceAll('\\', '/')); hash.update(readFileSync(next)); }
    }
  };
  for (const folder of ['src/game', 'src/world', 'src/gpu/terrain']) visit(join(root, folder));
  return hash.digest('hex').slice(0, 24);
}
