/// <reference types="vitest/config" />
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchForWorkspaceRoot, type Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import { compactWgslPlugin } from './scripts/compact-wgsl';
import { packWgslPlugin } from './scripts/pack-wgsl';
import { externalRapierWasmPlugin } from './scripts/external-rapier-wasm';
import { onlineBuild } from './scripts/online-build';

const root = fileURLToPath(new URL('.', import.meta.url));
// Worktrees may junction node_modules to the main checkout. Vite resolves real paths,
// so the junction target must be allowed explicitly or the dev server answers 403.
const modulesRealPath = (() => { try { return realpathSync(join(root, 'node_modules')); } catch { return undefined; } })();

// ---- vitest projects ------------------------------------------------------------------------------------------------
// Areas partition the test files: a file belongs to the FIRST area whose globs match it, so `vitest run <file>` runs it once
// (a literal "fast" project would overlap every area and double each run). npm run verify:fast lists every area except
// slow and physics by name: vitest ORs repeated --project filters, so two negations cannot be combined. Physics covers
// legacy kinematic controllers on the real seed-7 planet; these CPU-heavy tests run in verify:physics and npm test.
// New heavy suites are named *.slow.test.ts; the legacy ones below predate that convention.
// The heavy tiers never share the pool: vitest runs sequence groups in order, so npm test runs every light area first,
// then physics alone, then slow alone, each on at most HEAVY_WORKERS workers (the standalone verify:physics condition).
const LEGACY_SLOW = ['tests/resident-endurance.test.ts', 'tests/resident-planet.test.ts'];
const AREAS: [name: string, include: string[]][] = [
  ['slow', ['**/*.slow.test.ts', ...LEGACY_SLOW]],
  ['tools', ['tests/{image-metrics,guards,import-closure,check-capture,check-bundle,check-repo,sync-public}.test.ts']],
  ['engine', ['tests/engine-*.test.ts', 'tests/wgsl-naga.test.ts']],
  ['kit', ['tests/kit-*.test.ts', 'tests/game-assets*.test.ts']],
  // Legacy kinematic-controller suites on the real seed-7 planet.
  ['physics', ['tests/game-{contact,tank-collision,tank-pair-collision,tread-contact,wheel-terrain-contact,motion-cache,playable}.test.ts']],
  ['vehicle', ['tests/vehicle-*.test.ts']],
  ['terrain', ['tests/{resident,structural,terrain}-*.test.ts']],
  ['rules', ['tests/{rules,game}-*.test.ts']],
  ['ui', ['tests/ui-*.test.ts']],
  ['fx', ['tests/fx-*.test.ts']],
  ['world', ['tests/world-*.test.ts']],
  ['audio', ['tests/audio-*.test.ts']],
  ['content', ['tests/content-*.test.ts']],
  // Everything else: the kernel tests kept with the src/core closure (src/core/arrangement.test.ts).
  ['lab', ['tests/**/*.test.ts', 'src/**/*.test.ts']],
];
const HEAVY: Record<string, { groupOrder: number; retries: number }> = { physics: { groupOrder: 1, retries: 2 }, slow: { groupOrder: 2, retries: 1 } };
// Worker defaults per npm script: verify:fast at 4, the heavy real-planet suites at 2. They live here, not in
// package.json, because vitest rejects a repeated --maxWorkers flag. Projects copy test.maxWorkers from this file and
// vitest 4.1 does not forward the CLI --maxWorkers to them (it is not in its per-project cliOverrides list), so the flag
// is read here too: without that, `npm test -- --maxWorkers=2` silently ran at the file's value.
function cliMaxWorkers(argv: readonly string[] = process.argv): number | string | undefined {
  for (let i = 2; i < argv.length; i++) {
    const match = /^--max-?workers(?:=(.*))?$/i.exec(argv[i]);
    if (!match) continue;
    const value = match[1] ?? argv[i + 1];
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : value;
  }
  return process.env.VITEST_MAX_WORKERS ? Number(process.env.VITEST_MAX_WORKERS) : undefined;
}
const SCRIPT_WORKERS: Record<string, number> = { 'verify:fast': 4, 'verify:terrain': 2, 'verify:physics': 2, 'verify:slow': 2 };
const maxWorkers = cliMaxWorkers() ?? SCRIPT_WORKERS[process.env.npm_lifecycle_event ?? ''] ?? 6;
const HEAVY_WORKERS = typeof maxWorkers === 'number' ? Math.min(maxWorkers, 2) : maxWorkers;
// Nested agent worktrees (.kilo, .claude) and build/capture output must never be collected as duplicate suites.
const TEST_EXCLUDE = [...configDefaults.exclude, '.kilo/**', '.kilocode/**', '.claude/**', 'dist/**', 'artifacts/**', '.vite-capture/**', '.verify-dist/**'];

