import { sampleStats } from '../src/engine/gpu/frame-capture';
interface FeatureState {
  clouds?: { enabled: boolean; shadows: boolean } | null;
  volumetrics?: { enabled?: boolean; sun?: boolean; local?: boolean; density?: number };
}

/** Missing timestamp values never become zero. Optional passes may legitimately skip a frame. */
export function summarizeCapture(report: { capture: { frames: number; pendingGpu: number; droppedGpu: number; series: Record<string, (number | null)[]> };
  start?: { features?: FeatureState }; end?: { features?: FeatureState };
  action?: { settled: boolean; error: string | null; terrainVersionBefore: number; terrainVersionAfter: number };
  droppedDuringCapture: number; samples: { engine: { lost: boolean; validationErrors: number; compile: { errors: number; pending: number }; gpu: { timestamps: boolean }; vram: { total: number }; display?: number[]; internal?: number[]; tier?: string }; wallMilliseconds: number; presentationMilliseconds: number; cameraInsideTerrain: boolean }[] }, expectedFrames: number,
  expected?: { display: [number, number]; internal: [number, number]; tier: string }) {
  const { capture, samples } = report;
  const failures: string[] = [];
  if (report.action && (!report.action.settled || report.action.error || !(report.action.terrainVersionAfter > report.action.terrainVersionBefore))) failures.push('actual measured impact did not commit');
  if (report.action) for (const pass of ['fluids.gas', 'fluids.gasEmission']) {
    if (!capture.series[`gpu/${pass}`]?.some(value => value !== null && Number.isFinite(value))) failures.push(`actual measured impact omitted ${pass}`);
  }
  if (capture.frames !== expectedFrames || samples.length !== expectedFrames) failures.push('wrong frame count');
  if (capture.pendingGpu || capture.droppedGpu || report.droppedDuringCapture) failures.push('pending/dropped GPU timestamps');
  if (samples.some(s => !s.engine.gpu.timestamps)) failures.push('timestamp queries unavailable');
  if (samples.some(s => s.engine.lost || s.engine.validationErrors || s.engine.compile.errors || s.engine.compile.pending)) failures.push('device, validation or pipeline error');
  if (samples.some(s => s.cameraInsideTerrain)) failures.push('camera inside terrain');
  if (expected && samples.some(s => s.engine.tier !== expected.tier || ['display', 'internal'].some(key =>
    (s.engine[key as 'display' | 'internal'] ?? []).join(',') !== expected[key as 'display' | 'internal'].join(',')))) failures.push('wrong render dimensions or tier');
  const cpu = capture.series['cpu/encode'];
  if (!cpu || cpu.length !== expectedFrames || cpu.some(v => v === null || !Number.isFinite(v))) failures.push('missing CPU encode samples');
  if (samples.some(s => !Number.isFinite(s.engine.vram.total) || s.engine.vram.total < 0 || !Number.isFinite(s.presentationMilliseconds) || !Number.isFinite(s.wallMilliseconds))) failures.push('invalid CPU or allocation sample');
  const requiredPasses = new Set(['lighting', 'optics.source']);
  for (const state of [report.start, report.end]) {
    const clouds = state?.features?.clouds, volume = state?.features?.volumetrics;
    if (clouds?.enabled) {
      for (const name of ['clouds.raymarch', 'clouds.temporal', 'clouds.composite']) requiredPasses.add(name);
      if (clouds.shadows) requiredPasses.add('clouds.shadow');
    }
    if (volume?.enabled && (volume.sun || volume.local) && (volume.density ?? 0) > 0) {
      requiredPasses.add('volumetrics'); requiredPasses.add('volumetrics.composite');
    }
  }
  for (const name of requiredPasses) {
    const values = capture.series[`gpu/${name}`];
    if (!values || values.length !== expectedFrames || values.some(v => v === null || !Number.isFinite(v))) failures.push(`missing required ${name} timestamps`);
  }
  const features = report.start?.features;
  const forbiddenPasses: string[] = [];
  if (features?.clouds?.enabled === false) forbiddenPasses.push('clouds.raymarch', 'clouds.temporal', 'clouds.composite', 'clouds.shadow');
  else if (features?.clouds?.shadows === false) forbiddenPasses.push('clouds.shadow');
  if (features?.volumetrics?.enabled === false) forbiddenPasses.push('volumetrics', 'volumetrics.composite');
  for (const name of forbiddenPasses) if (capture.series[`gpu/${name}`]?.some(v => v !== null && Number.isFinite(v))) failures.push(`disabled pass ${name} dispatched`);
  const passSeries = Object.entries(capture.series).filter(([name]) => name.startsWith('gpu/') && name !== 'gpu/framePeriod');
  const total = Array.from({ length: expectedFrames }, (_, i) => [...requiredPasses].some(name => capture.series[`gpu/${name}`]?.[i] == null || !Number.isFinite(capture.series[`gpu/${name}`]?.[i]))
    ? NaN : passSeries.reduce((sum, [, values]) => sum + (values[i] ?? 0), 0));
  return { valid: failures.length === 0, failures, requiredPasses: [...requiredPasses], forbiddenPasses, gpuMs: sampleStats(total), encodeCpuMs: sampleStats(capture.series['cpu/encode']?.filter((v): v is number => v !== null) ?? []),
    presentationCpuMs: sampleStats(samples.map(s => s.presentationMilliseconds)), wallFrameMs: sampleStats(samples.map(s => s.wallMilliseconds)),
    trackedGpuBytes: sampleStats(samples.map(s => s.engine.vram.total)),
    passes: Object.fromEntries(passSeries.map(([name, values]) => [name.slice(4), { ...sampleStats(values.filter((v): v is number => v !== null)), missingOrSkipped: values.filter(v => v === null).length }])) };
}
