/** Copy a committed release tree into an independent checkout; never copy Git history. */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRepositoryCheck } from './check-repo.mjs';

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function syncPublic(sourceDirectory: string, targetDirectory: string): { files: number; tree: string } {
  const source = realpathSync(sourceDirectory), target = realpathSync(targetDirectory);
  for (const [root, label] of [[source, 'source'], [target, 'target']]) {
    if (realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error(`${label} must be a repository root`);
    if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error(`${label} checkout must be clean`);
  }
  const relative = path.relative(source, target);
  if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    || source.startsWith(`${target}${path.sep}`)) throw new Error('Checkouts must be separate, non-overlapping directories');
  const common = (root: string) => realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (common(source) === common(target)) throw new Error('Public checkout must have its own Git repository, not a worktree');
  if (git(target, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Public checkout must be on main');

  const commit = git(source, ['rev-parse', 'HEAD']);
  const tree = git(source, ['rev-parse', `${commit}^{tree}`]);
  const entries = git(source, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean);
  const executable: string[] = [];
  const files = entries.map(entry => {
    const [header, name] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)];
    if (!/^100(?:644|755) blob /.test(header)) throw new Error('Release snapshots cannot contain symlinks or submodules');
    if (header.startsWith('100755 ')) executable.push(name);
    return name;
  });
  const tracked = new Set(git(target, ['ls-files', '-z']).split('\0').filter(Boolean));
  for (const name of files) {
    const parts = name.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const destination = path.join(target, ...parts.slice(0, count));
      if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('A release path would traverse a target symlink');
    }
    if (existsSync(path.join(target, name)) && !tracked.has(name)) throw new Error(`A release file would overwrite an ignored target file: ${name}`);
  }

  const temporaryRoot = realpathSync(tmpdir());
  const staging = mkdtempSync(path.join(temporaryRoot, 'tmt-public-'));
  try {
    const archive = path.join(staging, 'release.tar');
    git(source, ['archive', '--format=tar', `--output=${archive}`, commit]);
    git(target, ['rm', '-r', '-q', '--ignore-unmatch', '--', '.']);
    execFileSync('tar', ['-xf', archive, '-C', target]);
    git(target, ['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], `${files.join('\0')}\0`);
    if (executable.length) git(target, ['update-index', '--chmod=+x', '-z', '--stdin'], `${executable.join('\0')}\0`);
    if (git(target, ['write-tree']) !== tree) throw new Error('Exported tree differs from the source commit; inspect the staged files');
  } finally {
    if (path.dirname(realpathSync(staging)) !== temporaryRoot) throw new Error('Temporary export directory moved unexpectedly');
    rmSync(staging, { recursive: true, force: true });
  }
  return { files: files.length, tree };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = process.argv[2];
  if (!target || process.argv.length !== 3) throw new Error('Usage: npm run public:sync -- ../TMT-public');
  if (!/^https:\/\/github\.com\/3merillon\/TMT-private(?:\.git)?$/.test(git(source, ['remote', 'get-url', 'origin']))
    || !/^https:\/\/github\.com\/3merillon\/TMT(?:\.git)?$/.test(git(target, ['remote', 'get-url', 'origin']))) {
    throw new Error('Expected the private development source and the independent public TMT target');
  }
  const checked = runRepositoryCheck(source);
  if (checked.issues.length) throw new Error(`Release checks failed: ${checked.issues.map(issue => `${issue.code}: ${issue.file ?? issue.message}`).join('; ')}`);
  const result = syncPublic(source, target);
  console.log(`Staged ${result.files} files in the public checkout. Review its diff, then commit and push there. No commit or push was performed.`);
}
