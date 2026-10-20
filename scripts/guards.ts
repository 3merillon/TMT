/**
 * Repository import, determinism, source-layout, and line-ending guards. `npm run verify:guard` runs it.
 *
 *   npx tsx scripts/guards.ts [--stream <ID> --ownership <file.json>] [--base <ref>] [--json]
 *
 * Rules (errors fail with exit 1; warnings print only):
 *   N1         three and all subpath imports under src/ outside src/lab/** and test files                    (N1_MODE)
 *   N4         Date.now, new Date(, performance.now and Math.random in sim files (comments and strings ignored)  (N4_MODE)
 *   layering   src/engine never imports src/game; src/world never imports src/engine or src/game and never touches
 *              DOM globals; sim files never import src/engine or src/audio
 *   crlf       CRLF committed in *.wgsl (the index holds CRLF or mixed endings), or a new untracked *.wgsl saved with CRLF
 *   crlf-worktree  (warning) the index is LF but the working-tree copy is CRLF or mixed: a stale checkout from before
 *              .gitattributes. A merge never rewrites untouched files, so the integration checkout keeps them; the fix is
 *              lossless and printed with the report:  rm <files> && git checkout -- <files>
 *   tests      test files only under tests/ or as src/**\/*.test.ts
 *   ownership  (with --stream) every file changed since the merge-base with the wave's base ref (committed, staged,
 *              unstaged and untracked) must be owned by the stream in the supplied ownership file, granted to it, or an
 *              append-only registry; append-only files may only gain lines (a removed line must reappear, e.g. with a
 *              trailing comma), and added lines should carry the stream tag; node_modules must never show up
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type GuardMode = 'warn' | 'error';
/** Three.js is development-only: diagnostic lab modules and test oracles may import it. */
export const N1_MODE: GuardMode = 'error';
/** Simulation code must use explicit ticks and seeded randomness. */
export const N4_MODE: GuardMode = 'error';

export type Rule = 'N1' | 'N4' | 'layering' | 'crlf' | 'crlf-worktree' | 'tests' | 'ownership' | 'append-only' | 'node_modules';
export interface Finding { rule: Rule; level: GuardMode; file: string; line?: number; message: string }

export const SIM_GLOBS = [
  'src/game/simulation.ts', 'src/game/realtime/**', 'src/game/campaign/**', 'src/game/rules/**', 'src/game/ai/**', 'src/game/vehicle/**', 'src/game/kit/**',
  'src/game/resident-*.ts', 'src/game/structural-*.ts', 'src/game/munitions.ts', 'src/world/**',
];
export const SIM_EXCLUDE = ['src/game/kit/mesh-builder.ts', '**/*.test.ts'];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const N1_SPECIFIER = /^three(?:\/|$)/;
const N4_PATTERNS: [RegExp, string][] = [[/\bDate\.now\s*\(/g, 'Date.now'], [/\bnew\s+Date\s*\(/g, 'new Date('], [/\bperformance\.now\s*\(/g, 'performance.now'], [/\bMath\.random\s*\(/g, 'Math.random']];
const DOM_GLOBALS = /(?<![.\w$])(?:window|document|navigator|localStorage|sessionStorage|requestAnimationFrame|cancelAnimationFrame|HTMLElement|HTMLCanvasElement|customElements)\b(?!\s*:)/g;

// ---- globs ------------------------------------------------------------------------------------------------------------
const globCache = new Map<string, RegExp>();
/** ** crosses directories, * and ? stay inside a segment, {a,b} alternates (nesting allowed). */
export function globToRegExp(glob: string): RegExp {
  let cached = globCache.get(glob);
  if (cached) return cached;
  let source = '', depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (c === '?') source += '[^/]';
    else if (c === '{') { depth++; source += '(?:'; }
    else if (c === '}' && depth) { depth--; source += ')'; }
    else if (c === ',' && depth) source += '|';
    else source += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  cached = new RegExp(`^${source}$`);
  globCache.set(glob, cached);
  return cached;
}
export const matchesAny = (file: string, globs: readonly string[] | undefined) => !!globs?.some(glob => globToRegExp(glob).test(file));
export const isSimFile = (file: string) => matchesAny(file, SIM_GLOBS) && !matchesAny(file, SIM_EXCLUDE) && SOURCE.test(file);

// ---- source helpers ---------------------------------------------------------------------------------------------------
/** Blank out comments and string/template contents (newlines kept, so offsets and lines stay valid). */
export function stripCommentsAndStrings(source: string): string {
  let out = '', i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (c === '/' && next === '/') { const end = source.indexOf('\n', i); const stop = end < 0 ? source.length : end; out += blank(source.slice(i, stop)); i = stop; }
    else if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); const stop = end < 0 ? source.length : end + 2; out += blank(source.slice(i, stop)); i = stop; }
    else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) { if (source[j] === '\\') j++; else if (c !== '`' && source[j] === '\n') break; j++; }
      out += c + blank(source.slice(i + 1, j)) + (source[j] === c ? c : '');
      i = j + (source[j] === c ? 1 : 0);
    } else { out += c; i++; }
  }
  return out;
}
const lineAt = (text: string, index: number) => { let line = 1; for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++; return line; };

