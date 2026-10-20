import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chunkClosure, entryChunk, evaluateBundle, type BundleBudget, type BundleReport } from '../scripts/check-bundle';

// play.html -> play.js imports shared.js statically and lazy.js dynamically; lazy.js pulls in the forbidden lab module.
const report: BundleReport = {
  chunks: [
    { fileName: 'assets/play.js', name: 'play', isEntry: true, isDynamicEntry: false, facadeModuleId: 'play.html', imports: ['assets/shared.js'], dynamicImports: ['assets/lazy.js'], modules: ['src/game/main.ts'] },
    { fileName: 'assets/shared.js', name: 'shared', isEntry: false, isDynamicEntry: false, facadeModuleId: null, imports: [], dynamicImports: [], modules: ['node_modules/three/build/three.webgpu.js', 'src/game/math.ts'] },
    { fileName: 'assets/lazy.js', name: 'lazy', isEntry: false, isDynamicEntry: true, facadeModuleId: 'src/game/resident.ts', imports: ['assets/shared.js'], dynamicImports: [], modules: ['src/lab/three-terrain-host.ts', null] },
  ],
  assets: [{ fileName: 'assets/worker.js' }, { fileName: 'assets/style.css' }],
};
const sizes: Record<string, number> = { 'assets/play.js': 100 * 1024, 'assets/shared.js': 300 * 1024, 'assets/lazy.js': 2000 * 1024, 'assets/worker.js': 50 * 1024 };
const size = (file: string) => ({ raw: sizes[file], gzip: Math.round(sizes[file] / 3) });

describe('bundle budgets', () => {
  it.each([
    ['shared', 'node_modules/three/build/three.core.js'],
    ['lazy', 'node_modules/three/src/math/Vector3.js'],
    ['lazy', 'node_modules/three/examples/jsm/controls/OrbitControls.js'],
  ])('rejects Three in the production %s closure: %s', (placement, module) => {
    const budget = JSON.parse(readFileSync(new URL('../budgets/bundle.json', import.meta.url), 'utf8')) as BundleBudget;
    const production: BundleReport = { ...report, chunks: report.chunks.map(c => ({ ...c,
      ...(c.isEntry ? { name: 'game', facadeModuleId: 'index.html' } : {}),
      modules: c.name === placement ? [module] : ['src/game/example.ts'],
    })) };
    const findings = evaluateBundle(production, budget, size).findings;
    expect(findings.filter(f => f.level === 'error')).toEqual([
      expect.objectContaining({ check: 'forbidden', message: expect.stringContaining(`game (all) contains node_modules/three/**: ${module}`) }),
    ]);
  });

  it('walks static imports for the initial closure and dynamic imports for all', () => {
    const entry = entryChunk(report, 'play')!;
    expect(entry.fileName).toBe('assets/play.js');
    expect(chunkClosure(report, entry, false).map(c => c.fileName).sort()).toEqual(['assets/play.js', 'assets/shared.js']);
    expect(chunkClosure(report, entry, true).map(c => c.fileName).sort()).toEqual(['assets/lazy.js', 'assets/play.js', 'assets/shared.js']);
  });

  it('passes a budget that fits and measures worker assets too', () => {
    const result = evaluateBundle(report, { anyJsMaxKb: 2000, entries: { play: { initialMaxKb: 400, initialGzipMaxKb: 140, allMaxKb: 2400 } } }, size);
    expect(result.findings).toEqual([]);
    expect(result.files.map(f => f.file)).toEqual(['assets/lazy.js', 'assets/shared.js', 'assets/play.js', 'assets/worker.js']);
    expect(result.entries[0]).toMatchObject({ entry: 'play', initialKb: 400, allKb: 2400 });
  });

  it('fails sizes beyond the tolerance and forbidden modules by level and scope', () => {
    const result = evaluateBundle(report, {
      tolerance: 0.1,
      files: [{ match: 'assets/lazy*.js', maxKb: 1500 }, { match: 'assets/missing-*.js', maxKb: 1 }],
      entries: { play: { initialMaxKb: 380 } },
      forbidden: [
        { entry: 'play', scope: 'initial', module: 'node_modules/three/build/three.{webgpu,tsl}.js', level: 'warn' },
        { entry: 'play', scope: 'initial', module: 'src/lab/**', level: 'error' },
        { entry: 'play', scope: 'all', module: 'src/lab/**', level: 'error', why: 'no lab in the game' },
        { entry: 'nope', module: 'x' },
      ],
    }, size);
    // lazy.js is over 1500 KB + 10%; the missing glob warns; three is in the initial closure (warn); the lab module is
    // only reachable lazily, so the "initial" rule is silent and the "all" rule fails; the unknown entry fails.
    expect(result.findings.map(f => [f.level, f.check])).toEqual([
      ['error', 'files'], ['warn', 'files'], ['warn', 'forbidden'], ['error', 'forbidden'], ['error', 'entries'],
    ]);
    expect(result.findings[3].message).toContain('src/lab/three-terrain-host.ts');
    expect(result.findings[3].message).toContain('no lab in the game');
    // 400 KB initial is within 380 KB + 10% = 418 KB.
    expect(result.findings.filter(f => f.message.includes('initial JS'))).toEqual([]);
    expect(evaluateBundle(report, { tolerance: 0, entries: { play: { initialMaxKb: 380 } } }, size).findings.map(f => f.check)).toEqual(['entries']);
  });
});
