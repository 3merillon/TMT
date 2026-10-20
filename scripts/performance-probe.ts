/**
 * In-page instrumentation for scripts/capture-performance.ts. Everything here is injected by the harness, so an
 * unmodified preserved bundle and a candidate bundle are measured by exactly the same code.
 *
 * - Real-time driver: the game loop asks `window.__tmtRenderBench` (the ?renderbench hook) for a fixed step and a batch
 *   gate. `realtime(true)` puts an object in front of it that reports no fixed step and never holds a frame, so the
 *   ordinary rAF loop, real dt and real input run, while the scene setup methods of the original driver stay usable.
 * - Per rendered frame: the rAF timestamp, main-thread work inside rAF callbacks, the JS heap, and the wall time at
 *   which the GPU finished that frame's submission (GPUQueue.onSubmittedWorkDone).
 * - Long tasks and long animation frames (PerformanceObserver), named marks.
 * - Optional WebGPU call statistics: counts, CPU time and uploaded bytes of device-level calls, charged to the next
 *   rendered frame (commits arrive in worker message handlers, outside rAF), plus one event per pipeline or
 *   shader-module creation and per mapAsync (first-use compiles and readback latency).
 *
 * This function is serialised into the page: it must not reference anything outside its own body.
 */
export interface ProbeOptions { capacity: number; apiStats: boolean }