export interface ImportRef { specifier: string; line: number }
export function importsOf(source: string): ImportRef[] {
  const info = ts.preProcessFile(source, true, true);
  return info.importedFiles.map(ref => ({ specifier: ref.fileName, line: lineAt(source, ref.pos) }));
}
/** Repo-relative target of a relative specifier ('./x', '../y'); undefined for bare packages. */
export function resolveRelative(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return specifier.startsWith('/') ? specifier.slice(1).split('?')[0] : undefined;
  return posix.normalize(posix.join(posix.dirname(file), specifier.split('?')[0]));
}

// ---- ownership --------------------------------------------------------------------------------------------------------
export interface StreamOwnership { title?: string; owns?: string[]; deletes?: string[]; shared?: string[] }
export interface Ownership {
  integrationBranch?: string;
  appendOnly?: string[];
  waves: Record<string, { base?: string; streams: Record<string, StreamOwnership>; tests?: Record<string, string[] | string> }>;
  grants?: { stream: string; paths: string[]; why?: string }[];
}
export interface ChangedFile { file: string; status: 'A' | 'M' | 'D' }
export interface Diff { added: string[]; removed: string[] }
export function waveOf(stream: string): string {
  const match = /^W(\d+)-/.exec(stream);
  if (!match) throw new Error(`stream id ${stream} does not look like W<wave>-<NAME>`);
  return match[1];
}
function streamGlobs(ownership: Ownership, stream: string): { owns: string[]; deletes: string[] } {
  const wave = ownership.waves[waveOf(stream)];
  const entry = wave?.streams[stream];
  if (!entry) throw new Error(`stream ${stream} is not in the supplied ownership file (wave ${waveOf(stream)})`);
  const tests = wave.tests?.[stream];
  const owns = [...entry.owns ?? [], ...entry.shared ?? [], ...(Array.isArray(tests) ? tests : []),
    ...(ownership.grants ?? []).filter(grant => grant.stream === stream).flatMap(grant => grant.paths)];
  return { owns, deletes: entry.deletes ?? [] };
}
const normalizeLine = (line: string) => line.trim().replace(/,\s*$/, '');
export function checkOwnership(stream: string, ownership: Ownership, changed: ChangedFile[], diff: (file: string) => Diff): Finding[] {
  const findings: Finding[] = [];
  const { owns, deletes } = streamGlobs(ownership, stream);
  const wave = ownership.waves[waveOf(stream)];
  const ownerOf = (file: string) => Object.entries(wave.streams).filter(([id, s]) => id !== stream && matchesAny(file, s.owns)).map(([id]) => id);
  for (const { file, status } of changed) {
    if (file === 'node_modules' || file.startsWith('node_modules/')) {
      findings.push({ rule: 'node_modules', level: 'error', file, message: 'node_modules shows up in git; it must stay an ignored junction (never stage it)' });
      continue;
    }
    if (matchesAny(file, owns) || (status === 'D' && matchesAny(file, deletes))) continue;
    if (matchesAny(file, ownership.appendOnly)) {
      if (status === 'D') { findings.push({ rule: 'append-only', level: 'error', file, message: 'append-only registry deleted' }); continue; }
      if (status === 'A') continue;
      const { added, removed } = diff(file);
      const readded = new Set(added.map(normalizeLine));
      const lost = removed.filter(line => normalizeLine(line) && !readded.has(normalizeLine(line)));
      if (lost.length) findings.push({ rule: 'append-only', level: 'error', file, message: `append-only registry: ${lost.length} existing line(s) changed or removed, e.g. ${JSON.stringify(lost[0].trim().slice(0, 100))}` });
      const removedSet = new Set(removed.map(normalizeLine));
      const untagged = added.filter(line => normalizeLine(line) && !removedSet.has(normalizeLine(line)) && !line.includes(stream));
      if (untagged.length) findings.push({ rule: 'append-only', level: 'warn', file, message: `${untagged.length} added line(s) without the ${stream} tag, e.g. ${JSON.stringify(untagged[0].trim().slice(0, 100))}` });
      continue;
    }
    const owners = ownerOf(file);
    findings.push({ rule: 'ownership', level: 'error', file, message: `${status === 'D' ? 'deleted' : status === 'A' ? 'added' : 'modified'} outside ${stream}'s ownership${owners.length ? ` (owned by ${owners.join(', ')})` : ''}; request it in your report or file a CC note` });
  }
  return findings;
}