// ---- verify:bundle report -------------------------------------------------------------------------------------------------
/** When building into .verify-dist, emit bundle-report.json (chunks, their modules and imports) for scripts/check-bundle.ts. */
function verifyBundleReport(): Plugin {
  // Repo-relative ids; packages as node_modules/<pkg>/... even through a worktree junction (real path elsewhere).
  const id = (module: string | null | undefined) => {
    if (!module) return null;
    const clean = module.replace(/^\0/, '').split('?')[0].split('\\').join('/');
    const packages = clean.indexOf('/node_modules/');
    return packages >= 0 ? clean.slice(packages + 1) : relative(root, clean).split('\\').join('/');
  };
  return {
    name: 'tmt-verify-bundle-report',
    apply: 'build',
    generateBundle(options, bundle) {
      if (!options.dir || !/[\\/]\.verify-dist[\\/]?$/.test(options.dir)) return;
      const chunks: unknown[] = [], assets: unknown[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') chunks.push({ fileName: item.fileName, name: item.name, isEntry: item.isEntry, isDynamicEntry: item.isDynamicEntry,
          facadeModuleId: id(item.facadeModuleId), imports: item.imports, dynamicImports: item.dynamicImports, modules: Object.keys(item.modules).map(id) });
        else assets.push({ fileName: item.fileName });
      }
      this.emitFile({ type: 'asset', fileName: 'bundle-report.json', source: JSON.stringify({ chunks, assets }, null, 1) });
    },
  };
}

export default defineConfig({
  define: { __ONLINE_BUILD__: JSON.stringify(onlineBuild(root)) },
  plugins: [compactWgslPlugin(), packWgslPlugin(), externalRapierWasmPlugin(), verifyBundleReport()],
  server: {
    proxy: { '/api/online': { target: process.env.HUB_PROXY ?? 'http://127.0.0.1:8787', changeOrigin: true, ws: true } },
    fs: { allow: [searchForWorkspaceRoot(root), ...(modulesRealPath ? [modulesRealPath] : [])] },
  },
  build: { rollupOptions: { input: { game: 'index.html', play: 'play.html' } } },
  // The debris worker builds collider descriptors with the Rapier compatibility JS, never its WASM: keep that binary out.
  worker: { plugins: () => [externalRapierWasmPlugin()] },
  test: {
    exclude: TEST_EXCLUDE, testTimeout: 30000, hookTimeout: 60000, maxWorkers,
    // A test that only TIMES OUT gets one more attempt to tolerate transient CPU contention. Assertion
    // failures are never retried, and a test that is slow on every attempt still fails.
    // The legacy physics suites carry tight explicit timeouts (up to 1.3x their standalone duration) and get two retries.
    retry: { count: 1, condition: /timed out/i },
    projects: AREAS.map(([name, include], index) => ({
      extends: true,
      test: {
        name, include, exclude: [...TEST_EXCLUDE, ...AREAS.slice(0, index).flatMap(([, claimed]) => claimed)],
        maxWorkers: HEAVY[name] ? HEAVY_WORKERS : maxWorkers,
        ...(HEAVY[name] && { sequence: { groupOrder: HEAVY[name].groupOrder }, retry: { count: HEAVY[name].retries, condition: /timed out/i } }),
      },
    })),
  },
});
