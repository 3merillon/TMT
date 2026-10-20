import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { syncPublic } from '../scripts/sync-public.ts';

describe('independent public snapshots', () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'tmt-public-test-'));
  afterAll(() => rmSync(fixtures, { recursive: true, force: true }));
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const repository = (name: string) => {
    const root = join(fixtures, name);
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Snapshot test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'config', 'core.filemode', 'false');
    return root;
  };
  const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', message); };

  it('exports only committed files, preserves public parents and ignored files, and synchronizes deletions', () => {
    const source = repository('source'), target = repository('target');
    writeFileSync(join(source, '.gitignore'), 'artifacts/\nnode_modules/\n');
    writeFileSync(join(source, 'obsolete.txt'), 'old');
    writeFileSync(join(source, 'game.txt'), 'first release');
    git(source, 'add', 'game.txt');
    git(source, 'update-index', '--chmod=+x', 'game.txt');
    commit(source, 'Private development');
    const privateCommit = git(source, 'rev-parse', 'HEAD');
    mkdirSync(join(source, 'artifacts'));
    writeFileSync(join(source, 'artifacts', 'private.txt'), 'never export');
    syncPublic(source, target);
    expect(git(target, 'write-tree')).toBe(git(source, 'rev-parse', 'HEAD^{tree}'));
    expect(existsSync(join(target, 'artifacts'))).toBe(false);
    commit(target, 'Initial public release');
    const publicCommit = git(target, 'rev-parse', 'HEAD');
    expect(git(target, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(target, 'ls-files', '--stage', 'game.txt')).toMatch(/^100755 /);
    expect(() => git(target, 'cat-file', '-e', privateCommit)).toThrow();
    mkdirSync(join(target, 'node_modules'));
    writeFileSync(join(target, 'node_modules', 'local.txt'), 'keep');
    rmSync(join(source, 'obsolete.txt'));
    writeFileSync(join(source, 'game.txt'), 'next release');
    writeFileSync(join(source, 'new.txt'), 'new');
    commit(source, 'Private iteration');
    syncPublic(source, target);
    expect(existsSync(join(target, 'obsolete.txt'))).toBe(false);
    expect(readFileSync(join(target, 'node_modules', 'local.txt'), 'utf8')).toBe('keep');
    expect(git(target, 'write-tree')).toBe(git(source, 'rev-parse', 'HEAD^{tree}'));
    commit(target, 'Public update');
    expect(git(target, 'rev-parse', 'HEAD^')).toBe(publicCommit);
    syncPublic(source, target);
    expect(git(target, 'status', '--porcelain')).toBe('');
  });

  it('refuses dirty checkouts, ignored-file collisions and overlapping repositories before changing files', () => {
    const source = repository('guard-source'), target = repository('guard-target');
    writeFileSync(join(source, '.gitignore'), 'local.txt\n');
    writeFileSync(join(source, 'game.txt'), 'source');
    commit(source, 'Source');
    writeFileSync(join(target, '.gitignore'), 'game.txt\n');
    commit(target, 'Target');
    writeFileSync(join(source, 'uncommitted.txt'), 'unfinished');
    expect(() => syncPublic(source, target)).toThrow('source checkout must be clean');
    rmSync(join(source, 'uncommitted.txt'));
    writeFileSync(join(target, 'uncommitted.txt'), 'unfinished');
    expect(() => syncPublic(source, target)).toThrow('target checkout must be clean');
    rmSync(join(target, 'uncommitted.txt'));
    writeFileSync(join(target, 'game.txt'), 'local ignored data');
    expect(() => syncPublic(source, target)).toThrow('overwrite an ignored target file');
    expect(readFileSync(join(target, 'game.txt'), 'utf8')).toBe('local ignored data');
    expect(() => syncPublic(source, source)).toThrow('separate, non-overlapping');
  });
});
