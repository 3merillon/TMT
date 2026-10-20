#!/usr/bin/env node
/** Release-tree, media-budget, and public-document checks. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);

function absolute(rootDir, repoPath) {
  return path.join(rootDir, ...repoPath.split('/'));
}

/** Git's index plus non-ignored untracked files, with already-deleted index entries removed. */
export function collectReleaseFiles(rootDir = root) {
  const output = execFileSync('git', ['-C', rootDir, 'ls-files', '-c', '-o', '--exclude-standard', '-z'], { encoding: 'buffer' });
  const names = new Set(output.toString('utf8').split('\0').filter(Boolean));
  // Vite copies all of public/, including ignored files, so include the actual deploy tree in media checks.
  const walkPublic = folder => {
    if (!existsSync(folder)) return;
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const fullPath = path.join(folder, item.name);
      if (item.isDirectory()) walkPublic(fullPath);
      else if (item.isFile()) names.add(path.relative(rootDir, fullPath).split(path.sep).join('/'));
    }
  };
  walkPublic(path.join(rootDir, 'public'));
  return [...names]
    .filter(repoPath => {
      try { return statSync(absolute(rootDir, repoPath)).isFile(); } catch { return false; }
    })
    .map(repoPath => ({ path: repoPath.replaceAll('\\', '/'), size: statSync(absolute(rootDir, repoPath)).size }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function normalizedDir(pathname) { return pathname.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''); }
function isWithin(file, dir) { const base = normalizedDir(dir); return file === base || file.startsWith(`${base}/`); }
function isPrivateArtifact(file) {
  const name = file.split('/').at(-1).toLowerCase();
  if (/^\.env(?:\..*)?$/.test(name) && name !== '.env.example' && name !== '.env.template') return true;
  if (/^\.dev\.vars(?:\..*)?$/.test(name) && name !== '.dev.vars.example' && name !== '.dev.vars.template') return true;
  return /(?:^|\/)(?:id_rsa|id_ed25519|credentials\.json|secrets\.json)$/.test(file.toLowerCase())
    || /\.(?:key|pem|p8|p12|pfx|keystore|jks)$/.test(name)
    || /(?:^|[._-])private(?:[._-]?key)?\.(?:json|txt|bin)$/.test(name);
}
function isTemporary(file) {
  const name = file.split('/').at(-1).toLowerCase();
  return /(?:\.tmp|\.temp|\.bak|\.orig|\.swp|\.swo|\.part|\.crdownload|\.log|~)$/.test(name)
    || name === '.ds_store' || name === 'thumbs.db';
}

/** Pure budget checks for a release file listing; returns safe, path-only diagnostics. */
export function auditReleaseFiles(files, budget) {
  const issues = [];
  const add = (code, message, file) => issues.push({ code, message, ...(file ? { file } : {}) });
  const videoAllowlist = new Set((budget.videoAllowlist ?? []).map(normalizedDir));

  for (const entry of files) {
    const file = entry.path.replaceAll('\\', '/');
    const lower = file.toLowerCase();
    for (const directory of budget.forbiddenDirectories ?? []) {
      const normalized = normalizedDir(directory).toLowerCase();
      if (normalized.includes('/') ? isWithin(lower, normalized) : lower.split('/').includes(normalized)) {
        add('generated-directory', 'generated output must not be part of the release tree', file);
        break;
      }
    }
    if (isPrivateArtifact(file)) add('private-artifact', 'private environment or key artifact detected', file);
    if (isTemporary(file)) add('temporary-file', 'temporary or machine-local file detected', file);
    if ((budget.videoExtensions ?? []).some(ext => lower.endsWith(ext.toLowerCase())) && !videoAllowlist.has(file)) {
      add('video-media', 'video media needs an explicit path in videoAllowlist', file);
    }
  }

  const totalUnder = directory => files.filter(file => isWithin(file.path.replaceAll('\\', '/'), directory)).reduce((sum, file) => sum + file.size, 0);
  const publicBytes = totalUnder('public');
  if (publicBytes > budget.publicMaxBytes) add('public-budget', `public release files use ${publicBytes} bytes; budget is ${budget.publicMaxBytes}`);
  const assetsBytes = totalUnder('assets');
  if (assetsBytes > budget.assetsMaxBytes) add('assets-budget', `asset sources use ${assetsBytes} bytes; budget is ${budget.assetsMaxBytes}`);
  const glbBytes = files.filter(file => isWithin(file.path.replaceAll('\\', '/'), 'assets') && file.path.toLowerCase().endsWith('.glb'))
    .reduce((sum, file) => sum + file.size, 0);
  if (glbBytes > budget.sourceGlbMaxBytes) add('source-glb-budget', `source GLBs use ${glbBytes} bytes; budget is ${budget.sourceGlbMaxBytes}`);

  const imageDir = budget.docsImages.directory;
  const images = files.filter(file => isWithin(file.path.replaceAll('\\', '/'), imageDir)
    && imageExtensions.has(path.posix.extname(file.path.toLowerCase())));
  const docsImageBytes = images.reduce((sum, file) => sum + file.size, 0);
  if (docsImageBytes > budget.docsImages.maxTotalBytes) add('docs-images-budget', `documentation images use ${docsImageBytes} bytes; budget is ${budget.docsImages.maxTotalBytes}`);
  for (const image of images) if (image.size > budget.docsImages.maxFileBytes) {
    add('docs-image-file-budget', `documentation image is ${image.size} bytes; per-file budget is ${budget.docsImages.maxFileBytes}`, image.path);
  }
  return { issues, totals: { files: files.length, publicBytes, assetsBytes, sourceGlbBytes: glbBytes, docsImageBytes } };
}

function internalTarget(sourceFile, target, rootDir) {
  const raw = target.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
  if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  const base = decoded.startsWith('/') ? rootDir : path.dirname(absolute(rootDir, sourceFile));
  return path.resolve(base, decoded.startsWith('/') ? `.${decoded}` : decoded);
}

function checkDocuments(rootDir, budget, packageJson, files) {
  const issues = [];
  const releasePaths = new Set(files.map(file => file.path));
  const releaseDirectories = new Set(files.length ? [''] : []);
  for (const file of releasePaths) {
    for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) {
      releaseDirectories.add(directory);
    }
  }
  const checked = new Set([...(budget.docFiles ?? []), ...files.filter(file => file.path.endsWith('.md')).map(file => file.path)]);
  for (const file of checked) if (!existsSync(absolute(rootDir, file))) {
    issues.push({ code: 'doc-file-missing', message: 'required current documentation file is missing', file });
  }
  const scripts = packageJson.scripts ?? {};
  const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g;
  const commandPattern = /\bnpm\s+run\s+([a-zA-Z0-9:_-]+)/g;
  for (const file of checked) {
    if (!file.endsWith('.md') || !existsSync(absolute(rootDir, file))) continue;
    const source = readFileSync(absolute(rootDir, file), 'utf8');
    for (const match of source.matchAll(linkPattern)) {
      const raw = match[1].trim();
      const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw.split(/\s+/, 1)[0];
      const resolved = internalTarget(file, target, rootDir);
      if (resolved) {
        if (!existsSync(resolved)) issues.push({ code: 'doc-link-missing', message: `internal link target does not exist: ${target}`, file });
        else {
          const relative = path.relative(rootDir, resolved).split(path.sep).join('/');
          if (!releasePaths.has(relative) && !releaseDirectories.has(relative)) {
            issues.push({ code: 'doc-link-not-released', message: `internal link target is not part of the release tree: ${target}`, file });
          }
        }
      }
    }
    for (const match of source.matchAll(commandPattern)) if (!Object.hasOwn(scripts, match[1])) {
      issues.push({ code: 'npm-script-missing', message: `npm script is not defined: ${match[1]}`, file });
    }
  }
  return issues;
}

