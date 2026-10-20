/**
 * Evaluate a capture run against a budget: numeric telemetry bounds plus image probes on the PNGs,
 * pairing screenshot verdicts with measured checks.
 *
 *   npx tsx scripts/check-capture.ts <capture.json> <budget.json> [--tolerance 0.15] [--json] [--strict]
 *   npx tsx scripts/check-capture.ts --plan scripts/capture-plans/smoke.json [--out <dir>] [--capture <file>] [--budget <file>]
 *
 * <capture.json> is the run document scripts/capture.ts writes as <out>/<run>.capture.json. With --plan, the budget
 * comes from the plan's "budget" field and the capture document is <out>/<plan>.capture.json, looked up in --out, the
 * plan's "out", then the newest artifacts/screens/**\/<plan>.capture.json.
 *
 * Budget file: an array of entries, or { "tolerance"?: 0.15, "checks": [ ... ] }. One entry per line (append-only,
 * tag each with "stream"). Every entry has an optional "id" and "note" and exactly one source:
 *   { "path": "shots.impact.telemetry.performance.p95", "max": 10 }
 *       Dotted path into the capture document. Array segments match an element's "label"/"name" or a numeric index
 *       (so an eval@stats: step is jobs.<job>.evals.stats.result);
 *       "shots.<key>" also accepts a bare shot label when it is unique. Arrays compared with a number use their length.
 *   { "image": { "shot": "baseline-drive-ready", "rect": [0, 0, 1, 0.15], "metric": "lumaMean" }, "min": 0.12, "gate": true }
 *       Metric of scripts/image-metrics.ts over the shot's PNG ("hue.green", "nanBlocks.total", "bandRatio", ...).
 *       metric "lumaRatio" divides lumaMean(rect) by lumaMean(ref): { "rect": [...], "ref": [...] }.
 *       metric "ssim" needs "golden": "<png path>".
 * Bounds: "max", "min" (numbers, with tolerance: max·(1+t), min·(1−t)), "equals" (exact). "gate": true means zero
 * tolerance. "optional": true turns a missing value into SKIP instead of FAIL. "expect": "fail" marks a known failure:
 * it prints XFAIL and does not fail the run; if it starts passing it prints XPASS (a failure only with --strict).
 * "severity": "warn" is for load-sensitive metrics: an exceeded bound prints WARN and does not fail the run (a probe
 * that cannot be measured still FAILs). "severity": "warn-unless-perf" warns the same way, except in a perf run
 * (capture.ts --perf --repeat 3 --min or more repeats: GPU lock held, best of n), where an exceeded bound FAILs.
 *
 * Output: a table (or --json results); exit 1 when any check FAILs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageMetricsFromFile, metricValue } from './image-metrics';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ImageProbe { shot: string; metric: string; rect?: string | number[]; ref?: string | number[]; golden?: string }
export interface BudgetEntry {
  id?: string; note?: string; stream?: string;
  path?: string; image?: ImageProbe;
  max?: number; min?: number; equals?: unknown;
  gate?: boolean; optional?: boolean; expect?: 'fail'; severity?: 'warn' | 'warn-unless-perf';
}
export interface BudgetFile { tolerance?: number; checks: BudgetEntry[]; plan?: string; description?: string }
export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'XFAIL' | 'XPASS' | 'SKIP';
export interface CheckResult { id: string; status: CheckStatus; value: unknown; bound: string; /** null for exact (equals-only) checks */ tolerance: number | null; note?: string; error?: string }

export function loadBudget(file: string): BudgetFile {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as BudgetEntry[] | BudgetFile;
  const budget = Array.isArray(parsed) ? { checks: parsed } : parsed;
  if (!Array.isArray(budget.checks)) throw new Error(`${file}: expected an array of checks or { "checks": [...] }`);
  return budget;
}

/** Resolve a dotted path; array segments match "label"/"name" or an index, shots.<label> falls back to a unique label. */
export function resolvePath(document: unknown, path: string): unknown {
  const segments = path.split('.');
  let value: unknown = document;
  for (let i = 0; i < segments.length; i++) {
    const key = segments[i];
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = /^\d+$/.test(key) ? Number(key) : value.findIndex(item => item && typeof item === 'object' && ((item as { label?: string }).label === key || (item as { name?: string }).name === key));
      value = index >= 0 ? value[index] : undefined;
      continue;
    }
    if (typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (key in record) { value = record[key]; continue; }
    if (i > 0 && segments[i - 1] === 'shots') {
      const matches = Object.values(record).filter(shot => shot && typeof shot === 'object' && (shot as { label?: string }).label === key);
      if (matches.length === 1) { value = matches[0]; continue; }
    }
    // Tolerate "telemetry" on documents that only carry the raw "probe" value.
    if (key === 'telemetry' && 'probe' in record) { value = record.probe; continue; }
    return undefined;
  }
  return value;
}

