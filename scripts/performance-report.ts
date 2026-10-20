/**
 * Before/after tables from measured arms (no GPU workload).
 *   tsx scripts/performance-report.ts --before DIR[,DIR] --after DIR[,DIR] [--out report.md]
 *
 * An arm directory holds what docs/performance-pass.md's commands write: paced-static, paced-impacts and paced-fog
 * (scripts/capture-planetary-lighting.ts) and realtime (scripts/capture-performance.ts). Several directories per arm are
 * repeated runs of the same build, e.g. the two halves of an A/B/B/A order: fixed-step values are the median over the
 * runs' own medians, real-time values the median over every repeat of every run.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { distribution, summarizeRecording } from './performance-metrics';

type Stats = { mean: number; median: number; p95: number; p99: number; max: number } | null;
interface PacedScene { scene: string; valid: boolean; gpuMs: Stats; encodeCpuMs: Stats; trackedGpuBytes: Stats; passes: Record<string, NonNullable<Stats> & { missingOrSkipped: number }> }
const PACED = ['paced-static', 'paced-impacts', 'paced-fog'] as const;

const args = process.argv.slice(2), value = (key: string) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : undefined;
const before = value('before')?.split(',') ?? [], after = value('after')?.split(',') ?? [];
assert.ok(before.length && after.length, 'Pass --before DIR[,DIR] --after DIR[,DIR]');
const median = (values: (number | null | undefined)[]) => distribution(values.filter((v): v is number => typeof v === 'number'))?.p50 ?? NaN;
const worst = (values: (number | null | undefined)[]) => { const known = values.filter((v): v is number => typeof v === 'number'); return known.length ? Math.max(...known) : NaN; };
const fixed = (v: number, digits = 1) => Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
const change = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && a > 0 ? `${b <= a ? '−' : '+'}${Math.abs((1 - b / a) * 100).toFixed(0)} %` : '';
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => i ? '---:' : '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');

function paced(dirs: string[], kind: string): Map<string, PacedScene[]> {
  const scenes = new Map<string, PacedScene[]>();
  for (const dir of dirs) {
    const file = join(dir, kind, 'summary.json');
    if (!existsSync(file)) continue;
    for (const scene of JSON.parse(readFileSync(file, 'utf8')) as PacedScene[]) scenes.set(scene.scene, [...scenes.get(scene.scene) ?? [], scene]);
  }
  return scenes;
}
function realtime(dirs: string[]): Map<string, any[]> {
  const scenes = new Map<string, any[]>();
  for (const dir of dirs) {
    const folder = join(dir, 'realtime');
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter(n => /-r\d+\.json$/.test(n))) {
      const run = JSON.parse(readFileSync(join(folder, name), 'utf8'));
      // Reduced again from the raw recording, so both arms are read by this version of the metrics whatever recorded them.
      if (!run.failures.length) scenes.set(run.scene.name, [...scenes.get(run.scene.name) ?? [], summarizeRecording(run.recording)]);
    }
  }
  return scenes;
}

const out: string[] = [];
for (const kind of PACED) {
  const a = paced(before, kind), b = paced(after, kind), names = [...a.keys()].filter(name => b.has(name));
  if (!names.length) continue;
  out.push(`### GPU passes per frame, fixed step: ${kind.slice(6)} (ms)\n`);
  out.push(table(['Scene', 'Before median', 'After median', 'Change', 'Before p95 / max', 'After p95 / max', 'Tracked GPU MiB before → after'], names.map(name => {
    const x = a.get(name)!, y = b.get(name)!, m = (runs: PacedScene[], read: (s: NonNullable<Stats>) => number) => median(runs.map(run => run.gpuMs ? read(run.gpuMs) : null));
    return [name, fixed(m(x, s => s.median), 2), fixed(m(y, s => s.median), 2), change(m(x, s => s.median), m(y, s => s.median)),
      `${fixed(m(x, s => s.p95), 1)} / ${fixed(worst(x.map(run => run.gpuMs?.max)), 1)}`, `${fixed(m(y, s => s.p95), 1)} / ${fixed(worst(y.map(run => run.gpuMs?.max)), 1)}`,
      `${fixed(median(x.map(run => run.trackedGpuBytes?.median)) / 1048576, 0)} → ${fixed(median(y.map(run => run.trackedGpuBytes?.median)) / 1048576, 0)}`];
  })));
  // A pass skipped on most frames (an SDF rebuild, the 30 Hz gas step) is shown by the mean over the frames it ran on.
  const passMean = (runs: PacedScene[], pass: string) => median(runs.map(run => run.passes[pass]?.mean));
  const passes = [...new Set(names.flatMap(name => [...a.get(name)!, ...b.get(name)!].flatMap(run => Object.keys(run.passes))))]
    .filter(pass => names.some(name => Math.max(passMean(a.get(name)!, pass) || 0, passMean(b.get(name)!, pass) || 0) >= 0.15))
    .sort((p, q) => Math.max(...names.map(name => passMean(a.get(name)!, q) || 0)) - Math.max(...names.map(name => passMean(a.get(name)!, p) || 0)));
  out.push(`\nPasses of at least 0.15 ms in either arm, mean ms over the frames on which the pass ran (before → after):\n`);
  out.push(table(['Pass', ...names], passes.map(pass => [`\`${pass}\``, ...names.map(name => `${fixed(passMean(a.get(name)!, pass), 2)} → ${fixed(passMean(b.get(name)!, pass), 2)}`)])) + '\n');
}

const a = realtime(before), b = realtime(after), names = [...a.keys()].filter(name => b.has(name));
if (names.length) {
  const pick = (runs: any[], read: (s: any) => number | null | undefined) => median(runs.map(read));
  const both = (name: string, read: (s: any) => number | null | undefined, digits = 1) => `${fixed(pick(a.get(name)!, read), digits)} → ${fixed(pick(b.get(name)!, read), digits)}`;
  out.push(`### Real play (real rAF pacing, real input and shots; median over ${Math.min(...names.map(name => a.get(name)!.length))}–${Math.max(...names.map(name => a.get(name)!.length))} repeats before, ${Math.min(...names.map(name => b.get(name)!.length))}–${Math.max(...names.map(name => b.get(name)!.length))} after)\n`);
  out.push(table(['Scenario', 'FPS', 'Change', 'Frame interval p50 / p95 / p99 ms (before)', '(after)', 'Worst frame ms, median of runs', 'Worst frame ms, any run'], names.map(name => {
    const x = a.get(name)!, y = b.get(name)!, c = (runs: any[]) => `${fixed(pick(runs, s => s.cadence?.p50))} / ${fixed(pick(runs, s => s.cadence?.p95))} / ${fixed(pick(runs, s => s.cadence?.p99))}`;
    return [name, both(name, s => s.cadence?.fps), change(pick(y, s => s.cadence?.fps), pick(x, s => s.cadence?.fps)).replace('−', '+'), c(x), c(y), both(name, s => s.cadence?.max, 0),
      `${fixed(worst(x.map(s => s.cadence?.max)), 0)} → ${fixed(worst(y.map(s => s.cadence?.max)), 0)}`];
  })));
  out.push(`\nHitches per run (frame intervals over the limit), main-thread work per frame, long tasks and allocation (before → after):\n`);
  out.push(table(['Scenario', '> 33.4 ms', '> 50 ms', '> 100 ms', 'Time beyond 16.7 ms frames, ms', 'Main-thread work p95 / max ms', 'Long tasks: count, total ms', 'JS allocation MB/s', 'JS heap peak MB'], names.map(name => [name,
    both(name, s => s.cadence?.hitches['over33.4ms'], 0), both(name, s => s.cadence?.hitches.over50ms, 0), both(name, s => s.cadence?.hitches.over100ms, 0), both(name, s => s.cadence?.excessMs, 0),
    `${fixed(pick(a.get(name)!, s => s.mainThreadFrameWorkMs?.p95))} / ${fixed(pick(a.get(name)!, s => s.mainThreadFrameWorkMs?.max), 0)} → ${fixed(pick(b.get(name)!, s => s.mainThreadFrameWorkMs?.p95))} / ${fixed(pick(b.get(name)!, s => s.mainThreadFrameWorkMs?.max), 0)}`,
    `${fixed(pick(a.get(name)!, s => s.longTasks.count), 0)}, ${fixed(pick(a.get(name)!, s => s.longTasks.totalMs), 0)} → ${fixed(pick(b.get(name)!, s => s.longTasks.count), 0)}, ${fixed(pick(b.get(name)!, s => s.longTasks.totalMs), 0)}`,
    both(name, s => s.heap?.allocatedMBPerSecond, 0), both(name, s => s.heap?.peakMB, 0)])) + '\n');
  // Marked events: the first of a scenario is the first use, later ones are warmed repeats.
  const events = names.flatMap(name => {
    const marks = [...new Set(a.get(name)!.flatMap(s => s.segments.map((segment: any) => segment.name as string)))].filter(mark => /first-use|warmed|shot-|collapse-|edit-/.test(mark));
    return marks.map(mark => {
      const read = (runs: any[], get: (segment: any) => number | null | undefined) => median(runs.map(s => { const segment = s.segments.find((x: any) => x.name === mark); return segment ? get(segment) : null; }));
      return [`${name} · ${mark}`, `${fixed(read(a.get(name)!, s => s.cadence?.max), 0)} → ${fixed(read(b.get(name)!, s => s.cadence?.max), 0)}`,
        `${fixed(read(a.get(name)!, s => s.longTasks.maxMs), 0)} → ${fixed(read(b.get(name)!, s => s.longTasks.maxMs), 0)}`,
        `${fixed(read(a.get(name)!, s => s.cadence?.hitches['over33.4ms']), 0)} → ${fixed(read(b.get(name)!, s => s.cadence?.hitches['over33.4ms']), 0)}`,
        `${fixed(read(a.get(name)!, s => s.cadence?.fps))} → ${fixed(read(b.get(name)!, s => s.cadence?.fps))}`];
    });
  });
  if (events.length) {
    out.push(`First use against warmed repeats, per marked event until the next mark (before → after):\n`);
    out.push(table(['Event', 'Worst frame ms', 'Longest main-thread task ms', 'Frames > 33.4 ms', 'FPS in the window'], events) + '\n');
  }
  // A terrain edit must not arrive later than before: request to committed terrain, per edit in scenario order.
  const edits = names.flatMap(name => {
    const count = Math.min(...[...a.get(name)!, ...b.get(name)!].map(s => s.edits.length));
    return Array.from({ length: count }, (_, i) => [`${name} · ${a.get(name)![0].edits[i].name}`, `${fixed(pick(a.get(name)!, s => s.edits[i].latencyMs), 0)} → ${fixed(pick(b.get(name)!, s => s.edits[i].latencyMs), 0)}`]);
  });
  if (edits.length) {
    out.push(`Terrain edit latency, from the blast request to the committed terrain (ms, before → after):\n`);
    out.push(table(['Edit', 'Latency ms'], edits) + '\n');
  }
}
const text = out.join('\n');
if (value('out')) writeFileSync(value('out')!, text);
console.log(text);
