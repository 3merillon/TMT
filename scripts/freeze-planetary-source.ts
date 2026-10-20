/** Freeze development-only acceptance pages without touching the working checkout. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..'), out = resolve(root, process.argv[2] ?? '');
assert.ok(Boolean(process.argv[2]) && (out.startsWith(`${root}\\`) || out.startsWith(`${root}/`)), 'Pass a new directory inside this workspace');
assert.ok(!existsSync(out), 'Never overwrite a frozen source arm');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  assert.ok(!entry.isSymbolicLink(), `Unexpected source link: ${join(dir, entry.name)}`);
  return entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)];
});
const files = [...['src', 'scripts', 'budgets'].flatMap(name => walk(join(root, name))),
  ...readdirSync(root).filter(name => name.endsWith('.html') || /^(?:package(?:-lock)?|tsconfig)\.json$/.test(name) || name === 'vite.config.ts').map(name => join(root, name))];
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha256 = Object.fromEntries(files.map(file => [relative(root, file).replace(/\\/g, '/'), hash(file)]));
mkdirSync(out, { recursive: true });
for (const file of files) { const destination = join(out, relative(root, file)); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file, destination); }
for (const [path, expected] of Object.entries(sha256)) {
  assert.equal(hash(join(root, path)), expected, `Live source changed during freeze: ${path}`);
  assert.equal(hash(join(out, path)), expected, `Frozen file differs: ${path}`);
}
// Dependencies and immutable public assets are shared explicitly; no link is ever a cleanup target.
for (const name of ['node_modules', 'public']) symlinkSync(join(root, name), join(out, name), 'junction');
const manifest = { frozenAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), sha256,
  assets: Object.fromEntries(walk(join(root, 'public')).map(file => [relative(root, file).replace(/\\/g, '/'), hash(file)])),
  shared: ['node_modules', 'public'], note: 'Source snapshot for development-only unchanged acceptance pages; not a production build.' };
writeFileSync(join(out, 'qualification-source.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ out, head: manifest.head, sourceFiles: files.length }));