function shotFile(document: unknown, shot: string, base: string): string {
  const record = resolvePath(document, `shots.${shot}`) as { file?: string } | undefined;
  if (!record?.file) throw new Error(`no shot "${shot}" in the capture document`);
  return isAbsolute(record.file) ? record.file : resolve(base, record.file);
}

export function measureImage(document: unknown, probe: ImageProbe, base = root): number | null | undefined {
  const file = shotFile(document, probe.shot, base);
  if (probe.metric === 'lumaRatio') {
    if (!probe.ref) throw new Error('lumaRatio needs "ref" (the comparison rect)');
    const inner = imageMetricsFromFile(file, { rect: probe.rect }).lumaMean, outer = imageMetricsFromFile(file, { rect: probe.ref }).lumaMean;
    return outer > 0 ? inner / outer : null;
  }
  if (probe.metric === 'ssim' && !probe.golden) throw new Error('ssim needs "golden"');
  const golden = probe.golden ? (isAbsolute(probe.golden) ? probe.golden : resolve(base, probe.golden)) : undefined;
  return metricValue(imageMetricsFromFile(file, { rect: probe.rect, golden }), probe.metric);
}

function describeBound(entry: BudgetEntry, tolerance: number): string {
  const parts: string[] = [];
  const fmt = (n: number) => Number.isInteger(n) ? String(n) : String(+n.toPrecision(4));
  if (entry.min !== undefined) parts.push(`>= ${fmt(entry.min)}${tolerance ? ` (${fmt(entry.min * (1 - tolerance))})` : ''}`);
  if (entry.max !== undefined) parts.push(`<= ${fmt(entry.max)}${tolerance ? ` (${fmt(entry.max * (1 + tolerance))})` : ''}`);
  if (entry.equals !== undefined) parts.push(`== ${JSON.stringify(entry.equals)}`);
  return parts.join(' and ');
}

/** A run whose load-sensitive numbers are trustworthy: GPU lock held and best of at least 3 repeats. */
export function isPerfRun(document: unknown): boolean {
  const meta = document as { perfLock?: unknown; repeat?: unknown; min?: unknown } | null;
  return !!meta && meta.perfLock === true && meta.min === true && typeof meta.repeat === 'number' && meta.repeat >= 3;
}

export function evaluateBudget(document: unknown, budget: BudgetFile, options: { tolerance?: number; base?: string } = {}): CheckResult[] {
  const defaultTolerance = options.tolerance ?? budget.tolerance ?? 0.15;
  const perfRun = isPerfRun(document);
  return budget.checks.map((entry, index): CheckResult => {
    const id = entry.id ?? entry.path ?? (entry.image ? `${entry.image.shot}:${entry.image.metric}` : `check-${index + 1}`);
    const tolerance = entry.gate ? 0 : defaultTolerance;
    const bound = describeBound(entry, tolerance);
    const numeric = entry.min !== undefined || entry.max !== undefined;
    const result: CheckResult = { id, status: 'FAIL', value: undefined, bound, tolerance: numeric ? tolerance : null, note: entry.note };
    if (!bound) { result.error = 'no bound (min, max or equals)'; return result; }
    if (!!entry.path === !!entry.image) { result.error = 'needs exactly one of "path" or "image"'; return result; }
    let value: unknown;
    try { value = entry.path ? resolvePath(document, entry.path) : measureImage(document, entry.image!, options.base ?? root); }
    catch (error) { result.error = error instanceof Error ? error.message : String(error); }
    if (Array.isArray(value) && (entry.min !== undefined || entry.max !== undefined)) value = value.length;
    result.value = value;
    // A probe that cannot be measured is broken, never an expected failure. (null is a value for "equals".)
    if (value === undefined || (value === null && entry.equals === undefined) || (typeof value === 'number' && !Number.isFinite(value))) {
      if (entry.optional && !result.error) { result.status = 'SKIP'; return result; }
      result.error ??= value === null ? 'value is null' : 'value missing';
      return result;
    }
    let pass = true;
    if (entry.equals !== undefined) pass &&= JSON.stringify(value) === JSON.stringify(entry.equals);
    if (entry.min !== undefined || entry.max !== undefined) {
      if (typeof value !== 'number') { result.error = `not a number: ${JSON.stringify(value)}`; return result; }
      if (entry.min !== undefined) pass &&= value >= entry.min * (entry.min >= 0 ? 1 - tolerance : 1 + tolerance);
      if (entry.max !== undefined) pass &&= value <= entry.max * (entry.max >= 0 ? 1 + tolerance : 1 - tolerance);
    }
    const warnOnly = entry.severity === 'warn' || (entry.severity === 'warn-unless-perf' && !perfRun);
    result.status = entry.expect === 'fail' ? (pass ? 'XPASS' : 'XFAIL') : pass ? 'PASS' : warnOnly ? 'WARN' : 'FAIL';
    return result;
  });
}

