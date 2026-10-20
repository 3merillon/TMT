import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireGpuLock, bestOf, breakStaleLock, frameStats, mergeRepeats, numericLeaves, stats, type JobResult } from '../scripts/capture';
import { evaluateBudget, failed, formatTable, isPerfRun, resolvePath, type BudgetEntry } from '../scripts/check-capture';
import { encodePng } from '../scripts/image-metrics';

const dir = mkdtempSync(join(tmpdir(), 'tmt-check-capture-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A 40x40 frame: dark top band (sky), a darker patch under the "tank" and bright ground elsewhere.
const png = join(dir, 'run-drive-ready.png');
{
  const width = 40, height = 40, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sky = y < 6, shadow = y >= 30 && y < 34 && x >= 10 && x < 20;
    const v = sky ? 12 : shadow ? 60 : 200;
    data.set([v, v, v, 255], (y * width + x) * 4);
  }
  writeFileSync(png, encodePng({ width, height, data }));
}
const document = {
  kind: 'tmt-capture',
  jobs: { 'run-drive': { ok: true, consoleErrors: 0, timings: { readyMs: 7000 }, evals: [{ step: 'eval:1', result: 3 }], shots: ['ready'] } },
  shots: {
    'run-drive-ready': { job: 'run-drive', label: 'ready', file: png, telemetry: { performance: { p95: 9.5, fps: 118, draws: 240 }, list: [1, 2, 3] } },
    'run-closeup-rear': { job: 'run-closeup', label: 'rear', file: png, probe: { game: { mode: 'drive' } } },
  },
};
const check = (entry: BudgetEntry, tolerance?: number) => evaluateBudget(document, { checks: [entry] }, { tolerance })[0];

describe('capture document paths', () => {
  it('resolves shots by key or unique label, arrays by index, and the raw probe', () => {
    expect(resolvePath(document, 'shots.run-drive-ready.telemetry.performance.p95')).toBe(9.5);
    expect(resolvePath(document, 'shots.ready.telemetry.performance.fps')).toBe(118);
    expect(resolvePath(document, 'jobs.run-drive.evals.0.result')).toBe(3);
    expect(resolvePath(document, 'shots.rear.telemetry.game.mode')).toBe('drive');
    expect(resolvePath(document, 'shots.nope.telemetry')).toBeUndefined();
  });
});

describe('budget evaluation', () => {
  it('applies the tolerance to min and max, and none to gates', () => {
    expect(check({ path: 'shots.ready.telemetry.performance.p95', max: 8.4 }).status).toBe('PASS');       // 9.5 <= 9.66
    expect(check({ path: 'shots.ready.telemetry.performance.p95', max: 8.4 }, 0.1).status).toBe('FAIL');  // 9.5 > 9.24
    expect(check({ path: 'shots.ready.telemetry.performance.p95', max: 8.4, gate: true }).status).toBe('FAIL');
    expect(check({ path: 'shots.ready.telemetry.performance.fps', min: 120 }).status).toBe('PASS');
    expect(check({ path: 'shots.ready.telemetry.performance.fps', min: 120, gate: true }).status).toBe('FAIL');
    expect(check({ path: 'jobs.run-drive.ok', equals: true }).status).toBe('PASS');
    expect(check({ path: 'shots.ready.telemetry.list', max: 3, gate: true })).toMatchObject({ status: 'PASS', value: 3 });
    expect(check({ path: 'shots.ready.telemetry.list', max: 2, gate: true }).status).toBe('FAIL');
  });

  it('treats missing values as failures unless optional, even for expected failures', () => {
    expect(check({ path: 'shots.ready.telemetry.performance.gpu.total', max: 4 })).toMatchObject({ status: 'FAIL', error: 'value missing' });
    expect(check({ path: 'shots.ready.telemetry.performance.gpu.total', max: 4, optional: true }).status).toBe('SKIP');
    expect(check({ path: 'shots.ready.telemetry.performance.gpu.total', max: 4, expect: 'fail' }).status).toBe('FAIL');
    expect(check({ path: 'shots.ready.telemetry.performance.p95' }).error).toMatch(/no bound/);
  });

  it('reports load-sensitive checks as WARN without failing the run', () => {
    const warn = check({ path: 'shots.ready.telemetry.performance.p95', max: 8.4, gate: true, severity: 'warn' });
    expect(warn.status).toBe('WARN');
    expect(failed([warn])).toBe(false);
    expect(check({ path: 'shots.ready.telemetry.performance.p95', max: 10, severity: 'warn' }).status).toBe('PASS');
    expect(check({ path: 'shots.ready.telemetry.nope', max: 10, severity: 'warn' }).status).toBe('FAIL');
  });

  it('warns on warn-unless-perf bounds except in a --perf --repeat 3 --min run', () => {
    const entry: BudgetEntry = { path: 'jobs.run-drive.timings.readyMs', max: 6000, severity: 'warn-unless-perf' };
    expect(check(entry).status).toBe('WARN');
    expect(check({ ...entry, max: 7000 }).status).toBe('PASS');
    const perf = { ...document, perfLock: true, repeat: 3, min: true };
    expect(isPerfRun(perf)).toBe(true);
    expect(evaluateBudget(perf, { checks: [entry] })[0].status).toBe('FAIL');
    for (const weaker of [{ ...perf, perfLock: false }, { ...perf, repeat: 2 }, { ...perf, min: false }]) {
      expect(isPerfRun(weaker)).toBe(false);
      expect(evaluateBudget(weaker, { checks: [entry] })[0].status).toBe('WARN');
    }
  });

  it('marks known failures XFAIL and surprises XPASS', () => {
    const xfail = check({ path: 'shots.ready.telemetry.performance.draws', max: 100, gate: true, expect: 'fail' });
    const xpass = check({ path: 'shots.ready.telemetry.performance.draws', max: 300, expect: 'fail' });
    expect([xfail.status, xpass.status]).toEqual(['XFAIL', 'XPASS']);
    expect(failed([xfail, xpass])).toBe(false);
    expect(failed([xfail, xpass], true)).toBe(true);
    expect(formatTable([xfail])).toContain('FAIL (expected)');
  });

  it('measures image probes on the shot PNG', () => {
    const sky = check({ image: { shot: 'run-drive-ready', rect: [0, 0, 1, 0.15], metric: 'lumaMean' }, min: 0.12, gate: true });
    expect(sky.status).toBe('FAIL');
    expect(sky.value as number).toBeCloseTo(12 / 255, 6);
    const shadow = check({ image: { shot: 'ready', metric: 'lumaRatio', rect: [10, 30, 10, 4], ref: [25, 30, 10, 4] }, max: 0.65, gate: true });
    expect(shadow.status).toBe('PASS');
    expect(shadow.value as number).toBeCloseTo(60 / 200, 6);
    expect(check({ image: { shot: 'ready', metric: 'nanBlocks.total' }, max: 0, gate: true }).status).toBe('PASS');
    expect(check({ image: { shot: 'missing-shot', metric: 'lumaMean' }, min: 0 }).error).toMatch(/no shot/);
  });
});

describe('capture helpers', () => {
  it('computes frame statistics and flattens numeric telemetry', () => {
    expect(stats([5, 1, 4, 2, 3])).toEqual({ p50: 3, p95: 5, max: 5, mean: 3 });
    expect(numericLeaves({ fps: 120, gpu: { total: 1.5, passes: { lighting: 0.4 } }, name: 'x', list: [1] })).toEqual({ fps: 120, 'gpu.total': 1.5, 'gpu.passes.lighting': 0.4 });
    const frames = frameStats([8, 8, 9, 30], [{ fps: 120 }, { fps: 118 }, { fps: 110 }, { fps: 60 }])!;
    expect(frames.frameMs.max).toBe(30);
    expect(frames.metrics.fps.p50).toBe(110);
  });

  it('takes the best of repeated runs: minimum times, maximum fps', () => {
    const merged = bestOf([
      { readyMs: 7200, performance: { fps: 110, p95: 9 }, frames: { metrics: { fps: { p50: 100 } } }, label: 'a' },
      { readyMs: 6900, performance: { fps: 120, p95: 8.4 }, frames: { metrics: { fps: { p50: 119 } } }, label: 'b' },
      { readyMs: 7100, performance: { fps: 118, p95: 8.9 } },
    ]);
    expect(merged).toEqual({ readyMs: 6900, performance: { fps: 120, p95: 8.4 }, frames: { metrics: { fps: { p50: 119 } } }, label: 'a' });
  });

  it('serialises perf runs with a GPU lock that breaks stale or orphaned locks', async () => {
    const lock = join(dir, 'gpu.lock');
    const release = await acquireGpuLock(lock, 200, 60_000);
    expect(existsSync(lock)).toBe(true);
    await expect(acquireGpuLock(lock, 300, 60_000)).rejects.toThrow(/held by pid/);
    release();
    expect(existsSync(lock)).toBe(false);
    // A lock whose process is gone is broken immediately.
    writeFileSync(lock, JSON.stringify({ pid: 999999999, root: 'elsewhere' }));
    (await acquireGpuLock(lock, 200, 60_000))();
    // A lock older than the stale age is broken even if its process looks alive.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, root: 'self' }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    (await acquireGpuLock(lock, 200, 60_000))();
    expect(existsSync(lock)).toBe(false);
  }, 20000);

  it('never deletes a fresh lock that replaced the stale one it judged', () => {
    const lock = join(dir, 'race.lock');
    const stale = JSON.stringify({ pid: 999999999, root: 'dead', since: '2026-01-01T00:00:00.000Z' });
    const fresh = JSON.stringify({ pid: process.pid, root: 'winner', since: '2026-01-01T00:00:05.000Z' });
    // Waiters A and B both judged `stale`; A broke it and took a fresh lock before B acted.
    writeFileSync(lock, fresh);
    expect(breakStaleLock(lock, stale)).toBe('restored');
    expect(readFileSync(lock, 'utf8')).toBe(fresh);
    // The lock B judged is still there: B removes exactly it.
    writeFileSync(lock, stale);
    expect(breakStaleLock(lock, stale)).toBe('broken');
    expect(existsSync(lock)).toBe(false);
    expect(breakStaleLock(lock, stale)).toBe('gone');
    expect(readdirSync(dir).filter(name => name.endsWith('.stale'))).toEqual([]);
  });

  it('merges repeated runs, including eval@ results, as the best of n', () => {
    const run = (readyMs: number, frame: number, evalMs: number, fps: number): JobResult => ({
      name: 'drive', url: '/play.html', ok: true, size: '1280x720', wait: 'auto', timings: { readyMs },
      shots: [{ label: 'ready', file: `ready-${readyMs}.png`, tMs: 0, probe: { performance: { fps, p95: frame } } }],
      evals: [{ step: 'eval@stats:x', label: 'stats', result: { commitMs: evalMs, fps, name: `run-${readyMs}` } }, { step: 'eval:y', result: evalMs }],
      console: [], pageErrors: [], failedRequests: [], httpErrors: [], repeat: 1,
    });
    const merged = mergeRepeats([run(7200, 9, 300, 110), run(6900, 8.4, 250, 118), run(7100, 8.9, 280, 120)]);
    expect(merged.timings.readyMs).toBe(6900);
    expect(merged.shots[0]).toMatchObject({ file: 'ready-7100.png', probe: { performance: { fps: 120, p95: 8.4 } } });
    expect(merged.evals).toEqual([
      { step: 'eval@stats:x', label: 'stats', result: { commitMs: 250, fps: 120, name: 'run-7200' } }, { step: 'eval:y', result: 250 },
    ]);
    expect(merged.repeats).toEqual({ count: 3, mode: 'min' });
  });
});
