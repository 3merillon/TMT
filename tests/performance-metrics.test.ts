import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cadence, distribution, frameIntervals, frameWindows, summarizeAllocations, summarizeRecording, summarizeTrace, type Recording, type TraceEvent } from '../scripts/performance-metrics';
import { reportPerformanceTarget } from './helpers/performance-target';

/** A recording at a steady 10 ms pace with one 120 ms frame of main-thread work at frame 5. */
function recording(): Recording {
  const frames = 12, zero = () => new Array<number>(frames).fill(0);
  const raf: number[] = [];
  for (let i = 0, time = 1000; i < frames; i++) { raf.push(time); time += i === 5 ? 120 : 10; }
  const work = zero().map((_, i) => i === 5 ? 118 : 3);
  return { frames, capacity: 100, begin: 1000, end: raf[frames - 1] + 10, apiStats: true,
    frame: { raf, start: raf.map(time => time + 1), work, rendered: raf.map((time, i) => time + 1 + work[i]), gpuDone: raf.map((time, i) => time + 1 + work[i] + 20), heap: raf.map((_, i) => (100 + i - (i > 8 ? 9 : 0)) * 1048576),
      apiMs: zero(), uploadBytes: zero().map(() => 2048), uploads: zero().map(() => 2), creates: zero().map((_, i) => i === 6 ? 4 : 0), bindGroups: zero(), views: zero() },
    marks: [{ name: 'shot-1', time: 1020, frame: 2 }, { name: 'blast:heavy:5:request', time: 1021, frame: 2 }, { name: 'blast:heavy:5:commit', time: 1171, frame: 6 },
      { name: 'shot-2', time: 1200, frame: 9 }, { name: 'blast:nuclear:4:request', time: 1201, frame: 9 }],
    longTasks: [{ start: 1051, duration: 118 }],
    longFrames: [{ start: 1050, duration: 120, blocking: 68, scripts: [{ duration: 118, invoker: 'FrameRequestCallback', fn: '', url: 'game.js' }] }],
    apiEvents: [{ kind: 'createComputePipelineAsync', label: 'fluids:gas', start: 1055, ms: 0.4, settledMs: 210 }, { kind: 'mapAsync', label: '', start: 1010, ms: 0.1, settledMs: 24 }] };
}

