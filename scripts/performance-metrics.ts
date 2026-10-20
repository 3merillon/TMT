/** Pure reductions of scripts/capture-performance.ts recordings: frame cadence, hitches, heap, WebGPU calls, CPU traces. */

export interface Recording {
  frames: number; capacity: number; begin: number; end: number; apiStats: boolean;
  frame: Record<'raf' | 'start' | 'work' | 'rendered' | 'gpuDone' | 'heap' | 'apiMs' | 'uploadBytes' | 'uploads' | 'creates' | 'bindGroups' | 'views', number[]>;
  marks: { name: string; time: number; frame: number }[];
  longTasks: { start: number; duration: number }[];
  longFrames: { start: number; duration: number; blocking: number; scripts: { duration: number; invoker: string; fn: string; url: string }[] }[];
  apiEvents: { kind: string; label: string; start: number; ms: number; settledMs?: number; bytes?: number }[];
}

/** Frame intervals longer than these count as hitches (ms): one missed 60 Hz refresh, 1.5 and 2 frames at 60 Hz, 50 and 100 ms. */
export const HITCH_MS = [16.7, 25, 33.4, 50, 100] as const;

export function distribution(values: readonly number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { samples: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), p999: at(.999), max: sorted[sorted.length - 1] };
}

/** Intervals between consecutive rendered frames, from the rAF timestamps. interval[i] ends at frame i + 1. */
export function frameIntervals(recording: Pick<Recording, 'frame'>): number[] {
  const raf = recording.frame.raf;
  return raf.slice(1).map((time, i) => time - raf[i]);
}

export function cadence(intervals: readonly number[]) {
  const stats = distribution(intervals);
  if (!stats) return null;
  const seconds = intervals.reduce((a, b) => a + b, 0) / 1000;
  // A stutter is relative to the run's own pace, so a steady 30 fps run has none and a 120 fps run with 20 ms frames does.
  const stutterLimit = Math.max(2 * stats.p50, stats.p50 + 8);
  return {
    ...stats, seconds, fps: intervals.length / seconds, onePercentLowFps: 1000 / stats.p99,
    hitches: Object.fromEntries(HITCH_MS.map(limit => [`over${limit}ms`, intervals.filter(v => v > limit).length])),
    stutters: intervals.filter(v => v > stutterLimit).length, stutterLimit,
    // Time spent beyond a 16.7 ms frame: one long freeze and many small ones compare on the same scale.
    excessMs: intervals.reduce((sum, v) => sum + Math.max(0, v - 16.7), 0),
  };
}

function heapSummary(heap: readonly number[], seconds: number) {
  const valid = heap.filter(Number.isFinite);
  if (valid.length < 2) return null;
  let allocated = 0, collections = 0, reclaimed = 0;
  for (let i = 1; i < valid.length; i++) {
    const delta = valid[i] - valid[i - 1];
    if (delta > 0) allocated += delta;
    else if (delta < -262144) { collections++; reclaimed -= delta; }
  }
  return { startMB: valid[0] / 1048576, endMB: valid[valid.length - 1] / 1048576, peakMB: Math.max(...valid) / 1048576,
    allocatedMBPerSecond: allocated / 1048576 / seconds, collections, reclaimedMB: reclaimed / 1048576 };
}

/**
 * The frames that held the main thread longest, with what the page reported inside them. A long frame delays the NEXT
 * rAF, so `nextInterval` is the gap the player sees after it. WebGPU counters are those charged to the frame itself
 * (its own callback) and to the following one (handlers that ran between the two).
 */
function worstFrames(recording: Recording, intervals: readonly number[], limit: number) {
  const f = recording.frame;
  return Array.from({ length: recording.frames }, (_, i) => ({ frame: i, at: f.start[i] - recording.begin, work: f.work[i], nextInterval: intervals[i] ?? NaN, gpuLatency: f.gpuDone[i] - f.rendered[i],
    uploadKB: (f.uploadBytes[i] + (f.uploadBytes[i + 1] ?? 0)) / 1024, creates: f.creates[i] + (f.creates[i + 1] ?? 0), bindGroups: f.bindGroups[i] + (f.bindGroups[i + 1] ?? 0),
    apiMs: f.apiMs[i] + (f.apiMs[i + 1] ?? 0) })).sort((a, b) => b.work - a.work).slice(0, limit);
}

/** Page-clock windows [from, to] of the frames in `worst`, for summarizeTrace. */
export function frameWindows(recording: Recording, worst: readonly { frame: number }[]): [number, number][] {
  return worst.map(({ frame }) => [recording.frame.start[frame], recording.frame.start[frame] + recording.frame.work[frame]]);
}

