/**
 * Bundle budgets for `npm run verify:bundle`: chunk sizes and forbidden modules per entry.
 *
 *   npm run verify:bundle                    (vite build --outDir .verify-dist, then this script)
 *   npx tsx scripts/check-bundle.ts [--dist .verify-dist] [--budget budgets/bundle.json] [--tolerance 0.15] [--json]
 *
 * Reads <dist>/bundle-report.json, which the tmt-verify-bundle-report plugin in vite.config.ts emits for .verify-dist
 * builds (every chunk with its modules, static imports and dynamic imports), and measures the emitted files.
 *
 * Budget file (append-only, one entry per line; tighten after Gate 1):
 *   {
 *     "tolerance": 0.15,
 *     "anyJsMaxKb": 3200,                                             every emitted .js file (chunks and worker assets), raw KB
 *     "files": [ { "match": "assets/resident-terrain-*.js", "maxKb": 3000, "gzipMaxKb": 1150 } ],   glob on the emitted file name
 *     "entries": { "play": { "initialMaxKb": 1400, "initialGzipMaxKb": 420, "allMaxKb": 4200 } },
 *              initial = the entry chunk plus its static imports (what the page preloads); all = plus dynamic imports
 *     "forbidden": [ { "entry": "play", "scope": "initial" | "all", "module": "<glob on module ids>", "level": "error" | "warn", "why": "..." } ]
 *   }
 * Module ids are repo-relative ("src/lab/three-terrain-host.ts", "node_modules/three/build/three.webgpu.js"). Exit 1 on any error.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { globToRegExp } from './guards';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ReportChunk { fileName: string; name: string; isEntry: boolean; isDynamicEntry: boolean; facadeModuleId: string | null; imports: string[]; dynamicImports: string[]; modules: (string | null)[] }
export interface BundleReport { chunks: ReportChunk[]; assets: { fileName: string }[] }
export interface BundleBudget {
  tolerance?: number;
  anyJsMaxKb?: number;
  files?: { match: string; maxKb?: number; gzipMaxKb?: number; stream?: string }[];
  entries?: Record<string, { initialMaxKb?: number; initialGzipMaxKb?: number; allMaxKb?: number; stream?: string }>;
  forbidden?: { entry: string; scope?: 'initial' | 'all'; module: string; level?: 'error' | 'warn'; why?: string; stream?: string }[];
}
export interface BundleFinding { level: 'error' | 'warn'; check: string; message: string }
export interface EntryClosure { entry: string; chunk: string; initial: string[]; all: string[]; initialKb: number; initialGzipKb: number; allKb: number; initialModules: string[]; allModules: string[] }

export function entryChunk(report: BundleReport, entry: string): ReportChunk | undefined {
  const html = entry.endsWith('.html') ? entry : `${entry}.html`;
  return report.chunks.find(chunk => chunk.isEntry && (chunk.facadeModuleId === html || chunk.name === entry));
}
export function chunkClosure(report: BundleReport, start: ReportChunk, dynamic: boolean): ReportChunk[] {
  const byName = new Map(report.chunks.map(chunk => [chunk.fileName, chunk]));
  const seen = new Set<string>();
  const stack = [start.fileName];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const chunk = byName.get(file);
    if (chunk) stack.push(...chunk.imports, ...(dynamic ? chunk.dynamicImports : []));
  }
  return [...seen].map(file => byName.get(file)).filter((chunk): chunk is ReportChunk => !!chunk);
}

export function evaluateBundle(report: BundleReport, budget: BundleBudget, size: (file: string) => { raw: number; gzip: number }, tolerance = budget.tolerance ?? 0.15):
  { findings: BundleFinding[]; files: { file: string; kb: number; gzipKb: number }[]; entries: EntryClosure[] } {
  const findings: BundleFinding[] = [];
  const kb = (bytes: number) => Math.round(bytes / 102.4) / 10;
  const over = (value: number, max: number | undefined) => max !== undefined && value > max * (1 + tolerance);
  const jsFiles = [...report.chunks.map(chunk => chunk.fileName), ...report.assets.map(asset => asset.fileName).filter(file => file.endsWith('.js'))];
  const files = jsFiles.map(file => { const s = size(file); return { file, kb: kb(s.raw), gzipKb: kb(s.gzip) }; }).sort((a, b) => b.kb - a.kb);
  for (const file of files) if (over(file.kb, budget.anyJsMaxKb)) findings.push({ level: 'error', check: 'anyJsMaxKb', message: `${file.file} is ${file.kb} KB > ${budget.anyJsMaxKb} KB (+${tolerance * 100}%)` });
  for (const rule of budget.files ?? []) {
    const matches = files.filter(file => globToRegExp(rule.match).test(file.file));
    if (!matches.length) findings.push({ level: 'warn', check: 'files', message: `no emitted file matches ${rule.match}` });
    for (const file of matches) {
      if (over(file.kb, rule.maxKb)) findings.push({ level: 'error', check: 'files', message: `${file.file} is ${file.kb} KB > ${rule.maxKb} KB (+${tolerance * 100}%)` });
      if (over(file.gzipKb, rule.gzipMaxKb)) findings.push({ level: 'error', check: 'files', message: `${file.file} is ${file.gzipKb} KB gzip > ${rule.gzipMaxKb} KB (+${tolerance * 100}%)` });
    }
  }
  const entryNames = [...new Set([...Object.keys(budget.entries ?? {}), ...(budget.forbidden ?? []).map(rule => rule.entry)])];
  const entries: EntryClosure[] = [];
  for (const name of entryNames) {
    const chunk = entryChunk(report, name);
    if (!chunk) { findings.push({ level: 'error', check: 'entries', message: `no entry chunk for ${name} (is ${name}.html a build input?)` }); continue; }
    const initial = chunkClosure(report, chunk, false), all = chunkClosure(report, chunk, true);
    const sum = (chunks: ReportChunk[], key: 'raw' | 'gzip') => chunks.reduce((total, c) => total + size(c.fileName)[key], 0);
    const modules = (chunks: ReportChunk[]) => [...new Set(chunks.flatMap(c => c.modules.filter((m): m is string => !!m)))].sort();
    const closure: EntryClosure = { entry: name, chunk: chunk.fileName, initial: initial.map(c => c.fileName), all: all.map(c => c.fileName),
      initialKb: kb(sum(initial, 'raw')), initialGzipKb: kb(sum(initial, 'gzip')), allKb: kb(sum(all, 'raw')), initialModules: modules(initial), allModules: modules(all) };
    entries.push(closure);
    const limits = budget.entries?.[name];
    if (limits) {
      if (over(closure.initialKb, limits.initialMaxKb)) findings.push({ level: 'error', check: 'entries', message: `${name} initial JS ${closure.initialKb} KB > ${limits.initialMaxKb} KB (+${tolerance * 100}%)` });
      if (over(closure.initialGzipKb, limits.initialGzipMaxKb)) findings.push({ level: 'error', check: 'entries', message: `${name} initial JS ${closure.initialGzipKb} KB gzip > ${limits.initialGzipMaxKb} KB (+${tolerance * 100}%)` });
      if (over(closure.allKb, limits.allMaxKb)) findings.push({ level: 'error', check: 'entries', message: `${name} JS incl. lazy chunks ${closure.allKb} KB > ${limits.allMaxKb} KB (+${tolerance * 100}%)` });
    }
    for (const rule of (budget.forbidden ?? []).filter(r => r.entry === name)) {
      const pattern = globToRegExp(rule.module);
      const hits = (rule.scope === 'all' ? closure.allModules : closure.initialModules).filter(module => pattern.test(module));
      if (hits.length) findings.push({ level: rule.level ?? 'error', check: 'forbidden', message: `${name} (${rule.scope ?? 'initial'}) contains ${rule.module}: ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ` (+${hits.length - 4})` : ''}${rule.why ? ` — ${rule.why}` : ''}` });
    }
  }
  return { findings, files, entries };
}

function main(argv: string[]): void {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
    if (token === '--json') { flags.set('json', 'true'); continue; }
    if (!token.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${token}`);
    flags.set(token.slice(2), argv[++i]);
  }
  const dist = resolve(root, flags.get('dist') ?? '.verify-dist');
  const reportFile = join(dist, 'bundle-report.json');
  if (!existsSync(reportFile)) throw new Error(`${reportFile} is missing: run \`npm run verify:bundle\` (vite build --outDir .verify-dist) first`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as BundleReport;
  const budgetFile = resolve(root, flags.get('budget') ?? 'budgets/bundle.json');
  const budget = JSON.parse(readFileSync(budgetFile, 'utf8')) as BundleBudget;
  const tolerance = flags.has('tolerance') ? Number(flags.get('tolerance')) : undefined;
  const sizes = new Map<string, { raw: number; gzip: number }>();
  const size = (file: string) => {
    let s = sizes.get(file);
    if (!s) { const path = join(dist, file); s = { raw: statSync(path).size, gzip: gzipSync(readFileSync(path)).length }; sizes.set(file, s); }
    return s;
  };
  const result = evaluateBundle(report, budget, size, tolerance);
  const errors = result.findings.filter(f => f.level === 'error').length;
  if (flags.has('json')) console.log(JSON.stringify({ dist, budget: budgetFile, errors, ...result, entries: result.entries.map(({ allModules: _a, initialModules, ...rest }) => ({ ...rest, initialModules: initialModules.length })) }, null, 2));
  else {
    console.log('largest JS files (KB raw / gzip):');
    for (const file of result.files.slice(0, 10)) console.log(`  ${String(file.kb).padStart(8)} ${String(file.gzipKb).padStart(8)}  ${file.file}`);
    for (const entry of result.entries) console.log(`entry ${entry.entry}: initial ${entry.initialKb} KB (${entry.initialGzipKb} KB gzip) in ${entry.initial.length} chunks, ${entry.allKb} KB with lazy chunks; ${entry.initialModules.length} initial modules`);
    for (const finding of result.findings) console.log(`${finding.level === 'error' ? 'ERROR' : 'warn '} ${finding.check.padEnd(10)} ${finding.message}`);
    console.log(`check-bundle: ${errors} error(s), ${result.findings.length - errors} warning(s)`);
  }
  process.exitCode = errors ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`[check-bundle] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
