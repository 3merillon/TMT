/** Preserve a production renderer arm and its source provenance. Never overwrites a prior arm.
 * `--profile` keeps identifiers (no minification) so CPU profiles name functions: attribute cost with it, time the real arm. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..'), output = process.argv[2], profile = process.argv.includes('--profile');
assert.ok(output && !output.startsWith('--'), 'Pass a new output directory');
// Performance arms may live on a separate drive; a fresh explicit directory still prevents overwriting evidence.
const out = resolve(root, output);
assert.ok(!existsSync(out), 'Use a fresh production-build directory'); mkdirSync(out, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const files = git('ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'vite.config.ts', 'package-lock.json').split('\n').filter(p => existsSync(join(root, p)));
const assetFiles = (directory: string): string[] => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? assetFiles(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []) : [];
const source = { production: true, profile, builtAt: new Date().toISOString(), head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), diff: git('diff', '--binary'),
  sha256: Object.fromEntries([...new Set(files)].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
  assets: Object.fromEntries(assetFiles(join(root, 'public')).map(path => [relative(root, path).replace(/\\/g, '/'), createHash('sha256').update(readFileSync(path)).digest('hex')])) };
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', out, '--logLevel', 'warn', ...(profile ? ['--minify', 'false'] : [])], { cwd: root, stdio: 'inherit' });
assert.equal(git('status', '--porcelain'), source.status, 'Source membership changed during build; preserve this directory and build a fresh arm');
for (const [path, hash] of Object.entries(source.sha256)) assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), hash,
  `Source changed during build: ${path}; build a fresh arm`);
for (const [path, hash] of Object.entries(source.assets)) assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), hash,
  `Public asset changed during build: ${path}; build a fresh arm`);
writeFileSync(join(out, 'source-state.json'), JSON.stringify(source, null, 2));
console.log(JSON.stringify({ out, head: source.head, production: true, profile }));