export function summarizeRecording(recording: Recording) {
  const f = recording.frame, intervals = frameIntervals(recording), pace = cadence(intervals);
  const seconds = pace?.seconds ?? 0;
  // Named marks split the run: the first event of a kind is the first use, later ones are warmed repeats. The probe's own
  // blast marks are not boundaries; they give each edit's latency from the request to the committed terrain.
  const named = recording.marks.filter(mark => !mark.name.startsWith('blast:'));
  const segments = named.map((mark, i) => {
    const from = mark.frame, to = named[i + 1]?.frame ?? recording.frames;
    const part = intervals.slice(Math.max(0, from - 1), Math.max(0, to - 1));
    const end = named[i + 1]?.time ?? recording.end;
    const tasks = recording.longTasks.filter(task => task.start >= mark.time && task.start < end);
    return { name: mark.name, at: mark.time - recording.begin, seconds: (end - mark.time) / 1000, frames: part.length, cadence: cadence(part),
      longTasks: { count: tasks.length, totalMs: tasks.reduce((sum, task) => sum + task.duration, 0), maxMs: Math.max(0, ...tasks.map(task => task.duration)) } };
  });
  const requests = recording.marks.filter(mark => mark.name.startsWith('blast:') && mark.name.endsWith(':request'));
  const edits = requests.map(request => {
    const kind = request.name.slice(0, -':request'.length);
    const settled = recording.marks.find(mark => mark.time >= request.time && (mark.name === `${kind}:commit` || mark.name === `${kind}:failed`));
    return { name: kind, at: request.time - recording.begin, committed: settled?.name.endsWith(':commit') ?? false, latencyMs: settled ? settled.time - request.time : null };
  });
  const scripts = new Map<string, { ms: number; count: number }>();
  for (const long of recording.longFrames) for (const script of long.scripts) {
    const key = `${script.invoker} ${script.fn} ${script.url}`.trim(), entry = scripts.get(key) ?? { ms: 0, count: 0 };
    entry.ms += script.duration; entry.count++; scripts.set(key, entry);
  }
  // rAF timestamps sit on the display's refresh grid. The times at which the GPU finished each frame do not, so a
  // GPU-bound run and a GPU spike are read from these.
  const done = f.gpuDone.filter(Number.isFinite);
  const compiles = recording.apiEvents.filter(event => event.kind !== 'mapAsync');
  const maps = recording.apiEvents.filter(event => event.kind === 'mapAsync' && event.settledMs !== undefined && event.settledMs >= 0);
  return {
    frames: recording.frames, truncated: recording.frames >= recording.capacity, seconds, cadence: pace,
    gpuCompletionCadence: cadence(done.slice(1).map((time, i) => time - done[i])),
    mainThreadFrameWorkMs: distribution(f.work), gpuCompletionLatencyMs: distribution(f.gpuDone.map((done, i) => done - f.rendered[i])),
    longTasks: { count: recording.longTasks.length, totalMs: recording.longTasks.reduce((sum, task) => sum + task.duration, 0), maxMs: Math.max(0, ...recording.longTasks.map(task => task.duration)) },
    longAnimationFrames: { count: recording.longFrames.length, blockingMs: recording.longFrames.reduce((sum, long) => sum + long.blocking, 0),
      maxMs: Math.max(0, ...recording.longFrames.map(long => long.duration)),
      scripts: [...scripts].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.ms - a.ms).slice(0, 12) },
    heap: heapSummary(f.heap, seconds),
    webgpu: recording.apiStats ? {
      apiMsPerFrame: distribution(f.apiMs), uploadKBPerFrame: distribution(f.uploadBytes.map(bytes => bytes / 1024)), uploadMBPerSecond: f.uploadBytes.reduce((a, b) => a + b, 0) / 1048576 / seconds,
      uploadsPerFrame: distribution(f.uploads), bindGroupsPerFrame: distribution(f.bindGroups), viewsPerFrame: distribution(f.views),
      resourceCreations: { total: f.creates.reduce((a, b) => a + b, 0), frames: f.creates.filter(v => v > 0).length },
      compiles: { count: compiles.length, blockingMs: compiles.reduce((sum, event) => sum + event.ms, 0),
        events: compiles.map(event => ({ ...event, at: event.start - recording.begin })).sort((a, b) => b.ms - a.ms).slice(0, 40) },
      mapAsync: { count: maps.length, latencyMs: distribution(maps.map(event => event.settledMs!)) },
    } : null,
    worstFrames: worstFrames(recording, intervals, 12), segments, edits,
  };
}