// ---- content rules ------------------------------------------------------------------------------------------------------
export interface GuardInput {
  files: readonly string[];
  read(file: string): string;
  /** Line endings git stores in the index for a file (`git ls-files --eol` i/ column): 'lf', 'crlf', 'mixed', 'none', or
   *  '' when untracked. Without it every CRLF WGSL file counts as committed CRLF (an error). */
  indexEol?(file: string): string | undefined;
  n1Mode?: GuardMode; n4Mode?: GuardMode;
}
/** Lossless repair for working-tree copies whose index content is already LF (git re-checks them out with eol=lf). */
export const recheckoutCommand = (files: readonly string[]) => {
  const quoted = files.map(file => (/^[\w./-]+$/.test(file) ? file : `"${file}"`)).join(' ');
  return `rm ${quoted} && git checkout -- ${quoted}`;
};
export function checkSources(input: GuardInput): Finding[] {
  const findings: Finding[] = [];
  const n1 = input.n1Mode ?? N1_MODE, n4 = input.n4Mode ?? N4_MODE;
  for (const file of input.files) {
    if (TEST_FILE.test(file) && !file.startsWith('tests/') && !(file.startsWith('src/') && /\.test\.[cm]?[jt]sx?$/.test(file)))
      findings.push({ rule: 'tests', level: 'error', file, message: 'test files live in tests/ or next to their module as src/**/*.test.ts' });
    if (file.endsWith('.wgsl')) {
      const text = input.read(file);
      const index = text.indexOf('\r\n');
      if (index < 0) continue;
      const line = lineAt(text, index), stored = input.indexEol?.(file);
      if (stored === 'lf' || stored === 'none')
        findings.push({ rule: 'crlf-worktree', level: 'warn', file, line, message: `working-tree copy has CRLF but the index is LF (a checkout from before .gitattributes); lossless fix: ${recheckoutCommand([file])}` });
      else findings.push({ rule: 'crlf', level: 'error', file, line, message: stored === ''
        ? 'new WGSL file saved with CRLF line endings; save it with LF (string patching and naga expect LF; see .gitattributes)'
        : `WGSL committed with ${stored ?? 'CRLF'} line endings (string patching and naga expect LF); fix with git add --renormalize ${file} and commit` });
      continue;
    }
    if (!file.startsWith('src/') || !SOURCE.test(file)) continue;
    const inLab = file.startsWith('src/lab/');
    const engine = file.startsWith('src/engine/'), world = file.startsWith('src/world/'), sim = isSimFile(file);
    if (inLab && !sim) continue;
    const text = input.read(file);
    const imports = importsOf(text);
    for (const ref of imports) {
      if (!inLab && !TEST_FILE.test(file) && N1_SPECIFIER.test(ref.specifier))
        findings.push({ rule: 'N1', level: n1, file, line: ref.line, message: `imports ${ref.specifier} (N1: Three.js is development-only; source imports are restricted to src/lab/** and test files)` });
      const target = resolveRelative(file, ref.specifier);
      if (!target) continue;
      if (engine && target.startsWith('src/game/')) findings.push({ rule: 'layering', level: 'error', file, line: ref.line, message: `src/engine imports ${target} (the engine never imports src/game)` });
      if (world && (target.startsWith('src/engine/') || target.startsWith('src/game/'))) findings.push({ rule: 'layering', level: 'error', file, line: ref.line, message: `src/world imports ${target} (world is pure: no engine, no game)` });
      if (sim && !world && (target.startsWith('src/engine/') || target.startsWith('src/audio/'))) findings.push({ rule: 'layering', level: 'error', file, line: ref.line, message: `sim file imports ${target} (sim code never imports the engine or audio)` });
    }
    if (!sim && !world) continue;
    const code = stripCommentsAndStrings(text);
    if (sim) for (const [pattern, name] of N4_PATTERNS) for (const match of code.matchAll(pattern))
      findings.push({ rule: 'N4', level: n4, file, line: lineAt(code, match.index ?? 0), message: `${name} in sim code (N4: use the tick clock and seeded RNG streams)` });
    if (world) for (const match of code.matchAll(DOM_GLOBALS))
      findings.push({ rule: 'layering', level: 'error', file, line: lineAt(code, match.index ?? 0), message: `src/world touches the DOM global ${match[0]} (world is Node-testable and DOM-free)` });
  }
  return findings;
}

