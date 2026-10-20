import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_APP_ENTRIES, defaultSecondaryEntries, fsHost, globPatternsOf, htmlModuleEntries, importClosure, resolveSpecifier, specifiersOf, whyReachable, type ClosureReport } from '../scripts/import-closure';

// A small fixture tree: one page, static/dynamic/worker/raw edges, a test-only module, a script-only server file and orphans.
const FIXTURE: Record<string, string> = {
  'play.html': '<!doctype html><body><script type="module" src="/src/main.ts"></script><script src="/legacy.js"></script></body>',
  'check.html': '<script src="./src/check.ts" type="module"></script>',
  'src/main.ts': [
    "import { a } from './a';",
    "import shader from './shaders/s.wgsl?raw';",
    "import * as THREE from 'three';",
    "import RAPIER from '@dimforge/rapier3d-compat';",
    "const lazy = () => import('./lazy');",
    "const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });",
    "const rootUrl = new URL('../', import.meta.url);",
    "const nestedRootUrl = new URL('../..', import.meta.url);",
    "const moduleUrl = new URL('.', import.meta.url);",
    "const wasmUrl = new URL('./engine.wasm', import.meta.url);",
    "const assetUrl = new URL('./textures/atlas.bin', import.meta.url);",
    "const missingWorker = new Worker(new URL('./missing-worker.ts', import.meta.url));",
    "const scenes = import.meta.glob('./scenes/**/scene.ts');",
    "// new URL('./ghost.ts', import.meta.url) in a comment is not an edge",
    "const text = \"new URL('./ghost.ts', import.meta.url)\";",
    'export { a, shader, THREE, RAPIER, lazy, worker, text };',
  ].join('\n'),
  'src/a.ts': "export * from './b.js';\nexport const a = 1;",
  'src/b.ts': "import type { T } from './types';\nexport const b: T = 2;",
  'src/types.ts': 'export type T = number;',
  'src/lazy/index.ts': 'export const lazy = true;',
  'src/worker.ts': "import { b } from './b';\nself.postMessage(b);",
  'src/engine.wasm': 'wasm bytes',
  'src/textures/atlas.bin': 'asset bytes',
  'src/scenes/scene.ts': 'export const scene = true;',
  'src/scenes/deep/scene.ts': 'export const scene = true;',
  'src/scenes/not-included.ts': 'export const scene = false;',
  'src/shaders/s.wgsl': 'fn main() {}',
  'src/ghost.ts': 'export {};',
  'src/check.ts': "import { missing } from './nope';\nexport { missing };",
  'src/dead.ts': "import './dead2';",
  'src/dead2.ts': 'export {};',
  'src/test-only.ts': 'export const t = 1;',
  'src/env.d.ts': 'declare const X: number;',
  'src/unit.test.ts': "import { t } from './test-only';\nconsole.log(t);",
  'tests/x.test.ts': "import '../src/a';\nimport { t } from '../src/test-only';\nconsole.log(t);",
  'scripts/tool.ts': "import { serve } from '../server/api';\nserve();",
  'scripts/nested/used.ts': "import '../../src/dead';",
  'server/api.ts': "import { b } from '../src/b';\nexport const serve = () => b;",
};
function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-closure-'));
  for (const [file, text] of Object.entries(FIXTURE)) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); }
  return dir;
}

