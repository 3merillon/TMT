// Validates every WGSL source with naga. Skips with a message when naga is absent.
// Sources: every src/**/*.wgsl file, plus the linked engine shaders returned by src/engine/wgsl/naga-exports.ts
// (`nagaModules(): { name, code }[]`) when that module exists.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compactWgsl } from '../scripts/compact-wgsl';
import { packWgsl, unpackWgsl } from '../scripts/pack-wgsl';
import { projectileTrailShader } from '../src/game/presentation/projectile-trails';
import { link } from '../src/engine/wgsl/module';

const root = resolve(import.meta.dirname, '..');

function findNaga(): string | undefined {
  const exe = process.platform === 'win32' ? 'naga.exe' : 'naga';
  const candidates = [process.env.TMT_NAGA, ...(process.env.PATH ?? '').split(delimiter).map(dir => dir && join(dir, exe)), join(homedir(), '.cargo', 'bin', exe)];
  return candidates.find((path): path is string => !!path && existsSync(path));
}
function wgslFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? wgslFiles(path) : entry.name.endsWith('.wgsl') ? [path] : [];
  }).sort();
}
function validate(naga: string, file: string): { ok: boolean; output: string } {
  const run = spawnSync(naga, [file], { encoding: 'utf8', timeout: 30000 });
  return { ok: run.status === 0, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`.trim() };
}

const naga = findNaga();
const files = wgslFiles(join(root, 'src')).map(file => relative(root, file).split('\\').join('/'));
const exportsModule = join(root, 'src', 'engine', 'wgsl', 'naga-exports.ts');
if (!naga) console.warn('[wgsl-naga] naga not found on PATH or in ~/.cargo/bin (set TMT_NAGA): WGSL validation skipped. Install with `cargo install naga-cli`.');

describe.skipIf(!naga)('naga validates WGSL', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-naga-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('finds the WGSL sources', () => expect(files.length).toBeGreaterThan(0));

  it.each(files)('%s', file => {
    const result = validate(naga!, join(root, file));
    expect(result.ok, result.output).toBe(true);
    const compactPath = join(scratch, file.replace(/[\\/]/g, '_'));
    const compactCode = compactWgsl(readFileSync(join(root, file), 'utf8'));
    const decoded = unpackWgsl(packWgsl(compactCode));
    expect(decoded).toBe(compactCode);
    writeFileSync(compactPath, decoded);
    const compact = validate(naga!, compactPath);
    expect(compact.ok, compact.output).toBe(true);
  });

  it.skipIf(!existsSync(exportsModule))('linked engine modules from src/engine/wgsl/naga-exports.ts', async () => {
    const loaded = await import(/* @vite-ignore */ pathToFileURL(exportsModule).href) as { nagaModules?: () => { name: string; code: string }[] };
    expect(typeof loaded.nagaModules, 'naga-exports.ts must export nagaModules()').toBe('function');
    const modules = loaded.nagaModules!();
    modules.push({ name: 'shader:projectile-trails', code: link(projectileTrailShader).code });
    expect(modules.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const { name, code } of modules) {
      const file = join(scratch, `${name.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.wgsl`);
      writeFileSync(file, code);
      const result = validate(naga!, file);
      if (!result.ok) failures.push(`${name}:\n${result.output}`);
      const compactCode = compactWgsl(code), decoded = unpackWgsl(packWgsl(compactCode));
      expect(decoded, `${name}: dictionary expansion changed WGSL`).toBe(compactCode);
      writeFileSync(file, decoded);
      const compact = validate(naga!, file);
      if (!compact.ok) failures.push(`${name} (build compacted):\n${compact.output}`);
    }
    expect(failures, failures.join('\n\n')).toEqual([]);
  }, 60000);
});
