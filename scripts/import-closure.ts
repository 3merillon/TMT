/**
 * Import-closure report: which source files the application and diagnostic pages reach, which are
 * unreachable, and which tests or scripts still depend on unreachable files. Check every deletion against it.
 *
 *   npx tsx scripts/import-closure.ts [--json] [--entry <page.html|module.ts>]... [--scope src] [--why <file>]
 *
 *   --entry   app entries (repeatable). An .html file contributes its <script type="module" src> modules.
 *             Default: index.html (the game) and the three diagnostic pages under dev/.
 *   --scope   comma-separated folders whose files are classified as reachable or unreachable (default src).
 *   --why     print the import chain from an entry (app, test or script) to a file.
 *   --json    machine-readable report.
 *
 * Edges followed (TypeScript preProcessFile, plus an AST pass for workers): static imports and re-exports, import type, dynamic
 * import(), require(), literal `import.meta.glob()` patterns, `new URL('./x.ts', import.meta.url)` workers, and `?raw`/`?url`
 * imports (the query is dropped; .wgsl/.json/.css targets are leaves). Literal glob patterns support `*` and `**`.
 * Specifiers resolve like Vite: relative, root-absolute ('/src/...'), extension
 * probing (.ts, .tsx, .mts, .js, .mjs, index.ts) and .js → .ts. Bare packages are recorded as external.
 * Tests (tests/**\/*.test.ts, src/**\/*.test.ts) and all parsed scripts, including nested files, are secondary entries:
 * files only they reach are "kept by tests/scripts", files nothing reaches are "orphans". Literal globs are expanded
 * against the source host; computed glob arguments and negative patterns are outside this report's static model.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface SourceHost { exists(file: string): boolean; read(file: string): string; list(dir: string): string[] }
export interface ClosureOptions { appEntries: string[]; testEntries?: string[]; scriptEntries?: string[]; scope: string[] }
export interface ClosureReport {
  appEntries: string[];
  reachable: string[];
  unreachable: string[];
  keptByTestsOrScripts: string[];
  orphans: string[];
  importers: Record<string, string[]>;
  missing: { from: string; specifier: string }[];
  external: string[];
  counts: Record<string, number>;
}

const PARSED = /\.(?:[cm]?[jt]sx?)$/;
const CLASSIFIED = /\.(?:[cm]?[jt]sx?|wgsl|glsl|css|json)$/;
const PROBES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];
const MODULE_SCRIPT = /<script\b[^>]*>/gi;
export const DEFAULT_APP_ENTRIES = ['index.html', 'dev/structural-check.html', 'dev/engine-sandbox.html', 'dev/kit.html'] as const;

export function fsHost(root: string): SourceHost {
  const abs = (file: string) => resolve(root, file);
  return {
    exists: file => { try { return statSync(abs(file)).isFile(); } catch { return false; } },
    read: file => readFileSync(abs(file), 'utf8'),
    list: dir => {
      const out: string[] = [];
      const walk = (folder: string) => {
        if (!existsSync(abs(folder))) return;
        for (const entry of readdirSync(abs(folder), { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          const path = folder ? `${folder}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path); else out.push(path);
        }
      };
      walk(dir);
      return out.sort();
    },
  };
}

/** Module entries of an HTML page: its <script type="module" src> targets. */
export function htmlModuleEntries(html: string, page: string): string[] {
  const entries: string[] = [];
  for (const [tag] of html.matchAll(MODULE_SCRIPT)) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src && !/^https?:/.test(src)) entries.push(src.startsWith('/') ? src.slice(1) : posix.join(posix.dirname(page), src));
  }
  return entries;
}

/** Import specifiers of a JS/TS module. */
export function specifiersOf(source: string): string[] {
  const found = ts.preProcessFile(source, true, true).importedFiles.map(ref => ref.fileName);
  if (source.includes('import.meta.url')) {
    // Parse only files that mention import.meta.url, so comments and strings never produce worker edges.
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length === 2) {
        const [first, second] = node.arguments;
        if ((ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && second.getText() === 'import.meta.url') {
          // Directory roots such as new URL('../', import.meta.url) and new URL('.', import.meta.url) are URL bases,
          // not file dependencies. Keep file-looking paths (including extensionless assets) for normal resolution.
          const ref = first.text;
          const pathParts = ref.replace(/\/+$/, '').split('/');
          const directoryBase = !ref || pathParts.every(part => part === '.' || part === '..');
          if (!directoryBase && !ref.endsWith('/')) found.push(ref);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true));
  }
  return found;
}

