import { describe, expect, it, vi } from 'vitest';
import { summarizeCapture } from '../scripts/planetary-lighting-metrics';
import { contactDarkening } from '../scripts/check-terrain-shadow-comparison';
import { installRenderBench } from '../src/game/app/render-bench';

function fixture() {
  return { capture: { frames: 2, pendingGpu: 0, droppedGpu: 0, series: {
    'gpu/lighting': [1, 2] as (number | null)[], 'gpu/optics.source': [0, 0], 'gpu/clouds': [null, .5], 'cpu/encode': [.2, .3],
  } }, droppedDuringCapture: 0, samples: Array.from({ length: 2 }, () => ({
    engine: { lost: false, validationErrors: 0, compile: { errors: 0, pending: 0 }, gpu: { timestamps: true }, vram: { total: 1234 } },
    wallMilliseconds: 16.667, presentationMilliseconds: .4, cameraInsideTerrain: false,
  })) };
}
describe('planetary renderer measurement acceptance', () => {
  it('resolves an actual blast with its terrain-aim camera and restores the observer immediately', async () => {
    const observer = { position: [0, 0, 30], target: [0, 0, 0], up: [0, 1, 0], fovY: 1 };
    const aim = { ...observer, target: [0, 10, 0] };
    let camera = observer, hitCamera: unknown;
    const view = { cameraRig: () => camera, benchmarkControls: () => ({ setCamera: (value: typeof observer) => { camera = value; } }) };
    const game = { on() {}, devBlast: vi.fn(() => { hitCamera = camera; return Promise.resolve(); }) };
    const windowMock: any = {}; vi.stubGlobal('window', windowMock);
    try {
      installRenderBench(game as any, view as any);
      await windowMock.__tmtRenderBench.blast(2.5, 'incendiary', aim);
      expect(hitCamera).toBe(aim); expect(camera).toBe(observer);
      expect(game.devBlast).toHaveBeenCalledWith(2.5, 'incendiary');
    } finally { vi.unstubAllGlobals(); }
  });
  it('pauses frame production at the GPU queue bound and resumes when submitted work completes', async () => {
    const completions: (() => void)[] = [];
    const sample = fixture().samples[0];
    const engine = { telemetry: () => sample.engine, services: { scene: { get: () => undefined } }, ctx: { queue: { onSubmittedWorkDone: () => new Promise<void>(resolve => completions.push(resolve)) } } };
    const view = { benchmarkControls: () => ({ engine: () => engine }), telemetry: () => ({ presentationMilliseconds: .4 }), cameraTelemetry: () => ({ insideTerrain: false }) };
    const game = { on() {}, snapshot: { tick: 1 } };
    const windowMock: any = {}; vi.stubGlobal('window', windowMock);
    try {
      installRenderBench(game as any, view as any);
      const api = windowMock.__tmtRenderBench, batch = api.step(3);
      let rendered = 0;
      for (let attempt = 0; attempt < 5; attempt++) if (api.beforeFrame()) { api.afterFrame(16.67); rendered++; }
      expect(rendered).toBe(2); expect(completions).toHaveLength(2);
      completions[0](); await Promise.resolve();
      expect(api.beforeFrame()).toBe(true); api.afterFrame(16.67);
      expect(await batch).toHaveLength(3); expect(api.beforeFrame()).toBe(false);
      completions.slice(1).forEach(resolve => resolve()); await Promise.resolve();
    } finally { vi.unstubAllGlobals(); }
  });
  it('counts only contact darkening in the declared terrain region', () => {
    const off = { width: 2, height: 1, data: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]) };
    const on = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) };
    expect(contactDarkening(on, off, [0, 0, 1, 1]).stronglyDarkenedFraction).toBe(1);
    expect(contactDarkening(on, off, [1, 0, 1, 1]).meanPositiveDarkening).toBe(0);
  });
  it('retains optional skipped passes and sums only present timestamp samples', () => {
    const summary = summarizeCapture(fixture(), 2);
    expect(summary.valid).toBe(true); expect(summary.gpuMs?.mean).toBe(1.75);
    expect(summary.passes.clouds.missingOrSkipped).toBe(1);
    expect(summary.trackedGpuBytes?.median).toBe(1234);
  });
  it('rejects missing mandatory GPU samples instead of turning them into a speedup', () => {
    const report = fixture(); report.capture.series['gpu/lighting'][0] = null;
    const summary = summarizeCapture(report, 2);
    expect(summary.valid).toBe(false); expect(summary.gpuMs?.samples).toBe(1);
    expect(summary.failures).toContain('missing required lighting timestamps');
  });
  it('requires enabled cloud and volume work while allowing disabled passes to be absent', () => {
    const start = { features: { clouds: { enabled: true, shadows: true }, volumetrics: { enabled: true, sun: false, local: true, density: 1 } } };
    const report = { ...fixture(), start };
    const enabled = summarizeCapture(report, 2);
    expect(enabled.valid).toBe(false);
    expect(enabled.failures).toEqual(expect.arrayContaining(['missing required clouds.raymarch timestamps', 'missing required clouds.temporal timestamps',
      'missing required clouds.composite timestamps', 'missing required clouds.shadow timestamps', 'missing required volumetrics timestamps', 'missing required volumetrics.composite timestamps']));
    start.features.clouds.enabled = false; start.features.volumetrics.enabled = false;
    expect(summarizeCapture(report, 2).valid).toBe(true);
    const unexpectedlyRunning = { ...report, capture: { ...report.capture, series: { ...report.capture.series, 'gpu/clouds.raymarch': [.4, .4] } } };
    expect(summarizeCapture(unexpectedlyRunning, 2).failures).toContain('disabled pass clouds.raymarch dispatched');
  });
  it('rejects device, compilation, geometry and late-readback failures', () => {
    const report = fixture(); report.capture.pendingGpu = 1; report.droppedDuringCapture = 1;
    report.samples[0].cameraInsideTerrain = true; report.samples[1].engine.compile.pending = 1;
    const summary = summarizeCapture(report, 2);
    expect(summary.valid).toBe(false);
    expect(summary.failures).toEqual(expect.arrayContaining(['pending/dropped GPU timestamps', 'device, validation or pipeline error', 'camera inside terrain']));
  });
  it('requires the declared rendering size and all raw CPU samples', () => {
    const report = fixture(), expected = { display: [1600, 1000] as [number, number], internal: [1600, 1000] as [number, number], tier: 'high' };
    expect(summarizeCapture(report, 2, expected).failures).toContain('wrong render dimensions or tier');
    for (const sample of report.samples) Object.assign(sample.engine, expected);
    expect(summarizeCapture(report, 2, expected).valid).toBe(true);
    report.capture.series['cpu/encode'].pop();
    expect(summarizeCapture(report, 2, expected).failures).toContain('missing CPU encode samples');
  });
  it('requires an actual measured impact to finish a terrain commit', () => {
    const base = fixture();
    const report = { ...base, capture: { ...base.capture, series: { ...base.capture.series, 'gpu/fluids.gas': [null, .4], 'gpu/fluids.gasEmission': [null, .2] } },
      action: { settled: true, error: null, terrainVersionBefore: 3, terrainVersionAfter: 3 } };
    expect(summarizeCapture(report, 2).failures).toContain('actual measured impact did not commit');
    report.action.terrainVersionAfter = 4;
    expect(summarizeCapture(report, 2).valid).toBe(true);
    report.capture.series['gpu/fluids.gasEmission'] = [null, null];
    expect(summarizeCapture(report, 2).failures).toContain('actual measured impact omitted fluids.gasEmission');
  });
});