// ---- Chrome traces ----------------------------------------------------------------------------------------------------

export interface TraceEvent { name: string; cat?: string; ph: string; ts: number; dur?: number; pid: number; tid: number; id?: string | number; args?: any }
interface FunctionTime { name: string; selfMs: number; totalMs: number }

const GC_NAMES = new Set(['MinorGC', 'MajorGC', 'V8.GC_SCAVENGER', 'V8.GC_MARK_COMPACTOR', 'V8.GC_MINOR_MS', 'BlinkGC.AtomicPhase']);
const TASK_NAMES = new Set(['RunTask', 'ThreadControllerImpl::RunTask']);

function profileFunctions(events: readonly TraceEvent[], inWindow: (ms: number) => boolean) {
  const profiles = new Map<string, { tid: number; time: number; nodes: Map<number, { key: string; parent?: number }> }>();
  const byThread = new Map<number, Map<string, FunctionTime>>();
  const chunks = events.filter(event => event.name === 'Profile' || event.name === 'ProfileChunk').sort((a, b) => a.ts - b.ts);
  for (const event of chunks) {
    const id = `${event.pid}:${event.id}`;
    if (event.name === 'Profile') { profiles.set(id, { tid: event.tid, time: event.args?.data?.startTime ?? event.ts, nodes: new Map() }); continue; }
    const profile = profiles.get(id), data = event.args?.data;
    if (!profile || !data) continue;
    for (const node of data.cpuProfile?.nodes ?? []) {
      const call = node.callFrame ?? {}, file = String(call.url ?? '').split('/').pop()?.split('?')[0] ?? '';
      profile.nodes.set(node.id, { key: `${call.functionName || '(anonymous)'}${file ? ` ${file}:${(call.lineNumber ?? -1) + 1}` : ''}`, parent: node.parent });
    }
    const samples: number[] = data.cpuProfile?.samples ?? [], deltas: number[] = data.timeDeltas ?? [];
    let functions = byThread.get(profile.tid);
    if (!functions) byThread.set(profile.tid, functions = new Map());
    for (let i = 0; i < samples.length; i++) {
      const delta = deltas[i] ?? 0;
      profile.time += delta;
      if (delta <= 0 || delta > 50000 || !inWindow(profile.time / 1000)) continue;
      const seen = new Set<string>();
      for (let node = profile.nodes.get(samples[i]), self = true; node; node = node.parent === undefined ? undefined : profile.nodes.get(node.parent), self = false) {
        let entry = functions.get(node.key);
        if (!entry) functions.set(node.key, entry = { name: node.key, selfMs: 0, totalMs: 0 });
        if (self) entry.selfMs += delta / 1000;
        if (!seen.has(node.key)) { seen.add(node.key); entry.totalMs += delta / 1000; }
      }
    }
  }
  return byThread;
}

/**
 * `syncName` is a performance.mark made at `syncNow` (performance.now of the page): it converts the page's clock into the
 * trace clock. `windows` are page-clock intervals (ms), e.g. the worst frames, reported separately from the whole run.
 */