describe('import closure', () => {
  const dir = writeFixture();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const host = fsHost(dir);

  it('reads module entries from HTML', () => {
    expect(DEFAULT_APP_ENTRIES).toEqual(['index.html', 'dev/structural-check.html', 'dev/engine-sandbox.html', 'dev/kit.html']);
    expect(htmlModuleEntries(FIXTURE['play.html'], 'play.html')).toEqual(['src/main.ts']);
    expect(htmlModuleEntries(FIXTURE['check.html'], 'check.html')).toEqual(['src/check.ts']);
  });

  it('follows static, dynamic, worker and raw edges but not comments or strings', () => {
    const specifiers = specifiersOf(FIXTURE['src/main.ts']);
    expect(specifiers).toEqual(expect.arrayContaining(['./a', './shaders/s.wgsl?raw', 'three', '@dimforge/rapier3d-compat', './lazy', './worker.ts', './engine.wasm', './textures/atlas.bin', './missing-worker.ts']));
    expect(specifiers).not.toContain('./ghost.ts');
    expect(specifiers).not.toContain('../');
    expect(specifiers).not.toContain('../..');
    expect(specifiers).not.toContain('.');
    expect(globPatternsOf(FIXTURE['src/main.ts'])).toEqual(['./scenes/**/scene.ts']);
    expect(resolveSpecifier(host, 'src/a.ts', './b.js')).toEqual({ file: 'src/b.ts' });
    expect(resolveSpecifier(host, 'src/main.ts', './lazy')).toEqual({ file: 'src/lazy/index.ts' });
    expect(resolveSpecifier(host, 'src/main.ts', '/src/types')).toEqual({ file: 'src/types.ts' });
    expect(resolveSpecifier(host, 'src/main.ts', 'three/webgpu')).toEqual({ external: 'three' });
    expect(resolveSpecifier(host, 'src/main.ts', '@dimforge/rapier3d-compat/x')).toEqual({ external: '@dimforge/rapier3d-compat' });
    expect(resolveSpecifier(host, 'src/check.ts', './nope')).toEqual({ missing: true });
    expect(resolveSpecifier(host, 'src/main.ts', './engine.wasm')).toEqual({ file: 'src/engine.wasm' });
    expect(resolveSpecifier(host, 'src/main.ts', './textures/atlas.bin')).toEqual({ file: 'src/textures/atlas.bin' });
    expect(resolveSpecifier(host, 'src/main.ts', './missing-worker.ts')).toEqual({ missing: true });
  });

  it('classifies reachable, unreachable, kept and orphan files', () => {
    const { tests, scripts } = defaultSecondaryEntries(host);
    expect(tests).toEqual(['tests/x.test.ts', 'src/unit.test.ts']);
    expect(scripts).toEqual(['scripts/nested/used.ts', 'scripts/tool.ts']);
    const report = importClosure(host, { appEntries: ['play.html', 'check.html'], testEntries: tests, scriptEntries: scripts, scope: ['src', 'server'] });
    expect(report.appEntries).toEqual(['src/main.ts', 'src/check.ts']);
    expect(report.reachable).toEqual(['src/a.ts', 'src/b.ts', 'src/check.ts', 'src/engine.wasm', 'src/lazy/index.ts', 'src/main.ts', 'src/scenes/deep/scene.ts', 'src/scenes/scene.ts', 'src/shaders/s.wgsl', 'src/textures/atlas.bin', 'src/types.ts', 'src/worker.ts']);
    expect(report.external).toEqual(['@dimforge/rapier3d-compat', 'three']);
    expect(report.unreachable).toEqual(['server/api.ts', 'src/dead.ts', 'src/dead2.ts', 'src/ghost.ts', 'src/scenes/not-included.ts', 'src/test-only.ts', 'src/unit.test.ts']);
    expect(report.keptByTestsOrScripts).toEqual(['server/api.ts', 'src/dead.ts', 'src/dead2.ts', 'src/test-only.ts', 'src/unit.test.ts']);
    expect(report.orphans).toEqual(['src/ghost.ts', 'src/scenes/not-included.ts']);
    expect(report.importers).toEqual({ 'tests/x.test.ts': ['src/test-only.ts'], 'src/unit.test.ts': ['src/test-only.ts'], 'scripts/nested/used.ts': ['src/dead.ts'], 'scripts/tool.ts': ['server/api.ts'] });
    expect(report.missing).toEqual([{ from: 'src/check.ts', specifier: './nope' }, { from: 'src/main.ts', specifier: './missing-worker.ts' }]);
  });

  it('explains why a file is reachable', () => {
    expect(whyReachable(host, ['src/main.ts'], 'src/types.ts')).toEqual(['src/main.ts', 'src/a.ts', 'src/b.ts', 'src/types.ts']);
    expect(whyReachable(host, ['src/main.ts'], 'src/dead.ts')).toBeUndefined();
  });

  it('prints the JSON report from the CLI', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', resolve('scripts/import-closure.ts'), '--root', dir, '--json', '--entry', 'play.html'], { encoding: 'utf8' });
    const report = JSON.parse(out) as ClosureReport;
    expect(report.appEntries).toEqual(['src/main.ts']);
    expect(report.unreachable).toContain('src/check.ts');
    expect(report.missing).toEqual([{ from: 'src/main.ts', specifier: './missing-worker.ts' }]);
    expect(report.counts.missing).toBe(1);
  }, 30000);
});
