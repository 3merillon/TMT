import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOwnership, checkSources, formatFindings, globToRegExp, N1_MODE, N4_MODE, recheckoutCommand, stripCommentsAndStrings, wgslIndexEol, type ChangedFile, type Diff, type Ownership } from '../scripts/guards';

function sources(files: Record<string, string>, modes: { n1Mode?: 'warn' | 'error'; n4Mode?: 'warn' | 'error' } = {}) {
  return checkSources({ files: Object.keys(files), read: file => files[file], ...modes });
}

describe('globs', () => {
  it.each([
    ['src/**', 'src/a.ts', true], ['src/**', 'src/a/b/c.ts', true], ['src/*.ts', 'src/a/b.ts', false], ['src/gpu/*', 'src/gpu/terrain/x.ts', false],
    ['src/gpu/*', 'src/gpu/scan.ts', true], ['**/*.test.ts', 'a.test.ts', true], ['**/*.test.ts', 'src/x/y.test.ts', true],
    ['tests/{a,b}-*.test.ts', 'tests/b-x.test.ts', true], ['tests/{a,b}-*.test.ts', 'tests/c-x.test.ts', false],
    ['src/game/{a,b{c,d}}.ts', 'src/game/bd.ts', true], ['src/game/resident-*.ts', 'src/game/resident-terrain.ts', true], ['a?c.ts', 'abc.ts', true],
    ['budgets/*.json', 'budgets/example.json', true], ['docs/reference/**', 'docs/reference/example.md', true],
  ])('%s matches %s: %s', (glob, file, expected) => expect(globToRegExp(glob).test(file)).toBe(expected));
});

