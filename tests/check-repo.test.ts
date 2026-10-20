import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { auditReleaseFiles, collectReleaseFiles, runRepositoryCheck } from '../scripts/check-repo.mjs';

describe('repository release checks', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tmt-release-check-'));
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it('collects tracked and non-ignored untracked files but drops deleted entries and ignored build output', () => {
    execFileSync('git', ['init', '-q', fixture]);
    writeFileSync(join(fixture, '.gitignore'), 'node_modules/\r\nrust/target/\r\npublic/*.mp4\r\n');
    mkdirSync(join(fixture, 'src'), { recursive: true });
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    mkdirSync(join(fixture, 'rust', 'target'), { recursive: true });
    mkdirSync(join(fixture, 'node_modules', 'sample'), { recursive: true });
    mkdirSync(join(fixture, 'public'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'kept.ts'), 'export {};');
    writeFileSync(join(fixture, 'docs', 'deleted.md'), 'gone');
    writeFileSync(join(fixture, 'src', 'new.ts'), 'export {};');
    writeFileSync(join(fixture, 'rust', 'target', 'generated.wasm'), 'build');
    writeFileSync(join(fixture, 'node_modules', 'sample', 'index.js'), 'build');
    writeFileSync(join(fixture, 'public', 'hidden-but-deployed.mp4'), 'video');
    execFileSync('git', ['-C', fixture, 'add', '.gitignore', 'src/kept.ts', 'docs/deleted.md']);
    unlinkSync(join(fixture, 'docs', 'deleted.md'));

    expect(collectReleaseFiles(fixture).map(file => file.path)).toEqual(['.gitignore', 'public/hidden-but-deployed.mp4', 'src/kept.ts', 'src/new.ts']);
  });

  it('enforces video, generated-output, private-file, and documentation image budgets while allowing source WASM', () => {
    const budget = {
      publicMaxBytes: 54,
      docsImages: { directory: 'docs/images', maxTotalBytes: 100, maxFileBytes: 60 },
      assetsMaxBytes: 1000,
      sourceGlbMaxBytes: 500,
      videoExtensions: ['.mp4', '.webm'],
      videoAllowlist: ['public/approved.webm'],
      forbiddenDirectories: ['node_modules', 'dist', 'target'],
    };
    const files = [
      { path: 'src/resident.wasm', size: 20 },
      { path: 'public/approved.webm', size: 1 },
      { path: 'public/unapproved.mp4', size: 1 },
      { path: 'dist/app.js', size: 1 },
      { path: 'rust/target/build.wasm', size: 1 },
      { path: '.env.production', size: 1 },
      { path: 'docs/images/large.webp', size: 61 },
      { path: 'docs/images/second.png', size: 50 },
    ];

    const result = auditReleaseFiles(files, budget);
    const codes = result.issues.map(issue => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['video-media', 'generated-directory', 'private-artifact', 'docs-images-budget', 'docs-image-file-budget']));
    expect(result.issues.filter(issue => issue.code === 'video-media').map(issue => issue.file)).toEqual(['public/unapproved.mp4']);
    expect(result.issues.some(issue => issue.file === 'src/resident.wasm')).toBe(false);
  });

  it('requires local documentation links to survive a public clone, while preserving missing-link and npm-script checks', () => {
    const docsFixture = join(fixture, 'documentation');
    mkdirSync(docsFixture);
    execFileSync('git', ['init', '-q', docsFixture]);
    for (const directory of ['budgets', 'docs/images', 'artifacts', 'empty']) mkdirSync(join(docsFixture, directory), { recursive: true });
    writeFileSync(join(docsFixture, '.gitignore'), 'artifacts/\n');
    writeFileSync(join(docsFixture, 'package.json'), JSON.stringify({ scripts: { check: 'tsc --noEmit' } }));
    writeFileSync(join(docsFixture, 'budgets/repository.json'), JSON.stringify({
      publicMaxBytes: 10000, assetsMaxBytes: 10000, sourceGlbMaxBytes: 10000,
      docsImages: { directory: 'docs/images', maxTotalBytes: 10000, maxFileBytes: 10000 }, docFiles: ['README.md'],
    }));
    writeFileSync(join(docsFixture, 'docs/guide.md'), '# Guide\n');
    writeFileSync(join(docsFixture, 'docs/draft guide.md'), '# Draft\n');
    writeFileSync(join(docsFixture, 'docs/images/guide.png'), 'tracked image');
    writeFileSync(join(docsFixture, 'docs/images/draft.png'), 'untracked image');
    writeFileSync(join(docsFixture, 'artifacts/capture.png'), 'ignored local capture');
    execFileSync('git', ['-C', docsFixture, 'add', '.gitignore', 'docs/guide.md', 'docs/images/guide.png']);
    const valid = [
      '[Guide](/docs/guide.md#section)', '[Draft](<docs/draft%20guide.md>)',
      '![Guide image](docs/images/guide.png)', '![Draft image](docs/images/draft.png)',
      '[Images](docs/images/)', '[Root](.)', '[Section](#section)', '[External](https://example.invalid/guide)',
      'npm run check',
    ].join('\n');
    writeFileSync(join(docsFixture, 'README.md'), valid);
    expect(runRepositoryCheck(docsFixture).issues).toEqual([]);

    writeFileSync(join(docsFixture, 'README.md'), `${valid}\n![Capture](artifacts/capture.png)\n[Captures](artifacts/)\n[Empty](empty/)\n[Missing](docs/missing.md)\nnpm run absent\n`);
    const result = runRepositoryCheck(docsFixture);
    expect(result.issues.map(issue => [issue.code, issue.file])).toEqual([
      ['doc-link-not-released', 'README.md'], ['doc-link-not-released', 'README.md'], ['doc-link-not-released', 'README.md'],
      ['doc-link-missing', 'README.md'], ['npm-script-missing', 'README.md'],
    ]);
    expect(result.issues[0].message).toContain('artifacts/capture.png');
    expect(result.issues[1].message).toContain('artifacts/');
    expect(result.issues[2].message).toContain('empty/');
    expect(result.issues[3].message).toContain('docs/missing.md');
    expect(result.issues[4].message).toContain('absent');

    // New guides must be checked even before someone adds them to the required-file list.
    writeFileSync(join(docsFixture, 'README.md'), valid);
    writeFileSync(join(docsFixture, 'docs/draft guide.md'), '[Local capture](../artifacts/capture.png)\n');
    expect(runRepositoryCheck(docsFixture).issues.map(issue => [issue.code, issue.file])).toEqual([
      ['doc-link-not-released', 'docs/draft guide.md'],
    ]);
  });

  it('rejects workstation paths embedded in binary WASM without exposing the private path', () => {
    const wasmFixture = join(fixture, 'wasm-privacy');
    mkdirSync(join(wasmFixture, 'budgets'), { recursive: true });
    execFileSync('git', ['init', '-q', wasmFixture]);
    writeFileSync(join(wasmFixture, 'package.json'), '{}');
    writeFileSync(join(wasmFixture, 'budgets/repository.json'), JSON.stringify({
      publicMaxBytes: 10000, assetsMaxBytes: 10000, sourceGlbMaxBytes: 10000,
      docsImages: { directory: 'docs/images', maxTotalBytes: 10000, maxFileBytes: 10000 },
    }));
    for (const sourcePath of ['C:\\Users\\private-person\\.cargo\\src', '/Users/private-person/.cargo/src', '/home/private-person/.cargo/src']) {
      writeFileSync(join(wasmFixture, 'compiler.wasm'), Buffer.from(`\0asm\xff${sourcePath}\0`));
      const issues = runRepositoryCheck(wasmFixture).issues;
      expect(issues).toEqual([{ code: 'wasm-private-path', message: 'WASM contains a workstation home path; rebuild with source-path remapping', file: 'compiler.wasm' }]);
      expect(JSON.stringify(issues)).not.toContain('private-person');
    }
    writeFileSync(join(wasmFixture, 'compiler.wasm'), Buffer.from('\0asm\xff/cargo/registry/src\0/tmt/rust/terrain-core/src\0/home/build/source\0'));
    expect(runRepositoryCheck(wasmFixture).issues).toEqual([]);
  });
});