/** Literal Vite glob patterns; dynamic or computed glob arguments are intentionally outside the static report. */
export function globPatternsOf(source: string): string[] {
  const patterns: string[] = [];
  const ast = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText() === 'import.meta' && node.expression.name.text === 'glob') {
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) patterns.push(first.text);
      else if (first && ts.isArrayLiteralExpression(first)) {
        for (const value of first.elements) if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) patterns.push(value.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return patterns;
}

function expandGlob(host: SourceHost, from: string, pattern: string): string[] {
  const joined = pattern.startsWith('/') ? posix.normalize(pattern.slice(1)) : posix.normalize(posix.join(posix.dirname(from), pattern));
  const firstWildcard = joined.search(/[?*]/);
  if (firstWildcard < 0) return host.exists(joined) ? [joined] : [];
  const prefix = joined.slice(0, firstWildcard);
  const slash = prefix.lastIndexOf('/');
  const folder = slash < 0 ? '' : prefix.slice(0, slash);
  let expression = '^';
  for (let i = 0; i < joined.length; i++) {
    const char = joined[i];
    if (char === '*') {
      if (joined[i + 1] === '*' && joined[i + 2] === '/') { expression += '(?:.*/)?'; i += 2; }
      else if (joined[i + 1] === '*') { expression += '.*'; i++; }
      else expression += '[^/]*';
    } else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  const matcher = new RegExp(`${expression}$`);
  return host.list(folder).filter(file => matcher.test(file));
}

export type Resolution = { file: string } | { external: string } | { missing: true };
export function resolveSpecifier(host: SourceHost, from: string, specifier: string): Resolution {
  const bare = specifier.split('?')[0].split('#')[0];
  let base: string;
  if (bare.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), bare));
  else if (bare.startsWith('/')) base = posix.normalize(bare.slice(1));
  else return { external: bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0] };
  for (const probe of PROBES) if (host.exists(base + probe)) return { file: base + probe };
  if (/\.[cm]?js$/.test(base)) { const swapped = base.replace(/\.([cm]?)js$/, '.$1ts'); if (host.exists(swapped)) return { file: swapped }; }
  return { missing: true };
}

interface Graph { edges: Map<string, string[]>; missing: { from: string; specifier: string }[]; external: Map<string, Set<string>> }
function buildGraph(host: SourceHost, entries: string[]): Graph {
  const graph: Graph = { edges: new Map(), missing: [], external: new Map() };
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (graph.edges.has(file)) continue;
    const targets: string[] = [];
    graph.edges.set(file, targets);
    if (!PARSED.test(file) || !host.exists(file)) continue;
    for (const specifier of specifiersOf(host.read(file))) {
      const resolved = resolveSpecifier(host, file, specifier);
      if ('file' in resolved) { targets.push(resolved.file); if (!graph.edges.has(resolved.file)) queue.push(resolved.file); }
      else if ('external' in resolved) { const users = graph.external.get(resolved.external) ?? new Set(); users.add(file); graph.external.set(resolved.external, users); }
      else graph.missing.push({ from: file, specifier });
    }
    for (const pattern of globPatternsOf(host.read(file))) {
      if (pattern.startsWith('!')) continue; // Vite exclusion patterns narrow positive matches; this report is conservative.
      const matches = expandGlob(host, file, pattern);
      if (matches.length) { targets.push(...matches); for (const match of matches) if (!graph.edges.has(match)) queue.push(match); }
      else graph.missing.push({ from: file, specifier: pattern });
    }
  }
  return graph;
}
function closureOf(graph: Graph, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) { const file = stack.pop()!; if (seen.has(file)) continue; seen.add(file); stack.push(...graph.edges.get(file) ?? []); }
  return seen;
}

export function expandEntries(host: SourceHost, entries: string[]): string[] {
  return entries.flatMap(entry => entry.endsWith('.html') ? htmlModuleEntries(host.read(entry), entry) : [entry]);
}
export function defaultSecondaryEntries(host: SourceHost): { tests: string[]; scripts: string[] } {
  return {
    tests: [...host.list('tests'), ...host.list('src')].filter(file => /\.test\.[cm]?[jt]sx?$/.test(file)),
    scripts: host.list('scripts').filter(file => PARSED.test(file)),
  };
}