describe('source rules', () => {
  it('ships with N1 and N4 at error level (N1 since the Gate-1 takeover, N4 since CC-012 part 2)', () => {
    expect(N1_MODE).toBe('error');
    expect(N4_MODE).toBe('error');
  });

  it('blanks comments and strings but keeps lines', () => {
    const text = "const a = 1; // Math.random()\n/* Date.now()\n */ const s = 'performance.now()'; const t = `x${1}`;\nMath.random();";
    const stripped = stripCommentsAndStrings(text);
    expect(stripped.split('\n')).toHaveLength(text.split('\n').length);
    expect(stripped).not.toMatch(/Date\.now|performance\.now/);
    expect(stripped.match(/Math\.random/g)).toHaveLength(1);
  });

  it('N1: rejects the Three package and every subpath outside diagnostic lab and test code', () => {
    const findings = sources({
      'src/game/a.ts': "import * as THREE from 'three/webgpu';\nimport { Fn } from 'three/tsl';\nimport * as M from 'three';",
      'src/game/b.ts': "const c = await import('three/addons/controls/OrbitControls.js');\nexport * from 'three/examples/jsm/x.js';",
      'src/game/c.ts': "import { Vector3 } from 'three/src/math/Vector3.js';\nconst three = require('three');",
      'src/lab/c.ts': "import * as THREE from 'three/webgpu';\nimport { Vector3 } from 'three';",
      'tests/d.test.ts': "import * as THREE from 'three/webgpu';\nimport { Vector3 } from 'three';",
      'src/core/oracle.test.ts': "import { Matrix4 } from 'three';",
      'scripts/probe.ts': "import { Vector3 } from 'three';",
      'src/game/unrelated.ts': "import { x } from 'three-other';",
    });
    expect(findings.map(f => [f.rule, f.level, f.file, f.line])).toEqual([
      ['N1', 'error', 'src/game/a.ts', 1], ['N1', 'error', 'src/game/a.ts', 2], ['N1', 'error', 'src/game/a.ts', 3],
      ['N1', 'error', 'src/game/b.ts', 1], ['N1', 'error', 'src/game/b.ts', 2],
      ['N1', 'error', 'src/game/c.ts', 1], ['N1', 'error', 'src/game/c.ts', 2],
    ]);
    expect(sources({ 'src/game/a.ts': "import 'three/tsl';" }, { n1Mode: 'warn' })[0].level).toBe('warn');
  });

  it('N4: flags wall clock and Math.random only in sim code', () => {
    const findings = sources({
      'src/game/simulation.ts': "const t = Date.now();\n// Math.random() in a comment\nconst s = 'performance.now()';\nconst d = new Date( 0 );",
      'src/game/rules/tempo.ts': 'export const r = () => Math.random();',
      'src/game/kit/mesh-builder.ts': 'const jitter = Math.random();',
      'src/game/kit/pose.ts': 'const t0 = performance.now();',
      'src/game/view.ts': 'const t = performance.now();',
      'src/game/rules/tempo.test.ts': 'Math.random();',
      'src/world/wind.ts': 'export const w = Date.now();',
    });
    expect(findings.filter(f => f.rule === 'N4').map(f => [f.file, f.line, f.message.split(' ')[0]])).toEqual([
      ['src/game/simulation.ts', 1, 'Date.now'], ['src/game/simulation.ts', 4, 'new'], ['src/game/rules/tempo.ts', 1, 'Math.random'],
      ['src/game/kit/pose.ts', 1, 'performance.now'], ['src/world/wind.ts', 1, 'Date.now'],
    ]);
    expect(sources({ 'src/game/munitions.ts': 'Math.random()' }, { n4Mode: 'warn' })[0].level).toBe('warn');
  });

  it('layering: engine never imports game; world stays pure; sim never imports engine or audio', () => {
    const findings = sources({
      'src/engine/scene/x.ts': "import { GameView } from '../../game/view';\nimport type { Bounds } from '../../core/types';",
      'src/world/sun.ts': "import { Engine } from '../engine/engine';\nexport const w = window.innerWidth;\nconst o = { window: 1 };\nconst n = o.window;",
      'src/world/wind.ts': "import type { V3 } from '../game/contracts';",
      'src/game/simulation.ts': "import { play } from '../audio/audio-manager';\nimport { Engine } from '../engine/engine';\nimport { x } from './kit';",
      'src/game/view.ts': "import { Engine } from '../engine/engine';",
    }).filter(f => f.rule === 'layering');
    expect(findings.map(f => [f.file, f.line])).toEqual([
      ['src/engine/scene/x.ts', 1], ['src/world/sun.ts', 1], ['src/world/sun.ts', 2], ['src/world/wind.ts', 1], ['src/game/simulation.ts', 1], ['src/game/simulation.ts', 2],
    ]);
    expect(findings.find(f => f.file === 'src/world/sun.ts' && f.line === 2)?.message).toContain('DOM global window');
    expect(findings.every(f => f.level === 'error')).toBe(true);
  });

  it('flags CRLF in WGSL and misplaced tests', () => {
    const findings = sources({
      'src/gpu/a.wgsl': 'fn a() {}\nfn b() {}\r\nfn c() {}\n',
      'src/gpu/b.wgsl': 'fn a() {}\n',
      'scripts/tool.test.ts': '', 'tests/deep/x.test.ts': '', 'src/game/y.test.ts': '', 'server/z.spec.ts': '', 'tests/helpers/world.ts': '',
    });
    expect(findings.map(f => [f.rule, f.file, f.line])).toEqual([['crlf', 'src/gpu/a.wgsl', 2], ['tests', 'scripts/tool.test.ts', undefined], ['tests', 'server/z.spec.ts', undefined]]);
  });

  it('tells stale CRLF working copies (index LF) apart from committed or new CRLF WGSL', () => {
    const files: Record<string, string> = { 'src/gpu/stale.wgsl': 'fn a() {}\r\n', 'src/gpu/mixed copy.wgsl': 'fn a() {}\nfn b() {}\r\n',
      'src/gpu/committed.wgsl': 'fn a() {}\r\n', 'src/gpu/new.wgsl': 'fn a() {}\r\n', 'src/gpu/clean.wgsl': 'fn a() {}\n' };
    const index: Record<string, string> = { 'src/gpu/stale.wgsl': 'lf', 'src/gpu/mixed copy.wgsl': 'lf', 'src/gpu/committed.wgsl': 'crlf', 'src/gpu/new.wgsl': '', 'src/gpu/clean.wgsl': 'lf' };
    const findings = checkSources({ files: Object.keys(files), read: file => files[file], indexEol: file => index[file] });
    expect(findings.map(f => [f.rule, f.level, f.file, f.line])).toEqual([
      ['crlf-worktree', 'warn', 'src/gpu/stale.wgsl', 1], ['crlf-worktree', 'warn', 'src/gpu/mixed copy.wgsl', 2],
      ['crlf', 'error', 'src/gpu/committed.wgsl', 1], ['crlf', 'error', 'src/gpu/new.wgsl', 1],
    ]);
    expect(findings[0].message).toContain('rm src/gpu/stale.wgsl && git checkout -- src/gpu/stale.wgsl');
    expect(findings[2].message).toContain('git add --renormalize src/gpu/committed.wgsl');
    expect(findings[3].message).toContain('save it with LF');
    expect(formatFindings(findings)).toContain('rm "src/gpu/mixed copy.wgsl" src/gpu/stale.wgsl && git checkout -- "src/gpu/mixed copy.wgsl" src/gpu/stale.wgsl');
    expect(recheckoutCommand(['a b.wgsl'])).toBe('rm "a b.wgsl" && git checkout -- "a b.wgsl"');
  });

  it('reads index line endings from git ls-files --eol', () => {
    const eol = wgslIndexEol();
    expect(eol.size).toBeGreaterThan(0);
    for (const [file, stored] of eol) {
      expect(file).toMatch(/^src\/.*\.wgsl$/);
      expect(['lf', 'crlf', 'mixed', 'none', '']).toContain(stored);
    }
  });
});