// ---- git plumbing -------------------------------------------------------------------------------------------------------
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function git(args: string[], cwd = root): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function listFiles(cwd = root): string[] {
  return [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd).split('\0').filter(Boolean))]
    .filter(file => existsSync(resolve(cwd, file)));
}
/** Index line endings of every tracked or untracked-but-not-ignored *.wgsl file ('' when untracked). */
export function wgslIndexEol(cwd = root): Map<string, string> {
  const eol = new Map<string, string>();
  for (const entry of git(['ls-files', '-z', '--eol', '--cached', '--others', '--exclude-standard', '--', '*.wgsl'], cwd).split('\0')) {
    const match = /^i\/(\S*)\s+w\/\S*\s+attr\/.*?\t(.+)$/s.exec(entry);
    if (match) eol.set(match[2], match[1]);
  }
  return eol;
}
export function changedFiles(base: string, cwd = root): { mergeBase: string; changed: ChangedFile[] } {
  const mergeBase = git(['merge-base', 'HEAD', base], cwd).trim();
  const changed = new Map<string, ChangedFile>();
  const entries = git(['diff', '--name-status', '-z', '--no-renames', mergeBase], cwd).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const [code, file] = [entries[i], entries[i + 1]];
    changed.set(file, { file, status: code.startsWith('A') ? 'A' : code.startsWith('D') ? 'D' : 'M' });
  }
  for (const file of git(['ls-files', '-z', '--others', '--exclude-standard'], cwd).split('\0').filter(Boolean)) changed.set(file, { file, status: 'A' });
  // A junction or a mistakenly staged node_modules shows up here even though .gitignore covers it.
  for (const line of git(['status', '--porcelain', '--ignored=no', '--', 'node_modules'], cwd).split('\n').filter(Boolean)) {
    const file = line.slice(3).replace(/\/$/, '');
    changed.set(file, { file, status: 'A' });
  }
  return { mergeBase, changed: [...changed.values()].sort((a, b) => a.file.localeCompare(b.file)) };
}
export function diffLines(mergeBase: string, file: string, cwd = root): Diff {
  const added: string[] = [], removed: string[] = [];
  let inHunk = false;
  for (const line of git(['diff', '--no-color', '-U0', mergeBase, '--', file], cwd).split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue; // diff, index, --- and +++ headers
    if (line.startsWith('+')) added.push(line.slice(1)); else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

export function formatFindings(findings: Finding[]): string {
  if (!findings.length) return 'guards: clean';
  const order: Rule[] = ['ownership', 'append-only', 'node_modules', 'layering', 'crlf', 'crlf-worktree', 'tests', 'N1', 'N4'];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.rule) - order.indexOf(b.rule) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const lines = sorted.map(f => `${f.level === 'error' ? 'ERROR' : 'warn '} ${f.rule.padEnd(13)} ${f.file}${f.line ? `:${f.line}` : ''}  ${f.message}`);
  const errors = findings.filter(f => f.level === 'error').length;
  const stale = sorted.filter(f => f.rule === 'crlf-worktree').map(f => f.file);
  const repair = stale.length ? `\n\nstale CRLF working copies (the index is LF, so this is lossless):\n  ${recheckoutCommand(stale)}` : '';
  return `${lines.join('\n')}${repair}\n\nguards: ${errors} error(s), ${findings.length - errors} warning(s)`;
}

function main(argv: string[]): void {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (key === 'json') { flags.set(key, 'true'); continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    flags.set(key, value);
  }
  const started = Date.now();
  const files = listFiles();
  const eol = wgslIndexEol();
  const findings = checkSources({ files, read: file => readFileSync(resolve(root, file), 'utf8'), indexEol: file => eol.get(file) });
  const stream = flags.get('stream');
  let ownershipInfo: Record<string, unknown> | undefined;
  if (stream) {
    const ownershipFile = flags.get('ownership');
    if (!ownershipFile) throw new Error('--stream requires --ownership <file.json>; the historical built-in wave map has been retired.');
    const ownership = JSON.parse(readFileSync(resolve(root, ownershipFile), 'utf8')) as Ownership;
    const wave = ownership.waves[waveOf(stream)];
    const base = flags.get('base') ?? wave?.base ?? ownership.integrationBranch ?? 'HEAD';
    let result: ReturnType<typeof changedFiles>;
    try { result = changedFiles(base); }
    catch (error) { throw new Error(`cannot find the merge-base with ${base} (${error instanceof Error ? error.message.split('\n')[0] : error}); pass --base <ref>`); }
    findings.push(...checkOwnership(stream, ownership, result.changed, file => diffLines(result.mergeBase, file)));
    ownershipInfo = { stream, base, mergeBase: result.mergeBase, changed: result.changed.length };
  }
  const errors = findings.filter(f => f.level === 'error').length;
  if (flags.has('json')) console.log(JSON.stringify({ ms: Date.now() - started, files: files.length, ownership: ownershipInfo, errors, findings }, null, 2));
  else {
    if (ownershipInfo) console.log(`ownership: ${ownershipInfo.stream} vs ${ownershipInfo.base} (merge-base ${String(ownershipInfo.mergeBase).slice(0, 10)}), ${ownershipInfo.changed} changed file(s)`);
    console.log(`${formatFindings(findings)} [${files.length} files, ${Date.now() - started} ms]`);
  }
  process.exitCode = errors ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`[guards] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