export function installPerformanceProbe(options: ProbeOptions): void {
  const g = globalThis as any;
  if (g.__tmtPerf || typeof window === 'undefined' || window.top !== window) return;
  const N = options.capacity;
  const series = () => new Float64Array(N);
  const frame = { raf: series(), start: series(), work: series(), rendered: series(), gpuDone: series(), heap: series(),
    apiMs: series(), uploadBytes: series(), uploads: series(), creates: series(), bindGroups: series(), views: series() };
  const pending = { apiMs: 0, uploadBytes: 0, uploads: 0, creates: 0, bindGroups: 0, views: 0 };
  type Counter = Exclude<keyof typeof pending, 'apiMs' | 'uploadBytes'>;
  let count = 0, recording = false, open = -1, openStamp = -1, stamp = -1, device: any;
  const marks: { name: string; time: number; frame: number }[] = [];
  const longTasks: { start: number; duration: number }[] = [];
  const longFrames: { start: number; duration: number; blocking: number; scripts: { duration: number; invoker: string; fn: string; url: string }[] }[] = [];
  const apiEvents: { kind: string; label: string; start: number; ms: number; settledMs?: number; bytes?: number }[] = [];
  const memory = () => g.performance.memory ? g.performance.memory.usedJSHeapSize : NaN;

  // ---- rAF: one record per animation frame in which the game rendered --------------------------------------------
  const nativeRaf = window.requestAnimationFrame.bind(window);
  let work = 0, frameStart = 0;
  window.requestAnimationFrame = (callback: FrameRequestCallback) => nativeRaf(time => {
    const t0 = performance.now();
    if (time !== stamp) { stamp = time; work = 0; frameStart = t0; }
    try { callback(time); } finally {
      work += performance.now() - t0;
      if (open >= 0 && openStamp === stamp) frame.work[open] = work;
    }
  });
  const rendered = () => {
    open = -1;
    if (!recording || count >= N) return;
    const i = open = count++;
    openStamp = stamp;
    frame.raf[i] = stamp; frame.start[i] = frameStart; frame.rendered[i] = performance.now(); frame.heap[i] = memory();
    for (const key of Object.keys(pending) as (keyof typeof pending)[]) { frame[key][i] = pending[key]; pending[key] = 0; }
    frame.gpuDone[i] = NaN;
    if (device) device.queue.onSubmittedWorkDone().then(() => { frame.gpuDone[i] = performance.now(); }, () => {});
  };

  // ---- Long tasks / long animation frames -----------------------------------------------------------------------
  try {
    new PerformanceObserver(list => { if (recording) for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration }); })
      .observe({ type: 'longtask', buffered: false });
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver(list => {
      if (recording) for (const e of list.getEntries() as any[]) longFrames.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration,
        scripts: (e.scripts ?? []).map((s: any) => ({ duration: s.duration, invoker: String(s.invoker ?? ''), fn: String(s.sourceFunctionName ?? ''), url: String(s.sourceURL ?? '').split('/').pop() ?? '' })) });
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch { /* unsupported */ }

  // ---- WebGPU: the device (always), call statistics (optional) -----------------------------------------------------
  const adapterProto = g.GPUAdapter?.prototype;
  if (adapterProto) {
    const requestDevice = adapterProto.requestDevice;
    adapterProto.requestDevice = function (...args: unknown[]) {
      return requestDevice.apply(this, args).then((d: any) => { device = d; return d; });
    };
  }
  if (options.apiStats && g.GPUDevice) {
    const timed = (proto: any, method: string, counter: Counter | null, extra?: (args: any[], ms: number, start: number, result: any) => void) => {
      const native = proto?.[method];
      if (typeof native !== 'function') return;
      proto[method] = function (...args: any[]) {
        const t0 = performance.now();
        const result = native.apply(this, args);
        const ms = performance.now() - t0;
        if (recording) { pending.apiMs += ms; if (counter) pending[counter]++; if (extra) extra(args, ms, t0, result); }
        return result;
      };
    };
    const D = g.GPUDevice.prototype, Q = g.GPUQueue.prototype;
    for (const method of ['createBuffer', 'createTexture', 'createSampler', 'createBindGroupLayout', 'createPipelineLayout', 'createQuerySet']) timed(D, method, 'creates');
    timed(D, 'createCommandEncoder', null);
    timed(D, 'createBindGroup', 'bindGroups');
    timed(g.GPUTexture.prototype, 'createView', 'views');
    const compile = (kind: string) => (args: any[], ms: number, start: number, result: any) => {
      const event: typeof apiEvents[number] = { kind, label: String(args[0]?.label ?? ''), start, ms };
      if (kind === 'createShaderModule') event.bytes = String(args[0]?.code ?? '').length;
      apiEvents.push(event);
      if (result && typeof result.then === 'function') result.then(() => { event.settledMs = performance.now() - start; }, () => { event.settledMs = -1; });
    };
    for (const method of ['createShaderModule', 'createRenderPipeline', 'createComputePipeline', 'createRenderPipelineAsync', 'createComputePipelineAsync'])
      timed(D, method, 'creates', compile(method));
    const upload = (sizeOf: (args: any[]) => number) => (args: any[]) => { pending.uploadBytes += sizeOf(args); pending.uploads++; };
    timed(Q, 'writeBuffer', null, upload(args => {
      const data = args[2], unit = data?.BYTES_PER_ELEMENT ?? 1;
      return args[4] !== undefined ? args[4] * unit : (data?.byteLength ?? 0) - (args[3] ?? 0) * unit;
    }));
    timed(Q, 'writeTexture', null, upload(args => args[1]?.byteLength ?? 0));
    timed(Q, 'submit', null);
    timed(g.GPUBuffer.prototype, 'mapAsync', null, (_args, ms, start, result) => {
      const event: typeof apiEvents[number] = { kind: 'mapAsync', label: '', start, ms };
      apiEvents.push(event);
      result.then(() => { event.settledMs = performance.now() - start; }, () => { event.settledMs = -1; });
    });
  }

  // ---- Real-time driver in front of the ?renderbench hook ------------------------------------------------------------
  let original: any, simulationScale = 1;
  const bench = () => {
    original ??= g.__tmtRenderBench;
    if (!original) throw new Error('The page was not started with ?renderbench');
    return original;
  };
  g.__tmtPerf = {
    get bench() { return bench(); },
    realtime(on: boolean, scale = 1) {
      const o = bench(); simulationScale = scale;
      if (!on) { Object.defineProperty(window, '__tmtRenderBench', { configurable: true, value: o }); return; }
      const driver = Object.create(o, { stepSeconds: { get: () => undefined }, simulationScale: { get: () => simulationScale } });
      driver.beforeFrame = () => true;
      driver.beforeRender = () => {};
      driver.afterFrame = rendered;
      Object.defineProperty(window, '__tmtRenderBench', { configurable: true, value: driver });
    },
    begin() {
      count = 0; open = -1; marks.length = 0; longTasks.length = 0; longFrames.length = 0; apiEvents.length = 0;
      for (const values of Object.values(frame)) values.fill(0);
      for (const key of Object.keys(pending) as (keyof typeof pending)[]) pending[key] = 0;
      recording = true;
      performance.mark('tmt-perf-begin');
      return performance.now();
    },
    mark(name: string) { const time = performance.now(); marks.push({ name, time, frame: count }); return time; },
    /** A real blast through the original driver; marks the request and the committed edit. */
    blast(radius: number, munition?: string, camera?: unknown) {
      const name = `blast:${munition ?? 'explosive'}:${radius}`;
      this.mark(`${name}:request`);
      return bench().blast(radius, munition, camera).then(() => { this.mark(`${name}:commit`); return true; }, (error: unknown) => { this.mark(`${name}:failed`); throw error; });
    },
    end() {
      recording = false; open = -1;
      performance.mark('tmt-perf-end');
      const slice = (values: Float64Array) => Array.from(values.subarray(0, count));
      return { frames: count, capacity: N, end: performance.now(), frame: Object.fromEntries(Object.entries(frame).map(([name, values]) => [name, slice(values)])),
        marks: [...marks], longTasks: [...longTasks], longFrames: [...longFrames], apiEvents: [...apiEvents], apiStats: options.apiStats };
    },
  };
}