describe('ownership', () => {
  const ownership: Ownership = {
    appendOnly: ['src/engine/modules.ts', 'scripts/capture-plans/index.json', 'budgets/*.json'],
    waves: {
      '0': { streams: {
        'W0-A': { owns: ['src/a/**', 'tests/a-*.test.ts'], deletes: ['src/old/**'], shared: ['src/shared.ts'] },
        'W0-B': { owns: ['src/b/**', 'src/engine/modules.ts'] },
      } },
      '1': { streams: { 'W1-X': { owns: ['src/x/**'] } }, tests: { 'W1-X': ['tests/game-x.test.ts'] } },
    },
    grants: [{ stream: 'W0-A', paths: ['tests/granted.test.ts'] }],
  };
  const noDiff = (): Diff => ({ added: [], removed: [] });
  const run = (stream: string, changed: ChangedFile[], diff: (file: string) => Diff = noDiff) => checkOwnership(stream, ownership, changed, diff);

  it('accepts owned, shared, granted and deletable files', () => {
    expect(run('W0-A', [
      { file: 'src/a/x.ts', status: 'M' }, { file: 'src/a/deep/y.ts', status: 'A' }, { file: 'tests/a-z.test.ts', status: 'A' },
      { file: 'src/shared.ts', status: 'M' }, { file: 'tests/granted.test.ts', status: 'M' }, { file: 'src/old/z.ts', status: 'D' },
    ])).toEqual([]);
    expect(run('W1-X', [{ file: 'tests/game-x.test.ts', status: 'M' }])).toEqual([]);
  });

  it('rejects edits outside ownership and names the owner', () => {
    const findings = run('W0-A', [{ file: 'src/b/view.ts', status: 'M' }, { file: 'src/old/z.ts', status: 'M' }, { file: 'README.md', status: 'A' }]);
    expect(findings.map(f => [f.rule, f.level, f.file])).toEqual([['ownership', 'error', 'src/b/view.ts'], ['ownership', 'error', 'src/old/z.ts'], ['ownership', 'error', 'README.md']]);
    expect(findings[0].message).toContain('owned by W0-B');
    expect(() => run('W0-NOPE', [])).toThrow(/not in the supplied ownership file/);
    expect(() => run('TOOLS', [])).toThrow(/W<wave>-<NAME>/);
  });

  it('lets any stream append tagged lines to append-only registries', () => {
    const diffs: Record<string, Diff> = {
      'src/engine/modules.ts': { added: ['  () => lighting(), // W0-A'], removed: [] },
      'scripts/capture-plans/index.json': { added: ['  { "plan": "smoke", "stream": "W0-B" },', '  { "plan": "flow", "stream": "W0-A" }'], removed: ['  { "plan": "smoke", "stream": "W0-B" }'] },
      'budgets/terrain.json': { added: ['    { "id": "x", "max": 1 }'], removed: [] },
    };
    const findings = run('W0-A', Object.keys(diffs).map(file => ({ file, status: 'M' as const })), file => diffs[file]);
    expect(findings.map(f => [f.rule, f.level, f.file])).toEqual([['append-only', 'warn', 'budgets/terrain.json']]);
  });

  it('rejects rewriting or deleting append-only registries, but not for their owner', () => {
    const rewrite = { added: ['  () => other(), // W0-A'], removed: ['  () => lighting(), // W0-B'] };
    expect(run('W0-A', [{ file: 'src/engine/modules.ts', status: 'M' }], () => rewrite).map(f => [f.rule, f.level])).toEqual([['append-only', 'error']]);
    expect(run('W0-A', [{ file: 'budgets/example.json', status: 'D' }]).map(f => [f.rule, f.level])).toEqual([['append-only', 'error']]);
    expect(run('W0-B', [{ file: 'src/engine/modules.ts', status: 'M' }], () => rewrite)).toEqual([]);
  });

  it('never lets node_modules through', () => {
    expect(run('W0-A', [{ file: 'node_modules', status: 'A' }]).map(f => f.rule)).toEqual(['node_modules']);
  });
});