describe('performance metrics', () => {
  it('reads percentiles without interpolating', () => {
    expect(distribution([4, 1, 3, 2])).toMatchObject({ samples: 4, mean: 2.5, p50: 3, max: 4 });
    expect(distribution([NaN, Infinity])).toBeNull();
  });

  it('counts hitches against fixed limits and stutters against the run\'s own pace', () => {
    const steady = cadence(new Array(100).fill(33.3))!;
    expect(steady.hitches['over16.7ms']).toBe(100);
    expect(steady.stutters).toBe(0);
    expect(steady.fps).toBeCloseTo(30.03, 1);
    const fast = cadence([...new Array(99).fill(8.33), 40])!;
    expect(fast.stutters).toBe(1);
    expect(fast.hitches['over33.4ms']).toBe(1);
    expect(fast.excessMs).toBeCloseTo(23.3, 5);
  });

  it('charges a long frame to the gap that follows it and splits the run at marks', () => {
    const r = recording(), summary = summarizeRecording(r);
    expect(frameIntervals(r)[5]).toBe(120);
    expect(summary.cadence!.max).toBe(120);
    expect(summary.worstFrames[0]).toMatchObject({ frame: 5, work: 118, nextInterval: 120, creates: 4 });
    expect(frameWindows(r, summary.worstFrames.slice(0, 1))).toEqual([[r.frame.start[5], r.frame.start[5] + 118]]);
    // The probe's blast marks time the edit; they do not cut the window of the event that caused it.
    expect(summary.segments.map(segment => segment.name)).toEqual(['shot-1', 'shot-2']);
    expect(summary.edits).toEqual([{ name: 'blast:heavy:5', at: 21, committed: true, latencyMs: 150 }, { name: 'blast:nuclear:4', at: 201, committed: false, latencyMs: null }]);
    expect(summary.segments[0].cadence!.max).toBe(120);
    expect(summary.segments[0].longTasks).toEqual({ count: 1, totalMs: 118, maxMs: 118 });
    expect(summary.segments[1].cadence!.max).toBe(10);
    expect(summary.longAnimationFrames.scripts[0]).toMatchObject({ ms: 118, count: 1 });
    expect(summary.webgpu!.compiles.events[0]).toMatchObject({ label: 'fluids:gas', at: 55 });
    expect(summary.webgpu!.mapAsync.latencyMs!.max).toBe(24);
    expect(summary.heap).toMatchObject({ collections: 1, reclaimedMB: 8 });
    // The frame whose work was long also finishes late on the GPU: 115 ms of extra work on top of the 10 ms pace.
    expect(summary.gpuCompletionCadence!.max).toBe(125);
  });

  it('aligns a trace to the page clock and separates threads, collections and functions', () => {
    const us = (ms: number) => ms * 1000, pid = 7, main = 1, worker = 2;
    const events: TraceEvent[] = [
      { name: 'thread_name', ph: 'M', ts: 0, pid, tid: main, args: { name: 'CrRendererMain' } },
      { name: 'thread_name', ph: 'M', ts: 0, pid, tid: worker, args: { name: 'DedicatedWorker thread 3' } },
      { name: 'process_name', ph: 'M', ts: 0, pid, tid: main, args: { name: 'Renderer' } },
      // The page's clock reads 1000 where the trace clock reads 5000 ms.
      { name: 'tmt-perf-begin', cat: 'blink.user_timing', ph: 'R', ts: us(5000), pid, tid: main },
      { name: 'RunTask', ph: 'X', ts: us(5050), dur: us(120), pid, tid: main },
      { name: 'RunTask', ph: 'X', ts: us(4000), dur: us(900), pid, tid: main },
      { name: 'MinorGC', ph: 'X', ts: us(5060), dur: us(2), pid, tid: main },
      { name: 'RunTask', ph: 'X', ts: us(5070), dur: us(80), pid, tid: worker },
      { name: 'MajorGC', ph: 'X', ts: us(5071), dur: us(60), pid, tid: worker },
      { name: 'Profile', ph: 'P', ts: us(5000), pid, tid: main, id: '0x1', args: { data: { startTime: us(5050) } } },
      { name: 'ProfileChunk', ph: 'P', ts: us(5001), pid, tid: 9, id: '0x1', args: { data: { cpuProfile: { nodes: [
        { id: 1, callFrame: { functionName: '(root)' } }, { id: 2, parent: 1, callFrame: { functionName: 'syncScene', url: 'http://h/assets/game.js', lineNumber: 43 } },
        { id: 3, parent: 2, callFrame: { functionName: 'trimesh', url: 'http://h/assets/rapier.js', lineNumber: 9 } }], samples: [3, 3, 2], }, timeDeltas: [us(50), us(50), us(10)] } } },
    ];
    const summary = summarizeTrace(events, { name: 'tmt-perf-begin', now: 1000, endNow: 1300 }, [[1050, 1160]]);
    if ('error' in summary) throw new Error(summary.error);
    expect(summary.seconds).toBeCloseTo(0.3, 6);
    const [first, second] = summary.threads;
    expect(first).toMatchObject({ thread: 'CrRendererMain', main: true, taskMs: 120, over50ms: 1, gcMs: 2, gcCount: 1 });
    expect(second).toMatchObject({ thread: 'DedicatedWorker thread 3', main: false, taskMs: 80, gcMs: 60 });
    expect(summary.functions.main.self[0]).toMatchObject({ name: 'trimesh rapier.js:10', selfMs: 100 });
    expect(summary.functions.main.total[0]).toMatchObject({ totalMs: 110 });
    expect(summary.functions.main.total.find(fn => fn.name.startsWith('syncScene'))).toMatchObject({ selfMs: 10, totalMs: 110 });
    expect(summary.worstFrameFunctions!.main.sampledMs).toBe(110);
    expect(summarizeTrace(events, { name: 'missing', now: 0, endNow: 1 })).toHaveProperty('error');
  });

  it('ranks allocation sites', () => {
    const profile = { head: { callFrame: { functionName: '(root)' }, selfSize: 0, children: [
      { callFrame: { functionName: 'shardWaterSpan', url: 'http://h/game.js', lineNumber: 12 }, selfSize: 3 * 1048576, children: [] },
      { callFrame: { functionName: 'clip', url: 'http://h/game.js', lineNumber: 30 }, selfSize: 1048576, children: [] }] } };
    const summary = summarizeAllocations(profile, 2);
    expect(summary.sampledMBPerSecond).toBe(2);
    expect(summary.sites[0]).toEqual({ name: 'shardWaterSpan game.js:13', MB: 3, share: 75 });
  });
});

