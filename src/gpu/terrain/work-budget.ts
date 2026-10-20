/** Yield only after using a frame's small CPU budget. No accepted state is
 * published at these boundaries; callers still commit a complete transaction. Pass a shared WorkBudget to keep one
 * slice clock across several drains (otherwise each drain starts a fresh slice). */
export async function drainTerrainWork<T>(steps: Generator<unknown, T>, check: () => void = () => {}, budget: number | WorkBudget = 6): Promise<T> {
  const clock = typeof budget === 'number' ? new WorkBudget(budget, check) : budget;
  try {
    for (;;) {
      const next = steps.next(); if (next.done) return next.value;
      await clock.tick();
    }
  } catch (error) { steps.return(undefined as T); throw error; } // a cancelled drain still runs the generator's cleanup
}
type SchedulerYield = { yield?: () => Promise<void>; postTask?: (task: () => void, options?: { priority?: 'user-blocking' | 'user-visible' | 'background' }) => Promise<void> };
/** Give the event loop a turn (input, rendering) and resume promptly: scheduler.yield() keeps the continuation's
 * priority; otherwise a MessageChannel message, which (unlike a nested setTimeout(0)) is never clamped to 4 ms. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerYield }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  if (typeof MessageChannel !== 'undefined') return new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(0);
  });
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}
/** Yield for idle work (compaction, the diagnostics oracle): background priority, so frames and edits go first. */
export function yieldBackground(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerYield }).scheduler;
  if (typeof scheduler?.postTask === 'function') return scheduler.postTask(() => {}, { priority: 'background' });
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}
type Raf = (callback: (time: number) => void) => number;
const raf = (): Raf | undefined => (globalThis as { requestAnimationFrame?: Raf }).requestAnimationFrame;
/** Frame pacing while an edit is in flight: a rAF ticker records the last frame; once a frame is due, the next slice
 * waits until just after it (rAF, then a message), so terrain work never stacks several slices into one frame. */
export class FramePacer {
  lastFrame = 0; worst = 0; private users = 0; private running = false; private waiters: (() => void)[] = [];
  /** Frame period estimate (ms) and the share of it a slice may take before the next one waits for a frame. */
  period = 16.7;
  /** Longest wait for a due frame (at least three periods). A frame that does not come while the main thread idles
   * (the GPU queue held by a pipeline compile, a hidden tab) must not hold the edit: slices then continue with plain
   * yields until the next frame arrives. */
  stallMs = 25;
  /** Stall seen: the awaited frame did not come within stallMs (cleared by the next frame). */
  stalls = 0; private stalled = false;
  get active(): boolean { return this.running; }
  acquire(): void { this.users++; this.start(); }
  release(): void { this.users = Math.max(0, this.users - 1); }
  private start(): void {
    const request = raf(); if (!request || this.running) return;
    this.running = true; this.lastFrame = performance.now();
    const frame = (time: number) => {
      const delta = time - this.lastFrame; if (delta > 0 && delta < this.period * 1.5) this.period = this.period * 0.8 + delta * 0.2;
      this.lastFrame = time; this.stalled = false;
      const waiters = this.waiters; this.waiters = [];
      if (waiters.length) { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); for (const w of waiters) w(); }; channel.port2.postMessage(0); }
      if (this.users > 0 || this.waiters.length) request(frame); else this.running = false;
    };
    request(frame);
  }
  /** Resolves right after the next animation frame has been produced, or once the frame is stallMs overdue. */
  afterNextFrame(): Promise<void> {
    return new Promise<void>(resolve => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { if (settled) return; this.stalled = true; this.stalls++; this.waiters = this.waiters.filter(w => w !== done); done(); }, Math.max(this.stallMs, this.period * 3));
      this.waiters.push(done); this.start();
    });
  }
  /** A frame is due (or overdue) when most of a period has passed since the last one, unless it has stalled. */
  get frameDue(): boolean { return this.running && !this.stalled && performance.now() - this.lastFrame > this.period * 0.6; }
}
export const framePacer = new FramePacer();
/** Cooperative time slicing for async pipelines: `await budget.tick()` yields once the slice is used up. */
export class WorkBudget {
  private started = performance.now();
  yields = 0;
  /** Longest synchronous stretch between two yields so far, and the label current when it ended (diagnostics). */
  longest = 0; longestLabel = ''; label = '';
  constructor(public budgetMs = 6, private readonly check: () => void = () => {}) {}
  async tick(): Promise<void> {
    const used = performance.now() - this.started;
    if (used < this.budgetMs) return;
    if (used > this.longest) { this.longest = used; this.longestLabel = this.label; }
    if (framePacer.frameDue) await framePacer.afterNextFrame(); else await yieldToMain();
    this.yields++; this.check(); this.started = performance.now();
  }
  /** Close the current slice before an external await (it yields); the next slice starts after it. */
  pause(): void { const used = performance.now() - this.started; if (used > this.longest) { this.longest = used; this.longestLabel = this.label; } }
  /** Start a fresh slice (after an external await that already yielded). */
  reset(): void { this.started = performance.now(); }
}