describe('guards on this repository', () => {
  it('requires an explicit ownership file when a stream is selected', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/guards.ts'), '--stream', 'W0-CLI', '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--stream requires --ownership <file.json>');
    expect(result.stdout).toBe('');
  }, 30000);

  it('loads a caller-supplied ownership policy with an explicit base', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'tmt-guard-policy-'));
    const ownershipFile = join(fixture, 'ownership.json');
    try {
      const ownership: Ownership = { waves: { '0': { base: 'intentionally-missing-default-base', streams: { 'W0-CLI': { owns: ['**'] } } } } };
      writeFileSync(ownershipFile, JSON.stringify(ownership));
      const out = execFileSync(process.execPath, ['--import', 'tsx', resolve('scripts/guards.ts'), '--stream', 'W0-CLI', '--ownership', ownershipFile, '--base', 'HEAD', '--json'], { encoding: 'utf8' });
      const report = JSON.parse(out) as { errors: number; ownership: { stream: string; base: string; mergeBase: string; changed: number } };
      expect(report.errors).toBe(0);
      expect(report.ownership).toMatchObject({ stream: 'W0-CLI', base: 'HEAD' });
      expect(report.ownership.mergeBase).toMatch(/^[a-f0-9]{40,64}$/);
      expect(report.ownership.changed).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(ownershipFile, { force: true });
      rmdirSync(fixture);
    }
  }, 30000);

  it('runs in under 5 s with no errors', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', resolve('scripts/guards.ts'), '--json'], { encoding: 'utf8' });
    const report = JSON.parse(out) as { ms: number; errors: number; findings: { rule: string; level: string }[] };
    expect(report.errors).toBe(0);
    expect(report.ms).toBeLessThan(5000);
    expect(report.findings.every(f => f.level === 'warn')).toBe(true);
  }, 30000);
});