describe('performance target reporting', () => {
  let temporary: string | undefined;
  const metric = { name: 'fixture CPU', value: 31, target: 30, unit: 'ms', comparison: '<=' as const };
  beforeEach(() => {
    vi.stubEnv('npm_lifecycle_event', 'test');
    vi.stubEnv('GITHUB_STEP_SUMMARY', undefined);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (temporary) { rmSync(temporary, { recursive: true, force: true }); temporary = undefined; }
  });

  it('reports an exceeded target without failing the ordinary suite', () => {
    expect(() => reportPerformanceTarget(metric)).not.toThrow();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('ABOVE TARGET (advisory)'));
  });

  it('enforces the unchanged target in the explicit performance command', () => {
    vi.stubEnv('npm_lifecycle_event', 'verify:performance');
    expect(() => reportPerformanceTarget(metric)).toThrow('ABOVE TARGET (strict)');
    expect(() => reportPerformanceTarget({ ...metric, value: 29 })).not.toThrow();
  });

  it('preserves the distinction between strict and inclusive target boundaries', () => {
    vi.stubEnv('npm_lifecycle_event', 'verify:performance');
    expect(() => reportPerformanceTarget({ ...metric, value: 30 })).not.toThrow();
    expect(() => reportPerformanceTarget({ ...metric, value: 30, comparison: '<' })).toThrow();
    expect(() => reportPerformanceTarget({ ...metric, value: 29, comparison: '<' })).not.toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid measurements and targets even in advisory mode: %s', invalid => {
    expect(() => reportPerformanceTarget({ ...metric, value: invalid })).toThrow('measurement must be finite and nonnegative');
    expect(() => reportPerformanceTarget({ ...metric, target: invalid })).toThrow('target must be finite and nonnegative');
    expect(console.info).not.toHaveBeenCalled();
  });

  it('appends measured values, targets, status and mode to an isolated GitHub summary', () => {
    temporary = mkdtempSync(join(tmpdir(), 'tmt-performance-summary-'));
    const summary = join(temporary, 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
    reportPerformanceTarget(metric);
    vi.stubEnv('npm_lifecycle_event', 'verify:performance');
    reportPerformanceTarget({ ...metric, name: 'fixture ratio', value: 1.1, target: 1.15, unit: 'ratio', comparison: '<' });
    expect(readFileSync(summary, 'utf8')).toContain('| fixture CPU | 31 ms | &lt;= 30 ms | ABOVE TARGET | advisory |');
    expect(readFileSync(summary, 'utf8')).toContain('| fixture ratio | 1.1 ratio | &lt; 1.15 ratio | WITHIN TARGET | strict |');
    expect(() => reportPerformanceTarget(metric)).toThrow();
    expect(readFileSync(summary, 'utf8')).toContain('| ABOVE TARGET | strict |');
  });
});
