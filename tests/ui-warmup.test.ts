/** The frame loop's match warm-up: the tick-0 snapshot is rendered with no time passing, one frame on the GPU at a
 * time, until the renderer reports its one-time work done and the GPU has completed a few frames after it; only then
 * is the match handed over. */
import { afterEach, expect, it, vi } from 'vitest';
import { startLoop, WARM_LIMIT_MS, WARM_SETTLE_FRAMES } from '../src/game/app/loop';
import type { GameSession } from '../src/game/app/session';
import type { GameView } from '../src/game/view';

const hooks = vi.hoisted(() => ({ dispatchFrame: vi.fn() }));
vi.mock('../src/game/app/hooks', () => ({ combinedTimeScale: () => 1, hasFrameHooks: () => true, dispatchFrame: hooks.dispatchFrame }));
afterEach(() => { vi.unstubAllGlobals(); hooks.dispatchFrame.mockClear(); });

function rig(bench?: object) {
  const callbacks: FrameRequestCallback[] = [], listeners = new Map<string, (payload?: unknown) => void>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  vi.stubGlobal('window', { __tmtRenderBench: bench });
  const flags = { sdf: false, solves: 0, water: false, pending: 1 }, gpu = { done: true, waiting: [] as (() => void)[] };
  const game = { ready: false, warming: true, snapshot: { tick: 0, tanks: [{ position: [0, 18, 0] }] }, observer: 0, setup: { mode: 'bot' },
    on: (event: string, listener: () => void) => { listeners.set(event, listener); return () => {}; },
    endWarmup: vi.fn(() => { game.warming = false; }), noteWarm: vi.fn(), step: vi.fn(), command: vi.fn(), setPaused: vi.fn(), previewPrediction: vi.fn(() => []), interpolation: () => undefined };
  const view = { update: vi.fn(), render: vi.fn(), idle: vi.fn(), cameraRig: vi.fn(),
    visibilityDebug: () => ({ stats: () => ({ sdf: { builds: flags.sdf ? 1 : 0 }, sdfValid: flags.sdf }) }),
    fluidsDebug: () => ({ stats: () => ({ solves: flags.solves, ready: flags.water, basins: 2 }) }),
    devControls: () => ({ compileStats: () => ({ pending: flags.pending }) }),
    terrainHost: { device: { queue: { onSubmittedWorkDone: () => gpu.done ? Promise.resolve() : new Promise<void>(resolve => gpu.waiting.push(resolve)) } } } };
  const shell = { modalOpen: () => false, driveInput: () => ({ throttle: 0, steer: 0 }), fullPreview: () => false, syncActive: vi.fn(), updateHud: vi.fn(), tickToast: vi.fn(), diagnostics: vi.fn() };
  startLoop(game as unknown as GameSession, view as unknown as GameView, shell);
  listeners.get('warming')?.();
  let t = performance.now();
  /** One animation frame, then the GPU and promise callbacks it released. */
  const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  const frame = async (ms = 16) => { t += ms; callbacks.shift()!(t); await settle(); };
  /** The GPU finishes the oldest submitted frame. */
  const complete = async () => { gpu.waiting.shift()!(); await settle(); };
  return { game, view, shell, flags, gpu, frame, complete };
}

it('renders the tick-0 snapshot with no time passing until the renderer is warm and the GPU has settled', async () => {
  const { game, view, shell, flags, frame } = rig();
  for (let i = 0; i < 5; i++) await frame();
  expect(view.update).toHaveBeenCalledTimes(5);
  for (const call of view.update.mock.calls) expect(call[2]).toBe(0);
  expect(view.render.mock.calls.every(call => call[0] === 0)).toBe(true);
  expect(game.step).not.toHaveBeenCalled(); expect(game.command).not.toHaveBeenCalled(); expect(game.setPaused).not.toHaveBeenCalled();
  expect(hooks.dispatchFrame).not.toHaveBeenCalled(); expect(shell.updateHud).not.toHaveBeenCalled(); expect(view.idle).not.toHaveBeenCalled();
  flags.sdf = true; flags.pending = 0; flags.solves = 1;
  for (let i = 0; i < 4; i++) await frame();
  expect(game.endWarmup).not.toHaveBeenCalled();
  flags.water = true;
  for (let i = 0; i < WARM_SETTLE_FRAMES; i++) await frame();
  expect(game.endWarmup).not.toHaveBeenCalled();
  const rendered = view.render.mock.calls.length;
  await frame();
  expect(game.endWarmup).toHaveBeenCalledOnce();
  expect(view.render).toHaveBeenCalledTimes(rendered);
  await frame();
  expect(view.idle).toHaveBeenCalledOnce();
});

it('keeps one warm-up frame on the GPU at a time and hands the match over only when the GPU is idle', async () => {
  const { game, view, flags, gpu, frame, complete } = rig();
  Object.assign(flags, { sdf: true, pending: 0, solves: 1, water: true });
  gpu.done = false;
  await frame();
  for (let i = 0; i < 6; i++) await frame();
  expect(view.render).toHaveBeenCalledOnce();
  await complete();
  await frame();
  expect(view.render).toHaveBeenCalledTimes(2);
  expect(game.endWarmup).not.toHaveBeenCalled();
  await frame();
  expect(game.endWarmup).not.toHaveBeenCalled();
  await complete();
  await frame();
  expect(game.endWarmup).toHaveBeenCalledOnce();
  expect(view.render).toHaveBeenCalledTimes(WARM_SETTLE_FRAMES);
});

it('settles a planet without water once its basins are solved', async () => {
  const { game, view, flags, frame } = rig();
  Object.assign(flags, { sdf: true, pending: 0, solves: 1 });
  view.fluidsDebug = () => ({ stats: () => ({ solves: 1, ready: false, basins: 0 }) });
  for (let i = 0; i <= WARM_SETTLE_FRAMES; i++) await frame();
  expect(game.endWarmup).toHaveBeenCalledOnce();
});

it('hands the match over when the warm-up runs too long, even with the GPU busy', async () => {
  const { game, gpu, frame } = rig();
  gpu.done = false;
  await frame();
  expect(game.endWarmup).not.toHaveBeenCalled();
  await frame(WARM_LIMIT_MS);
  expect(game.endWarmup).toHaveBeenCalledOnce();
});

it('hands the match over at once to the fixed-step render bench, which paces every frame from ready', async () => {
  const { game, view, frame } = rig({ stepSeconds: 1 / 60, simulationScale: 0, beforeFrame: () => true, beforeRender: vi.fn(), afterFrame: vi.fn() });
  await frame();
  expect(game.endWarmup).toHaveBeenCalledOnce();
  expect(view.update).not.toHaveBeenCalled(); expect(view.render).not.toHaveBeenCalled();
});