export function runRepositoryCheck(rootDir = root) {
  const budget = JSON.parse(readFileSync(path.join(rootDir, 'budgets/repository.json'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const files = collectReleaseFiles(rootDir);
  const audited = auditReleaseFiles(files, budget);
  for (const file of files.filter(file => file.path.endsWith('.wasm'))) {
    const sourcePaths = readFileSync(absolute(rootDir, file.path)).toString('utf8');
    if (/(?:[a-z]:[\\/]Users[\\/]|\/Users\/|\/home\/(?!build\/))[^\s\0/\\]+[/\\]/i.test(sourcePaths)) {
      audited.issues.push({ code: 'wasm-private-path', message: 'WASM contains a workstation home path; rebuild with source-path remapping', file: file.path });
    }
  }
  audited.issues.push(...checkDocuments(rootDir, budget, packageJson, files));
  return audited;
}

function main() {
  const { issues, totals } = runRepositoryCheck();
  console.log(`Repository release inventory: ${totals.files} files; public ${(totals.publicBytes / 1e6).toFixed(2)} MB; assets ${(totals.assetsBytes / 1e6).toFixed(2)} MB; source GLBs ${(totals.sourceGlbBytes / 1e6).toFixed(2)} MB; docs images ${(totals.docsImageBytes / 1e6).toFixed(2)} MB`);
  if (issues.length) {
    for (const issue of issues) console.error(`[${issue.code}] ${issue.message}${issue.file ? ` (${issue.file})` : ''}`);
    process.exitCode = 1;
  } else console.log('Repository release checks passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
