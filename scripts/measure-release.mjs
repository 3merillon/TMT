/** Comparable file-byte totals, not runtime-memory or network-transfer claims. */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { collectReleaseFiles } from './check-repo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, process.argv[2] ?? 'dist');
const files = collectReleaseFiles(root);
const groups = {};
for (const file of files) {
  const name = file.path.startsWith('rust/target/') ? 'rust/target' : file.path.split('/')[0];
  const group = groups[name] ??= { files: 0, bytes: 0 };
  group.files++; group.bytes += file.size;
}
const walk = folder => readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
  const path = join(folder, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const outputFiles = walk(dist), bundles = {};
for (const extension of ['js', 'css', 'wasm']) {
  const matches = outputFiles.filter(file => extname(file) === `.${extension}`);
  const sizes = matches.map(file => { const bytes = readFileSync(file); return { raw: bytes.length, gzip: gzipSync(bytes).length, brotli: brotliCompressSync(bytes).length }; });
  bundles[extension] = { files: matches.length, ...Object.fromEntries(['raw', 'gzip', 'brotli'].map(key => [key, sizes.reduce((sum, size) => sum + size[key], 0)])) };
}
const result = { files: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0), groups, bundles,
  deployBytes: outputFiles.reduce((sum, file) => sum + statSync(file).size, 0) };
const destination = resolve(root, 'artifacts/release-final-sizes.json');
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ files: result.files, totalBytes: result.totalBytes, deployBytes: result.deployBytes, bundles }, null, 2));