export function summarizeTrace(events: readonly TraceEvent[], sync: { name: string; now: number; endNow: number }, windows: readonly (readonly [number, number])[] = [], top = 40) {
  const mark = events.find(event => event.name === sync.name && event.cat?.includes('blink.user_timing'));
  if (!mark) return { error: `The trace has no ${sync.name} mark` };
  const offset = mark.ts / 1000 - sync.now, begin = sync.now + offset, end = sync.endNow + offset;
  const threadNames = new Map<string, string>(), processNames = new Map<number, string>();
  for (const event of events) if (event.ph === 'M') {
    if (event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, String(event.args?.name ?? ''));
    if (event.name === 'process_name') processNames.set(event.pid, String(event.args?.name ?? ''));
  }
  const threads = new Map<string, { process: string; thread: string; taskMs: number; tasks: number; maxTaskMs: number; over50ms: number; gcMs: number; gcCount: number; maxGcMs: number; source: string }>();
  const entryFor = (event: TraceEvent) => {
    const key = `${event.pid}:${event.tid}`;
    let entry = threads.get(key);
    if (!entry) threads.set(key, entry = { process: processNames.get(event.pid) ?? String(event.pid), thread: threadNames.get(key) ?? String(event.tid),
      taskMs: 0, tasks: 0, maxTaskMs: 0, over50ms: 0, gcMs: 0, gcCount: 0, maxGcMs: 0, source: '' });
    return entry;
  };
  const longTasks: { thread: string; at: number; ms: number }[] = [];
  for (const event of events) {
    if (event.ph !== 'X' || event.dur === undefined) continue;
    const start = event.ts / 1000, ms = event.dur / 1000;
    if (start + ms < begin || start > end) continue;
    if (TASK_NAMES.has(event.name)) {
      const entry = entryFor(event);
      // A thread reports through one task event name; the renderer's timeline name wins over the generic one.
      if (!entry.source) entry.source = event.name;
      if (entry.source !== event.name) { if (event.name !== 'RunTask') continue; entry.source = 'RunTask'; entry.taskMs = 0; entry.tasks = 0; entry.maxTaskMs = 0; entry.over50ms = 0; }
      entry.taskMs += ms; entry.tasks++; entry.maxTaskMs = Math.max(entry.maxTaskMs, ms);
      if (ms > 50) { entry.over50ms++; longTasks.push({ thread: entry.thread, at: start - begin, ms }); }
    } else if (GC_NAMES.has(event.name)) {
      const entry = entryFor(event);
      entry.gcMs += ms; entry.gcCount++; entry.maxGcMs = Math.max(entry.maxGcMs, ms);
    }
  }
  const rendererPid = mark.pid, mainKey = `${mark.pid}:${mark.tid}`;
  const functionTables = (inWindow: (ms: number) => boolean) => {
    const byThread = profileFunctions(events.filter(event => event.pid === rendererPid), inWindow), tables: Record<string, { self: FunctionTime[]; total: FunctionTime[]; sampledMs: number }> = {};
    const merged = new Map<string, Map<string, FunctionTime>>();
    for (const [tid, functions] of byThread) {
      const key = `${rendererPid}:${tid}`, label = key === mainKey ? 'main' : (threadNames.get(key) ?? String(tid)).replace(/\s*\d+$/, '');
      let target = merged.get(label);
      if (!target) merged.set(label, target = new Map());
      for (const fn of functions.values()) {
        const entry = target.get(fn.name) ?? { name: fn.name, selfMs: 0, totalMs: 0 };
        entry.selfMs += fn.selfMs; entry.totalMs += fn.totalMs; target.set(fn.name, entry);
      }
    }
    for (const [label, functions] of merged) {
      const list = [...functions.values()], round = (fn: FunctionTime) => ({ name: fn.name, selfMs: Math.round(fn.selfMs * 100) / 100, totalMs: Math.round(fn.totalMs * 100) / 100 });
      const busy = list.filter(fn => !fn.name.startsWith('(idle)'));
      tables[label] = { sampledMs: Math.round(busy.reduce((sum, fn) => sum + fn.selfMs, 0) * 10) / 10,
        self: busy.sort((a, b) => b.selfMs - a.selfMs).slice(0, top).map(round), total: [...busy].sort((a, b) => b.totalMs - a.totalMs).slice(0, top).map(round) };
    }
    return tables;
  };
  const shifted = windows.map(([from, to]) => [from + offset, to + offset] as const);
  return {
    seconds: (end - begin) / 1000, renderer: processNames.get(rendererPid) ?? String(rendererPid),
    threads: [...threads.entries()].map(([key, entry]) => ({ ...entry, main: key === mainKey })).filter(entry => entry.taskMs > 1 || entry.gcMs > 0).sort((a, b) => b.taskMs - a.taskMs),
    longTasks: longTasks.sort((a, b) => b.ms - a.ms).slice(0, 30),
    functions: functionTables(ms => ms >= begin && ms <= end),
    worstFrameFunctions: shifted.length ? functionTables(ms => shifted.some(([from, to]) => ms >= from && ms <= to)) : null,
  };
}

/** Top allocation sites of a CDP HeapProfiler sampling profile (bytes sampled while it ran, collected objects included). */
export function summarizeAllocations(profile: { head: any }, seconds: number, top = 40) {
  const sites = new Map<string, number>();
  let total = 0;
  const visit = (node: any) => {
    const call = node.callFrame ?? {}, file = String(call.url ?? '').split('/').pop()?.split('?')[0] ?? '';
    const key = `${call.functionName || '(anonymous)'}${file ? ` ${file}:${(call.lineNumber ?? -1) + 1}` : ''}`;
    if (node.selfSize) { sites.set(key, (sites.get(key) ?? 0) + node.selfSize); total += node.selfSize; }
    for (const child of node.children ?? []) visit(child);
  };
  visit(profile.head);
  return { sampledMB: total / 1048576, sampledMBPerSecond: total / 1048576 / seconds,
    sites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, bytes]) => ({ name, MB: Math.round(bytes / 10485.76) / 100, share: Math.round(bytes / total * 1000) / 10 })) };
}
