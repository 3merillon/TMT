// Ported from Pinionfall src/gpu/frame-capture.test.ts (MIT, same owner)
/** GPU samples belong to their submission frame; late callbacks never leak into the next capture; missing ≠ zero. */
import { describe, expect, it } from 'vitest';
import { FrameCapture, FrameCaptureController, sampleStats } from '../src/engine/gpu/frame-capture';

describe('frame capture', () => {
  it('attributes GPU samples to the submission frame and isolates captures', () => {
    const controller = new FrameCaptureController();
    const capture = controller.begin(4);
    const early = controller.scheduleGpu()!;
    controller.cpuFrame(new Map([['cpu.frame', 10]]), new Map([['draw', 3]]), new Map());
    const late = controller.scheduleGpu()!;
    controller.cpuFrame(new Map([['cpu.frame', 30]]), new Map(), new Map());
    controller.seal();
    // Readbacks completing together, in reverse order, keep BOTH submission frames and cannot enter a new capture.
    const next = controller.begin(2);
    late.capture.write('gpu/_frame-busy', late.frame, 20);
    early.capture.write('gpu/_frame-busy', early.frame, 5);
    const dump = capture.dump();
    expect(dump.series['gpu/_frame-busy']).toEqual([5, 20]);
    expect(dump.stats['gpu/_frame-busy']!.samples).toBe(2);
    expect(dump.series['count/draw'][1]).toBe(0);
    expect(next.dump().frames).toBe(0);
    controller.seal();
    expect(() => { controller.begin(1); controller.begin(1); }).toThrow();
  });

  it('keeps unavailable samples null and excludes them from stats', () => {
    const missing = new FrameCapture(2);
    missing.cpu(new Map(), new Map(), new Map());
    missing.cpu(new Map(), new Map(), new Map());
    missing.write('gpu/test', 1, 7);
    expect(missing.dump().series['gpu/test']).toEqual([null, 7]);
    expect(sampleStats([NaN, 3, 1, 2])!.median).toBe(2);
    expect(sampleStats([])).toBeNull();
  });

  it('rejects out-of-range capacities', () => {
    expect(() => new FrameCapture(0)).toThrow();
    expect(() => new FrameCapture(20001)).toThrow();
  });
});