export function failed(results: CheckResult[], strict = false): boolean {
  return results.some(r => r.status === 'FAIL' || (strict && r.status === 'XPASS'));
}

export function formatTable(results: CheckResult[]): string {
  if (!results.length) return '(the budget has no checks)';
  const show = (value: unknown) => typeof value === 'number' ? String(+value.toPrecision(5)) : value === undefined ? '—' : JSON.stringify(value);
  const rows = results.map(r => [r.status === 'XFAIL' ? 'FAIL (expected)' : r.status === 'XPASS' ? 'XPASS (expected fail now passes)' : r.status, r.id, show(r.value), r.bound,
    r.tolerance === null ? '—' : r.tolerance ? `${Math.round(r.tolerance * 100)}%` : 'gate', [r.error, r.note].filter(Boolean).join(' — ')]);
  const header = ['status', 'check', 'value', 'bound', 'tol', 'note'];
  const widths = header.map((h, i) => Math.min(i === 5 ? 90 : 60, Math.max(h.length, ...rows.map(row => row[i].length))));
  const line = (cells: string[]) => cells.map((cell, i) => (cell.length > widths[i] ? `${cell.slice(0, widths[i] - 1)}…` : cell).padEnd(widths[i])).join('  ').trimEnd();
  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  return [line(header), line(widths.map(w => '-'.repeat(w))), ...rows.map(line), '',
    Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(', ')].join('\n');
}

interface PlanFile { jobs?: unknown[]; budget?: string; out?: string; name?: string }
export function readPlan(file: string): PlanFile & { name: string } {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as PlanFile | unknown[];
  const plan: PlanFile = Array.isArray(parsed) ? { jobs: parsed } : parsed;
  return { ...plan, name: plan.name ?? file.replace(/\\/g, '/').split('/').pop()!.replace(/\.json$/, '') };
}

function newestCapture(name: string): string | undefined {
  const dir = join(root, 'artifacts', 'screens');
  let best: { file: string; mtime: number } | undefined;
  const walk = (folder: string, depth: number) => {
    if (depth > 3 || !existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.name === `${name}.capture.json`) { const mtime = statSync(file).mtimeMs; if (!best || mtime > best.mtime) best = { file, mtime }; }
    }
  };
  walk(dir, 0);
  return best?.file;
}

function main(argv: string[]): void {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return; }
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const [key, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (key === 'json' || key === 'strict') { flags.set(key, 'true'); continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    flags.set(key, value);
  }
  let captureFile: string | undefined = flags.get('capture') ?? positional[0];
  let budgetFile: string | undefined = flags.get('budget') ?? positional[1];
  const planSpec = flags.get('plan');
  if (planSpec) {
    const planFile = existsSync(resolve(planSpec)) ? resolve(planSpec) : join(root, 'scripts', 'capture-plans', planSpec.endsWith('.json') ? planSpec : `${planSpec}.json`);
    const plan = readPlan(planFile);
    budgetFile ??= plan.budget;
    if (!captureFile) {
      const candidates = [flags.get('out'), plan.out].filter((dir): dir is string => !!dir).map(dir => resolve(root, dir, `${plan.name}.capture.json`));
      captureFile = candidates.find(existsSync) ?? newestCapture(plan.name);
      if (!captureFile) throw new Error(`no ${plan.name}.capture.json found (looked in ${candidates.join(', ') || '—'} and artifacts/screens/**); run npx tsx scripts/capture.ts --plan ${planSpec} first`);
    }
  }
  if (!captureFile || !budgetFile) throw new Error('usage: check-capture.ts <capture.json> <budget.json> [--tolerance 0.15] | --plan <plan.json>');
  const document = JSON.parse(readFileSync(resolve(captureFile), 'utf8'));
  const budget = loadBudget(resolve(root, budgetFile));
  const tolerance = flags.has('tolerance') ? Number(flags.get('tolerance')) : undefined;
  if (tolerance !== undefined && !(tolerance >= 0)) throw new Error('--tolerance must be a non-negative number');
  const results = evaluateBudget(document, budget, { tolerance });
  if (flags.has('json')) console.log(JSON.stringify({ capture: captureFile, budget: budgetFile, results }, null, 2));
  else console.log(`capture ${captureFile}\nbudget  ${budgetFile}\n\n${formatTable(results)}`);
  process.exitCode = failed(results, flags.has('strict')) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`[check-capture] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