export function importClosure(host: SourceHost, options: ClosureOptions): ClosureReport {
  const appEntries = expandEntries(host, options.appEntries);
  const secondary = [...options.testEntries ?? [], ...options.scriptEntries ?? []];
  const graph = buildGraph(host, [...appEntries, ...secondary]);
  const reachable = closureOf(graph, appEntries);
  const inScope = [...new Set(options.scope.flatMap(dir => host.list(dir)))].filter(file => CLASSIFIED.test(file) && !file.endsWith('.d.ts')).sort();
  const unreachable = inScope.filter(file => !reachable.has(file));
  const unreachableSet = new Set(unreachable);
  const kept = closureOf(graph, secondary);
  const importers: Record<string, string[]> = {};
  for (const entry of secondary) {
    const direct = (graph.edges.get(entry) ?? []).filter(file => unreachableSet.has(file));
    if (direct.length) importers[entry] = [...new Set(direct)].sort();
  }
  const external = [...graph.external].filter(([, users]) => [...users].some(user => reachable.has(user))).map(([name]) => name).sort();
  const report: ClosureReport = {
    appEntries,
    reachable: [...reachable].filter(file => host.exists(file)).sort(),
    unreachable,
    keptByTestsOrScripts: unreachable.filter(file => kept.has(file)),
    orphans: unreachable.filter(file => !kept.has(file) && !secondary.includes(file)),
    importers,
    missing: graph.missing.filter(m => reachable.has(m.from) || kept.has(m.from)),
    external,
    counts: {},
  };
  report.counts = { appEntries: appEntries.length, reachable: report.reachable.length, unreachable: unreachable.length, keptByTestsOrScripts: report.keptByTestsOrScripts.length,
    orphans: report.orphans.length, testOrScriptImporters: Object.keys(importers).length, missing: report.missing.length, secondaryEntries: secondary.length };
  return report;
}

/** Shortest import chain from any entry to the target. */
export function whyReachable(host: SourceHost, entries: string[], target: string): string[] | undefined {
  const graph = buildGraph(host, entries);
  const parent = new Map<string, string | null>(entries.map(entry => [entry, null]));
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (file === target) { const chain = [file]; let at = parent.get(file); while (at) { chain.unshift(at); at = parent.get(at); } return chain; }
    for (const next of graph.edges.get(file) ?? []) if (!parent.has(next)) { parent.set(next, file); queue.push(next); }
  }
  return undefined;
}

function groupByFolder(files: string[], depth = 2): string {
  const groups = new Map<string, number>();
  for (const file of files) { const key = file.split('/').slice(0, Math.min(depth, file.split('/').length - 1)).join('/') || '.'; groups.set(key, (groups.get(key) ?? 0) + 1); }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([folder, count]) => `  ${folder}/ (${count})`).join('\n');
}

function main(argv: string[]): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entries: string[] = [];
  let json = false, scope = ['src'], why: string | undefined, rootDir = root;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const take = () => { const value = argv[++i]; if (value === undefined) throw new Error(`missing value for ${token}`); return value; };
    if (token === '--json') json = true;
    else if (token === '--entry') entries.push(take());
    else if (token === '--scope') scope = take().split(',').map(s => s.trim()).filter(Boolean);
    else if (token === '--why') why = take();
    else if (token === '--root') rootDir = resolve(take());
    else if (token === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
    else throw new Error(`unexpected argument ${token}`);
  }
  const host = fsHost(rootDir);
  const normalize = (file: string) => relative(rootDir, resolve(rootDir, file)).split(sep).join('/');
  const appEntries = (entries.length ? entries : [...DEFAULT_APP_ENTRIES]).map(normalize);
  const { tests, scripts } = defaultSecondaryEntries(host);
  if (why) {
    const target = normalize(why);
    const chain = whyReachable(host, [...expandEntries(host, appEntries), ...tests, ...scripts], target);
    console.log(chain ? chain.join('\n  -> ') : `${target} is not reachable from the app entries, tests or scripts`);
    return;
  }
  const report = importClosure(host, { appEntries, testEntries: tests, scriptEntries: scripts, scope });
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  const lines = [
    `app entries: ${report.appEntries.join(', ')}`,
    `reachable from the app: ${report.reachable.length} files (external: ${report.external.join(', ') || 'none'})`,
    `unreachable in ${scope.join(', ')}: ${report.unreachable.length} files`, groupByFolder(report.unreachable),
    `  of which ${report.keptByTestsOrScripts.length} are still reached by tests or scripts and ${report.orphans.length} by nothing (orphans)`,
    `tests/scripts importing unreachable files directly: ${Object.keys(report.importers).length}`,
    ...Object.entries(report.importers).map(([entry, files]) => `  ${entry} -> ${files.length > 3 ? `${files.slice(0, 3).join(', ')} (+${files.length - 3})` : files.join(', ')}`),
    report.missing.length ? `unresolved relative imports: ${report.missing.length}\n${report.missing.map(m => `  ${m.from}: ${m.specifier}`).join('\n')}` : 'unresolved relative imports: 0',
  ];
  console.log(lines.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`[import-closure] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
